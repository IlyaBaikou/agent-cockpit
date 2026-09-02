import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseCommand } from "../commands.js";
import type { HubControlClient } from "../hub-client.js";
import { readSlackDesktopProof } from "../integration-doctor.js";
import { runProcess } from "../process.js";
import type { RepositoryRegistry } from "../repositories.js";
import type { AgentId } from "../types.js";

export type SlackDesktopMessage = { id: string; url: string; author: string; text: string };
export type SlackDesktopScan = { channelVisible: boolean; messages: SlackDesktopMessage[] };
export type SlackDesktopScanner = { scan(): Promise<SlackDesktopScan> };

type ReaderState = { version: 1; lastMessageId: string };

function newer(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

async function loadState(path: string): Promise<ReaderState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ReaderState;
    return parsed.version === 1 && /^\d+$/.test(parsed.lastMessageId) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveState(path: string, state: ReaderState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export class SlackAccessibilityScanner implements SlackDesktopScanner {
  readonly #proofFile: string;
  readonly #expectedChannelId: string | undefined;
  readonly #sourceFile: string;
  readonly #binaryFile: string;

  constructor(options: { proofFile: string; expectedChannelId?: string; sourceFile?: string; binaryFile?: string }) {
    this.#proofFile = options.proofFile;
    this.#expectedChannelId = options.expectedChannelId;
    this.#sourceFile = resolve(options.sourceFile ?? resolve(process.cwd(), "native/slack_ax_reader.swift"));
    this.#binaryFile = resolve(options.binaryFile ?? resolve(dirname(this.#proofFile), "bin/slack-ax-reader"));
  }

  async prepare(): Promise<void> {
    if (process.platform !== "darwin") throw new Error("Slack Desktop reading currently requires macOS");
    const source = await stat(this.#sourceFile);
    const binary = await stat(this.#binaryFile).catch(() => undefined);
    if (binary && binary.mtimeMs >= source.mtimeMs) return;
    await mkdir(dirname(this.#binaryFile), { recursive: true });
    const compiled = await runProcess("/usr/bin/swiftc", [this.#sourceFile, "-o", this.#binaryFile], { timeoutMs: 60_000 });
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.trim() || `swiftc exited with ${compiled.exitCode}`);
    await chmod(this.#binaryFile, 0o700);
  }

  async scan(): Promise<SlackDesktopScan> {
    await this.prepare();
    const proof = await readSlackDesktopProof(this.#proofFile);
    if (!proof) throw new Error("Slack Desktop proof is missing; run runner:slack-proof first");
    if (this.#expectedChannelId && proof.channelId !== this.#expectedChannelId) {
      throw new Error(`Slack proof channel ${proof.channelId} does not match configured channel ${this.#expectedChannelId}`);
    }
    const readVisibleChannel = async (): Promise<SlackDesktopScan> => {
      const result = await runProcess(this.#binaryFile, [proof.channelId, proof.channelName], { timeoutMs: 10_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Slack reader exited with ${result.exitCode}`);
      return JSON.parse(result.stdout) as SlackDesktopScan;
    };
    return await readVisibleChannel();
  }
}

export class SlackDesktopCommandReader {
  readonly #scanner: SlackDesktopScanner;
  readonly #client: Pick<HubControlClient, "open" | "reply">;
  readonly #repositories: RepositoryRegistry;
  readonly #stateFile: string;
  readonly #allowedAuthors: Set<string>;
  readonly #channelLabel: string;
  readonly #targetAgent: AgentId;

  constructor(options: {
    scanner: SlackDesktopScanner;
    client: Pick<HubControlClient, "open" | "reply">;
    repositories: RepositoryRegistry;
    stateFile: string;
    allowedAuthors: string[];
    channelLabel?: string;
    targetAgent?: AgentId;
  }) {
    this.#scanner = options.scanner;
    this.#client = options.client;
    this.#repositories = options.repositories;
    this.#stateFile = options.stateFile;
    this.#allowedAuthors = new Set(options.allowedAuthors.map((author) => author.trim()).filter(Boolean));
    this.#channelLabel = options.channelLabel ?? "agent-hub-lab";
    this.#targetAgent = options.targetAgent ?? "codex";
  }

  async poll(): Promise<{ initialized: boolean; accepted: number; rejected: number; channelVisible: boolean }> {
    const scan = await this.#scanner.scan();
    if (!scan.channelVisible) return { initialized: false, accepted: 0, rejected: 0, channelVisible: false };
    const messages = scan.messages.filter((message) => /^\d+$/.test(message.id)).sort((a, b) => newer(a.id, b.id) ? 1 : newer(b.id, a.id) ? -1 : 0);
    const latest = messages.at(-1)?.id;
    let state = await loadState(this.#stateFile);
    if (!state) {
      await saveState(this.#stateFile, { version: 1, lastMessageId: latest ?? "0" });
      return { initialized: true, accepted: 0, rejected: 0, channelVisible: true };
    }

    let accepted = 0;
    let rejected = 0;
    for (const message of messages.filter((candidate) => newer(candidate.id, state!.lastMessageId))) {
      try {
        if (await this.#handle(message)) accepted += 1;
      } catch (error) {
        rejected += 1;
        console.error(`Slack command ${message.id} rejected: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        state = { version: 1, lastMessageId: message.id };
        await saveState(this.#stateFile, state);
      }
    }
    return { initialized: false, accepted, rejected, channelVisible: true };
  }

  async #handle(message: SlackDesktopMessage): Promise<boolean> {
    const match = message.text.trim().match(/^@AgentHub\b\s*(.*)$/is);
    if (!match) return false;
    if (!this.#allowedAuthors.has(message.author)) throw new Error(`author '${message.author}' is not allowed`);
    const rawCommand = match[1]?.trim() ?? "";
    const command = parseCommand(rawCommand);
    const source = `[Slack #${this.#channelLabel} from ${message.author}]`;

    if (command.kind === "ask") {
      if (command.agent !== this.#targetAgent) return false;
      this.#repositories.get(command.repository);
      await this.#client.open({
        topic: `${source}\n${command.prompt}`,
        codexRepository: command.repository,
        claudeRepository: command.repository,
        target: this.#targetAgent,
        mode: "read",
        turns: 1,
      });
      return true;
    }
    if (command.kind === "open") {
      if (command.target !== this.#targetAgent) return false;
      if (command.mode !== "read") throw new Error("Slack Desktop reader accepts only mode=read");
      this.#repositories.get(command.codexRepository);
      await this.#client.open({ ...command, topic: `${source}\n${command.prompt}` });
      return true;
    }
    if (command.kind === "reply") {
      if (command.target !== this.#targetAgent) return false;
      if (command.mode !== "read") throw new Error("Slack Desktop reader accepts only mode=read");
      if (command.repository) this.#repositories.get(command.repository);
      await this.#client.reply({
        conversationId: command.conversationId,
        target: this.#targetAgent,
        ...(command.repository ? { repository: command.repository } : {}),
        mode: "read",
        turns: command.turns,
        content: `${source}\n${command.prompt}`,
      });
      return true;
    }
    throw new Error(`allowed commands are: ask ${this.#targetAgent}, open ... to=${this.#targetAgent}, reply ... to=${this.#targetAgent}`);
  }
}
