import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseCommand } from "../commands.js";
import type { ConversationSnapshot } from "../conversations.js";
import type { HubControlClient } from "../hub-client.js";
import type { ConversationParticipant } from "../types.js";
import type { SlackDesktopMessage, SlackDesktopScanner } from "./desktop-reader.js";
import type { SlackThreadMessage, SlackThreadsScanner } from "./desktop-threads-reader.js";

type GatewayPublisher = {
  publish(input: { conversationId: string; agentLabel: string; content: string; threadRootMessageId?: string }): Promise<void>;
};

type Binding = {
  rootMessageId: string;
  rootUrl: string;
  lastHubMessageId: number;
  lastSlackReplyId: string;
  acknowledged: boolean;
};

type GatewayState = {
  version: 1;
  lastRootMessageId: string;
  conversations: Record<string, Binding>;
};

export type SlackGatewayDefaults = {
  codexRepository: string;
  claudeRepository: string;
  target: "codex" | "claude";
  turns: number;
};

function newer(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return newer(left, right) ? 1 : -1;
}

function slackRootFromTopic(topic: string): { rootMessageId: string; rootUrl: string } | undefined {
  const match = topic.match(/^\[Slack root (https:\/\/\S+\/archives\/[^/\s]+\/p(\d+))\s+·/);
  if (!match?.[1] || !match[2]) return undefined;
  return { rootUrl: match[1], rootMessageId: match[2] };
}

async function loadState(path: string): Promise<GatewayState | undefined> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as GatewayState;
    return state.version === 1 ? state : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveState(path: string, state: GatewayState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function option(tokens: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const index = tokens.findIndex((token) => token.toLowerCase().startsWith(prefix));
  if (index < 0) return undefined;
  const [value] = tokens.splice(index, 1);
  return value?.slice(prefix.length);
}

function discussRequest(raw: string, defaults: SlackGatewayDefaults): {
  topic: string;
  codexRepository: string;
  claudeRepository: string;
  target: "codex" | "claude";
  turns: number;
} | undefined {
  const tokens = raw.trim().split(/\s+/);
  if (tokens.shift()?.toLowerCase() !== "discuss") return undefined;
  const repository = option(tokens, "repo");
  const codexRepository = option(tokens, "codex_repo") ?? repository ?? defaults.codexRepository;
  const claudeRepository = option(tokens, "claude_repo") ?? repository ?? defaults.claudeRepository;
  const targetValue = (option(tokens, "to") ?? defaults.target).toLowerCase();
  if (targetValue !== "codex" && targetValue !== "claude") throw new Error("to must be codex or claude");
  const rounds = option(tokens, "rounds");
  const turnsValue = option(tokens, "turns");
  const turns = turnsValue ? Number(turnsValue) : rounds ? Number(rounds) * 2 : defaults.turns;
  if (!Number.isInteger(turns) || turns < 2 || turns > 12) throw new Error("turns must be between 2 and 12");
  const topic = tokens.join(" ").trim();
  if (!topic) throw new Error("Discussion topic is required");
  return { topic, codexRepository, claudeRepository, target: targetValue, turns };
}

function sourceTopic(message: SlackDesktopMessage, prompt: string): string {
  return `[Slack root ${message.url} · ${message.author}]\n${prompt}`;
}

function explicitTarget(text: string): "codex" | "claude" | undefined {
  const match = text.match(/(?:^|\s)to=(codex|claude)(?:\s|$)/i);
  return match?.[1]?.toLowerCase() as "codex" | "claude" | undefined;
}

function explicitMode(text: string): "read" | "write" {
  const match = text.match(/(?:^|\s)mode=(read|write)(?:\s|$)/i);
  return match?.[1]?.toLowerCase() === "write" ? "write" : "read";
}

function explicitTurns(text: string, fallback: number): number {
  const match = text.match(/(?:^|\s)turns=(\d+)(?:\s|$)/i);
  if (!match?.[1]) return fallback;
  const turns = Number(match[1]);
  if (!Number.isInteger(turns) || turns < 1 || turns > 12) throw new Error("turns must be between 1 and 12");
  return turns;
}

function removeRoutingOptions(text: string): string {
  return text
    .replace(/(?:^|\s)(?:to=(?:codex|claude)|mode=(?:read|write)|turns=\d+)(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGatewayPost(text: string): boolean {
  return /^\*?AgentHub\s*·/i.test(text.trim()) || /Sent using\s+(?:Codex|Claude|Hub)/i.test(text);
}

export class SlackHubGateway {
  readonly #roots: SlackDesktopScanner;
  readonly #threads: SlackThreadsScanner;
  readonly #client: Pick<HubControlClient, "open" | "reply" | "get" | "list">;
  readonly #publisher: GatewayPublisher;
  readonly #stateFile: string;
  readonly #allowedAuthors: Set<string>;
  readonly #publishActors: Set<ConversationParticipant>;
  readonly #defaults: SlackGatewayDefaults;
  readonly #ingress: boolean;

  constructor(options: {
    rootScanner: SlackDesktopScanner;
    threadsScanner: SlackThreadsScanner;
    client: Pick<HubControlClient, "open" | "reply" | "get" | "list">;
    publisher: GatewayPublisher;
    stateFile: string;
    allowedAuthors: string[];
    publishActors: ConversationParticipant[];
    defaults: SlackGatewayDefaults;
    ingress: boolean;
  }) {
    this.#roots = options.rootScanner;
    this.#threads = options.threadsScanner;
    this.#client = options.client;
    this.#publisher = options.publisher;
    this.#stateFile = options.stateFile;
    this.#allowedAuthors = new Set(options.allowedAuthors);
    this.#publishActors = new Set(options.publishActors);
    this.#defaults = options.defaults;
    this.#ingress = options.ingress;
  }

  async poll(): Promise<{ opened: number; humanReplies: number; published: number; initialized: boolean }> {
    const rootScan = this.#ingress ? await this.#roots.scan() : { channelVisible: true, messages: [] };
    let state = await loadState(this.#stateFile);
    let initialized = false;
    if (!state) {
      const latest = rootScan.messages.filter((message) => /^\d+$/.test(message.id)).sort((a, b) => compareIds(a.id, b.id)).at(-1)?.id ?? "0";
      state = { version: 1, lastRootMessageId: latest, conversations: {} };
      await saveState(this.#stateFile, state);
      initialized = true;
    }

    let opened = 0;
    if (this.#ingress && rootScan.channelVisible) {
      for (const message of rootScan.messages.filter((item) => /^\d+$/.test(item.id) && newer(item.id, state!.lastRootMessageId)).sort((a, b) => compareIds(a.id, b.id))) {
        try {
          if (await this.#openRoot(message, state)) opened += 1;
        } finally {
          state.lastRootMessageId = message.id;
          await saveState(this.#stateFile, state);
        }
      }
    }

    await this.#discoverBindings(state);
    const humanReplies = this.#ingress ? await this.#ingestThreadReplies(state) : 0;
    const published = await this.#publishHubMessages(state);
    await saveState(this.#stateFile, state);
    return { opened, humanReplies, published, initialized };
  }

  async #discoverBindings(state: GatewayState): Promise<void> {
    for (const conversation of await this.#client.list(100)) {
      if (state.conversations[conversation.id]) continue;
      const root = slackRootFromTopic(conversation.topic);
      if (!root) continue;
      state.conversations[conversation.id] = {
        ...root,
        lastHubMessageId: 0,
        lastSlackReplyId: root.rootMessageId,
        acknowledged: !this.#ingress,
      };
    }
  }

  async #openRoot(message: SlackDesktopMessage, state: GatewayState): Promise<boolean> {
    const match = message.text.trim().match(/^@AgentHub\b\s*(.*)$/is);
    if (!match) return false;
    if (!this.#allowedAuthors.has(message.author)) throw new Error(`Slack author '${message.author}' is not allowed`);
    const raw = match[1]?.trim() ?? "";
    const discuss = discussRequest(raw, this.#defaults);
    let snapshot: ConversationSnapshot;
    if (discuss) {
      snapshot = await this.#client.open({ ...discuss, topic: sourceTopic(message, discuss.topic), mode: "read" });
    } else {
      const command = parseCommand(raw, 6);
      if (command.kind === "ask") {
        snapshot = await this.#client.open({
          topic: sourceTopic(message, command.prompt),
          codexRepository: command.repository,
          claudeRepository: command.repository,
          target: command.agent,
          mode: "read",
          turns: 1,
        });
      } else if (command.kind === "open") {
        if (command.mode !== "read") throw new Error("Slack Gateway accepts only mode=read");
        snapshot = await this.#client.open({
          topic: sourceTopic(message, command.prompt),
          codexRepository: command.codexRepository,
          claudeRepository: command.claudeRepository,
          target: command.target,
          mode: "read",
          turns: command.turns,
        });
      } else {
        throw new Error("Use ask, discuss, or open for a new Slack topic");
      }
    }
    const lastHubMessageId = snapshot.messages.at(-1)?.id ?? 0;
    state.conversations[snapshot.conversation.id] = {
      rootMessageId: message.id,
      rootUrl: message.url,
      lastHubMessageId,
      lastSlackReplyId: message.id,
      acknowledged: false,
    };
    await saveState(this.#stateFile, state);
    return true;
  }

  async #ingestThreadReplies(state: GatewayState): Promise<number> {
    const messages = await this.#threads.scan();
    let count = 0;
    for (const [conversationId, binding] of Object.entries(state.conversations)) {
      const candidates = messages
        .filter((message) => message.rootId === binding.rootMessageId && newer(message.id, binding.lastSlackReplyId))
        .sort((a, b) => compareIds(a.id, b.id));
      for (const message of candidates) {
        if (!this.#allowedAuthors.has(message.author) || isGatewayPost(message.text)) {
          binding.lastSlackReplyId = message.id;
          continue;
        }
        const snapshot = await this.#client.get(conversationId);
        if (snapshot.conversation.status === "running") break;
        const lastAgent = [...snapshot.messages].reverse().find((item) => item.actor === "codex" || item.actor === "claude")?.actor;
        const target = explicitTarget(message.text) ?? (lastAgent === "codex" || lastAgent === "claude" ? lastAgent : this.#defaults.target);
        await this.#client.reply({
          conversationId,
          target,
          mode: explicitMode(message.text),
          turns: explicitTurns(message.text, this.#defaults.turns),
          content: `[Slack thread reply · ${message.author}]\n${removeRoutingOptions(message.text)}`,
        });
        binding.lastSlackReplyId = message.id;
        count += 1;
      }
    }
    return count;
  }

  async #publishHubMessages(state: GatewayState): Promise<number> {
    let count = 0;
    for (const [conversationId, binding] of Object.entries(state.conversations)) {
      if (!binding.acknowledged) {
        const snapshot = await this.#client.get(conversationId);
        await this.#publisher.publish({
          conversationId,
          agentLabel: "Hub",
          content: `Диалог создан: Codex → ${snapshot.conversation.codexRepository}, Claude → ${snapshot.conversation.claudeRepository}.`,
          threadRootMessageId: binding.rootMessageId,
        });
        binding.acknowledged = true;
        count += 1;
      }
      const snapshot = await this.#client.get(conversationId);
      for (const message of snapshot.messages.filter((item) => item.id > binding.lastHubMessageId)) {
        if (this.#publishActors.has(message.actor) && message.actor !== "human") {
          await this.#publisher.publish({
            conversationId,
            agentLabel: message.label,
            content: message.content,
            threadRootMessageId: binding.rootMessageId,
          });
          count += 1;
        }
        binding.lastHubMessageId = message.id;
      }
    }
    return count;
  }
}
