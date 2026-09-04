import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import type pg from "pg";
import { CollaborationService } from "../src/collab/service.js";
import { MemoryStateStore, PostgresStateStore, SqliteStateStore, type StateStore } from "../src/collab/store.js";
import { CollaborationClient } from "../src/collab/client.js";
import { EmployeeRunner, type LocalAgent } from "../src/collab/runner.js";
import { agentFailure } from "../src/agents/diagnostics.js";
import type { Agent, Job, Message, Snapshot, Space, Thread } from "../src/collab/model.js";

const adminToken = "operator-test-token-long";
async function fixture(store: StateStore = new MemoryStateStore()) {
  let now = Date.now();
  const service = new CollaborationService(store, [{ actor: "operator", token: adminToken }], () => now);
  const call = <T>(token: string, op: string, input: Record<string, unknown> = {}) => service.call(token, op, input) as Promise<T>;
  const enroll = async (name: string) => {
    const { code } = await call<{ code: string }>(adminToken, "invite", { name }); return service.enroll(code);
  };
  const owner = await enroll("Owner"), peer = await enroll("Peer"), outsider = await enroll("Outsider");
  const space = await call<Space>(owner.token, "space", { name: "Test", members: [owner.employee, peer.employee, "operator"] });
  const agent = await call<Agent>(owner.token, "agent", { id: "claude-agent", name: "Reviewer", executor: "claude", device: "device", enabled: true, allowWrite: true });
  await call(owner.token, "heartbeat", { agent: agent.id, device: "device", ready: true });
  const post = (requestId = "post-1", mode = "read") => call<{ thread: Thread; message: Message }>(owner.token, "post", { space: space.id, content: `@{a:${agent.id}} review`, requestId, mode });
  const claim = () => call<{ job: Job }>(owner.token, "claim", { agent: agent.id, device: "device" });
  const snapshot = (token = owner.token) => call<Snapshot>(token, "sync", { channelVersion: 1 });
  const report = () => agentFailure({ provider: "claude", stage: "response", result: { stdout: "local private error detail", stderr: "token=never-publish-this", exitCode: 1 } }).diagnostic;
  return { store, service, call, owner, peer, outsider, agent, space, post, claim, snapshot, report, advance: (ms: number) => { now += ms; } };
}
it("stores a sanitized report; owner and configured operator can inspect it but peers cannot", async () => {
  const f = await fixture(); await f.post(); const { job } = await f.claim();
  await f.call(f.owner.token, "fail", { job: job.id, lease: job.lease, device: "device", error: "do not publish provider text", diagnostic: { ...f.report(), summary: "do not publish", prompt: "do not store" } });
  const owner = await f.snapshot(), peer = await f.snapshot(f.peer.token), operator = await f.snapshot(adminToken), outsider = await f.snapshot(f.outsider.token);
  expect(owner.jobs[0]!.diagnostic!.stdout).toBe("local private error detail");
  expect(operator.jobs[0]!.diagnostic).toEqual(owner.jobs[0]!.diagnostic);
  expect(peer.jobs[0]!.diagnostic).toBeUndefined(); expect(outsider.jobs).toHaveLength(0);
  expect(owner.messages.at(-1)!.diagnosticJob).toBe(job.id);
  expect(JSON.stringify(owner.messages)).not.toMatch(/local private error|never-publish|do not publish/);
  expect(JSON.stringify(peer)).not.toMatch(/local private error|never-publish|do not store/);
  expect(await f.store.read((s) => JSON.stringify(s))).not.toMatch(/never-publish|do not store/);
  // Repeated fail cannot replace the report or create another fallback/message.
  await f.call(f.owner.token, "fail", { job: job.id, lease: job.lease, device: "device", diagnostic: { ...f.report(), stdout: "overwrite" } });
  expect((await f.snapshot()).messages).toHaveLength(owner.messages.length);
  expect((await f.snapshot()).jobs[0]!.diagnostic!.stdout).not.toBe("overwrite");
});
it("prevents another owner from attaching a report to the job", async () => {
  const f = await fixture(); await f.post(); const { job } = await f.claim();
  await expect(f.call(f.peer.token, "fail", { job: job.id, lease: job.lease, device: "device", diagnostic: f.report() })).rejects.toThrow();
  expect((await f.snapshot()).jobs[0]!.diagnostic).toBeUndefined();
});
it("keeps errors visible for old clients and hides expired details without deleting conversation history", async () => {
  const f = await fixture(); await f.post(); const { job } = await f.claim();
  await f.call(f.owner.token, "fail", { job: job.id, lease: job.lease, device: "device", diagnostic: f.report() });
  const old = await f.call<Snapshot>(f.peer.token, "sync"); expect(old.messages.at(-1)!.content).toContain("CLI не смог");
  f.advance(15 * 86400_000);
  expect((await f.snapshot()).jobs[0]!.diagnostic).toBeUndefined();
  await f.call(f.owner.token, "heartbeat", { agent: f.agent.id, device: "device", ready: true });
  expect(await f.store.read((s) => s.jobs[0]!.diagnostic)).toBeUndefined();
  expect((await f.snapshot()).messages).toHaveLength(old.messages.length);
});
it("attaches readiness diagnostics to queued failures without exposing local details to peers", async () => {
  const f = await fixture(); await f.post();
  await f.call(f.owner.token, "heartbeat", { agent: f.agent.id, device: "device", ready: false, diagnostic: f.report() });
  expect((await f.snapshot()).jobs[0]!.diagnostic).toBeDefined();
  expect((await f.snapshot()).agents[0]!.diagnostic).toBeDefined();
  expect((await f.snapshot(f.peer.token)).agents[0]!.diagnostic).toBeUndefined();
});
it("retains only the newest 200 detailed reports", async () => {
  const f = await fixture(); await f.post(); const { job } = await f.claim();
  await f.store.transact((s) => { for (let i = 0; i < 205; i++) s.jobs.push({ ...job, id: `old-${i}`, status: "error", diagnostic: { ...f.report(), at: Date.now() - 10_000 + i } }); });
  await f.call(f.owner.token, "fail", { job: job.id, lease: job.lease, device: "device", diagnostic: f.report() });
  expect(await f.store.read((s) => s.jobs.filter((j) => j.diagnostic).length)).toBe(200);
  expect(await f.store.read((s) => s.jobs.length)).toBe(206);
});
it("deduplicates posts and agent launches even after the RPC cache has been evicted", async () => {
  const f = await fixture(); const first = await f.post();
  await f.store.transact((s) => { s.requests = []; });
  const repeated = await f.post();
  expect(repeated.message.id).toBe(first.message.id); expect(repeated.thread.id).toBe(first.thread.id);
  expect((await f.snapshot()).jobs).toHaveLength(1);
  expect((await f.snapshot()).messages.filter((m) => m.kind === "human")).toHaveLength(1);
});
it.each(["sqlite", "postgres"])("persists diagnostics and receipts in %s", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-store-"));
  let store: StateStore;
  if (kind === "sqlite") store = new SqliteStateStore(join(root, "test.db"));
  else { const Pg = newDb().adapters.createPg(); const pgStore = new PostgresStateStore(new Pg.Pool() as unknown as pg.Pool); await pgStore.migrate(); store = pgStore; }
  try {
    const f = await fixture(store); await f.post(); const { job } = await f.claim();
    await f.call(f.owner.token, "fail", { job: job.id, lease: job.lease, device: "device", diagnostic: f.report() });
    const restarted = new CollaborationService(store, [{ actor: "operator", token: adminToken }]);
    const snapshot = await restarted.call(f.owner.token, "sync", { channelVersion: 1 }) as Snapshot;
    expect(snapshot.jobs[0]!.diagnostic!.exitCode).toBe(1);
    expect(snapshot.messages.find((m) => m.kind === "human")!.clientRequestId).toBe("post-1");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
it("delivers the real runner diagnostic to the coordinator, including app version, without retrying execution", async () => {
  const f = await fixture(); await f.post(); let runs = 0;
  class Client extends CollaborationClient {
    override async call<T>(op: string, input: Record<string, unknown> = {}): Promise<T> { return f.call<T>(f.owner.token, op, input); }
  }
  const agent: LocalAgent = { ...f.agent, directory: tmpdir(), binary: "fake", description: "" };
  const runner = new EmployeeRunner(new Client("http://localhost", f.owner.token), agent, "device", tmpdir(), {
    check: async () => "ready", adapter: () => ({ id: "claude", healthCheck: async () => "ready", run: async () => { runs++; throw agentFailure({ provider: "claude", stage: "response", result: { stdout: "", stderr: "ECONNRESET", exitCode: 0 } }); } }),
  }, "0.2.6-test");
  try {
    runner.start();
    for (let i = 0; i < 100 && (await f.snapshot()).jobs[0]!.status !== "error"; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await f.snapshot()).jobs[0]!.diagnostic).toMatchObject({ code: "network", appVersion: "0.2.6-test", exitCode: 0 }); expect(runs).toBe(1);
  } finally { runner.stop(); }
});
