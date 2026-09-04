import { generalChannelId, requireValue, type State } from "./model.js";

// A separate monotonic sequence avoids wall-clock ties and notice cursor coupling.
export function migrateReadState(s: State): void {
  if (s.readVersion === 1) return;
  let seq = 0;
  for (const message of s.messages) message.seq = ++seq;
  s.messageSequence = seq; s.readVersion = 1; s.readPositions = [];
  // Existing users do not get a badge for the entire pre-upgrade archive.
  // New employees have no baseline, so their accessible history is unread.
  s.readBaselines = s.employees.map((e) => ({ employee: e.id, through: seq }));
}

export function markRead(s: State, actor: string, input: Record<string, unknown>): { ok: true } {
  const channel = s.channels?.find((c) => c.id === input.channel);
  requireValue(channel && s.spaces.some((sp) => sp.id === channel.space && sp.members.includes(actor)), "Канал недоступен", 403);
  const thread = input.thread ?? null;
  requireValue(thread === null || s.threads.some((t) => t.id === thread && t.space === channel.space
    && (t.channel ?? generalChannelId(t.space)) === channel.id), "Тред не относится к каналу", 403);
  if (input.through !== undefined) {
    const message = s.messages.find((m) => m.id === input.through && m.space === channel.space && m.thread === thread
      && (m.channel ?? generalChannelId(m.space)) === channel.id);
    requireValue(message?.seq, "Сообщение для отметки прочтения не найдено", 400);
    const positions = s.readPositions ??= [];
    const position = positions.find((p) => p.employee === actor && p.channel === channel.id && p.thread === thread);
    if (position) position.through = Math.max(position.through, message.seq);
    else positions.push({ employee: actor, channel: channel.id, thread: thread as string | null, through: message.seq });
  }
  if (input.noticeThrough !== undefined) {
    const through = noticeThrough(s, input.noticeThrough);
    for (const n of s.notices) if (n.employee === actor && n.seq <= through && n.thread === thread
      && (n.channel ?? generalChannelId(n.space)) === channel.id) n.read = true;
  }
  return { ok: true };
}

function noticeThrough(s: State, value: unknown): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= s.sequence, "Неверная граница уведомлений");
  return value;
}
export function manageNotices(s: State, actor: string, input: Record<string, unknown>): { ok: true } {
  const through = noticeThrough(s, input.through);
  requireValue(input.action === "read" || input.action === "clear-read", "Неверное действие с уведомлениями");
  const spaces = new Set(s.spaces.filter((sp) => sp.members.includes(actor)).map((sp) => sp.id));
  const selected = (n: State["notices"][number]) => n.employee === actor && spaces.has(n.space) && n.seq <= through;
  if (input.action === "read") for (const n of s.notices) { if (selected(n)) n.read = true; }
  else s.notices = s.notices.filter((n) => !(selected(n) && n.read));
  // Notification clearing never advances message read cursors or resolves approvals.
  return { ok: true };
}
