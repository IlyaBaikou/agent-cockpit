import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../src/conversations.js";
import { SlackHubGateway } from "../src/slack/gateway.js";
import type { SlackDesktopScan } from "../src/slack/desktop-reader.js";
import type { SlackThreadMessage } from "../src/slack/desktop-threads-reader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function snapshot(options: {
  id?: string;
  topic?: string;
  status?: "open" | "running" | "waiting" | "completed" | "failed";
  messages?: ConversationSnapshot["messages"];
} = {}): ConversationSnapshot {
  return {
    conversation: {
      id: options.id ?? "CHAT-0042",
      topic: options.topic ?? "A topic",
      codexRepository: "gameengine",
      claudeRepository: "ccp-library-core",
      status: options.status ?? "waiting",
      waitingFor: "human",
      createdAt: "2026-08-31T10:00:00.000Z",
      updatedAt: "2026-08-31T10:00:00.000Z",
    },
    messages: options.messages ?? [],
    artifacts: [],
  };
}

describe("SlackHubGateway", () => {
  it("opens a Hub conversation from a Slack topic and forwards thread replies", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-slack-gateway-"));
    temporaryDirectories.push(root);
    let roots: SlackDesktopScan = { channelVisible: true, messages: [] };
    let replies: SlackThreadMessage[] = [];
    let current = snapshot();
    const client = {
      open: vi.fn(async (input) => {
        current = snapshot({
          topic: input.topic,
          status: "running",
          messages: [{ id: 1, conversationId: "CHAT-0042", actor: "human", label: "Human", kind: "request", content: input.topic, createdAt: "2026-08-31T10:00:00.000Z" }],
        });
        return current;
      }),
      reply: vi.fn(async () => current),
      get: vi.fn(async () => current),
      list: vi.fn(async () => [current.conversation]),
    };
    const publish = vi.fn(async () => undefined);
    const gateway = new SlackHubGateway({
      rootScanner: { scan: async () => roots },
      threadsScanner: { scan: async () => replies },
      client,
      publisher: { publish },
      stateFile: join(root, "state.json"),
      allowedAuthors: ["Ilya Baikou", "Pavel Pogosov"],
      publishActors: ["codex", "system"],
      defaults: { codexRepository: "gameengine", claudeRepository: "ccp-library-core", target: "codex", turns: 6 },
      ingress: true,
    });

    expect(await gateway.poll()).toMatchObject({ initialized: true, opened: 0 });
    roots = { channelVisible: true, messages: [{
      id: "1788200000000001",
      url: "https://workspace.slack.com/archives/C123/p1788200000000001",
      author: "Ilya Baikou",
      text: "@AgentHub discuss codex_repo=gameengine claude_repo=ccp-library-core turns=6 Сверьте контракт геймификации",
    }] };
    expect(await gateway.poll()).toMatchObject({ opened: 1, published: 1 });
    expect(client.open).toHaveBeenCalledWith(expect.objectContaining({
      codexRepository: "gameengine",
      claudeRepository: "ccp-library-core",
      target: "codex",
      turns: 6,
      mode: "read",
    }));
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationId: "CHAT-0042",
      agentLabel: "Hub",
      threadRootMessageId: "1788200000000001",
    }));

    current = snapshot({
      topic: current.conversation.topic,
      status: "waiting",
      messages: [
        current.messages[0]!,
        { id: 2, conversationId: "CHAT-0042", actor: "codex", label: "Codex", kind: "response", content: "Контракт проверен.\nHANDOFF: human", createdAt: "2026-08-31T10:01:00.000Z" },
      ],
    });
    expect(await gateway.poll()).toMatchObject({ published: 1 });
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ agentLabel: "Codex", threadRootMessageId: "1788200000000001" }));

    replies = [{
      rootId: "1788200000000001",
      id: "1788200000000002",
      url: "https://workspace.slack.com/archives/C123/p1788200000000002?thread_ts=1788200000.000001&cid=C123",
      author: "Pavel Pogosov",
      text: "to=claude mode=write turns=4 Доработай документ и верни результат",
    }];
    expect(await gateway.poll()).toMatchObject({ humanReplies: 1 });
    expect(client.reply).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "CHAT-0042",
      target: "claude",
      mode: "write",
      turns: 4,
      content: "[Slack thread reply · Pavel Pogosov]\nДоработай документ и верни результат",
    }));
  });

  it("discovers Slack bindings from Hub and publishes only its configured actor", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-slack-gateway-"));
    temporaryDirectories.push(root);
    const rootUrl = "https://workspace.slack.com/archives/C123/p1788200000000010";
    const current = snapshot({
      topic: `[Slack root ${rootUrl} · Ilya Baikou]\nReview API`,
      messages: [
        { id: 1, conversationId: "CHAT-0042", actor: "human", label: "Human", kind: "request", content: "Review API", createdAt: "2026-08-31T10:00:00.000Z" },
        { id: 2, conversationId: "CHAT-0042", actor: "codex", label: "Codex", kind: "response", content: "Backend view", createdAt: "2026-08-31T10:01:00.000Z" },
        { id: 3, conversationId: "CHAT-0042", actor: "claude", label: "Claude", kind: "response", content: "Frontend view", createdAt: "2026-08-31T10:02:00.000Z" },
      ],
    });
    const publish = vi.fn(async () => undefined);
    const gateway = new SlackHubGateway({
      rootScanner: { scan: async () => { throw new Error("ingress scanner must be disabled"); } },
      threadsScanner: { scan: async () => { throw new Error("thread scanner must be disabled"); } },
      client: {
        open: vi.fn(), reply: vi.fn(), get: vi.fn(async () => current), list: vi.fn(async () => [current.conversation]),
      },
      publisher: { publish },
      stateFile: join(root, "state.json"),
      allowedAuthors: [],
      publishActors: ["claude"],
      defaults: { codexRepository: "gameengine", claudeRepository: "ccp-library-core", target: "claude", turns: 6 },
      ingress: false,
    });

    expect(await gateway.poll()).toMatchObject({ initialized: true, published: 1 });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "CHAT-0042",
      agentLabel: "Claude",
      content: "Frontend view",
      threadRootMessageId: "1788200000000010",
    }));
    expect(await gateway.poll()).toMatchObject({ published: 0 });
  });
});
