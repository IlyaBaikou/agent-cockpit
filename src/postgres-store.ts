import pg, { type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import type { ConversationStore } from "./conversation-store.js";
import type {
  AgentId,
  ConversationArtifactRecord,
  ConversationMessageRecord,
  ConversationParticipant,
  ConversationRecord,
  ConversationStatus,
  RunnerJobMode,
  RunnerJobRecord,
  RunnerJobStatus,
  WaitingFor,
} from "./types.js";

const { Pool } = pg;

type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
};

type PoolLike = Queryable & {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};

type ConversationRow = {
  id: string;
  topic: string;
  codex_repository: string;
  claude_repository: string;
  status: ConversationStatus;
  waiting_for: WaitingFor;
  created_at: Date | string;
  updated_at: Date | string;
};

type MessageRow = {
  id: number | string;
  conversation_id: string;
  actor: ConversationParticipant;
  label: string;
  kind: string;
  content: string;
  created_at: Date | string;
};

type ArtifactRow = {
  id: number | string;
  conversation_id: string;
  message_id: number | string | null;
  path: string;
  sha256: string;
  size: number | string;
  content: string | null;
  created_at: Date | string;
};

type JobRow = {
  id: string;
  conversation_id: string;
  target_agent: AgentId;
  repository: string;
  mode: RunnerJobMode;
  prompt: string;
  remaining_turns: number;
  status: RunnerJobStatus;
  runner_id: string | null;
  lease_until: Date | string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const migration = `
  CREATE TABLE IF NOT EXISTS hub_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS conversation_threads (
    sequence BIGSERIAL PRIMARY KEY,
    id TEXT UNIQUE,
    topic TEXT NOT NULL,
    codex_repository TEXT NOT NULL,
    claude_repository TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'running', 'waiting', 'completed', 'failed')),
    waiting_for TEXT NOT NULL CHECK (waiting_for IN ('codex', 'claude', 'human', 'none')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS conversation_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation_threads(id),
    actor TEXT NOT NULL CHECK (actor IN ('codex', 'claude', 'human', 'system')),
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS conversation_messages_thread
    ON conversation_messages(conversation_id, id);

  CREATE TABLE IF NOT EXISTS conversation_artifacts (
    id BIGSERIAL PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation_threads(id),
    message_id BIGINT REFERENCES conversation_messages(id),
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size BIGINT NOT NULL,
    content TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS conversation_artifacts_thread
    ON conversation_artifacts(conversation_id, id);

  CREATE TABLE IF NOT EXISTS runner_jobs (
    sequence BIGSERIAL PRIMARY KEY,
    id TEXT UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversation_threads(id),
    target_agent TEXT NOT NULL CHECK (target_agent IN ('codex', 'claude')),
    repository TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
    prompt TEXT NOT NULL,
    remaining_turns INTEGER NOT NULL CHECK (remaining_turns BETWEEN 1 AND 12),
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'failed')),
    runner_id TEXT,
    lease_until TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS runner_jobs_claim
    ON runner_jobs(target_agent, status, sequence);
  CREATE UNIQUE INDEX IF NOT EXISTS runner_jobs_one_active_thread
    ON runner_jobs(conversation_id) WHERE status IN ('queued', 'claimed');
`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function conversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    topic: row.topic,
    codexRepository: row.codex_repository,
    claudeRepository: row.claude_repository,
    status: row.status,
    waitingFor: row.waiting_for,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function message(row: MessageRow): ConversationMessageRecord {
  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    actor: row.actor,
    label: row.label,
    kind: row.kind,
    content: row.content,
    createdAt: iso(row.created_at),
  };
}

function artifact(row: ArtifactRow): ConversationArtifactRecord {
  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    ...(row.message_id === null ? {} : { messageId: Number(row.message_id) }),
    path: row.path,
    sha256: row.sha256,
    size: Number(row.size),
    ...(row.content === null ? {} : { content: row.content }),
    createdAt: iso(row.created_at),
  };
}

