import type { AgentAdapter } from "./agents/adapter.js";
import type { AgentProfiles } from "./config.js";
import { GitWorktreeManager } from "./git.js";
import type { RepositoryRegistry } from "./repositories.js";
import type { HubStore } from "./store.js";
import type { AgentId, DiscussionMessage, TaskRecord, TaskStatus } from "./types.js";

type MessageCallback = (message: DiscussionMessage) => Promise<void> | void;

function peerOf(agent: AgentId): AgentId {
  return agent === "codex" ? "claude" : "codex";
}

function requireStatus(task: TaskRecord, allowed: TaskStatus[]): void {
  if (!allowed.includes(task.status)) {
    throw new Error(`Task ${task.id} is '${task.status}', expected: ${allowed.join(" or ")}`);
  }
}

export function parseReviewDecision(content: string): "approve" | "changes_requested" {
  const decisions = [...content.matchAll(/DECISION:\s*(APPROVE|CHANGES_REQUESTED)/gi)];
  const last = decisions.at(-1)?.[1]?.toUpperCase();
  return last === "APPROVE" ? "approve" : "changes_requested";
}

export class TaskFlow {
  readonly #agents: Record<AgentId, AgentAdapter>;
  readonly #profiles: AgentProfiles;
  readonly #store: HubStore;
  readonly #repositories: RepositoryRegistry;
  readonly #git: GitWorktreeManager;
  readonly #approvalLeaseMs: number;

  constructor(options: {
    agents: Record<AgentId, AgentAdapter>;
    profiles: AgentProfiles;
    store: HubStore;
    repositories: RepositoryRegistry;
    git?: GitWorktreeManager;
    approvalLeaseMs?: number;
  }) {
    this.#agents = options.agents;
    this.#profiles = options.profiles;
    this.#store = options.store;
    this.#repositories = options.repositories;
    this.#git = options.git ?? new GitWorktreeManager();
    this.#approvalLeaseMs = options.approvalLeaseMs ?? Number(process.env.HUB_APPROVAL_LEASE_MS ?? 120_000);
  }

