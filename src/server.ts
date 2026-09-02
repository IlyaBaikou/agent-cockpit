import "dotenv/config";
import { createCloudRuntime } from "./cloud-runtime.js";
import { createHubHttpServer } from "./hub-server.js";
import { PostgresStateStore } from "./collab/store.js";
import { CollaborationService } from "./collab/service.js";
import { parseControlCredentials } from "./control-auth.js";

const runtime = await createCloudRuntime();
const collaborationStore = new PostgresStateStore();
await collaborationStore.migrate();
const collaboration = new CollaborationService(collaborationStore, parseControlCredentials());
const host = process.env.HUB_HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? process.env.HUB_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const server = createHubHttpServer({ store: runtime.store, conversations: runtime.conversations, collaboration });
server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  console.log(`Agent Hub cloud coordinator listening on ${host}:${port}`);
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void Promise.all([runtime.store.close(), collaborationStore.close()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
