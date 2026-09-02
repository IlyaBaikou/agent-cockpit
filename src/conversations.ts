import type { AgentProfiles } from "./config.js";
import type { ConversationStore } from "./conversation-store.js";
import type {
  AgentId,
  ConversationArtifactRecord,
  ConversationMessageRecord,
  ConversationRecord,
  RunnerJobMode,
  RunnerJobRecord,
  WaitingFor,
} from "./types.js";

export type RunnerArtifactInput = {
  path: string;
  sha256: string;
  size: number;
  content?: string;
};

export type ConversationSnapshot = {
  conversation: ConversationRecord;
  messages: ConversationMessageRecord[];
  artifacts: ConversationArtifactRecord[];
};

function parseHandoff(content: string): WaitingFor {
  const finalLine = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const value = /^HANDOFF:\s*(codex|claude|human|done)$/i.exec(finalLine)?.[1]?.toLowerCase();
  return value === "done" ? "none" : value === "codex" || value === "claude" || value === "human" ? value : "human";
}

function clampTurns(turns: number): number {
  if (!Number.isInteger(turns) || turns < 1 || turns > 12) {
    throw new Error("turns must be an integer between 1 and 12");
  }
  return turns;
}

function truncate(input: string, maxLength: number): string {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength)}\n[truncated by Agent Hub]`;
}

export class ConversationHub {
  readonly #store: ConversationStore;
  readonly #profiles: AgentProfiles;

  constructor(options: { store: ConversationStore; profiles: AgentProfiles }) {
    this.#store = options.store;
    this.#profiles = options.profiles;
  }

  async open(input: {
    topic: string;
    codexRepository: string;
    claudeRepository: string;
    target: AgentId;
    mode: RunnerJobMode;
    turns: number;
    actor?: string;
  }): Promise<ConversationSnapshot> {
    const conversation = await this.#store.createConversation({
      topic: input.topic,
      codexRepository: input.codexRepository,
      claudeRepository: input.claudeRepository,
    });
    await this.#store.addConversationMessage({
      conversationId: conversation.id,
      actor: "human",
      label: input.actor ?? "Human",
      kind: "request",
      content: input.topic,
    });
    await this.#enqueue(conversation.id, input.target, input.mode, clampTurns(input.turns));
    return await this.get(conversation.id);
  }

  async reply(input: {
    conversationId: string;
    target: AgentId;
    repository?: string;
    mode: RunnerJobMode;
    turns: number;
    content: string;
    actor?: string;
  }): Promise<ConversationSnapshot> {
    const conversation = await this.#store.getConversation(input.conversationId);
    if (conversation.status === "running") {
      throw new Error(`Conversation ${conversation.id} already has an active runner job`);
    }
    if (conversation.status === "completed") {
      await this.#store.setConversationState(conversation.id, "open", "human");
    }
    await this.#store.addConversationMessage({
      conversationId: conversation.id,
      actor: "human",
      label: input.actor ?? "Human",
      kind: "reply",
      content: input.content,
    });
    await this.#enqueue(conversation.id, input.target, input.mode, clampTurns(input.turns), input.repository);
    return await this.get(conversation.id);
  }

  async get(id: string): Promise<ConversationSnapshot> {
    return {
      conversation: await this.#store.getConversation(id),
      messages: await this.#store.listConversationMessages(id),
      artifacts: await this.#store.listConversationArtifacts(id),
    };
  }

  async list(limit = 20): Promise<ConversationRecord[]> {
    return await this.#store.listConversations(limit);
  }

  async close(id: string): Promise<ConversationSnapshot> {
    const conversation = await this.#store.getConversation(id);
    if (conversation.status === "running") {
      throw new Error(`Conversation ${conversation.id} has an active runner job and cannot be closed`);
    }
    await this.#store.addConversationMessage({
      conversationId: conversation.id,
      actor: "system",
      label: "Agent Hub",
      kind: "closed",
      content: "Conversation closed by a human.",
    });
    await this.#store.setConversationState(conversation.id, "completed", "none");
    return await this.get(conversation.id);
  }

  async completeJob(input: {
    jobId: string;
    runnerId: string;
    content: string;
    artifacts?: RunnerArtifactInput[];
  }): Promise<ConversationSnapshot> {
    const job = await this.#store.getRunnerJob(input.jobId);
    if (job.status === "completed" && job.runnerId === input.runnerId) {
      return await this.get(job.conversationId);
    }
    if (job.status !== "claimed" || job.runnerId !== input.runnerId) {
      throw new Error(`Runner ${input.runnerId} does not own claimed job ${job.id}`);
    }
    const message = await this.#store.addConversationMessage({
      conversationId: job.conversationId,
      actor: job.targetAgent,
      label: this.#profiles[job.targetAgent].label,
      kind: job.mode === "write" ? "implementation" : "response",
      content: input.content,
    });
    for (const artifact of input.artifacts ?? []) {
      await this.#store.addConversationArtifact({
        conversationId: job.conversationId,
        messageId: message.id,
        path: artifact.path,
        sha256: artifact.sha256,
        size: artifact.size,
        ...(artifact.content === undefined ? {} : { content: artifact.content }),
      });
    }
    await this.#store.completeRunnerJob(job.id, input.runnerId);

    const handoff = parseHandoff(input.content);
    if (handoff === "none") {
      await this.#store.setConversationState(job.conversationId, "completed", "none");
    } else if ((handoff === "codex" || handoff === "claude") && job.remainingTurns > 1) {
      await this.#enqueue(job.conversationId, handoff, "read", job.remainingTurns - 1);
    } else {
      await this.#store.setConversationState(job.conversationId, "waiting", "human");
      if (handoff !== "human" && job.remainingTurns <= 1) {
        await this.#store.addConversationMessage({
          conversationId: job.conversationId,
          actor: "system",
          label: "Agent Hub",
          kind: "turn_limit",
          content: `Automatic handoff to ${handoff} paused because the turn budget was exhausted.`,
        });
      }
    }
    return await this.get(job.conversationId);
  }

  async failJob(input: { jobId: string; runnerId: string; error: string }): Promise<ConversationSnapshot> {
    const current = await this.#store.getRunnerJob(input.jobId);
    if ((current.status === "completed" || current.status === "failed") && current.runnerId === input.runnerId) {
      return await this.get(current.conversationId);
    }
    const job = await this.#store.failRunnerJob(input.jobId, input.runnerId, input.error);
    await this.#store.addConversationMessage({
      conversationId: job.conversationId,
      actor: "system",
      label: "Agent Hub",
      kind: "runner_error",
      content: `${job.targetAgent} runner failed: ${input.error}`,
    });
    await this.#store.setConversationState(job.conversationId, "failed", "human");
    return await this.get(job.conversationId);
  }

  async #enqueue(
    conversationId: string,
    target: AgentId,
    mode: RunnerJobMode,
    remainingTurns: number,
    repositoryOverride?: string,
  ): Promise<RunnerJobRecord> {
    const conversation = await this.#store.getConversation(conversationId);
    const repository = repositoryOverride ??
      (target === "codex" ? conversation.codexRepository : conversation.claudeRepository);
    return await this.#store.enqueueRunnerJob({
      conversationId,
      targetAgent: target,
      repository,
      mode,
      prompt: await this.#buildPrompt(conversationId, target, mode, repository),
      remainingTurns,
    });
  }

  async #buildPrompt(conversationId: string, target: AgentId, mode: RunnerJobMode, repository: string): Promise<string> {
    const conversation = await this.#store.getConversation(conversationId);
    const messages = await this.#store.listConversationMessages(conversationId);
    const artifacts = await this.#store.listConversationArtifacts(conversationId);
    const transcript = messages
      .map((message) => `[${message.label} · ${message.kind}]\n${truncate(message.content, 16_000)}`)
      .join("\n\n---\n\n");
    const artifactContext = artifacts.length
      ? artifacts
          .slice(-10)
          .map((artifact) => {
            const header = `${artifact.path} (${artifact.size} bytes, sha256 ${artifact.sha256})`;
            return artifact.content ? `${header}\n${truncate(artifact.content, 24_000)}` : header;
          })
          .join("\n\n---\n\n")
      : "No shared artifacts yet.";

    return [
      `Persistent Agent Hub conversation ${conversation.id}.`,
      `Topic: ${conversation.topic}`,
      `You are ${this.#profiles[target].label}; your repository for this turn is '${repository}'.`,
      mode === "write"
        ? "This turn was explicitly approved for edits in an isolated runner worktree. Make the requested changes and list every shareable file as 'ARTIFACT: relative/path'. Do not commit or push."
        : "This is a read-only turn. Inspect code and shared artifacts, answer the latest message, and do not edit files.",
      "Continue from the full history. Resolve settled points instead of restarting the discussion.",
      "End with exactly one routing line: HANDOFF: codex, HANDOFF: claude, HANDOFF: human, or HANDOFF: done.",
      "Use HANDOFF: human for approvals, missing product decisions, or when an edit must be explicitly authorized.",
      "",
      "Conversation history:",
      transcript || "No messages.",
      "",
      "Shared artifacts:",
      artifactContext,
    ].join("\n");
  }
}
