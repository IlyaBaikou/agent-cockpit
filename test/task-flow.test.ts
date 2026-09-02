import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRequest, AgentResult } from "../src/agents/adapter.js";
import { GitWorktreeManager } from "../src/git.js";
import { RepositoryRegistry } from "../src/repositories.js";
import { HubStore } from "../src/store.js";
import { parseReviewDecision, TaskFlow } from "../src/task-flow.js";
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
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createApprovalFixture(approvalLeaseMs = 120_000): Promise<{
  flow: TaskFlow;
  store: HubStore;
  repositories: RepositoryRegistry;
  git: GitWorktreeManager;
  repositoryPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-hub-approval-"));
  temporaryDirectories.push(root);
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath);
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Agent Hub Test"]);
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.email", "agent-hub@example.test"]);
  await writeFile(join(repositoryPath, "README.md"), "baseline\n");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "commit", "-m", "baseline"]);
  const configPath = join(root, "repositories.json");
  await writeFile(configPath, JSON.stringify({ fixture: { path: repositoryPath, baseRef: "main", verify: [] } }));
  const repositories = new RepositoryRegistry(configPath);
  await repositories.load();
  const store = new HubStore(join(root, "hub.sqlite"));
  const git = new GitWorktreeManager(join(root, "worktrees"));
  const idleAgent = (id: AgentId): FakeAgent => new FakeAgent(id, async () => "unused");
  const flow = new TaskFlow({
    agents: { codex: idleAgent("codex"), claude: idleAgent("claude") },
    profiles: {
      codex: { label: "Codex", provider: "openai", role: "test" },
      claude: { label: "Claude", provider: "anthropic", role: "test" },
    },
    store,
    repositories,
    git,
    approvalLeaseMs,
  });
  return { flow, store, repositories, git, repositoryPath };
}

describe("TaskFlow", () => {
  it("runs propose through commit in an isolated worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-task-flow-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    await mkdir(repositoryPath);
    await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
    await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Agent Hub Test"]);
    await execFileAsync("git", ["-C", repositoryPath, "config", "user.email", "agent-hub@example.test"]);
    await writeFile(join(repositoryPath, "README.md"), "baseline\n");
    await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
    await execFileAsync("git", ["-C", repositoryPath, "commit", "-m", "baseline"]);

    const configPath = join(root, "repositories.json");
    await writeFile(
      configPath,
      JSON.stringify({
        fixture: {
          path: repositoryPath,
          baseRef: "main",
          verify: [{ command: "node", args: ["-e", "process.exit(0)"] }],
        },
      }),
    );
    const repositories = new RepositoryRegistry(configPath);
    await repositories.load();
    const store = new HubStore(join(root, "hub.sqlite"));
    const codex = new FakeAgent("codex", async (request) => {
      expect(request.mode).toBe("write");
      await writeFile(join(request.repositoryPath, "feature.txt"), "implemented\n");
      return "Implemented feature.txt";
    });
    const claude = new FakeAgent("claude", async (request) => {
      expect(request.mode).toBe("read");
      expect(request.prompt).toContain("feature.txt");
      return "Looks correct.\nDECISION: APPROVE";
    });
    const flow = new TaskFlow({
      agents: { codex, claude },
      profiles: {
        codex: { label: "Codex", provider: "openai", role: "implementation" },
        claude: { label: "Claude", provider: "anthropic", role: "review" },
      },
      store,
      repositories,
      git: new GitWorktreeManager(join(root, "worktrees")),
    });

    try {
      const proposed = flow.propose({ repository: "fixture", goal: "Add feature", owner: "codex", actor: "test" });
      expect(proposed.status).toBe("proposed");
      const approved = await flow.approve(proposed.id, "test");
      expect(approved.status).toBe("approved");
      expect(approved.worktreePath).not.toBe(repositoryPath);
      expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("baseline\n");
      expect((await flow.implement(proposed.id, "test")).status).toBe("implemented");
      expect((await flow.review(proposed.id, "test")).status).toBe("ready_to_commit");
      const committed = await flow.commit(proposed.id, "test");
      expect(committed.status).toBe("committed");
      expect(committed.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(await readFile(join(approved.worktreePath!, "feature.txt"), "utf8")).toBe("implemented\n");
    } finally {
      store.close();
    }
  });

  it("allows only one of two concurrent approvals to own the task", async () => {
    const fixture = await createApprovalFixture();
    try {
      const task = fixture.flow.propose({ repository: "fixture", goal: "Concurrent approval", owner: "codex", actor: "test" });
      const results = await Promise.allSettled([
        fixture.flow.approve(task.id, "developer-a"),
        fixture.flow.approve(task.id, "developer-b"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(fixture.flow.get(task.id).status).toBe("approved");
      const { stdout } = await execFileAsync("git", ["-C", fixture.repositoryPath, "worktree", "list", "--porcelain"]);
      expect(stdout.match(/^worktree /gm)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });

  it("recovers a stale approval after the Git worktree was already created", async () => {
    const fixture = await createApprovalFixture(0);
    try {
      const task = fixture.flow.propose({ repository: "fixture", goal: "Crash recovery", owner: "codex", actor: "test" });
      fixture.store.transitionTask(task.id, ["proposed"], "approving");
      const created = await fixture.git.create(task.id, fixture.repositories.get("fixture"), task.baseRef);

      const recovered = await fixture.flow.approve(task.id, "recovery-operator");
      expect(recovered.status).toBe("approved");
      expect(recovered.branchName).toBe(created.branchName);
      expect(recovered.worktreePath).toBe(created.path);
      const { stdout } = await execFileAsync("git", ["-C", fixture.repositoryPath, "worktree", "list", "--porcelain"]);
      expect(stdout.match(/^worktree /gm)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  });
});

describe("parseReviewDecision", () => {
  it("uses the final explicit decision and defaults safely", () => {
    expect(parseReviewDecision("DECISION: CHANGES_REQUESTED\nfixed\nDECISION: APPROVE")).toBe("approve");
    expect(parseReviewDecision("looks fine but no marker")).toBe("changes_requested");
  });
});
