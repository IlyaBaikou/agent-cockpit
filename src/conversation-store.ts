import type {
  AgentId,
  ConversationArtifactRecord,
  ConversationMessageRecord,
  ConversationParticipant,
  ConversationRecord,
  ConversationStatus,
  RunnerJobMode,
  RunnerJobRecord,
  WaitingFor,
} from "./types.js";

export type Awaitable<T> = T | Promise<T>;

export interface ConversationStore {
  ping(): Awaitable<void>;
  createConversation(input: {
    topic: string;
    codexRepository: string;
    claudeRepository: string;
  }): Awaitable<ConversationRecord>;
  getConversation(id: string): Awaitable<ConversationRecord>;
  listConversations(limit?: number): Awaitable<ConversationRecord[]>;
  setConversationState(
    id: string,
    status: ConversationStatus,
    waitingFor: WaitingFor,
  ): Awaitable<ConversationRecord>;
  addConversationMessage(input: {
    conversationId: string;
    actor: ConversationParticipant;
    label: string;
    kind: string;
    content: string;
  }): Awaitable<ConversationMessageRecord>;
  listConversationMessages(conversationId: string): Awaitable<ConversationMessageRecord[]>;
  addConversationArtifact(input: {
    conversationId: string;
    messageId?: number;
    path: string;
    sha256: string;
    size: number;
    content?: string;
  }): Awaitable<ConversationArtifactRecord>;
  listConversationArtifacts(conversationId: string): Awaitable<ConversationArtifactRecord[]>;
  enqueueRunnerJob(input: {
    conversationId: string;
    targetAgent: AgentId;
    repository: string;
    mode: RunnerJobMode;
    prompt: string;
    remainingTurns: number;
  }): Awaitable<RunnerJobRecord>;
  getRunnerJob(id: string): Awaitable<RunnerJobRecord>;
  claimRunnerJob(input: {
    runnerId: string;
    agent: AgentId;
    leaseMs: number;
  }): Awaitable<RunnerJobRecord | undefined>;
  completeRunnerJob(id: string, runnerId: string): Awaitable<RunnerJobRecord>;
  failRunnerJob(id: string, runnerId: string, error: string): Awaitable<RunnerJobRecord>;
  close(): Awaitable<void>;
}
