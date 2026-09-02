import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { ConversationHub } from "../src/conversations.js";
import { createHubHttpServer } from "../src/hub-server.js";
import { HubControlClient } from "../src/hub-client.js";
import { PostgresConversationStore } from "../src/postgres-store.js";

const profiles = {
  codex: { label: "Backend Codex", provider: "openai", role: "backend" },
  claude: { label: "Frontend Claude", provider: "anthropic", role: "frontend" },
} as const;

async function fixture(): Promise<{
  store: PostgresConversationStore;
  conversations: ConversationHub;
  serverUrl: string;
  close(): Promise<void>;
}> {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const store = new PostgresConversationStore(pool, { supportsSkipLocked: false });
  await store.migrate({ useAdvisoryLock: false });
  const conversations = new ConversationHub({ store, profiles });
  const server = createHubHttpServer({
    store,
    conversations,
    credentials: [{ runnerId: "backend", agent: "codex", token: "backend-runner-token-123456" }],
    controlCredentials: [{ actor: "ilya", token: "ilya-control-token-123456789" }],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return {
    store,
    conversations,
    serverUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}

describe("Railway cloud Hub", () => {
  it("migrates PostgreSQL and controls conversations remotely", async () => {
    const app = await fixture();
    try {
      const client = new HubControlClient({ serverUrl: app.serverUrl, token: "ilya-control-token-123456789" });
      await client.health();
      const opened = await client.open({
        topic: "Agree the gamification API",
        codexRepository: "backend",
        claudeRepository: "frontend",
        target: "codex",
        mode: "read",
        turns: 3,
      });
      expect(opened.conversation).toMatchObject({ id: "CHAT-0001", status: "running", waitingFor: "codex" });
      expect((await client.list())[0]?.id).toBe("CHAT-0001");
      expect((await client.get("CHAT-0001")).messages[0]).toMatchObject({ actor: "human", label: "ilya" });

      const claim = await fetch(new URL("/v1/jobs/claim", app.serverUrl), {
        method: "POST",
        headers: { authorization: "Bearer backend-runner-token-123456", "content-type": "application/json" },
        body: JSON.stringify({ runnerId: "backend" }),
      });
      const claimBody = await claim.json();
      expect({ status: claim.status, body: claimBody }).toMatchObject({
        status: 200,
        body: { job: { id: "JOB-000001", targetAgent: "codex" } },
      });

      const repeatedClaim = await fetch(new URL("/v1/jobs/claim", app.serverUrl), {
        method: "POST",
        headers: { authorization: "Bearer backend-runner-token-123456", "content-type": "application/json" },
        body: JSON.stringify({ runnerId: "backend" }),
      });
      expect(await repeatedClaim.json()).toMatchObject({ job: { id: "JOB-000001" } });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const completed = await fetch(new URL("/v1/jobs/complete", app.serverUrl), {
          method: "POST",
          headers: { authorization: "Bearer backend-runner-token-123456", "content-type": "application/json" },
          body: JSON.stringify({
            runnerId: "backend",
            jobId: "JOB-000001",
            content: "Contract agreed.\nHANDOFF: done",
            artifacts: [],
          }),
        });
        expect(completed.status).toBe(200);
      }
      const finished = await client.get("CHAT-0001");
      expect(finished.conversation.status).toBe("completed");
      expect(finished.messages.map((item) => item.actor)).toEqual(["human", "codex"]);
    } finally {
      await app.close();
    }
  });

  it("rejects control calls without the developer token", async () => {
    const app = await fixture();
    try {
      const response = await fetch(new URL("/v1/conversations", app.serverUrl));
      expect(response.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