  propose(input: {
    sourceKey?: string;
    repository: string;
    goal: string;
    owner: AgentId;
    baseRef?: string;
    actor: string;
  }): TaskRecord {
    const repository = this.#repositories.get(input.repository);
    return this.#store.createTask({
      ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
      repository: input.repository,
      goal: input.goal,
      owner: input.owner,
      reviewer: peerOf(input.owner),
      baseRef: input.baseRef || repository.baseRef,
      actor: input.actor,
    });
  }

  async approve(taskId: string, actor: string): Promise<TaskRecord> {
    let task = this.#store.getTask(taskId);
    if (task.status === "proposed") {
      task = this.#store.transitionTask(task.id, ["proposed"], "approving");
      this.#store.addTaskEvent(task.id, "approval_started", actor, "Approval lease acquired");
    } else if (task.status === "approving") {
      const leaseAge = Date.now() - Date.parse(task.updatedAt);
      if (!Number.isFinite(leaseAge) || leaseAge < this.#approvalLeaseMs) {
        throw new Error(`Task ${task.id} approval is already in progress; retry after the approval lease expires`);
      }
      task = this.#store.claimTaskLease(task.id, "approving", task.updatedAt);
      this.#store.addTaskEvent(task.id, "approval_recovery_started", actor, `Recovering stale approval after ${leaseAge}ms`);
    } else {
      requireStatus(task, ["proposed", "approving"]);
    }
    const repository = this.#repositories.get(task.repository);
    try {
      const worktree = await this.#git.create(task.id, repository, task.baseRef);
      return this.#store.completeApproval(task.id, worktree.branchName, worktree.path, actor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.#store.failApproval(task.id, actor, message);
      } catch {
        // Preserve the original Git/database error; doctor/status can diagnose the current task state.
      }
      throw error;
    }
  }

  async implement(taskId: string, actor: string, onMessage?: MessageCallback): Promise<TaskRecord> {
    const task = this.#store.getTask(taskId);
    requireStatus(task, ["approved"]);
    return await this.#runImplementation(task, actor, false, onMessage);
  }

  async revise(taskId: string, actor: string, onMessage?: MessageCallback): Promise<TaskRecord> {
    const task = this.#store.getTask(taskId);
    requireStatus(task, ["changes_requested"]);
    return await this.#runImplementation(task, actor, true, onMessage);
  }

  async review(taskId: string, actor: string, onMessage?: MessageCallback): Promise<TaskRecord> {
    const task = this.#store.getTask(taskId);
    requireStatus(task, ["implemented"]);
    if (!task.worktreePath) {
      throw new Error(`Task ${task.id} has no worktree`);
    }
    this.#store.transitionTask(task.id, ["implemented"], "reviewing");
    try {
      const status = await this.#git.status(task.worktreePath);
      const diff = await this.#git.diff(task.worktreePath);
      const prompt = [
        `Review task ${task.id}.`,
        `Goal: ${task.goal}`,
        `Implementation agent: ${this.#profiles[task.owner].label}`,
        "Review correctness, regressions, tests, security, API/UI contract impact, and scope discipline.",
        "Do not edit files. End the response with exactly one final line:",
        "DECISION: APPROVE",
        "or",
        "DECISION: CHANGES_REQUESTED",
        "",
        "Git status:",
        status || "(clean)",
        "",
        "Diff:",
        diff || "(empty)",
      ].join("\n");
      const result = await this.#agents[task.reviewer].run({
        repositoryPath: task.worktreePath,
        prompt,
        mode: "read",
      });
      const decision = parseReviewDecision(result.content);
      const message: DiscussionMessage = {
        agent: task.reviewer,
        label: this.#profiles[task.reviewer].label,
        round: 1,
        content: result.content,
      };
      await onMessage?.(message);
      const updated = this.#store.updateTask(task.id, {
        status: decision === "approve" ? "ready_to_commit" : "changes_requested",
        reviewSummary: result.content,
      });
      this.#store.addTaskEvent(task.id, "reviewed", actor, `${task.reviewer}: ${decision}`);
      return updated;
    } catch (error) {
      this.#store.updateTask(task.id, { status: "implemented" });
      this.#store.addTaskEvent(task.id, "review_failed", actor, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async commit(taskId: string, actor: string): Promise<TaskRecord> {
    const task = this.#store.getTask(taskId);
    requireStatus(task, ["ready_to_commit"]);
    if (!task.worktreePath) {
      throw new Error(`Task ${task.id} has no worktree`);
    }
    const repository = this.#repositories.get(task.repository);
    this.#store.transitionTask(task.id, ["ready_to_commit"], "committing");
    try {
      const verification = await this.#git.verify(task.worktreePath, repository.verify);
      const subject = `Agent Hub ${task.id}: ${task.goal}`.slice(0, 120);
      const commitSha = await this.#git.commit(task.worktreePath, subject);
      const updated = this.#store.updateTask(task.id, {
        status: "committed",
        verificationSummary: verification,
        commitSha,
      });
      this.#store.addTaskEvent(task.id, "committed", actor, commitSha);
      return updated;
    } catch (error) {
      this.#store.updateTask(task.id, { status: "ready_to_commit" });
      this.#store.addTaskEvent(task.id, "commit_failed", actor, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  get(taskId: string): TaskRecord {
    return this.#store.getTask(taskId);
  }

  list(limit = 20): TaskRecord[] {
    return this.#store.listTasks(limit);
  }

  async #runImplementation(
    task: TaskRecord,
    actor: string,
    revision: boolean,
    onMessage?: MessageCallback,
  ): Promise<TaskRecord> {
    if (!task.worktreePath) {
      throw new Error(`Task ${task.id} has no worktree`);
    }
    const previousStatus = task.status;
    this.#store.transitionTask(task.id, [previousStatus], "implementing");
    try {
      const prompt = [
        `${revision ? "Revise" : "Implement"} task ${task.id}.`,
        `Goal: ${task.goal}`,
        revision ? `Reviewer feedback:\n${task.reviewSummary ?? "No review details were stored."}` : "",
        "Work only in the current worktree. Do not commit or push; Agent Hub owns Git lifecycle.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const result = await this.#agents[task.owner].run({
        repositoryPath: task.worktreePath,
        prompt,
        mode: "write",
      });
      const changes = await this.#git.status(task.worktreePath);
      if (!changes) {
        throw new Error(`Agent ${task.owner} completed without producing file changes`);
      }
      const message: DiscussionMessage = {
        agent: task.owner,
        label: this.#profiles[task.owner].label,
        round: revision ? 2 : 1,
        content: `${result.content}\n\nGit status:\n${changes}`,
      };
      await onMessage?.(message);
      const updated = this.#store.updateTask(task.id, {
        status: "implemented",
        implementationSummary: result.content,
      });
      this.#store.addTaskEvent(task.id, revision ? "revised" : "implemented", actor, changes);
      return updated;
    } catch (error) {
      this.#store.updateTask(task.id, { status: previousStatus });
      this.#store.addTaskEvent(task.id, "implementation_failed", actor, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
