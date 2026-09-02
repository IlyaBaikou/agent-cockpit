import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentId,
  ConversationArtifactRecord,
  ConversationMessageRecord,
  ConversationParticipant,
  ConversationRecord,
  ConversationStatus,
  DiscussionMessage,
  RunnerJobMode,
  RunnerJobRecord,
  RunnerJobStatus,
  TaskRecord,
  TaskStatus,
  WaitingFor,
} from "./types.js";

type ConversationRow = {
  id: string;
  topic: string;
  codex_repository: string;
  claude_repository: string;
  status: ConversationStatus;
  waiting_for: WaitingFor;
  created_at: string;
  updated_at: string;
};

type ConversationMessageRow = {
  id: number;
  conversation_id: string;
  actor: ConversationParticipant;
  label: string;
  kind: string;
  content: string;
  created_at: string;
};

type ConversationArtifactRow = {
  id: number;
  conversation_id: string;
  message_id: number | null;
  path: string;
  sha256: string;
  size: number;
  content: string | null;
  created_at: string;
};

type RunnerJobRow = {
  id: string;
  conversation_id: string;
  target_agent: AgentId;
  repository: string;
  mode: RunnerJobMode;
  prompt: string;
  remaining_turns: number;
  status: RunnerJobStatus;
  runner_id: string | null;
  lease_until: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  source_key: string | null;
  repository: string;
  goal: string;
  owner: AgentId;
  reviewer: AgentId;
  base_ref: string;
  branch_name: string | null;
  worktree_path: string | null;
  status: TaskStatus;
  implementation_summary: string | null;
  review_summary: string | null;
  verification_summary: string | null;
  commit_sha: string | null;
  created_at: string;
  updated_at: string;
};

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    ...(row.source_key ? { sourceKey: row.source_key } : {}),
    repository: row.repository,
    goal: row.goal,
    owner: row.owner,
    reviewer: row.reviewer,
    baseRef: row.base_ref,
    ...(row.branch_name ? { branchName: row.branch_name } : {}),
    ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
    status: row.status,
    ...(row.implementation_summary ? { implementationSummary: row.implementation_summary } : {}),
    ...(row.review_summary ? { reviewSummary: row.review_summary } : {}),
    ...(row.verification_summary ? { verificationSummary: row.verification_summary } : {}),
    ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    topic: row.topic,
    codexRepository: row.codex_repository,
    claudeRepository: row.claude_repository,
    status: row.status,
    waitingFor: row.waiting_for,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToConversationMessage(row: ConversationMessageRow): ConversationMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    actor: row.actor,
    label: row.label,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
  };
}

function rowToArtifact(row: ConversationArtifactRow): ConversationArtifactRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    path: row.path,
    sha256: row.sha256,
    size: row.size,
    ...(row.content === null ? {} : { content: row.content }),
    createdAt: row.created_at,
  };
}

