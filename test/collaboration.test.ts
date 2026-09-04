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
import type { Agent, Job, LiveEvent, Snapshot, Space, Thread } from "../src/collab/model.js";
import { decodeInvitation, encodeInvitation } from "../src/collab/invitations.js";
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
  const approve = async (a: Agent, token = alice) => {
    const s = await call<Snapshot>("sync", { channelVersion: 1 }, token), p = s.participations?.find((p) => p.agent === a.id && p.status === "pending");
    if (p) await call("participation", { id: p.id, revision: p.revision, threadRevision: s.threads.find((t) => t.id === p.thread)!.revision, action: "allow", runs: 3 }, token);
  };
  return { store, service, call, agent, space, post, claim, complete, approve, advance: (ms: number) => { now += ms; } };
}

describe("employee-owned agents and shared spaces", () => {
  it("tags and notifies human recipients once, even if they also follow the thread", async () => {
    const h = setup(), a = await h.agent("A"), space = await h.space();
    const { thread } = await h.post(space, a); const first = await h.claim(a);
    expect(first.prompt).toContain("mention @{u:Bob}"); expect(first.prompt).toContain(`Your agent ID is ${a.id}`);
    await h.call("thread-subscription", { thread: thread.id, following: true }, bob);
    const before = (await h.call<Snapshot>("sync", {}, bob)).sequence;
    await h.complete(a, first.job, "Approve?\nROUTE: human:Bob");
    await h.complete(a, first.job, "Approve?\nROUTE: human:Bob");
    const s = await h.call<Snapshot>("sync", {}, bob), reply = s.messages.find((m) => m.kind === "agent")!;
    expect(reply.content).toBe("@{u:Bob}\n\nApprove?");
    expect(s.notices.filter((n) => n.seq > before)).toEqual([expect.objectContaining({ employee: "Bob", event: reply.id, title: "Нужно ваше решение" })]);
    await h.post(space, a, { thread: thread.id }); const next = await h.claim(a);
    const previous = (await h.call<Snapshot>("sync")).sequence;
    await h.complete(a, next.job);
    const final = await h.call<Snapshot>("sync");
    expect(final.messages.filter((m) => m.kind === "agent").at(-1)?.content).toBe("@{u:Alice}\n\nAnswer");
    expect(final.notices.filter((n) => n.seq > previous)).toHaveLength(1);
  });
  it("runs a mention-only peer handoff once after consent, in the same thread, with shared context", async () => {
    const h = setup(), a = await h.agent("A"), b = await h.agent("B", bob), space = await h.space();
    const { thread } = await h.post(space, a); const first = await h.claim(a);
    await h.complete(a, first.job, `@{a:${b.id}} Review the contract?`);
    await h.complete(a, first.job, `@{a:${b.id}} Review the contract?`);
    expect((await h.claim(b, bob)).job).toBeNull();
    const waiting = await h.call<Snapshot>("sync", {}, bob);
    expect(waiting.jobs).toHaveLength(1); expect(waiting.participations).toHaveLength(1);
    expect(waiting.notices.filter((n) => n.title === "Разрешить участие агента?")).toHaveLength(1);
    await h.approve(b, bob); const second = await h.claim(b, bob);
    expect(second.job.thread).toBe(thread.id); expect(second.job.mode).toBe("read");
    expect(second.prompt).toContain("Review the contract?");
    await h.complete(b, second.job, `@{a:${a.id}} Please clarify the field.`, bob);
    expect((await h.claim(a)).job).toBeNull(); await h.approve(a);
    const third = await h.claim(a); expect(third.prompt).toContain("Please clarify the field.");
    await h.complete(a, third.job, "Clarified\nROUTE: done");
    expect((await h.call<Snapshot>("sync")).jobs).toHaveLength(3);
  });
  it("does not launch a mention-only peer after human intervention or conflicting recipients", async () => {
    const h = setup(), a = await h.agent("A"), b = await h.agent("B"), space = await h.space();
    const { thread } = await h.post(space, a); const { job } = await h.claim(a);
    await h.post(space, undefined, { thread: thread.id, content: "Wait, changed requirements" });
    await h.complete(a, job, `@{a:${b.id}} Review?`);
    expect((await h.call<Snapshot>("sync")).participations).toHaveLength(0);
    await h.post(space, a, { thread: thread.id }); const next = await h.claim(a);
    await h.complete(a, next.job, `@{a:${b.id}} Review?\nROUTE: done`);
    const s = await h.call<Snapshot>("sync");
    expect(s.threads[0]?.status).toBe("error"); expect(s.jobs).toHaveLength(2);
    expect(s.messages.at(-1)?.content).toContain("противоречат");
  });
  it("applies the chain cap to mention-only ping-pong and never calls models for quoted human posts", async () => {
    const h = setup(), a = await h.agent("A"), b = await h.agent("B"), space = await h.space();
    await h.post(space, undefined, { content: `Example: \`@{a:${a.id}}\`\n\n> @{a:${b.id}}` });
    expect((await h.call<Snapshot>("sync")).jobs).toHaveLength(0);
    await h.post(space, a);
    for (let i = 0; i < 12; i++) {
      const active = i % 2 ? b : a, next = i % 2 ? a : b;
      await h.approve(active); const { job } = await h.claim(active);
      await h.complete(active, job, `@{a:${next.id}} Question ${i}`);
    }
    const s = await h.call<Snapshot>("sync");
    expect(s.jobs).toHaveLength(12); expect(s.threads[0]?.status).toBe("waiting");
    expect(s.messages.at(-1)?.content).toContain("лимит 12");
  });
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
    expect((await h.claim(b, bob)).job).toBeNull(); await h.approve(b, bob);
    const second = await h.claim(b, bob); expect(second.job.thread).toBe(posted.thread.id);
    expect(second.prompt).toContain("Question for frontend"); expect(second.prompt).toContain("Please review");
    await h.complete(b, second.job, "Agreed\nROUTE: done", bob);
    const s = await h.call<Snapshot>("sync"); expect(s.threads[0]?.status).toBe("resolved");
    expect(s.messages.filter((m) => m.kind === "agent").map((m) => m.author)).toEqual([a.id, b.id]);
  });
  it("keeps one owner-selected default agent and offers only peer defaults to agents", async () => {
    const h = setup(), first = await h.agent("First"), second = await h.agent("Second"), peerDefault = await h.agent("Peer default", bob), peerAux = await h.agent("Peer aux", bob);
    expect(first.primary).toBe(true); expect(second.primary).toBe(false);
    const promoted = await h.call<Agent>("agent", { ...second, primary: true });
    expect(promoted.primary).toBe(true);
    await h.call("heartbeat", { agent: second.id, device: second.device, ready: true });
    const own = await h.call<Snapshot>("sync");
    expect(own.agents.find((a) => a.id === first.id)?.primary).toBe(false);
    expect(own.agents.find((a) => a.id === second.id)?.primary).toBe(true);
    const space = await h.space();
    const next = await h.post(space, second); const claimed = await h.claim(second);
    expect(claimed.prompt).toContain(`Peer default [${peerDefault.id}]`);
    expect(claimed.prompt).not.toContain(`Peer aux [${peerAux.id}]`);
    expect(next.thread.id).toBeTruthy();
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
    const h = setup(), a = await h.agent("A"), peer = await h.agent("B", bob), space = await h.space();
    const { thread } = await h.post(space, a); const first = await h.claim(a);
    await h.complete(a, first.job, "Approve contract?\nROUTE: human:Bob");
    const waiting = await h.call<Snapshot>("sync", {}, bob); expect(waiting.threads[0]?.status).toBe("waiting"); expect(waiting.notices.at(-1)?.title).toBe("Нужно ваше решение");
    await h.call("post", { space: space.id, thread: thread.id, content: `Approved discussion direction, but no code edits. @{a:${a.id}} Continue with the peer.` }, bob);
    await h.approve(a);
    const next = await h.claim(a); expect(next.prompt).toContain("Approved"); expect(next.prompt).toContain("Approve contract?");
    expect(next.job.mode).toBe("read"); expect(next.job.thread).toBe(thread.id);
    await h.complete(a, next.job, `Please review the clarified contract\nROUTE: agent:${peer.id}`);
    await h.approve(peer, bob);
    const handoff = await h.claim(peer, bob);
    expect(handoff.job.thread).toBe(thread.id); expect(handoff.job.mode).toBe("read");
    expect(handoff.prompt).toContain("no code edits"); expect(handoff.prompt).toContain("clarified contract");
    await h.complete(peer, handoff.job, "Clarification addressed\nROUTE: done", bob);
    expect((await h.call<Snapshot>("sync")).threads).toHaveLength(1);
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
    for (let index = 0; index < 12; index++) { const active = index % 2 ? b : a, next = index % 2 ? a : b; await h.approve(active); const { job } = await h.claim(active); await h.complete(active, job, `Question ${index}\nROUTE: agent:${next.id}`); }
    const s = await h.call<Snapshot>("sync"); expect(s.jobs).toHaveLength(12); expect(s.threads[0]?.status).toBe("waiting");
  });
});

