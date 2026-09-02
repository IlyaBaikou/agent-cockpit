import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { newDb } from "pg-mem";
import type pg from "pg";
import { CollaborationService } from "../src/collab/service.js";
import { MemoryStateStore, PostgresStateStore, SqliteStateStore } from "../src/collab/store.js";
import { collaborationHttp } from "../src/collab/http.js";
import { CollaborationClient, hubUrl } from "../src/collab/client.js";
import { pendingNotices } from "../src/collab/notifications.js";
import type { Agent, Job, Snapshot, Space, Thread } from "../src/collab/model.js";
import { compactionPlan, type ContextPacket } from "../src/collab/context.js";

const alice = "alice-test-credential-0000000000", bob = "bob-test-credential-000000000000";
function setup() {
  let now = 1_000_000;
  const store = new MemoryStateStore();
  const service = new CollaborationService(store, [{ actor: "Alice", token: alice }, { actor: "Bob", token: bob }], () => now);
  const call = <T = any>(op: string, body: Record<string, unknown> = {}, token = alice): Promise<T> => service.call(token, op, body) as Promise<T>;
  const agent = async (name: string, token = alice, extra: Record<string, unknown> = {}): Promise<Agent> => {
    const a = await call<Agent>("agent", { name, executor: "codex", device: token === alice ? "device-a" : "device-b", enabled: true, ...extra }, token);
    await call("heartbeat", { agent: a.id, device: a.device, ready: true }, token); return a;
  };
  const space = (members = ["Bob"]): Promise<Space> => call("space", { name: "Integration", members });
  const post = (space: Space, target?: Agent, extra = {}): Promise<{ thread: Thread; message: unknown }> => call("post", { space: space.id, content: target ? `Please review @{a:${target.id}}` : "Hello people", ...extra });
  const claim = (a: Agent, token = alice): Promise<{ job: Job; prompt: string }> => call("claim", { agent: a.id, device: a.device }, token);
  const complete = (a: Agent, job: Job, content = "Answer\nROUTE: done", token = alice): Promise<unknown> => call("complete", { job: job.id, lease: job.lease, device: a.device, content }, token);
  return { store, service, call, agent, space, post, claim, complete, advance: (ms: number) => { now += ms; } };
}

