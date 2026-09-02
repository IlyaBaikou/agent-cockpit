import { generalChannelId, type Channel, type Space, type State } from "./model.js";

export function makeGeneralChannel(space: Space): Channel {
  return { id: generalChannelId(space.id), space: space.id, name: "Общий", description: "Объявления и вопросы команды", owner: space.owner, createdAt: space.createdAt, archived: false, general: true };
}

// Executed once under the same lock as posts/claims. Preserve every existing ID,
// content, timestamp, memory and credential; legacy records belong to General.
export function migrateChannels(s: State): void {
  if (s.channelsVersion === 1) return;
  s.channels ??= [];
  s.channelPreferences ??= [];
  s.threadSubscriptions ??= [];
  for (const space of s.spaces) if (!s.channels.some((c) => c.id === generalChannelId(space.id))) s.channels.push(makeGeneralChannel(space));
  for (const thread of s.threads) thread.channel ??= generalChannelId(thread.space);
  const threads = new Map(s.threads.map((t) => [t.id, t]));
  for (const m of s.messages) m.channel ??= (m.thread ? threads.get(m.thread)?.channel : undefined) ?? generalChannelId(m.space);
  for (const n of s.notices) n.channel ??= (n.thread ? threads.get(n.thread)?.channel : undefined) ?? generalChannelId(n.space);
  const follows = new Map<string, Set<string>>();
  for (const t of s.threads) follows.set(t.id, new Set([t.owner]));
  for (const m of s.messages) if (m.kind === "human" && m.thread) follows.get(m.thread)?.add(m.author);
  for (const j of s.jobs) follows.get(j.thread)?.add(j.requestedBy);
  for (const [thread, employees] of follows) for (const employee of employees) {
    if (!s.threadSubscriptions.some((f) => f.thread === thread && f.employee === employee)) s.threadSubscriptions.push({ thread, employee, following: true });
  }
  s.channelsVersion = 1;
}