describe("fallbacks, leases and write boundaries", () => {
  it("uses a configured fallback on unavailability", async () => {
    const h = setup(), b = await h.agent("Backup"), a = await h.agent("Primary", alice, { fallback: b.id }), space = await h.space();
    await h.post(space, a); await h.call("heartbeat", { agent: a.id, device: a.device, ready: false, detail: "CLI unavailable" });
    expect((await h.claim(b)).job).toBeNull(); await h.approve(b);
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
  it("requires a separate owner write request even for fallback before execution starts", async () => {
    const h = setup(), b = await h.agent("Backup", alice, { allowWrite: true }), a = await h.agent("Writer", alice, { allowWrite: true, fallback: b.id }), space = await h.space();
    await h.post(space, a, { mode: "write" }); const { job } = await h.claim(a);
    await h.call("fail", { job: job.id, lease: job.lease, device: a.device, error: "Preflight failed" });
    expect((await h.claim(b)).job).toBeNull();
    expect((await h.call<Snapshot>("sync")).messages.at(-1)?.content).toContain("отдельный запрос владельца");
  });
  it("does not let a coworker authorize another employee's writes", async () => {
    const h = setup(), a = await h.agent("Writer", bob, { allowWrite: true }), space = await h.space(); await h.post(space, a, { mode: "write" });
    const s = await h.call<Snapshot>("sync", {}, bob); expect(s.jobs).toHaveLength(0); expect(s.threads[0]?.status).toBe("waiting"); expect(s.notices.at(-1)?.title).toBe("Нужно ваше решение");
  });
  it("never propagates write authorization along an agent handoff", async () => {
    const h = setup(), a = await h.agent("Writer", alice, { allowWrite: true }), b = await h.agent("Peer", bob, { allowWrite: true }), space = await h.space(); await h.post(space, a, { mode: "write" }); const { job } = await h.claim(a);
    await h.complete(a, job, `Review diff\nROUTE: agent:${b.id}`); await h.approve(b, bob); expect((await h.claim(b, bob)).job.mode).toBe("read");
  });
  it("cancels work on stop or membership removal and rejects a late answer", async () => {
    const h = setup(), a = await h.agent("A", bob), space = await h.space(); await h.post(space, a); await h.approve(a, bob); const { job } = await h.claim(a, bob);
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
    await h.approve(b);
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
    await h.approve(b);
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
  it("enrolls multiple independent employees into only the invited space", async () => {
    const h = setup(), space = await h.space([]), other = await h.space([]);
    await h.post(space); await h.post(other, undefined, { content: "Private other-space history" });
    const invite = await h.call<{ code: string; id: string }>("group-invite", { space: space.id });
    const first = await h.service.enroll(invite.code, "New colleague");
    const second = await h.service.enroll(invite.code, "Another colleague");
    expect(first.employee).not.toBe(second.employee); expect(first.token).not.toBe(second.token);
    const snapshot = await h.call<Snapshot>("sync", {}, first.token);
    expect(snapshot.me.name).toBe("New colleague"); expect(snapshot.spaces.map((s) => s.id)).toEqual([space.id]);
    expect(snapshot.messages.some((m) => m.content === "Hello people")).toBe(true);
    expect(snapshot.messages.some((m) => m.content === "Private other-space history")).toBe(false);
    expect(snapshot.groupInvitations).toEqual([]);
    await h.call("post", { space: space.id, content: "Ready to talk" }, first.token);
    expect((await h.call<Snapshot>("sync", {}, second.token)).messages.at(-1)?.content).toBe("Ready to talk");
    const owner = await h.call<Snapshot>("sync");
    expect(owner.groupInvitations?.[0]?.uses).toBe(2);
    expect(owner.notices.filter((n) => n.title === "Новый участник спейса")).toHaveLength(2);
    for (const secret of [invite.code, first.token, second.token, '"hash"', '"usedBy"']) expect(JSON.stringify(owner)).not.toContain(secret);
    expect(await h.store.read((s) => JSON.stringify(s))).not.toContain(invite.code);
    await expect(h.call("members", { space: space.id, members: [] }, first.token)).rejects.toThrow("создатель");
  });
  it("allows only space owners to issue or revoke group invitations", async () => {
    const h = setup(), space = await h.space();
    await expect(h.call("group-invite", { space: space.id }, bob)).rejects.toThrow("владелец");
    const invite = await h.call<{ id: string; code: string }>("group-invite", { space: space.id });
    await expect(h.call("revoke-invite", { id: invite.id }, bob)).rejects.toThrow("недоступно");
    await expect(h.call("group-invite", { space: "missing" })).rejects.toThrow("недоступен");
  });
  it("atomically caps concurrent enrollments and leaves no orphan accounts", async () => {
    const h = setup(), space = await h.space([]);
    const invite = await h.call<{ code: string }>("group-invite", { space: space.id, maxUses: 2 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => h.service.enroll(invite.code, `Colleague ${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await h.store.read((s) => s.credentials.length)).toBe(2);
    expect((await h.call<Snapshot>("sync")).employees).toHaveLength(4);
    expect((await h.call<Snapshot>("sync")).groupInvitations?.[0]?.uses).toBe(2);
  });
  it("expires and revokes invitations without removing existing members", async () => {
    const h = setup(), space = await h.space([]);
    const invite = await h.call<{ code: string; id: string }>("group-invite", { space: space.id, days: 1 });
    const joined = await h.service.enroll(invite.code, "Joined before revocation");
    await h.call("revoke-invite", { id: invite.id });
    await expect(h.service.enroll(invite.code, "Too late")).rejects.toThrow("отключено");
    expect((await h.call<Snapshot>("sync", {}, joined.token)).spaces[0]?.id).toBe(space.id);
    const expired = await h.call<{ code: string }>("group-invite", { space: space.id, days: 1 });
    h.advance(24 * 3600_000);
    await expect(h.service.enroll(expired.code, "Expired")).rejects.toThrow("истекло");
  });
  it("validates invitation limits and names without consuming an entry", async () => {
    const h = setup(), space = await h.space([]);
    for (const args of [{ days: 0 }, { days: 31 }, { days: 1.5 }, { days: "7" }, { maxUses: 0 }, { maxUses: 1001 }, { maxUses: 2.5 }]) {
      await expect(h.call("group-invite", { space: space.id, ...args })).rejects.toThrow();
    }
    const invite = await h.call<{ code: string }>("group-invite", { space: space.id });
    for (const name of [undefined, " ", "x".repeat(81), { name: "bad" }]) await expect(h.service.enroll(invite.code, name)).rejects.toThrow("имя");
    expect((await h.call<Snapshot>("sync")).groupInvitations?.[0]?.uses).toBe(0);
    expect((await h.call<Snapshot>("sync")).employees).toHaveLength(2);
  });
  it("joins existing employees without duplicate identities or consuming repeated entries", async () => {
    const h = setup(), space = await h.space([]); await h.agent("Bob agent", bob);
    const invite = await h.call<{ code: string }>("group-invite", { space: space.id, maxUses: 1 });
    for (let i = 0; i < 2; i++) expect(await h.call("join-invite", { code: invite.code }, bob)).toEqual({ space: space.id });
    const snapshot = await h.call<Snapshot>("sync", {}, bob);
    expect(snapshot.me.id).toBe("Bob"); expect(snapshot.agents.some((a) => a.owner === "Bob")).toBe(true);
    expect(snapshot.employees).toHaveLength(2); expect(snapshot.spaces).toHaveLength(1);
    await h.call("members", { space: space.id, members: [] });
    await expect(h.call("join-invite", { code: invite.code }, bob)).rejects.toThrow("отозван");
    await expect(h.call("join-invite", { code: "missing" }, bob)).rejects.toThrow("не найдено");
  });
  it("keeps group membership and usage in PostgreSQL across service restarts", async () => {
    const mem = newDb({ noAstCoverageCheck: true }), adapter = mem.adapters.createPg();
    const store = new PostgresStateStore(new adapter.Pool() as unknown as pg.Pool); await store.migrate();
    const first = new CollaborationService(store, [{ actor: "Alice", token: alice }]);
    const space = await first.call(alice, "space", { name: "Team" }) as Space;
    const invite = await first.call(alice, "group-invite", { space: space.id }) as { code: string; id: string };
    const joined = await first.enroll(invite.code, "Peer");
    const second = new CollaborationService(store, [{ actor: "Alice", token: alice }]);
    expect((await second.call(joined.token, "sync") as Snapshot).spaces[0]?.id).toBe(space.id);
    expect((await second.call(alice, "sync") as Snapshot).groupInvitations?.[0]?.uses).toBe(1);
    await second.call(alice, "revoke-invite", { id: invite.id });
    await expect(first.enroll(invite.code, "Late")).rejects.toThrow("отключено");
    await store.close();
  });
  it("encodes reusable and legacy AH2 codes with validated coordinator URLs", () => {
    const code = encodeInvitation("https://hub.example", "secret-test", true);
    expect(decodeInvitation(code)).toEqual({ url: "https://hub.example", code: "secret-test", group: true });
    expect(decodeInvitation(encodeInvitation("https://hub.example", "legacy"))).toEqual({ url: "https://hub.example", code: "legacy", group: false });
    for (const bad of ["wrong", "AH2:invalid", "AH2:" + Buffer.from("null").toString("base64url"), "AH2:" + Buffer.from(JSON.stringify({ url: "http://remote.example", code: "secret" })).toString("base64url")]) expect(() => decodeInvitation(bad)).toThrow();
  });
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
  afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); } server = undefined; });
  it("serves the authenticated v2 API and rejects malformed and cross-origin input", async () => {
    const h = setup(); server = createServer((req, res) => void collaborationHttp(h.service, req, res));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}`, client = new CollaborationClient(url, alice);
    const controller = new AbortController();
    let readyResolve!: () => void, changeResolve!: () => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    const changed = new Promise<void>((resolve) => { changeResolve = resolve; });
    const stream = client.events(controller.signal, (event) => {
      if (event.type === "ready") readyResolve();
      if (event.type === "change") changeResolve();
    }).catch((error) => { if (!controller.signal.aborted) throw error; });
    await ready;
    expect((await client.call<Snapshot>("sync")).me.id).toBe("Alice");
    const space = await client.call<Space>("space", { name: "HTTP Team", members: ["Bob"] });
    await changed;
    const bobClient = new CollaborationClient(url, bob), bobController = new AbortController();
    let bobReadyResolve!: () => void, typingResolve!: (event: Extract<LiveEvent, { type: "typing" }>) => void;
    const bobReady = new Promise<void>((resolve) => { bobReadyResolve = resolve; });
    const typed = new Promise<Extract<LiveEvent, { type: "typing" }>>((resolve) => { typingResolve = resolve; });
    const bobStream = bobClient.events(bobController.signal, (event) => {
      if (event.type === "ready") bobReadyResolve();
      if (event.type === "typing") typingResolve(event);
    }).catch((error) => { if (!bobController.signal.aborted) throw error; });
    await bobReady;
    await client.typing({ space: space.id, channel: `general:${space.id}`, thread: null, active: true, version: 1 });
    expect(await typed).toMatchObject({ employee: "Alice", space: space.id, active: true, version: 1 });
    const invite = await client.call<{ code: string }>("group-invite", { space: space.id });
    const anonymous = new CollaborationClient(url, "");
    await expect(anonymous.enroll(invite.code)).rejects.toThrow("имя");
    const joined = await anonymous.enroll(invite.code, "HTTP Colleague");
    expect((await new CollaborationClient(url, joined.token).call<Snapshot>("sync")).spaces[0]?.id).toBe(space.id);
    const bad = await fetch(`${url}/v2/rpc`, { method: "POST", body: "[" }); expect(bad.status).toBe(400);
    const cors = await fetch(`${url}/v2/rpc`, { method: "POST", headers: { Origin: "https://evil.test" }, body: "{}" }); expect(cors.status).toBe(403);
    await expect(new CollaborationClient(url, "bad").call("sync")).rejects.toThrow("Нет доступа");
    const rejectedEvents = new CollaborationClient(url, "bad").events(AbortSignal.timeout(1_000), () => {});
    await expect(rejectedEvents).rejects.toThrow("Нет доступа");
    expect(() => hubUrl("http://public.example")).toThrow("HTTPS"); expect(() => hubUrl("https://user:password@example.com")).toThrow();
    controller.abort(); bobController.abort(); await Promise.all([stream, bobStream]);
  });
});
