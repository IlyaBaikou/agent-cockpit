import { loadAgentProfiles } from "./config.js";
import { parseControlCredentials } from "./control-auth.js";
import { ConversationHub } from "./conversations.js";
import { PostgresConversationStore } from "./postgres-store.js";
import { parseRunnerCredentials } from "./runner-auth.js";

export async function createCloudRuntime(): Promise<{
  store: PostgresConversationStore;
  conversations: ConversationHub;
}> {
  const runners = parseRunnerCredentials();
  const controllers = parseControlCredentials();
  if (new Set(runners.map((item) => item.runnerId)).size !== runners.length) {
    throw new Error("Every HUB_RUNNER_TOKENS entry must have a unique runner id");
  }
  if (process.env.NODE_ENV === "production" && runners.length === 0) {
    throw new Error("HUB_RUNNER_TOKENS must configure at least one runner in production");
  }
  if (process.env.NODE_ENV === "production" && controllers.length === 0) {
    throw new Error("HUB_CONTROL_TOKENS must configure at least one controller in production");
  }
  const allTokens = [...runners.map((item) => item.token), ...controllers.map((item) => item.token)];
  if (new Set(allTokens).size !== allTokens.length) {
    throw new Error("Every runner and controller must have a unique token");
  }

  const store = new PostgresConversationStore();
  try {
    await retryDatabase(async () => {
      await store.ping();
      await store.migrate();
    });
    const profiles = await loadAgentProfiles();
    return { store, conversations: new ConversationHub({ store, profiles }) };
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}

async function retryDatabase(operation: () => Promise<void>): Promise<void> {
  const attempts = Number(process.env.HUB_DB_STARTUP_ATTEMPTS ?? 10);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = Math.min(5_000, 250 * 2 ** (attempt - 1));
      console.warn(`PostgreSQL is not ready (attempt ${attempt}/${attempts}); retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