describe("employee-owned agents and shared spaces", () => {
  it("does not invoke models for ordinary chat or human mentions", async () => {
    const h = setup(), space = await h.space(); await h.agent("Reviewer");
    await h.post(space); await h.call("post", { space: space.id, content: "Question for @{u:Bob}" });
    const s = await h.call<Snapshot>("sync", {}, bob);
    expect(s.jobs).toHaveLength(0); expect(s.threads).toHaveLength(0); expect(s.notices.at(-1)?.title).toContain("Alice");
  });
  it("routes two same-provider agents by distinct owner identity, not provider", async () => {
    const h = setup(), a = await h.agent("Backend"), b = await h.agent("Frontend", bob), space = await h.space();
    const posted = await h.post(space, a); const first = await h.claim(a);
    expect((await h.claim(b, bob)).job).toBeNull();
    await h.complete(a, first.job, `Question for frontend\nROUTE: agent:${b.id}`);
    const second = await h.claim(b, bob); expect(second.job.thread).toBe(posted.thread.id);
    expect(second.prompt).toContain("Question for frontend"); expect(second.prompt).toContain("Please review");
    await h.complete(b, second.job, "Agreed\nROUTE: done", bob);
    const s = await h.call<Snapshot>("sync"); expect(s.threads[0]?.status).toBe("resolved");
    expect(s.messages.filter((m) => m.kind === "agent").map((m) => m.author)).toEqual([a.id, b.id]);
  });
  it("keeps private spaces private and disallows outsiders in mentions", async () => {
    const h = setup(), space = await h.space([]), b = await h.agent("Foreign", bob);
    expect((await h.call<Snapshot>("sync", {}, bob)).spaces).toHaveLength(0);
    await expect(h.call("post", { space: space.id, content: "Intrusion" }, bob)).rejects.toThrow("Спейс недоступен");
    await expect(h.post(space, b)).rejects.toThrow("не входит");
    await expect(h.call("post", { space: space.id, content: "@{u:Bob}" })).rejects.toThrow("не входит");
  });
  it("checks owner and device on registration, claim and completion", async () => {
    const h = setup(), a = await h.agent("A"), space = await h.space(); await h.post(space, a);
    await expect(h.call("agent", { ...a, name: "Hijacked" }, bob)).rejects.toThrow("чужого");
    await expect(h.claim(a, bob)).rejects.toThrow("не принадлежит");
    await expect(h.call("claim", { agent: a.id, device: "other" })).rejects.toThrow("не принадлежит");
    const { job } = await h.claim(a);
    await expect(h.call("complete", { job: job.id, device: a.device, lease: "wrong", content: "spoof" })).rejects.toThrow("аренда");
  });
  it("serializes duplicate claims and idempotent post/complete delivery", async () => {
    const h = setup(), a = await h.agent("A"), space = await h.space();
    const body = { space: space.id, content: `@{a:${a.id}} review`, requestId: "same-post" };
    await Promise.all([h.call("post", body), h.call("post", body)]);
    const claims = await Promise.all([h.claim(a), h.claim(a)]); expect(claims.filter((c) => c.job)).toHaveLength(1);
    const job = claims.find((c) => c.job)!.job;
    await h.complete(a, job); await h.complete(a, job);
    const s = await h.call<Snapshot>("sync"); expect(s.threads).toHaveLength(1); expect(s.messages.filter((m) => m.kind === "agent")).toHaveLength(1);
  });
  it("stops the automatic chain when a person adds new information mid-run", async () => {
    const h = setup(), a = await h.agent("A"), b = await h.agent("B"), space = await h.space();
    const { thread } = await h.post(space, a); const { job } = await h.claim(a);
    await h.call("post", { space: space.id, thread: thread.id, content: "New constraints" });
    await h.complete(a, job, `Old answer\nROUTE: agent:${b.id}`);
    const s = await h.call<Snapshot>("sync"); expect(s.threads[0]?.status).toBe("waiting"); expect(s.jobs).toHaveLength(1);
  });
  it("requests a human decision then continues with full context", async () => {
    const h = setup(), a = await h.agent("A"), space = await h.space();
    const { thread } = await h.post(space, a); const first = await h.claim(a);
    await h.complete(a, first.job, "Approve contract?\nROUTE: human:Bob");
    const waiting = await h.call<Snapshot>("sync", {}, bob); expect(waiting.threads[0]?.status).toBe("waiting"); expect(waiting.notices.at(-1)?.title).toBe("Нужно ваше решение");
    await h.call("post", { space: space.id, thread: thread.id, content: `Approved @{a:${a.id}}` }, bob);
    const next = await h.claim(a); expect(next.prompt).toContain("Approved"); expect(next.prompt).toContain("Approve contract?");
  });
  it("rejects broad multi-agent broadcasts in the pilot", async () => {
    const h = setup(), a = await h.agent("A"), b = await h.agent("B"), space = await h.space();
    await expect(h.call("post", { space: space.id, content: `@{a:${a.id}} @{a:${b.id}}` })).rejects.toThrow("одного агента");
  });
  it("makes an unconfigured/invalid handoff visible instead of silently dropping it", async () => {
    const h = setup(), a = await h.agent("A"), space = await h.space(); await h.post(space, a); const { job } = await h.claim(a);
    await h.complete(a, job, "Question\nROUTE: agent:missing"); expect((await h.call<Snapshot>("sync")).threads[0]?.status).toBe("error");
  });
  it("limits a ping-pong chain to 12 answers", async () => {
    const h = setup(), a = await h.agent("A"), b = await h.agent("B"), space = await h.space(); await h.post(space, a);
    for (let index = 0; index < 12; index++) { const active = index % 2 ? b : a, next = index % 2 ? a : b; const { job } = await h.claim(active); await h.complete(active, job, `Question ${index}\nROUTE: agent:${next.id}`); }
    const s = await h.call<Snapshot>("sync"); expect(s.jobs).toHaveLength(12); expect(s.threads[0]?.status).toBe("waiting");
  });
});

