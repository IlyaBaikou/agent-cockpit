import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationClient } from "../src/collab/client.js";
import { CollaborationService } from "../src/collab/service.js";
import { MemoryStateStore } from "../src/collab/store.js";
import { EmployeeRunner, type LocalAgent } from "../src/collab/runner.js";
import type { AgentAdapter } from "../src/agents/adapter.js";
import type { Snapshot, Space, Thread } from "../src/collab/model.js";
import { runProcess } from "../src/process.js";

const token = "test-employee-personal-token-00000000";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "employee-runner-test-"));
  const store = new MemoryStateStore(), service = new CollaborationService(store, [{ actor: "Owner", token }]);
  class Client extends CollaborationClient {
    failDeliveryOnce = false;
    override async call<T>(op: string, input: Record<string, unknown> = {}): Promise<T> {
      const result = await service.call(token, op, input);
      if (op === "complete" && this.failDeliveryOnce) { this.failDeliveryOnce = false; throw new Error("Lost response after acceptance"); }
      return result as T;
    }
  }
  const client = new Client("http://localhost", token);
  const agent: LocalAgent = { id: "test-agent", executor: "codex", name: "Test", description: "", binary: "", directory: dir, enabled: true, allowWrite: true, fallback: null };
  await client.call("agent", { ...agent, device: "test-device" });
  const space = await client.call<Space>("space", { name: "Test" });
  const post = (mode = "read") => client.call<{ thread: Thread }>("post", { space: space.id, content: `@{a:${agent.id}} Test`, mode });
  const snapshot = () => client.call<Snapshot>("sync");
  return { dir, client, agent, post, snapshot };
}
async function until(check: () => Promise<boolean>, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > timeout) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("retries delivery without executing the agent twice", async () => {
  const f = await fixture(); let runs = 0;
  const adapter: AgentAdapter = { id: "codex", healthCheck: async () => "ready", run: async () => { runs++; return { agent: "codex", content: "Answer\nROUTE: done" }; } };
  const runner = new EmployeeRunner(f.client, f.agent, "test-device", join(f.dir, "worktrees"), { check: async () => "ready", adapter: () => adapter });
  try {
    f.client.failDeliveryOnce = true; await f.post(); runner.start();
    await until(async () => (await f.snapshot()).threads[0]?.status === "resolved");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(runs).toBe(1); expect((await f.snapshot()).messages.filter((m) => m.kind === "agent")).toHaveLength(1);
  } finally { runner.stop(); await rm(f.dir, { recursive: true, force: true }); }
});

it("isolates v2 write jobs and delivers the diff without changing the original checkout", async () => {
  const f = await fixture(); let writtenPath = "";
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"]]) {
    expect((await runProcess("git", args, { cwd: f.dir })).exitCode).toBe(0);
  }
  await writeFile(join(f.dir, "contract.md"), "before\n");
  await runProcess("git", ["add", "contract.md"], { cwd: f.dir }); await runProcess("git", ["commit", "-m", "fixture"], { cwd: f.dir });
  const adapter: AgentAdapter = { id: "codex", healthCheck: async () => "ready", run: async (request) => {
    writtenPath = request.repositoryPath; expect(request.mode).toBe("write");
    await writeFile(join(writtenPath, "contract.md"), "after\n"); return { agent: "codex", content: "Changed contract\nROUTE: done" };
  } };
  const runner = new EmployeeRunner(f.client, f.agent, "test-device", join(f.dir, "worktrees"), { check: async () => "ready", adapter: () => adapter });
  try {
    await f.post("write"); runner.start(); await until(async () => ["resolved", "error"].includes((await f.snapshot()).threads[0]?.status ?? ""));
    const final = await f.snapshot(); expect(final.threads[0]?.status, JSON.stringify(final.messages)).toBe("resolved");
    expect(writtenPath).not.toBe(f.dir); expect(await readFile(join(f.dir, "contract.md"), "utf8")).toBe("before\n");
    const message = (await f.snapshot()).messages.find((m) => m.kind === "agent"); expect(message?.content).toContain("+after"); expect(message?.content).toContain("-before");
    expect((await runProcess("git", ["status", "--porcelain", "--", "contract.md"], { cwd: f.dir })).stdout).toBe("");
  } finally { runner.stop(); await rm(f.dir, { recursive: true, force: true }); }
});

it("receives a remote stop through lease renewal and aborts the running executor", async () => {
  const f = await fixture(); let aborted = false;
  const adapter: AgentAdapter = { id: "codex", healthCheck: async () => "ready", run: async (request) => new Promise((_resolve, reject) => {
    request.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("stopped")); }, { once: true });
  }) };
  const runner = new EmployeeRunner(f.client, f.agent, "test-device", join(f.dir, "worktrees"), { check: async () => "ready", adapter: () => adapter });
  try {
    const { thread } = await f.post(); runner.start(); await until(async () => (await f.snapshot()).jobs[0]?.started === true);
    await f.client.call("thread-state", { thread: thread.id, status: "paused" });
    await until(async () => aborted); expect((await f.snapshot()).jobs[0]?.status).toBe("cancelled");
    expect((await f.snapshot()).messages.filter((m) => m.kind === "agent")).toHaveLength(0);
  } finally { runner.stop(); await rm(f.dir, { recursive: true, force: true }); }
}, 10_000);

it("cancels a spawned CLI process on AbortSignal", async () => {
  const controller = new AbortController();
  const run = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal, timeoutMs: 10_000 });
  setTimeout(() => controller.abort(), 100);
  await expect(run).rejects.toThrow("stopped");
});