function rowToRunnerJob(row: RunnerJobRow): RunnerJobRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    targetAgent: row.target_agent,
    repository: row.repository,
    mode: row.mode,
    prompt: row.prompt,
    remainingTurns: row.remaining_turns,
    status: row.status,
    ...(row.runner_id ? { runnerId: row.runner_id } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class HubStore {
  readonly #database: DatabaseSync;

  constructor(path = process.env.HUB_DB_PATH ?? "./data/hub.sqlite") {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.#database = new DatabaseSync(absolute);
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS discussions (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discussion_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        label TEXT NOT NULL,
        round INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (discussion_id) REFERENCES discussions(id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE,
        source_key TEXT UNIQUE,
        repository TEXT NOT NULL,
        goal TEXT NOT NULL,
        owner TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        branch_name TEXT,
        worktree_path TEXT,
        status TEXT NOT NULL,
        implementation_summary TEXT,
        review_summary TEXT,
        verification_summary TEXT,
        commit_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS task_events_task_id ON task_events(task_id, id);
      CREATE TABLE IF NOT EXISTS conversation_threads (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE,
        topic TEXT NOT NULL,
        codex_repository TEXT NOT NULL,
        claude_repository TEXT NOT NULL,
        status TEXT NOT NULL,
        waiting_for TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversation_threads(id)
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_thread ON conversation_messages(conversation_id, id);
      CREATE TABLE IF NOT EXISTS conversation_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        message_id INTEGER,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversation_threads(id),
        FOREIGN KEY (message_id) REFERENCES conversation_messages(id)
      );
      CREATE INDEX IF NOT EXISTS conversation_artifacts_thread ON conversation_artifacts(conversation_id, id);
      CREATE TABLE IF NOT EXISTS runner_jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE,
        conversation_id TEXT NOT NULL,
        target_agent TEXT NOT NULL,
        repository TEXT NOT NULL,
        mode TEXT NOT NULL,
        prompt TEXT NOT NULL,
        remaining_turns INTEGER NOT NULL,
        status TEXT NOT NULL,
        runner_id TEXT,
        lease_until TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversation_threads(id)
      );
      CREATE INDEX IF NOT EXISTS runner_jobs_claim ON runner_jobs(target_agent, status, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS runner_jobs_one_active_thread
        ON runner_jobs(conversation_id) WHERE status IN ('queued', 'claimed');
    `);
  }

  createTask(input: {
    sourceKey?: string;
    repository: string;
    goal: string;
    owner: AgentId;
    reviewer: AgentId;
    baseRef: string;
    actor: string;
  }): TaskRecord {
    if (input.sourceKey) {
      const existing = this.#database.prepare("SELECT * FROM tasks WHERE source_key = ?").get(input.sourceKey) as
        | TaskRow
        | undefined;
      if (existing) {
        return rowToTask(existing);
      }
    }

    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database
        .prepare(
          `INSERT INTO tasks
           (source_key, repository, goal, owner, reviewer, base_ref, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
        )
        .run(input.sourceKey ?? null, input.repository, input.goal, input.owner, input.reviewer, input.baseRef, now, now);
      const id = `AH-${String(result.lastInsertRowid).padStart(4, "0")}`;
      this.#database.prepare("UPDATE tasks SET id = ? WHERE sequence = ?").run(id, result.lastInsertRowid);
      this.#database
        .prepare(
          `INSERT INTO task_events (task_id, type, actor, content, created_at)
           VALUES (?, 'proposed', ?, ?, ?)`,
        )
        .run(id, input.actor, input.goal, now);
      this.#database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getTask(id: string): TaskRecord {
    const row = this.#database.prepare("SELECT * FROM tasks WHERE id = ?").get(id.toUpperCase()) as TaskRow | undefined;
    if (!row) {
      throw new Error(`Unknown task '${id}'`);
    }
    return rowToTask(row);
  }

  listTasks(limit = 20): TaskRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM tasks WHERE id IS NOT NULL ORDER BY sequence DESC LIMIT ?")
      .all(limit) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  updateTask(
    id: string,
    patch: Partial<
      Pick<
        TaskRecord,
        | "status"
        | "branchName"
        | "worktreePath"
        | "implementationSummary"
        | "reviewSummary"
        | "verificationSummary"
        | "commitSha"
      >
    >,
  ): TaskRecord {
    const columns: Record<string, string> = {
      status: "status",
      branchName: "branch_name",
      worktreePath: "worktree_path",
      implementationSummary: "implementation_summary",
      reviewSummary: "review_summary",
      verificationSummary: "verification_summary",
      commitSha: "commit_sha",
    };
    const entries = Object.entries(patch).filter((entry) => entry[1] !== undefined);
    if (entries.length === 0) {
      return this.getTask(id);
    }
    const assignments = entries.map(([key]) => `${columns[key]} = ?`);
    const values = entries.map((entry) => entry[1]);
    assignments.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id.toUpperCase());
    const result = this.#database.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    if (result.changes === 0) {
      throw new Error(`Unknown task '${id}'`);
    }
    return this.getTask(id);
  }

  transitionTask(id: string, from: TaskStatus[], to: TaskStatus): TaskRecord {
    if (from.length === 0) {
      throw new Error("At least one source status is required");
    }
    const normalizedId = id.toUpperCase();
    const placeholders = from.map(() => "?").join(", ");
    const result = this.#database
      .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(to, new Date().toISOString(), normalizedId, ...from);
    if (result.changes === 0) {
      const current = this.getTask(normalizedId);
      throw new Error(`Task ${current.id} is '${current.status}', expected: ${from.join(" or ")}`);
    }
    return this.getTask(normalizedId);
  }

  claimTaskLease(id: string, status: TaskStatus, expectedUpdatedAt: string): TaskRecord {
    const normalizedId = id.toUpperCase();
    const result = this.#database
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?")
      .run(new Date().toISOString(), normalizedId, status, expectedUpdatedAt);
    if (result.changes === 0) {
      const current = this.getTask(normalizedId);
      throw new Error(`Task ${current.id} lease was already claimed or status changed to '${current.status}'`);
    }
    return this.getTask(normalizedId);
  }

  completeApproval(id: string, branchName: string, worktreePath: string, actor: string): TaskRecord {
    const normalizedId = id.toUpperCase();
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database
        .prepare(
          `UPDATE tasks
           SET status = 'approved', branch_name = ?, worktree_path = ?, updated_at = ?
           WHERE id = ? AND status = 'approving'`,
        )
        .run(branchName, worktreePath, now, normalizedId);
      if (result.changes === 0) {
        throw new Error(`Task ${normalizedId} is no longer awaiting approval completion`);
      }
      this.#database
        .prepare(
          `INSERT INTO task_events (task_id, type, actor, content, created_at)
           VALUES (?, 'approved', ?, ?, ?)`,
        )
        .run(normalizedId, actor, `Created or recovered ${branchName} at ${worktreePath}`, now);
      this.#database.exec("COMMIT");
      return this.getTask(normalizedId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  failApproval(id: string, actor: string, content: string): TaskRecord {
    const normalizedId = id.toUpperCase();
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database
        .prepare("UPDATE tasks SET status = 'proposed', updated_at = ? WHERE id = ? AND status = 'approving'")
        .run(now, normalizedId);
      if (result.changes === 0) {
        throw new Error(`Task ${normalizedId} is no longer in approving state`);
      }
      this.#database
        .prepare(
          `INSERT INTO task_events (task_id, type, actor, content, created_at)
           VALUES (?, 'approval_failed', ?, ?, ?)`,
        )
        .run(normalizedId, actor, content, now);
      this.#database.exec("COMMIT");
      return this.getTask(normalizedId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  addTaskEvent(taskId: string, type: string, actor: string, content: string): void {
    this.#database
      .prepare(
        `INSERT INTO task_events (task_id, type, actor, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(taskId.toUpperCase(), type, actor, content, new Date().toISOString());
  }

  createDiscussion(id: string, repository: string, prompt: string): void {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO discussions
         (id, repository, prompt, status, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repository = excluded.repository,
           prompt = excluded.prompt,
           status = 'running',
           updated_at = excluded.updated_at`,
      )
      .run(id, repository, prompt, now, now);
  }

  addMessage(discussionId: string, message: DiscussionMessage): void {
    this.#database
      .prepare(
        `INSERT INTO messages
         (discussion_id, agent, label, round, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(discussionId, message.agent, message.label, message.round, message.content, new Date().toISOString());
  }

  finishDiscussion(id: string, status: "completed" | "failed"): void {
    this.#database
      .prepare("UPDATE discussions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  createConversation(input: {
    topic: string;
    codexRepository: string;
    claudeRepository: string;
  }): ConversationRecord {
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database
        .prepare(
          `INSERT INTO conversation_threads
           (topic, codex_repository, claude_repository, status, waiting_for, created_at, updated_at)
           VALUES (?, ?, ?, 'open', 'human', ?, ?)`,
        )
        .run(input.topic, input.codexRepository, input.claudeRepository, now, now);
      const id = `CHAT-${String(result.lastInsertRowid).padStart(4, "0")}`;
      this.#database.prepare("UPDATE conversation_threads SET id = ? WHERE sequence = ?").run(id, result.lastInsertRowid);
      this.#database.exec("COMMIT");
      return this.getConversation(id);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getConversation(id: string): ConversationRecord {
    const row = this.#database
      .prepare("SELECT * FROM conversation_threads WHERE id = ?")
      .get(id.toUpperCase()) as ConversationRow | undefined;
    if (!row) {
      throw new Error(`Unknown conversation '${id}'`);
    }
    return rowToConversation(row);
  }

  listConversations(limit = 20): ConversationRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM conversation_threads WHERE id IS NOT NULL ORDER BY sequence DESC LIMIT ?")
      .all(limit) as unknown as ConversationRow[];
    return rows.map(rowToConversation);
  }

  setConversationState(id: string, status: ConversationStatus, waitingFor: WaitingFor): ConversationRecord {
    const result = this.#database
      .prepare("UPDATE conversation_threads SET status = ?, waiting_for = ?, updated_at = ? WHERE id = ?")
      .run(status, waitingFor, new Date().toISOString(), id.toUpperCase());
    if (result.changes === 0) {
      throw new Error(`Unknown conversation '${id}'`);
    }
    return this.getConversation(id);
  }

  addConversationMessage(input: {
    conversationId: string;
    actor: ConversationParticipant;
    label: string;
    kind: string;
    content: string;
  }): ConversationMessageRecord {
    const conversationId = input.conversationId.toUpperCase();
    this.getConversation(conversationId);
    const result = this.#database
      .prepare(
        `INSERT INTO conversation_messages
         (conversation_id, actor, label, kind, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, input.actor, input.label, input.kind, input.content, new Date().toISOString());
    const row = this.#database
      .prepare("SELECT * FROM conversation_messages WHERE id = ?")
      .get(result.lastInsertRowid) as ConversationMessageRow;
    return rowToConversationMessage(row);
  }

  listConversationMessages(conversationId: string): ConversationMessageRecord[] {
    this.getConversation(conversationId);
    const rows = this.#database
      .prepare("SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY id")
      .all(conversationId.toUpperCase()) as unknown as ConversationMessageRow[];
    return rows.map(rowToConversationMessage);
  }

  addConversationArtifact(input: {
    conversationId: string;
    messageId?: number;
    path: string;
    sha256: string;
    size: number;
    content?: string;
  }): ConversationArtifactRecord {
    const result = this.#database
      .prepare(
        `INSERT INTO conversation_artifacts
         (conversation_id, message_id, path, sha256, size, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId.toUpperCase(),
        input.messageId ?? null,
        input.path,
        input.sha256,
        input.size,
        input.content ?? null,
        new Date().toISOString(),
      );
    const row = this.#database
      .prepare("SELECT * FROM conversation_artifacts WHERE id = ?")
      .get(result.lastInsertRowid) as ConversationArtifactRow;
    return rowToArtifact(row);
  }

  listConversationArtifacts(conversationId: string): ConversationArtifactRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM conversation_artifacts WHERE conversation_id = ? ORDER BY id")
      .all(conversationId.toUpperCase()) as unknown as ConversationArtifactRow[];
    return rows.map(rowToArtifact);
  }

  enqueueRunnerJob(input: {
    conversationId: string;
    targetAgent: AgentId;
    repository: string;
    mode: RunnerJobMode;
    prompt: string;
    remainingTurns: number;
  }): RunnerJobRecord {
    const conversationId = input.conversationId.toUpperCase();
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database
        .prepare(
          `INSERT INTO runner_jobs
           (conversation_id, target_agent, repository, mode, prompt, remaining_turns, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          conversationId,
          input.targetAgent,
          input.repository,
          input.mode,
          input.prompt,
          input.remainingTurns,
          now,
          now,
        );
      const id = `JOB-${String(result.lastInsertRowid).padStart(6, "0")}`;
      this.#database.prepare("UPDATE runner_jobs SET id = ? WHERE sequence = ?").run(id, result.lastInsertRowid);
      this.#database
        .prepare("UPDATE conversation_threads SET status = 'running', waiting_for = ?, updated_at = ? WHERE id = ?")
        .run(input.targetAgent, now, conversationId);
      this.#database.exec("COMMIT");
      return this.getRunnerJob(id);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getRunnerJob(id: string): RunnerJobRecord {
    const row = this.#database.prepare("SELECT * FROM runner_jobs WHERE id = ?").get(id.toUpperCase()) as
      | RunnerJobRow
      | undefined;
    if (!row) {
      throw new Error(`Unknown runner job '${id}'`);
    }
    return rowToRunnerJob(row);
  }

  claimRunnerJob(input: {
    runnerId: string;
    agent: AgentId;
    leaseMs: number;
  }): RunnerJobRecord | undefined {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + input.leaseMs).toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `UPDATE runner_jobs
           SET status = 'queued', runner_id = NULL, lease_until = NULL, updated_at = ?
           WHERE status = 'claimed' AND lease_until < ?`,
        )
        .run(nowIso, nowIso);
      const owned = this.#database
        .prepare(
          `SELECT * FROM runner_jobs
           WHERE target_agent = ? AND runner_id = ? AND status = 'claimed' AND lease_until >= ?
           ORDER BY sequence LIMIT 1`,
        )
        .get(input.agent, input.runnerId, nowIso) as RunnerJobRow | undefined;
      if (owned) {
        this.#database.exec("COMMIT");
        return rowToRunnerJob(owned);
      }
      const row = this.#database
        .prepare("SELECT * FROM runner_jobs WHERE target_agent = ? AND status = 'queued' ORDER BY sequence LIMIT 1")
        .get(input.agent) as RunnerJobRow | undefined;
      if (!row) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      const changed = this.#database
        .prepare(
          `UPDATE runner_jobs SET status = 'claimed', runner_id = ?, lease_until = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(input.runnerId, leaseUntil, nowIso, row.id);
      if (changed.changes !== 1) {
        throw new Error(`Runner job ${row.id} was claimed concurrently`);
      }
      this.#database.exec("COMMIT");
      return this.getRunnerJob(row.id);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  completeRunnerJob(id: string, runnerId: string): RunnerJobRecord {
    const result = this.#database
      .prepare(
        `UPDATE runner_jobs
         SET status = 'completed', lease_until = NULL, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND runner_id = ?`,
      )
      .run(new Date().toISOString(), id.toUpperCase(), runnerId);
    if (result.changes !== 1) {
      throw new Error(`Runner ${runnerId} does not own claimed job ${id}`);
    }
    return this.getRunnerJob(id);
  }

  ping(): void {
    this.#database.prepare("SELECT 1").get();
  }

  failRunnerJob(id: string, runnerId: string, error: string): RunnerJobRecord {
    const result = this.#database
      .prepare(
        `UPDATE runner_jobs
         SET status = 'failed', error = ?, lease_until = NULL, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND runner_id = ?`,
      )
      .run(error, new Date().toISOString(), id.toUpperCase(), runnerId);
    if (result.changes !== 1) {
      throw new Error(`Runner ${runnerId} does not own claimed job ${id}`);
    }
    return this.getRunnerJob(id);
  }

  close(): void {
    this.#database.close();
  }
}
