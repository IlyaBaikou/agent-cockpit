import type { ContextStats, ThreadMemory } from "./context.js";
import type { AgentDiagnostic } from "../agents/diagnostics.js";
export type Executor = "codex" | "claude" | "cursor";
export type Employee = { id: string; name: string };
export type Agent = {
  id: string; owner: string; name: string; description: string; executor: Executor;
  device: string; enabled: boolean; allowWrite: boolean; fallback: string | null;
  seenAt: number; ready: boolean; detail: string;
  diagnostic?: AgentDiagnostic;
};
export type Space = { id: string; name: string; owner: string; members: string[]; createdAt: number };
export type Channel = { id: string; space: string; name: string; description: string; owner: string; createdAt: number; archived: boolean; general: boolean };
export type ChannelPreference = { employee: string; channel: string; muted: boolean };
export type ThreadSubscription = { employee: string; thread: string; following: boolean };
export const generalChannelId = (space: string): string => `general:${space}`;
export type Thread = {
  id: string; space: string; title: string; owner: string; createdAt: number;
  channel?: string;
  status: "open" | "working" | "waiting" | "resolved" | "error" | "paused";
  revision: number;
  memory?: ThreadMemory;
};
export type Message = {
  id: string; space: string; thread: string | null; author: string;
  channel?: string;
  kind: "human" | "agent" | "system"; content: string; createdAt: number;
  diagnosticJob?: string;
  clientRequestId?: string;
};
export type Job = {
  id: string; thread: string; agent: string; requestedBy: string; mode: "read" | "write";
  status: "queued" | "running" | "done" | "error" | "cancelled";
  createdAt: number; expiresAt: number; lease: string | null; revision: number;
  remaining: number; visited: string[]; started: boolean;
  contextThrough?: string;
  contextStats?: ContextStats;
  diagnostic?: AgentDiagnostic;
};
export type Notice = {
  seq: number; employee: string; title: string; body: string; space: string; thread: string | null;
  channel?: string; silent?: boolean; event?: string;
};
export type GroupInvitation = {
  id: string; owner: string; space: string; hash: string; createdAt: number;
  expiresAt: number; maxUses: number; usedBy: string[]; revoked: boolean;
};
export type GroupInvitationInfo = Omit<GroupInvitation, "hash" | "usedBy"> & { uses: number };
export type State = {
  version: 2; revision: number; employees: Employee[]; agents: Agent[]; spaces: Space[];
  threads: Thread[]; messages: Message[]; jobs: Job[]; notices: Notice[]; sequence: number;
  credentials: { employee: string; hash: string }[];
  invitations: { employee: string; hash: string; expiresAt: number }[];
  groupInvitations?: GroupInvitation[];
  channelsVersion?: 1; channels?: Channel[];
  channelPreferences?: ChannelPreference[]; threadSubscriptions?: ThreadSubscription[];
  requests: { actor: string; key: string; result: unknown }[];
};
export type Snapshot = {
  me: Employee; revision: number; employees: Employee[]; agents: Agent[]; spaces: Space[];
  threads: Thread[]; messages: Message[]; jobs: Omit<Job, "lease">[]; notices: Notice[]; sequence: number;
  groupInvitations?: GroupInvitationInfo[];
  channels?: Channel[];
  channelPreferences?: ChannelPreference[]; threadSubscriptions?: ThreadSubscription[];
};
export function emptyState(): State {
  return { version: 2, revision: 0, employees: [], agents: [], spaces: [], threads: [], messages: [], jobs: [], notices: [], sequence: 0, credentials: [], invitations: [], requests: [] };
}
export class CollabError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function requireValue(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new CollabError(message, status);
}
export function field(value: unknown, label: string, max = 200): string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= max, `${label}: требуется текст (до ${max} символов)`);
  return value.trim();
}
export function mentions(content: string): { kind: "a" | "u"; id: string }[] {
  return [...content.matchAll(/@\{([au]):([a-zA-Z0-9._-]+)\}/g)].map((m) => ({ kind: m[1] as "a" | "u", id: m[2]! }));
}
