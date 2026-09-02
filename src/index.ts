import "dotenv/config";
import { createRuntime } from "./runtime.js";
import { createSlackApp } from "./slack/app.js";

const runtime = await createRuntime();
const app = createSlackApp(runtime);

const shutdown = async (): Promise<void> => {
  await app.stop();
  runtime.store.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.start();
console.log(`Agent Hub is connected to Slack. Repositories: ${runtime.repositories.aliases().join(", ")}`);