describe("fallbacks, leases and write boundaries", () => {
  it("uses a configured fallback on unavailability", async () => {
    const h = setup(), b = await h.agent("Backup"), a = await h.agent("Primary", alice, { fallback: b.id }), space = await h.space();
    await h.post(space, a); await h.call("heartbeat", { agent: a.id, device: a.device, ready: false, detail: "CLI unavailable" });
    const job = await h.claim(b); expect(job.job.agent).toBe(b.id); expect(job.prompt).toContain("CLI unavailable");
  });
  it("prevents fallback cycles and cross-owner escalation", async () => {
    const h = setup(), b = await h.agent("B"), a = await h.agent("A", alice, { fallback: b.id }), foreign = await h.agent("Foreign", bob);
    await expect(h.call("agent", { ...b, fallback: a.id })).rejects.toThrow("Цикл");
    await expect(h.call("agent", { ...a, fallback: foreign.id })).rejects.toThrow("принадлежать вам");
  });
  it("shows an error when no fallback can answer", async () => {
    const h = setup(), a = await h.agent("A"), space = await h.space(); await h.post(space, a); const { job } = await h.claim(a);
    await h.complete(a, job, "Cannot process\nROUTE: unable");
    const s = await h.call<Snapshot>("sync"); expect(s.threads[0]?.status).toBe("error"); expect(s.notices.at(-1)?.title).toBe("Агент не смог продолжить");
  });
  it("does not auto-retry possibly started writes, even on lease expiry", async () => {
    const h = setup(), b = await h.agent("Backup", alice, { allowWrite: true }), a = await h.agent("Writer", alice, { allowWrite: true, fallback: b.id }), space = await h.space();
    await h.post(space, a, { mode: "write" }); const { job } = await h.claim(a);
    await h.call("lease", { job: job.id, lease: job.lease, device: a.device, started: true }); h.advance(91_000);
    const s = await h.call<Snapshot>("sync"); expect(s.jobs).toHaveLength(1); expect(s.threads[0]?.status).toBe("error");
    expect(s.messages.at(-1)?.content).toContain("Изменения могли");
  });
  it("allows fallback before write execution starts", async () => {
    const h = setup(), b = await h.agent("Backup", alice, { allowWrite: true }), a = await h.agent("Writer", alice, { allowWrite: true, fallback: b.id }), space = await h.space();
    await h.post(space, a, { mode: "write" }); const { job } = await h.claim(a);
    await h.call("fail", { job: job.id, lease: job.lease, device: a.device, error: "Preflight failed" });
    expect((await h.claim(b)).job.mode).toBe("write");
  });
  it("does not let a coworker authorize another employee's writes", async () => {
    const h = setup(), a = await h.agent("Writer", bob, { allowWrite: true }), space = await h.space(); await h.post(space, a, { mode: "write" });
    const s = await h.call<Snapshot>("sync", {}, bob); expect(s.jobs).toHaveLength(0); expect(s.threads[0]?.status).toBe("waiting"); expect(s.notices.at(-1)?.title).toBe("Нужно ваше решение");
  });
  it("never propagates write authorization along an agent handoff", async () => {
    const h = setup(), a = await h.agent("Writer", alice, { allowWrite: true }), b = await h.agent("Peer", bob, { allowWrite: true }), space = await h.space(); await h.post(space, a, { mode: "write" }); const { job } = await h.claim(a);
    await h.complete(a, job, `Review diff\nROUTE: agent:${b.id}`); expect((await h.claim(b, bob)).job.mode).toBe("read");
  });
  it("cancels work on stop or membership removal and rejects a late answer", async () => {
    const h = setup(), a = await h.agent("A", bob), space = await h.space(); await h.post(space, a); const { job } = await h.claim(a, bob);
    await h.call("members", { space: space.id, members: [] });
    expect(await h.call("lease", { job: job.id, lease: job.lease, device: a.device }, bob)).toEqual({ cancelled: true });
    await expect(h.complete(a, job, "late\nROUTE: done", bob)).rejects.toThrow("остановлено");
    expect((await h.call<Snapshot>("sync", {}, bob)).messages).toHaveLength(0);
  });
  it("does not persist failed transactions", async () => {
    const h = setup(), space = await h.space();
    await expect(h.call("post", { space: space.id, content: "@{a:unknown}" })).rejects.toThrow();
    expect((await h.call<Snapshot>("sync")).messages).toHaveLength(0);
  });
});

