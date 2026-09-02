import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { emptyState, type State } from "./model.js";

export interface StateStore {
  read<T>(action: (state: State) => T): Promise<T>;
  transact<T>(action: (state: State) => T): Promise<T>;
  close(): Promise<void>;
}
// Pilot storage: one atomic state document. The lock also makes claim/complete/handoff
// atomic across HTTP requests and processes. v1 tables are deliberately untouched.
export class MemoryStateStore implements StateStore {
  #state = emptyState();
  async read<T>(action: (state: State) => T): Promise<T> { return action(structuredClone(this.#state)); }
  async transact<T>(action: (state: State) => T): Promise<T> {
    const next = structuredClone(this.#state);
    const result = action(next);
    next.revision++;
    this.#state = next;
    return structuredClone(result);
  }
  async close(): Promise<void> {}
}
export class SqliteStateStore implements StateStore {
  #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS collaboration_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    this.#db.prepare("INSERT OR IGNORE INTO collaboration_state VALUES (1, ?)").run(JSON.stringify(emptyState()));
  }
  async read<T>(action: (state: State) => T): Promise<T> {
    const row = this.#db.prepare("SELECT value FROM collaboration_state WHERE id=1").get() as { value: string };
    return action(JSON.parse(row.value) as State);
  }
  async transact<T>(action: (state: State) => T): Promise<T> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT value FROM collaboration_state WHERE id=1").get() as { value: string };
      const state = JSON.parse(row.value) as State;
      const result = action(state);
      state.revision++;
      this.#db.prepare("UPDATE collaboration_state SET value=? WHERE id=1").run(JSON.stringify(state));
      this.#db.exec("COMMIT");
      return structuredClone(result);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  async close(): Promise<void> { this.#db.close(); }
}
export class PostgresStateStore implements StateStore {
  #pool: pg.Pool;
  constructor(pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 })) { this.#pool = pool; }
  async migrate(): Promise<void> {
    await this.#pool.query("CREATE TABLE IF NOT EXISTS collaboration_state (id INTEGER PRIMARY KEY, value JSONB NOT NULL)");
    await this.#pool.query("INSERT INTO collaboration_state VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING", [JSON.stringify(emptyState())]);
  }
  async read<T>(action: (state: State) => T): Promise<T> {
    const result = await this.#pool.query<{ value: State }>("SELECT value FROM collaboration_state WHERE id=1");
    return action(result.rows[0]!.value);
  }
  async transact<T>(action: (state: State) => T): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ value: State }>("SELECT value FROM collaboration_state WHERE id=1 FOR UPDATE");
      const state = result.rows[0]!.value;
      const answer = action(state);
      state.revision++;
      await client.query("UPDATE collaboration_state SET value=$1::jsonb WHERE id=1", [JSON.stringify(state)]);
      await client.query("COMMIT");
      return structuredClone(answer);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> { await this.#pool.end(); }
}