function job(row: JobRow): RunnerJobRecord {
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
    ...(row.lease_until ? { leaseUntil: iso(row.lease_until) } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function requireRow<R extends QueryResultRow>(result: QueryResult<R>, description: string): R {
  const row = result.rows[0];
  if (!row) {
    throw new Error(description);
  }
  return row;
}

export class PostgresConversationStore implements ConversationStore {
  readonly #pool: PoolLike;
  readonly #supportsSkipLocked: boolean;

  constructor(pool?: PoolLike, options: { supportsSkipLocked?: boolean } = {}) {
    this.#supportsSkipLocked = options.supportsSkipLocked ?? true;
    if (pool) {
      this.#pool = pool;
      return;
    }
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
      throw new Error("DATABASE_URL is required for the cloud Hub");
    }
    const config: PoolConfig = {
      connectionString,
      max: Number(process.env.HUB_DB_POOL_SIZE ?? 10),
      connectionTimeoutMillis: Number(process.env.HUB_DB_CONNECT_TIMEOUT_MS ?? 10_000),
      idleTimeoutMillis: 30_000,
      application_name: "animaplay-agent-hub",
    };
    this.#pool = new Pool(config);
  }

  async migrate(options: { useAdvisoryLock?: boolean } = {}): Promise<void> {
    const client = await this.#pool.connect();
    try {
      if (options.useAdvisoryLock !== false) {
        await client.query("SELECT pg_advisory_lock(hashtext('animaplay-agent-hub-schema'))");
      }
      await client.query("BEGIN");
      await client.query(migration);
      await client.query("INSERT INTO hub_schema_migrations(version) VALUES (1) ON CONFLICT (version) DO NOTHING");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (options.useAdvisoryLock !== false) {
        await client.query("SELECT pg_advisory_unlock(hashtext('animaplay-agent-hub-schema'))").catch(() => undefined);
      }
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  async createConversation(input: {
    topic: string;
    codexRepository: string;
    claudeRepository: string;
  }): Promise<ConversationRecord> {
    return await this.#transaction(async (client) => {
      const inserted = await client.query<{ sequence: string }>(
        `INSERT INTO conversation_threads
         (topic, codex_repository, claude_repository, status, waiting_for)
         VALUES ($1, $2, $3, 'open', 'human') RETURNING sequence`,
        [input.topic, input.codexRepository, input.claudeRepository],
      );
      const sequence = requireRow(inserted, "Failed to create conversation").sequence;
      const id = `CHAT-${String(sequence).padStart(4, "0")}`;
      const updated = await client.query<ConversationRow>(
        "UPDATE conversation_threads SET id = $1 WHERE sequence = $2 RETURNING *",
        [id, sequence],
      );
      return conversation(requireRow(updated, "Failed to assign conversation id"));
    });
  }

  async getConversation(id: string): Promise<ConversationRecord> {
    const normalized = id.toUpperCase();
    const result = await this.#pool.query<ConversationRow>("SELECT * FROM conversation_threads WHERE id = $1", [normalized]);
    return conversation(requireRow(result, `Unknown conversation '${id}'`));
  }

  async listConversations(limit = 20): Promise<ConversationRecord[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 20;
    const result = await this.#pool.query<ConversationRow>(
      "SELECT * FROM conversation_threads WHERE id IS NOT NULL ORDER BY sequence DESC LIMIT $1",
      [safeLimit],
    );
    return result.rows.map(conversation);
  }

  async setConversationState(
    id: string,
    status: ConversationStatus,
    waitingFor: WaitingFor,
  ): Promise<ConversationRecord> {
    const result = await this.#pool.query<ConversationRow>(
      `UPDATE conversation_threads SET status = $1, waiting_for = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, waitingFor, id.toUpperCase()],
    );
    return conversation(requireRow(result, `Unknown conversation '${id}'`));
  }

  async addConversationMessage(input: {
    conversationId: string;
    actor: ConversationParticipant;
    label: string;
    kind: string;
    content: string;
  }): Promise<ConversationMessageRecord> {
    const result = await this.#pool.query<MessageRow>(
      `INSERT INTO conversation_messages (conversation_id, actor, label, kind, content)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.conversationId.toUpperCase(), input.actor, input.label, input.kind, input.content],
    );
    return message(requireRow(result, `Unknown conversation '${input.conversationId}'`));
  }

  async listConversationMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
    await this.getConversation(conversationId);
    const result = await this.#pool.query<MessageRow>(
      "SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY id",
      [conversationId.toUpperCase()],
    );
    return result.rows.map(message);
  }

  async addConversationArtifact(input: {
    conversationId: string;
    messageId?: number;
    path: string;
    sha256: string;
    size: number;
    content?: string;
  }): Promise<ConversationArtifactRecord> {
    const result = await this.#pool.query<ArtifactRow>(
      `INSERT INTO conversation_artifacts (conversation_id, message_id, path, sha256, size, content)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [input.conversationId.toUpperCase(), input.messageId ?? null, input.path, input.sha256, input.size, input.content ?? null],
    );
    return artifact(requireRow(result, "Failed to store conversation artifact"));
  }

  async listConversationArtifacts(conversationId: string): Promise<ConversationArtifactRecord[]> {
    const result = await this.#pool.query<ArtifactRow>(
      "SELECT * FROM conversation_artifacts WHERE conversation_id = $1 ORDER BY id",
      [conversationId.toUpperCase()],
    );
    return result.rows.map(artifact);
  }

  async enqueueRunnerJob(input: {
    conversationId: string;
    targetAgent: AgentId;
    repository: string;
    mode: RunnerJobMode;
    prompt: string;
    remainingTurns: number;
  }): Promise<RunnerJobRecord> {
    return await this.#transaction(async (client) => {
      const inserted = await client.query<{ sequence: string }>(
        `INSERT INTO runner_jobs
         (conversation_id, target_agent, repository, mode, prompt, remaining_turns, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued') RETURNING sequence`,
        [input.conversationId.toUpperCase(), input.targetAgent, input.repository, input.mode, input.prompt, input.remainingTurns],
      );
      const sequence = requireRow(inserted, "Failed to enqueue runner job").sequence;
      const id = `JOB-${String(sequence).padStart(6, "0")}`;
      const updated = await client.query<JobRow>("UPDATE runner_jobs SET id = $1 WHERE sequence = $2 RETURNING *", [id, sequence]);
      await client.query(
        `UPDATE conversation_threads SET status = 'running', waiting_for = $1, updated_at = NOW()
         WHERE id = $2`,
        [input.targetAgent, input.conversationId.toUpperCase()],
      );
      return job(requireRow(updated, "Failed to assign runner job id"));
    });
  }

  async getRunnerJob(id: string): Promise<RunnerJobRecord> {
    const result = await this.#pool.query<JobRow>("SELECT * FROM runner_jobs WHERE id = $1", [id.toUpperCase()]);
    return job(requireRow(result, `Unknown runner job '${id}'`));
  }

  async claimRunnerJob(input: {
    runnerId: string;
    agent: AgentId;
    leaseMs: number;
  }): Promise<RunnerJobRecord | undefined> {
    return await this.#transaction(async (client) => {
      const leaseUntil = new Date(Date.now() + input.leaseMs);
      await client.query(
        `UPDATE runner_jobs SET status = 'queued', runner_id = NULL, lease_until = NULL, updated_at = NOW()
         WHERE status = 'claimed' AND lease_until < NOW()`,
      );
      const owned = await client.query<JobRow>(
        `SELECT * FROM runner_jobs
         WHERE target_agent = $1 AND runner_id = $2 AND status = 'claimed' AND lease_until >= NOW()
         ORDER BY sequence LIMIT 1`,
        [input.agent, input.runnerId],
      );
      if (owned.rows[0]) return job(owned.rows[0]);
      let result: QueryResult<JobRow>;
      if (this.#supportsSkipLocked) {
        result = await client.query<JobRow>(
          `WITH candidate AS (
             SELECT sequence FROM runner_jobs
             WHERE target_agent = $1 AND status = 'queued'
             ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED
           )
           UPDATE runner_jobs AS jobs
           SET status = 'claimed', runner_id = $2,
               lease_until = $3, updated_at = NOW()
           FROM candidate WHERE jobs.sequence = candidate.sequence
           RETURNING jobs.*`,
          [input.agent, input.runnerId, leaseUntil],
        );
      } else {
        const candidate = await client.query<{ sequence: string }>(
          `SELECT sequence FROM runner_jobs WHERE target_agent = $1 AND status = 'queued'
           ORDER BY sequence LIMIT 1`,
          [input.agent],
        );
        const sequence = candidate.rows[0]?.sequence;
        result = sequence === undefined
          ? { rows: [], rowCount: 0, command: "UPDATE", oid: 0, fields: [] }
          : await client.query<JobRow>(
              `UPDATE runner_jobs SET status = 'claimed', runner_id = $1,
               lease_until = $2, updated_at = NOW()
               WHERE sequence = $3 AND status = 'queued' RETURNING *`,
              [input.runnerId, leaseUntil, sequence],
            );
      }
      return result.rows[0] ? job(result.rows[0]) : undefined;
    });
  }

  async completeRunnerJob(id: string, runnerId: string): Promise<RunnerJobRecord> {
    const result = await this.#pool.query<JobRow>(
      `UPDATE runner_jobs SET status = 'completed', lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'claimed' AND runner_id = $2 RETURNING *`,
      [id.toUpperCase(), runnerId],
    );
    return job(requireRow(result, `Runner ${runnerId} does not own claimed job ${id}`));
  }

  async failRunnerJob(id: string, runnerId: string, error: string): Promise<RunnerJobRecord> {
    const result = await this.#pool.query<JobRow>(
      `UPDATE runner_jobs SET status = 'failed', error = $1, lease_until = NULL, updated_at = NOW()
       WHERE id = $2 AND status = 'claimed' AND runner_id = $3 RETURNING *`,
      [error, id.toUpperCase(), runnerId],
    );
    return job(requireRow(result, `Runner ${runnerId} does not own claimed job ${id}`));
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