describe("shared thread context", () => {
  async function history(h: ReturnType<typeof setup>, thread: Thread, space: Space) {
    await h.store.transact((s) => {
      for (let i = 0; i < 24; i++) s.messages.push({ id: `context-${i}`, space: space.id, thread: thread.id,
        author: "Alice", kind: i === 23 ? "human" : "agent", content: i === 23 ? "Latest instruction: no writes."
          : `Proposed contract ${i}: ${"evidence ".repeat(220)}`, createdAt: i });
    });
  }
  it("shares a validated checkpoint across providers without deleting history or leaking to outsiders", async () => {
    const h = setup(), a = await h.agent("A"), b = await h.agent("B", alice, { executor: "claude" }), space = await h.space([]);
    const { thread } = await h.post(space, a); await history(h, thread, space);
    const first = await h.call<{ job: Job; context: ContextPacket; prompt: string }>("claim", { agent: a.id, device: a.device, contextVersion: 1 });
    expect(first.prompt).not.toContain("Proposed contract"); expect(first.context.messages.length).toBeGreaterThan(24);
    const plan = compactionPlan(first.context)!;
    const memory = { through: plan.through, sourceHash: plan.sourceHash, summary: "Contract proposal remains unapproved.", citations: [plan.ids[0]] };
    const complete = { job: first.job.id, lease: first.job.lease, device: a.device, content: `Review\nROUTE: agent:${b.id}`, memory };
    await h.call("complete", complete); await h.call("complete", complete);
    const next = await h.call<{ context: ContextPacket }>("claim", { agent: b.id, device: b.device, contextVersion: 1 });
    expect(next.context.memory?.summary).toBe(memory.summary);
    expect(next.context.messages.some((m) => m.content.includes("Proposed contract 0"))).toBe(true);
    const s = await h.call<Snapshot>("sync"); expect(s.threads[0]?.memory?.agent).toBe(a.id);
    expect((await h.call<Snapshot>("sync", {}, bob)).threads).toHaveLength(0);
  });
  it("does not accept a checkpoint from a stale, stopped or forged job", async () => {
    const h = setup(), a = await h.agent("A"), space = await h.space();
    const { thread } = await h.post(space, a); await history(h, thread, space);
    const { job, context } = await h.call<{ job: Job; context: ContextPacket }>("claim", { agent: a.id, device: a.device, contextVersion: 1 });
    const plan = compactionPlan(context)!;
    await h.call("post", { space: space.id, thread: thread.id, content: "Correction: new constraints" });
    expect(await h.call("lease", { job: job.id, lease: job.lease, device: a.device, contextRevision: job.revision })).toEqual({ cancelled: true });
    await h.call("complete", { job: job.id, lease: job.lease, device: a.device, content: "Old answer\nROUTE: done",
      memory: { through: plan.through, sourceHash: plan.sourceHash, summary: "Old summary", citations: [plan.ids[0]] } });
    const s = await h.call<Snapshot>("sync"); expect(s.threads[0]?.memory).toBeUndefined(); expect(s.threads[0]?.status).toBe("waiting");
  });
  it("backs off failed compaction instead of paying for it on every handoff", async () => {
    const h = setup(), a = await h.agent("A"), b = await h.agent("B"), space = await h.space();
    const { thread } = await h.post(space, a); await history(h, thread, space);
    const { job } = await h.call<{ job: Job }>("claim", { agent: a.id, device: a.device, contextVersion: 1 });
    await h.call("complete", { job: job.id, lease: job.lease, device: a.device, content: `Next\nROUTE: agent:${b.id}`,
      memory: { summary: "Forged", through: "other-thread", sourceHash: "bad", citations: [] },
      contextStats: { historyChars: 40000, promptChars: 20000, summaryInputChars: 30000, summaryOutputChars: 0, memoryReused: false, compacted: false } });
    const next = await h.call<{ context: ContextPacket }>("claim", { agent: b.id, device: b.device, contextVersion: 1 });
    expect(next.context.memory).toBeUndefined(); expect(next.context.skipCompaction).toBe(true); expect(compactionPlan(next.context)).toBeUndefined();
  });
  it("allows upgraded runners to retrieve long threads but keeps the legacy guard", async () => {
    const h = setup(), a = await h.agent("A"), space = await h.space(); const { thread } = await h.post(space, a);
    await h.store.transact((s) => { s.messages.push({ id: "large", space: space.id, thread: thread.id, kind: "agent", author: a.id, content: "x".repeat(220000), createdAt: 1 }); });
    await expect(h.claim(a)).rejects.toThrow("Обновите приложение");
    const next = await h.call<{ context: ContextPacket; prompt: string }>("claim", { agent: a.id, device: a.device, contextVersion: 1 });
    expect(next.context.messages.at(-1)?.content.length).toBe(220000); expect(next.prompt.length).toBeLessThan(5000);
  });
});

