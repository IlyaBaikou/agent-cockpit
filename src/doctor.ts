import "dotenv/config";
import { runProcess } from "./process.js";
import { createRuntime } from "./runtime.js";

const runtime = await createRuntime();
let failed = false;

try {
  const runnerAgent = process.env.HUB_RUNNER_AGENT;
  if (runnerAgent && runnerAgent !== "codex" && runnerAgent !== "claude") {
    throw new Error("HUB_RUNNER_AGENT must be codex or claude");
  }
  const agentEntries = Object.entries(runtime.agents).filter(([name]) => !runnerAgent || name === runnerAgent);
  for (const [name, agent] of agentEntries) {
    try {
      console.log(`✓ ${name}: ${await agent.healthCheck()}`);
    } catch (error) {
      failed = true;
      console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const alias of runtime.repositories.aliases()) {
    const repository = runtime.repositories.get(alias);
    const root = await runProcess("git", ["-C", repository.path, "rev-parse", "--show-toplevel"], { timeoutMs: 10_000 });
    const base = await runProcess("git", ["-C", repository.path, "rev-parse", "--verify", `${repository.baseRef}^{commit}`], {
      timeoutMs: 10_000,
    });
    if (root.exitCode !== 0 || base.exitCode !== 0) {
      failed = true;
      console.error(`✗ repository ${alias}: Git root or base ref '${repository.baseRef}' is invalid`);
    } else {
      console.log(`✓ repository ${alias}: ${repository.path} (base ${repository.baseRef}, checks ${repository.verify.length})`);
    }
  }
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    console.log("✓ Slack tokens are configured");
  } else {
    console.log("○ Slack tokens are not configured; local CLI mode is available");
  }
} finally {
  runtime.store.close();
}

if (failed) {
  process.exitCode = 1;
}
