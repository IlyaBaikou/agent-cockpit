import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryRegistry } from "../src/repositories.js";
import { SlackDesktopCommandReader, type SlackDesktopScan } from "../src/slack/desktop-reader.js";
import { writeRepositoriesConfig } from "../src/runner-setup-core.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SlackDesktopCommandReader", () => {
  it("baselines existing messages and forwards only new allowed read-only Codex commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-slack-reader-"));
    temporaryDirectories.push(root);
    const repositoriesFile = join(root, "repositories.json");
    await writeRepositoriesConfig(repositoriesFile, [{ alias: "gameengine", path: root, baseRef: "HEAD" }]);
    const repositories = new RepositoryRegistry(repositoriesFile);
    await repositories.load();
    let scan: SlackDesktopScan = {
      channelVisible: true,
      messages: [{ id: "100", url: "url-100", author: "Pavel Pogosov", text: "@AgentHub ask codex repo=gameengine old" }],
    };
    const client = { open: vi.fn(async () => ({} as never)), reply: vi.fn(async () => ({} as never)) };
    const reader = new SlackDesktopCommandReader({
      scanner: { scan: async () => scan },
      client,
      repositories,
      stateFile: join(root, "state.json"),
      allowedAuthors: ["Pavel Pogosov"],
    });

    expect(await reader.poll()).toMatchObject({ initialized: true, accepted: 0 });
    scan = { channelVisible: true, messages: [
      ...scan.messages,
      { id: "101", url: "url-101", author: "Pavel Pogosov", text: "@AgentHub ask codex repo=gameengine explain scoring" },
      { id: "102", url: "url-102", author: "Pavel Pogosov", text: "@AgentHub ask claude repo=gameengine ignore me" },
    ] };
    expect(await reader.poll()).toMatchObject({ accepted: 1, rejected: 0 });
    expect(client.open).toHaveBeenCalledWith({
      topic: "[Slack #agent-hub-lab from Pavel Pogosov]\nexplain scoring",
      codexRepository: "gameengine",
      claudeRepository: "gameengine",
      target: "codex",
      mode: "read",
      turns: 1,
    });
    expect(await reader.poll()).toMatchObject({ accepted: 0, rejected: 0 });
  });

  it("rejects writes and unauthorized authors without retrying them forever", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-slack-reader-"));
    temporaryDirectories.push(root);
    const repositoriesFile = join(root, "repositories.json");
    await writeRepositoriesConfig(repositoriesFile, [{ alias: "gameengine", path: root, baseRef: "HEAD" }]);
    const repositories = new RepositoryRegistry(repositoriesFile);
    await repositories.load();
    let scan: SlackDesktopScan = { channelVisible: true, messages: [] };
    const client = { open: vi.fn(async () => ({} as never)), reply: vi.fn(async () => ({} as never)) };
    const reader = new SlackDesktopCommandReader({
      scanner: { scan: async () => scan }, client, repositories,
      stateFile: join(root, "state.json"), allowedAuthors: ["Pavel Pogosov"],
    });
    await reader.poll();
    scan = { channelVisible: true, messages: [
      { id: "200", url: "url-200", author: "Unknown", text: "@AgentHub ask codex repo=gameengine hi" },
      { id: "201", url: "url-201", author: "Pavel Pogosov", text: "@AgentHub open repo=gameengine to=codex mode=write change it" },
    ] };
    expect(await reader.poll()).toMatchObject({ accepted: 0, rejected: 2 });
    expect(client.open).not.toHaveBeenCalled();
    expect(await reader.poll()).toMatchObject({ accepted: 0, rejected: 0 });
  });
});