describe("enrollment, persistence, HTTP and notifications", () => {
  it("exchanges single-use expiring invitations without exposing credentials", async () => {
    const h = setup(); const invite = await h.call<{ code: string }>("invite", { name: "New colleague" });
    const joined = await h.service.enroll(invite.code); expect((await h.call<Snapshot>("sync", {}, joined.token)).me.name).toBe("New colleague");
    await expect(h.service.enroll(invite.code)).rejects.toThrow("уже использовано");
    const serialized = JSON.stringify(await h.call("sync")); expect(serialized).not.toContain(invite.code); expect(serialized).not.toContain(joined.token); expect(serialized).not.toContain("credentials");
    const expired = await h.call<{ code: string }>("invite", { name: "Late colleague" }); h.advance(49 * 3600_000);
    await expect(h.service.enroll(expired.code)).rejects.toThrow("истекло");
  });
  it("rejects unauthenticated access", async () => { await expect(setup().call("sync", {}, "bad")).rejects.toThrow("Нет доступа"); });
  it("does not rewrite or increment persistent state on idle syncs/claims", async () => {
    const h = setup(), a = await h.agent("A");
    const first = await h.call<Snapshot>("sync"); await h.claim(a); const second = await h.call<Snapshot>("sync");
    expect(second.revision).toBe(first.revision);
  });
  it("deduplicates notifications and does not replay all history on first login", () => {
    const n = { seq: 2, employee: "Alice", title: "Answer", body: "", space: "sp", thread: "th" };
    expect(pendingNotices([n], null, 2).pending).toHaveLength(0);
    expect(pendingNotices([n], 1, 2).pending).toEqual([n]);
    expect(pendingNotices([n], 2, 2).pending).toHaveLength(0);
  });
  it("persists SQLite state across restarts and rolls back on error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenthub-state-test-"));
    try {
      const path = join(dir, "state.sqlite"), first = new SqliteStateStore(path);
      await first.transact((s) => { s.employees.push({ id: "a", name: "Alice" }); });
      await expect(first.transact((s) => { s.employees.length = 0; throw new Error("rollback"); })).rejects.toThrow(); await first.close();
      const second = new SqliteStateStore(path); expect(await second.transact((s) => s.employees)).toHaveLength(1); await second.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("migrates and persists PostgreSQL state independently of v1", async () => {
    // pg-mem skips the second CREATE IF NOT EXISTS but reports its constraints as
    // unconsumed AST. Real PostgreSQL accepts the idempotent migration as written.
    const mem = newDb({ noAstCoverageCheck: true }), adapter = mem.adapters.createPg();
    const store = new PostgresStateStore(new adapter.Pool() as unknown as pg.Pool); await store.migrate(); await store.migrate();
    const service = new CollaborationService(store, [{ actor: "Alice", token: alice }]);
    await service.call(alice, "space", { name: "PG Space" });
    expect((await service.call(alice, "sync") as Snapshot).spaces[0]?.name).toBe("PG Space"); await store.close();
  });
  let server: Server | undefined;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; });
  it("serves the authenticated v2 API and rejects malformed and cross-origin input", async () => {
    const h = setup(); server = createServer((req, res) => void collaborationHttp(h.service, req, res));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}`, client = new CollaborationClient(url, alice);
    expect((await client.call<Snapshot>("sync")).me.id).toBe("Alice");
    const bad = await fetch(`${url}/v2/rpc`, { method: "POST", body: "[" }); expect(bad.status).toBe(400);
    const cors = await fetch(`${url}/v2/rpc`, { method: "POST", headers: { Origin: "https://evil.test" }, body: "{}" }); expect(cors.status).toBe(403);
    await expect(new CollaborationClient(url, "bad").call("sync")).rejects.toThrow("Нет доступа");
    expect(() => hubUrl("http://public.example")).toThrow("HTTPS"); expect(() => hubUrl("https://user:password@example.com")).toThrow();
  });
});
