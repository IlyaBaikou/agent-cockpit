import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRequest, AgentResult } from "../src/agents/adapter.js";
import { ConversationHub } from "../src/conversations.js";
import { createHubHttpServer } from "../src/hub-server.js";
import { GitWorktreeManager } from "../src/git.js";
import { RepositoryRegistry } from "../src/repositories.js";
import { RemoteRunner } from "../src/runner.js";
import { HubStore } from "../src/store.js";
import type { AgentId } from "../src/types.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

class FakeAgent implements AgentAdapter {
  constructor(
    readonly id: AgentId,
    readonly handler: (request: AgentRequest) => Promise<string>,
  ) {}

  async healthCheck(): Promise<string> {
    return "ok";
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    return { agent: this.id, content: await this.handler(request) };
  }
}

afterEach(async () => {
  delete process.env.HUB_RUNNER_ALLOW_WRITE;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent remote runner flow", () => {
  it("restores history, hands off across two runners, and shares a written artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-runners-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    await mkdir(repositoryPath);
    await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
    await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Agent Hub Test"]);
    await execFileAsync("git", ["-C", repositoryPath, "config", "user.email", "agent-hub@example.test"]);
    await writeFile(join(repositoryPath, "README.md"), "baseline\n");
    await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
    await execFileAsync("git", ["-C", repositoryPath, "commit", "-m", "baseline"]);
    const canonicalRepositoryPath = await realpath(repositoryPath);
    const repositoriesPath = join(root, "repositories.json");
    await writeFile(repositoriesPath, JSON.stringify({ fixture: { path: repositoryPath, baseRef: "main", verify: [] } }));
    const repositories = new RepositoryRegistry(repositoriesPath);
    await repositories.load();

    const store = new HubStore(join(root, "hub.sqlite"));
    const profiles = {
      codex: { label: "Backend Codex", provider: "openai", role: "backend" },
      claude: { label: "Frontend Claude", provider: "anthropic", role: "frontend" },
    } as const;
    const conversations = new ConversationHub({ store, profiles });
    const server = createHubHttpServer({
      store,
      conversations,
      credentials: [
        { runnerId: "backend", agent: "codex", token: "backend-token-123456789" },
        { runnerId: "frontend", agent: "claude", token: "frontend-token-12345678" },
      ],
      leaseMs: 60_000,
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const runnerCheck = await fetch(new URL("/v1/runners/check", serverUrl), {
      method: "POST",
      headers: { authorization: "Bearer backend-token-123456789", "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "backend" }),
    });
    expect(runnerCheck.status).toBe(200);
    expect(await runnerCheck.json()).toMatchObject({ ok: true, runnerId: "backend", agent: "codex" });

    let codexTurn = 0;
    const codex = new FakeAgent("codex", async (request) => {
      codexTurn += 1;
      if (codexTurn === 1) {
        expect(request.repositoryPath).toBe(canonicalRepositoryPath);
        expect(request.prompt).toContain("Which endpoint supplies rewards?");
        return "The backend contract uses /rewards.\nHANDOFF: human";
      }
      expect(request.mode).toBe("write");
      await mkdir(join(request.repositoryPath, "docs"), { recursive: true });
      await writeFile(join(request.repositoryPath, "docs/gamification.md"), "# Gamification\n\nUse /rewards.\n");
      return "Updated the shared contract.\nARTIFACT: docs/gamification.md\nHANDOFF: claude";
    });
    const claude = new FakeAgent("claude", async (request) => {
      if (request.mode === "read") expect(request.repositoryPath).toBe(canonicalRepositoryPath);
      if (request.prompt.includes("Use /rewards.")) {
        return "The artifact answers the frontend contract; continuing implementation.\nHANDOFF: done";
      }
      return "Which endpoint supplies rewards?\nHANDOFF: codex";
    });
    const codexRunner = new RemoteRunner({
      serverUrl,
      runnerId: "backend",
      token: "backend-token-123456789",
      agentId: "codex",
      repositories,
      agent: codex,
      worktrees: new GitWorktreeManager(join(root, "codex-worktrees")),
      allowWrite: true,
    });
    const claudeRunner = new RemoteRunner({
      serverUrl,
      runnerId: "frontend",
      token: "frontend-token-12345678",
      agentId: "claude",
      repositories,
      agent: claude,
      worktrees: new GitWorktreeManager(join(root, "claude-worktrees")),
    });

    try {
      const opened = await conversations.open({
        topic: "Review the gamification contract",
        codexRepository: "fixture",
        claudeRepository: "fixture",
        target: "claude",
        mode: "read",
        turns: 3,
        actor: "developer",
      });
      expect(await claudeRunner.runOnce()).toBe(true);
      expect(await codexRunner.runOnce()).toBe(true);
      expect((await conversations.get(opened.conversation.id)).conversation.waitingFor).toBe("human");

      process.env.HUB_RUNNER_ALLOW_WRITE = "true";
      await conversations.reply({
        conversationId: opened.conversation.id,
        target: "codex",
        mode: "write",
        turns: 2,
        content: "Approved: update the gamification document and return it to frontend.",
        actor: "developer",
      });
      expect(await codexRunner.runOnce()).toBe(true);
      expect(await claudeRunner.runOnce()).toBe(true);

      const finished = await conversations.get(opened.conversation.id);
      expect(finished.conversation.status).toBe("completed");
      expect(finished.messages.map((message) => message.actor)).toEqual([
        "human",
        "claude",
        "codex",
        "human",
        "codex",
        "claude",
      ]);
      expect(finished.artifacts.map((artifact) => artifact.path)).toContain("docs/gamification.md");
      expect(finished.artifacts.map((artifact) => artifact.path)).toContain(`.agent-hub/${opened.conversation.id}.patch`);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      store.close();
    }
  });
});
