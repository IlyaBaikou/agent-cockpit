export type AgentId = "codex" | "claude";

export type ConversationParticipant = AgentId | "human" | "system";
export type ConversationStatus = "open" | "running" | "waiting" | "completed" | "failed";
export type WaitingFor = AgentId | "human" | "none";
export type RunnerJobMode = "read" | "write";
export type RunnerJobStatus = "queued" | "claimed" | "completed" | "failed";

export type TaskStatus =
  | "proposed"
  | "approving"
  | "approved"
  | "implementing"
  | "implemented"
  | "reviewing"
  | "changes_requested"
  | "ready_to_commit"
  | "committing"
  | "committed"
  | "failed";

export type TaskRecord = {
  id: string;
  sourceKey?: string;
  repository: string;
  goal: string;
  owner: AgentId;
  reviewer: AgentId;
  baseRef: string;
  branchName?: string;
  worktreePath?: string;
  status: TaskStatus;
  implementationSummary?: string;
  reviewSummary?: string;
  verificationSummary?: string;
  commitSha?: string;
  createdAt: string;
  updatedAt: string;
};

export type HubCommand =
  | { kind: "help" }
  | { kind: "ask"; agent: AgentId; repository: string; prompt: string }
  | { kind: "discuss"; repository: string; prompt: string; rounds: number }
  | { kind: "propose"; repository: string; owner: AgentId; baseRef: string; goal: string }
  | { kind: "approve"; taskId: string }
  | { kind: "implement"; taskId: string }
  | { kind: "review"; taskId: string }
  | { kind: "revise"; taskId: string }
  | { kind: "commit"; taskId: string }
  | { kind: "status"; taskId: string }
  | { kind: "tasks" }
  | {
      kind: "open";
      target: AgentId;
      codexRepository: string;
      claudeRepository: string;
      mode: RunnerJobMode;
      turns: number;
      prompt: string;
    }
  | {
      kind: "reply";
      conversationId: string;
      target: AgentId;
      repository?: string;
      mode: RunnerJobMode;
      turns: number;
      prompt: string;
    }
  | { kind: "thread"; conversationId: string }
  | { kind: "threads" }
  | { kind: "close"; conversationId: string };

export type ConversationRecord = {
  id: string;
  topic: string;
  codexRepository: string;
  claudeRepository: string;
  status: ConversationStatus;
  waitingFor: WaitingFor;
  createdAt: string;
  updatedAt: string;
};

export type ConversationMessageRecord = {
  id: number;
  conversationId: string;
  actor: ConversationParticipant;
  label: string;
  kind: string;
  content: string;
  createdAt: string;
};

export type ConversationArtifactRecord = {
  id: number;
  conversationId: string;
  messageId?: number;
  path: string;
  sha256: string;
  size: number;
  content?: string;
  createdAt: string;
};

export type RunnerJobRecord = {
  id: string;
  conversationId: string;
  targetAgent: AgentId;
  repository: string;
  mode: RunnerJobMode;
  prompt: string;
  remainingTurns: number;
  status: RunnerJobStatus;
  runnerId?: string;
  leaseUntil?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type DiscussionMessage = {
  agent: AgentId;
  label: string;
  round: number;
  content: string;
};

export type AgentProfile = {
  label: string;
  provider: string;
  role: string;
};
