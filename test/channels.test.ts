import { afterEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import type pg from "pg";
import { CollaborationService } from "../src/collab/service.js";
import { MemoryStateStore, PostgresStateStore, SqliteStateStore, type StateStore } from "../src/collab/store.js";
import { generalChannelId, type Agent, type Channel, type Job, type Message, type Snapshot, type Space, type Thread } from "../src/collab/model.js";
import { pendingNotices } from "../src/collab/notifications.js";
import { sourceHash, validMemory } from "../src/collab/context.js";

const tokens = { Alice: "alice-channel-test-credential", Bob: "bob-channel-test-credential", Eve: "eve-channel-test-credential" };
const stores: StateStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
function setup(store: StateStore = new MemoryStateStore()) {
  stores.push(store);
  const service = new CollaborationService(store, Object.entries(tokens).map(([actor, token]) => ({ actor, token })));
  const call = <T = any>(op: string, b: Record<string, unknown> = {}, actor: keyof typeof tokens = "Alice"): Promise<T> => service.call(tokens[actor], op, op === "sync" ? { channelVersion: 1, ...b } : b) as Promise<T>;
  const sync = (actor: keyof typeof tokens = "Alice") => call<Snapshot>("sync", {}, actor);
  const space = () => call<Space>("space", { name: "Team", members: ["Bob"] });
  const channel = (space: Space, name = "Gamification", actor: keyof typeof tokens = "Alice") => call<Channel>("channel", { space: space.id, name }, actor);
  const post = (channel: Channel, content: string, thread?: string, actor: keyof typeof tokens = "Alice") => call<{ thread: Thread; message: Message }>("post", { space: channel.space, channel: channel.id, content, ...(thread ? { thread } : {}) }, actor);
  const agent = async (name: string, actor: keyof typeof tokens = "Alice") => {
    const a = await call<Agent>("agent", { name, executor: "codex", device: actor, enabled: true }, actor);
    await call("heartbeat", { agent: a.id, device: actor, ready: true }, actor); return a;
  };
  const claim = (a: Agent, actor: keyof typeof tokens = "Alice") => call<{ job: Job; prompt: string }>("claim", { agent: a.id, device: actor }, actor);
  const complete = (job: Job, content: string, actor: keyof typeof tokens = "Alice") => call("complete", { job: job.id, lease: job.lease, device: actor, content }, actor);
  return { service, store, call, sync, space, channel, post, agent, claim, complete };
}

describe("space channels", () => {
  it.each(["memory", "sqlite", "postgres"])("migrates legacy %s history once without changing IDs, content, dates or memory", async (backend) => {
    let store: StateStore = new MemoryStateStore();
    if (backend === "sqlite") store = new SqliteStateStore(":memory:");
    if (backend === "postgres") {
      const adapter = newDb({ noAstCoverageCheck: true }).adapters.createPg();
      const pgStore = new PostgresStateStore(new adapter.Pool() as unknown as pg.Pool); await pgStore.migrate(); store = pgStore;
    }
    const h = setup(store);
    const original = { id: "old-thread", space: "old-space", owner: "Alice", title: "Old topic", createdAt: 55, revision: 7, status: "waiting" as const };
    const message = { id: "old-message", space: "old-space", thread: "old-thread", author: "Bob", kind: "human" as const, content: "Existing code and decisions", createdAt: 56 };
    const memory = { version: 1 as const, through: message.id, sourceHash: sourceHash([message]), summary: "Prior agreed contract", citations: [message.id], agent: "old-agent", createdAt: 60 };
    await store.transact((s) => {
      s.spaces.push({ id: "old-space", name: "Legacy", owner: "Alice", members: ["Alice", "Bob"], createdAt: 42 });
      s.threads.push({ ...original, memory }); s.messages.push(message);
    });
    const first = await h.sync();
    expect(first.channels).toEqual([expect.objectContaining({ id: generalChannelId("old-space"), name: "Общий", createdAt: 42, general: true })]);
    expect(first.threads[0]).toEqual({ ...original, memory, channel: generalChannelId("old-space") });
    expect(validMemory(first.messages, first.threads[0]?.memory)).toEqual(memory);
    expect(first.messages[0]).toEqual({ ...message, channel: generalChannelId("old-space"), seq: 1 });
    expect(first.threadSubscriptions?.[0]?.following).toBe(true);
    const persistedRevision = await store.read((s) => s.revision);
    const second = await h.sync(); expect(second.revision).toBe(persistedRevision);
    expect(second.channels).toHaveLength(1); expect(second.messages).toHaveLength(1);
  });
  it("creates channels for all space members, while respecting ownership and private spaces", async () => {
    const h = setup(), space = await h.space(), c = await h.channel(space, "Math", "Bob");
    expect((await h.sync()).channels?.map((v) => v.name)).toEqual(["Общий", "Math"]);
    expect((await h.sync("Bob")).channels?.some((v) => v.id === c.id)).toBe(true);
    expect((await h.sync("Eve")).channels).toHaveLength(0);
    for (const op of ["channel-state", "channel-preference"]) await expect(h.call(op, { channel: c.id, archived: true, muted: true }, "Eve")).rejects.toThrow("недоступен");
    await expect(h.channel(space, "Intrusion", "Eve")).rejects.toThrow("недоступен");
    await expect(h.channel(space, "math")).rejects.toThrow("уже есть");
    await h.call("channel", { id: c.id, space: space.id, name: "Mathematics" });
    expect((await h.sync()).channels?.find((v) => v.id === c.id)?.name).toBe("Mathematics");
    const own = await h.channel(space, "Owned by Alice");
    await expect(h.call("channel", { id: own.id, space: space.id, name: "Hijack" }, "Bob")).rejects.toThrow("создатель");
    await expect(h.call("channel-state", { channel: own.id, archived: true }, "Bob")).rejects.toThrow("создатель");
  });
  it("keeps each channel's messages, threads, agent handoffs and notices together", async () => {
    const h = setup(), space = await h.space(), game = await h.channel(space, "Game 1"), math = await h.channel(space, "Math");
    const a = await h.agent("A"), b = await h.agent("B", "Bob");
    await h.post(math, "Unrelated math discussion");
    const { thread } = await h.post(game, `Discuss progress @{a:${a.id}}`);
    expect(thread.channel).toBe(game.id);
    const first = await h.claim(a); expect(first.prompt).toContain("Channel: Game 1"); expect(first.prompt).not.toContain("Unrelated math");
    await h.complete(first.job, `Peer question\nROUTE: agent:${b.id}`);
    const pending = await h.sync("Bob"), p = pending.participations!.find((p) => p.agent === b.id)!;
    await h.call("participation", { id: p.id, revision: p.revision, threadRevision: pending.threads[0]!.revision, action: "allow", runs: 3 }, "Bob");
    const second = await h.claim(b, "Bob"); expect(second.job.thread).toBe(thread.id); expect(second.prompt).toContain("Peer question");
    await h.complete(second.job, "Agreed\nROUTE: done", "Bob");
    const s = await h.sync();
    expect(s.messages.filter((m) => m.thread === thread.id).every((m) => m.channel === game.id)).toBe(true);
    expect(s.notices.filter((n) => n.thread === thread.id).every((n) => n.channel === game.id)).toBe(true);
    expect(s.threads[0]?.status).toBe("resolved");
  });
  it("rejects channel/space and thread/channel mismatches even for a member of both", async () => {
    const h = setup(), space = await h.space(), other = await h.space(), c = await h.channel(space), foreign = await h.channel(other);
    const t = await h.call<{ thread: Thread }>("post", { space: space.id, channel: c.id, newThread: true, content: "Question" });
    await expect(h.call("post", { space: space.id, channel: foreign.id, content: "Wrong space" })).rejects.toThrow("другому спейсу");
    await expect(h.call("post", { space: space.id, thread: t.thread.id, channel: generalChannelId(space.id), content: "Wrong channel" })).rejects.toThrow("другому каналу");
    await expect(h.call("channel", { space: other.id, id: c.id, name: "Move" })).rejects.toThrow("другому спейсу");
    await expect(h.call("thread-subscription", { thread: t.thread.id, following: true }, "Eve")).rejects.toThrow("недоступен");
  });
  it("archives read-only, cancels live jobs and restores without launching any agent", async () => {
    const h = setup(), space = await h.space(), c = await h.channel(space), a = await h.agent("A");
    const { thread } = await h.post(c, `Review @{a:${a.id}}`); const { job } = await h.claim(a);
    await h.call("channel-state", { channel: c.id, archived: true });
    expect((await h.sync()).jobs[0]?.status).toBe("cancelled");
    await expect(h.post(c, "New message")).rejects.toThrow("архиве");
    await expect(h.post(c, "Thread reply", thread.id)).rejects.toThrow("архиве");
    await expect(h.call("thread-state", { thread: thread.id, status: "open" })).rejects.toThrow("архиве");
    await expect(h.complete(job, "Late reply\nROUTE: done")).rejects.toThrow("остановлено");
    expect((await h.sync()).messages.some((m) => m.content.includes("Review"))).toBe(true);
    await h.call("channel-state", { channel: c.id, archived: false });
    expect((await h.claim(a)).job).toBeNull(); await h.post(c, "Resumed", thread.id);
    expect((await h.sync()).messages.at(-1)?.content).toBe("Resumed");
    await expect(h.call("channel-state", { channel: generalChannelId(space.id), archived: true })).rejects.toThrow("нельзя");
  });
  it("routes legacy posts to General and never flattens other channels for old clients", async () => {
    const h = setup(), space = await h.space(), c = await h.channel(space);
    const oldPost = await h.call<{ message: Message }>("post", { space: space.id, content: "Legacy general post" });
    expect(oldPost.message.channel).toBe(generalChannelId(space.id));
    await h.call("post", { space: space.id, channel: c.id, content: "New channel topic", newThread: true });
    const legacy = await h.service.call(tokens.Alice, "sync") as Snapshot;
    expect(legacy.channels).toBeUndefined(); expect(legacy.threads).toHaveLength(0);
    expect(legacy.messages.map((m) => m.content)).toEqual(["Legacy general post"]);
    expect((await h.sync()).threads).toHaveLength(1);
  });
  it("notifies followers and mentions once per message, and preserves explicit unsubscribe", async () => {
    const h = setup(), space = await h.space(), c = await h.channel(space);
    const { thread } = await h.call<{ thread: Thread }>("post", { space: space.id, channel: c.id, content: "Start", newThread: true });
    await h.call("thread-subscription", { thread: thread.id, following: true }, "Bob");
    const before = (await h.sync("Bob")).sequence;
    const reply = await h.post(c, "Question for @{u:Bob}", thread.id);
    const notices = (await h.sync("Bob")).notices.filter((n) => n.seq > before);
    expect(notices).toHaveLength(1); expect(notices[0]?.event).toBe(reply.message.id); expect(notices[0]?.title).toContain("упомянул");
    await h.call("thread-subscription", { thread: thread.id, following: false }, "Bob");
    await h.post(c, "Bob contributes but stays unsubscribed", thread.id, "Bob");
    const after = (await h.sync("Bob")).sequence;
    await h.post(c, "No notification for Bob", thread.id);
    expect((await h.sync("Bob")).notices.filter((n) => n.seq > after)).toHaveLength(0);
    await h.post(c, "Explicit @{u:Bob}", thread.id);
    expect((await h.sync("Bob")).notices.filter((n) => n.seq > after)).toHaveLength(1);
  });
  it("mutes banners, not inbox history, and does not replay messages after unmuting", async () => {
    const h = setup(), space = await h.space(), c = await h.channel(space);
    await h.call("channel-preference", { channel: c.id, muted: true }, "Bob");
    const before = (await h.sync("Bob")).sequence;
    await h.post(c, "Quiet mention @{u:Bob}");
    const quiet = await h.sync("Bob"); expect(quiet.notices.at(-1)?.silent).toBe(true);
    const pending = pendingNotices(quiet.notices, before, quiet.sequence); expect(pending.pending).toHaveLength(0);
    await h.call("channel-preference", { channel: c.id, muted: false }, "Bob");
    const unmuted = await h.sync("Bob"); expect(pendingNotices(unmuted.notices, pending.cursor, unmuted.sequence).pending).toHaveLength(0);
    await h.post(c, "New mention @{u:Bob}");
    const latest = await h.sync("Bob"); expect(pendingNotices(latest.notices, pending.cursor, latest.sequence).pending).toHaveLength(1);
    expect((await h.sync()).channelPreferences).toHaveLength(0);
  });
  it("does not notify removed members who previously followed a thread", async () => {
    const h = setup(), space = await h.space(), c = await h.channel(space);
    const { thread } = await h.call<{ thread: Thread }>("post", { space: space.id, channel: c.id, content: "Start", newThread: true });
    await h.call("thread-subscription", { thread: thread.id, following: true }, "Bob");
    await h.call("members", { space: space.id, members: [] });
    const before = await h.store.read((s) => s.sequence); await h.post(c, "Private follow-up", thread.id);
    expect(await h.store.read((s) => s.notices.filter((n) => n.seq > before && n.employee === "Bob"))).toHaveLength(0);
    expect((await h.sync("Bob")).threadSubscriptions).toHaveLength(0);
  });
  it("includes all existing and future channels after shared space enrollment", async () => {
    const h = setup(), space = await h.space(); await h.channel(space, "Game 1");
    const invite = await h.call<{ code: string }>("group-invite", { space: space.id });
    const joined = await h.service.enroll(invite.code, "Colleague"); await h.channel(space, "Math");
    const s = await h.service.call(joined.token, "sync", { channelVersion: 1 }) as Snapshot;
    expect(s.channels?.map((c) => c.name)).toEqual(["Общий", "Game 1", "Math"]);
  });
});
