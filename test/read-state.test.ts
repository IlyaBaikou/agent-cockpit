import { afterEach, expect, it } from "vitest";
import { newDb } from "pg-mem";
import type pg from "pg";
import { CollaborationService } from "../src/collab/service.js";
import { MemoryStateStore, PostgresStateStore, SqliteStateStore, type StateStore } from "../src/collab/store.js";
import type { Channel, Message, Snapshot, Space, Thread } from "../src/collab/model.js";
import { pendingNotices } from "../src/collab/notifications.js";

const credentials = ["Alice", "Bob", "Eve"].map((actor) => ({ actor, token: `read-test-${actor}-token` }));
const stores: StateStore[] = [];
afterEach(async () => { for (const s of stores.splice(0)) await s.close(); });
async function fixture(store: StateStore = new MemoryStateStore()) {
  stores.push(store); const service = new CollaborationService(store, credentials);
  const call = <T = any>(op: string, input: Record<string, unknown> = {}, actor = "Alice") => service.call(`read-test-${actor}-token`, op, input) as Promise<T>;
  const sync = (actor = "Alice") => call<Snapshot>("sync", { channelVersion: 1 }, actor);
  const space = await call<Space>("space", { name: "Team", members: ["Bob"] });
  const channel = await call<Channel>("channel", { space: space.id, name: "Feature" });
  const post = (content: string, thread?: string, extra = {}) => call<{ thread: Thread; message: Message }>("post", { space: space.id, channel: channel.id, content, thread, ...extra }, "Bob");
  const read = (message: Message, extra = {}, actor = "Alice") => call("read", { channel: message.channel, thread: message.thread, through: message.id, ...extra }, actor);
  const unread = (s: Snapshot) => s.messages.filter((m) => m.kind !== "system" && !(m.kind === "human" && m.author === s.me.id)
    && m.seq! > Math.max(s.readBaseline ?? 0, s.readPositions?.find((p) => p.channel === m.channel && p.thread === m.thread)?.through ?? 0));
  return { store, service, call, sync, space, channel, post, read, unread };
}

it("reads root chat and threads independently, ignoring own and system messages for unread badges", async () => {
  const f = await fixture(), root = await f.post("Hello @{u:Alice}"), one = await f.post("Topic one", undefined, { newThread: true }), two = await f.post("Topic two", undefined, { newThread: true });
  await f.call("post", { space: f.space.id, channel: f.channel.id, content: "My own text" });
  await f.call("thread-state", { thread: two.thread.id, status: "paused" }, "Bob");
  expect(f.unread(await f.sync())).toHaveLength(3);
  await f.read(root.message); expect(f.unread(await f.sync()).map((m) => m.id)).toEqual([one.message.id, two.message.id]);
  await f.read(one.message); expect(f.unread(await f.sync()).map((m) => m.id)).toEqual([two.message.id]);
  expect((await f.sync("Bob")).readPositions).toHaveLength(0); expect((await f.sync()).jobs).toHaveLength(0);
});

it("uses monotonic positions and never reads a new arrival after the captured boundary", async () => {
  const f = await fixture(), first = await f.post("First"), second = await f.post("Second");
  await f.read(first.message); expect(f.unread(await f.sync()).map((m) => m.id)).toEqual([second.message.id]);
  await f.read(second.message); await f.read(first.message);
  expect(f.unread(await f.sync())).toHaveLength(0);
  expect((await f.sync()).readPositions![0]!.through).toBe(second.message.seq);
  const third = await f.post("Third"); expect(f.unread(await f.sync()).map((m) => m.id)).toEqual([third.message.id]);
});

it("checks scope and membership, including archived channels, without trusting future cursors", async () => {
  const f = await fixture(), root = await f.post("Root"), thread = await f.post("Thread", undefined, { newThread: true });
  await expect(f.read(root.message, {}, "Eve")).rejects.toThrow("недоступен");
  await expect(f.read(root.message, { thread: thread.thread.id })).rejects.toThrow("не найдено");
  await expect(f.read(root.message, { through: "future" })).rejects.toThrow("не найдено");
  await expect(f.read(root.message, { noticeThrough: 999999 })).rejects.toThrow("граница");
  expect((await f.sync()).readPositions).toHaveLength(0);
  await f.call("channel-state", { channel: f.channel.id, archived: true });
  await f.read(root.message); expect((await f.sync()).readPositions).toHaveLength(1);
  await f.call("members", { space: f.space.id, members: [] });
  await expect(f.read(root.message, {}, "Bob")).rejects.toThrow("недоступен");
});

