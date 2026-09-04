import type { Notice } from "./model.js";

export function pendingNotices(notices: Notice[], cursor: number | null, sequence: number): { cursor: number; pending: Notice[] } {
  // First connection establishes a baseline; reconnects retain unread notifications.
  return { cursor: Math.max(cursor ?? 0, sequence), pending: cursor === null ? [] : notices.filter((n) => n.seq > cursor && !n.silent && !n.read).sort((a, b) => a.seq - b.seq) };
}