it("marks only observed scope notifications as read, preserving unread sibling threads and new notifications", async () => {
  const f = await fixture(), root = await f.post("Root @{u:Alice}"), thread = await f.post("Thread @{u:Alice}", undefined, { newThread: true });
  const before = await f.sync(); const newer = await f.post("New @{u:Alice}");
  await f.read(root.message, { noticeThrough: before.sequence });
  const s = await f.sync();
  expect(s.notices.find((n) => n.event === root.message.id)!.read).toBe(true);
  expect(s.notices.find((n) => n.event === thread.message.id)!.read).not.toBe(true);
  expect(s.notices.find((n) => n.event === newer.message.id)!.read).not.toBe(true);
  expect(pendingNotices(s.notices, 0, s.sequence).pending.some((n) => n.event === root.message.id)).toBe(false);
});

it("clears only this employee's read notices, without deleting history, changing badges or replaying OS banners", async () => {
  const f = await fixture(); await f.post("Mention @{u:Alice}");
  const before = await f.sync(), peer = await f.sync("Bob");
  await f.call("notices", { action: "clear-read", through: before.sequence });
  expect((await f.sync()).notices).toHaveLength(before.notices.length);
  await f.call("notices", { action: "read", through: before.sequence });
  expect((await f.sync()).notices.every((n) => n.read)).toBe(true);
  expect(f.unread(await f.sync())).toHaveLength(1);
  const fresh = await f.post("New mention @{u:Alice}");
  await f.call("notices", { action: "clear-read", through: before.sequence });
  const s = await f.sync(); expect(s.notices).toHaveLength(1); expect(s.notices[0]!.event).toBe(fresh.message.id);
  expect(s.sequence).toBeGreaterThan(before.sequence); expect(s.messages).toHaveLength(2);
  expect((await f.sync("Bob")).notices).toEqual(peer.notices);
  expect(pendingNotices(s.notices, s.sequence, s.sequence).pending).toHaveLength(0);
});

it("seeing an approval notice does not approve it or start a job", async () => {
  const f = await fixture();
  await f.call("agent", { id: "A", name: "A", executor: "codex", device: "local", enabled: true });
  const posted = await f.post("@{a:A} Review"); const snapshot = await f.sync();
  await f.read(posted.message, { noticeThrough: snapshot.sequence });
  await f.call("notices", { action: "clear-read", through: snapshot.sequence });
  const after = await f.sync(); expect(after.jobs).toHaveLength(0); expect(after.participations![0]!.status).toBe("pending");
});

it.each(["memory", "sqlite", "postgres"])("persists read positions and notice state in %s across coordinator restarts", async (kind) => {
  let store: StateStore = new MemoryStateStore();
  if (kind === "sqlite") store = new SqliteStateStore(":memory:");
  if (kind === "postgres") { const Pg = newDb().adapters.createPg(); const p = new PostgresStateStore(new Pg.Pool() as unknown as pg.Pool); await p.migrate(); store = p; }
  const f = await fixture(store), message = await f.post("Hello @{u:Alice}"), before = await f.sync();
  await f.read(message.message, { noticeThrough: before.sequence });
  const restarted = new CollaborationService(store, credentials);
  const after = await restarted.call(credentials[0]!.token, "sync", { channelVersion: 1 }) as Snapshot;
  expect(f.unread(after)).toHaveLength(0); expect(after.notices.every((n) => n.read)).toBe(true);
});

it("migrates old history to a baseline once without losing content or creating a badge avalanche", async () => {
  const store = new MemoryStateStore(); stores.push(store);
  await store.transact((s) => {
    s.spaces.push({ id: "s", name: "Legacy", owner: "Alice", members: ["Alice", "Bob"], createdAt: 1 });
    s.messages.push({ id: "old", space: "s", thread: null, author: "Bob", kind: "human", content: "Existing", createdAt: 1 });
  });
  const service = new CollaborationService(store, credentials);
  const first = await service.call(credentials[0]!.token, "sync") as Snapshot;
  expect(first.messages[0]).toMatchObject({ id: "old", content: "Existing", createdAt: 1, seq: 1 }); expect(first.readBaseline).toBe(1);
  await service.call(credentials[1]!.token, "post", { space: "s", content: "New" });
  const second = await service.call(credentials[0]!.token, "sync") as Snapshot;
  expect(second.readBaseline).toBe(1); expect(second.messages[1]!.seq).toBe(2);
});
