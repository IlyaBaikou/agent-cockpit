import "dotenv/config";
import { CodexAdapter } from "./agents/codex.js";
import { ClaudeAdapter } from "./agents/claude.js";
import { inspectIntegrations } from "./integration-doctor.js";
import { runProcess } from "./process.js";
import { RepositoryRegistry } from "./repositories.js";
import { loadRunnerConfig, resolveRunnerToken, runnerConfigPathFromArgs } from "./runner-config.js";
import { inspectSlackDesktopAutomation } from "./slack/desktop-publisher.js";

const configPath = runnerConfigPathFromArgs();
const loadedConfig = await loadRunnerConfig(configPath);
if (!loadedConfig) {
  throw new Error(`Runner config not found at ${configPath}; run \`npm run runner:setup\``);
}
const config = loadedConfig;
let failed = false;

async function checkHub(): Promise<void> {
  try {
    const response = await fetch(new URL("/v1/runners/check", config.serverUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${resolveRunnerToken(config)}`, "content-type": "application/json" },
      body: JSON.stringify({ runnerId: config.runnerId }),
    });
    const body = (await response.json()) as { ok?: boolean; runnerId?: string; agent?: string; error?: string };
    if (!response.ok || !body.ok || body.agent !== config.agent) {
      throw new Error(body.error ?? `Hub returned HTTP ${response.status}`);
    }
    console.log(`✓ hub: ${config.serverUrl} authenticated ${body.runnerId} as ${body.agent}`);
  } catch (error) {
    failed = true;
    console.error(`✗ hub: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await checkHub();
const agent = config.agent === "codex" ? new CodexAdapter() : new ClaudeAdapter();
try {
  console.log(`✓ ${config.agent}: ${await agent.healthCheck()}`);
} catch (error) {
  failed = true;
  console.error(`✗ ${config.agent}: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const repositories = new RepositoryRegistry(config.repositoriesFile);
  await repositories.load();
  for (const alias of repositories.aliases()) {
    const repository = repositories.get(alias);
    const root = await runProcess("git", ["-C", repository.path, "rev-parse", "--show-toplevel"], { timeoutMs: 10_000 });
    const base = await runProcess("git", ["-C", repository.path, "rev-parse", "--verify", `${repository.baseRef}^{commit}`], {
      timeoutMs: 10_000,
    });
    if (root.exitCode !== 0 || base.exitCode !== 0) {
      failed = true;
      console.error(`✗ repository ${alias}: invalid Git root or base '${repository.baseRef}'`);
    } else {
      console.log(`✓ repository ${alias}: ${repository.path} (base ${repository.baseRef})`);
    }
  }
} catch (error) {
  failed = true;
  console.error(`✗ repositories: ${error instanceof Error ? error.message : String(error)}`);
}

const inspection = await inspectIntegrations({
  agent: config.agent,
  slackProofFile: config.integrations.slackDesktop.proofFile,
});
if (config.integrations.slackDesktop.enabled) {
  if (!inspection.desktopInstalled) {
    failed = true;
    console.error(`✗ Slack Desktop relay: ${config.agent} desktop application not found`);
  } else if (!inspection.slackProofFresh) {
    failed = true;
    console.error("✗ Slack Desktop relay: no fresh agent-assisted proof; verify the channel in the desktop agent and record it with `npm run runner:slack-proof`");
  } else if (
    config.integrations.slackDesktop.channelId &&
    inspection.slackProof?.channelId !== config.integrations.slackDesktop.channelId
  ) {
    failed = true;
    console.error(`✗ Slack Desktop relay: proof is for ${inspection.slackProof?.channelId}, expected ${config.integrations.slackDesktop.channelId}`);
  } else {
    console.log(
      `✓ Slack Desktop relay: ${inspection.slackProof?.workspaceName}/#${inspection.slackProof?.channelName} as ${inspection.slackProof?.userName}`,
    );
  }
  console.log(
    inspection.slackCliConfigured
      ? "✓ Slack background transport: directly available to the agent CLI"
      : "○ Slack background transport: desktop-assisted only; CLI cannot reuse the desktop OAuth session",
  );
  if (config.integrations.slackDesktop.publishResponses || process.env.HUB_SLACK_DESKTOP_POST === "true") {
    const automation = await inspectSlackDesktopAutomation();
    if (automation.ready) {
      console.log(`✓ Slack Desktop publisher: ${automation.detail}`);
    } else {
      failed = true;
      console.error(`✗ Slack Desktop publisher: ${automation.detail}`);
    }
  } else {
    console.log("○ Slack Desktop publisher: disabled; enable slackDesktop.publishResponses or HUB_SLACK_DESKTOP_POST=true");
  }
  if (config.integrations.slackDesktop.readCommands || process.env.HUB_SLACK_DESKTOP_READ === "true") {
    if (!process.env.HUB_CONTROL_TOKEN?.trim()) {
      failed = true;
      console.error("✗ Slack Desktop reader: HUB_CONTROL_TOKEN is required");
    } else if ((config.integrations.slackDesktop.allowedAuthors ?? []).length === 0) {
      failed = true;
      console.error("✗ Slack Desktop reader: configure allowedAuthors");
    } else {
      console.log(`✓ Slack Desktop reader: explicit read-only ${config.agent} commands from ${config.integrations.slackDesktop.allowedAuthors?.join(", ")}`);
    }
  } else {
    console.log("○ Slack Desktop reader: disabled; enable slackDesktop.readCommands or HUB_SLACK_DESKTOP_READ=true");
  }
}
if (config.integrations.atlassian.enabled) {
  if (inspection.atlassianAuthenticated) {
    console.log("✓ Jira/Confluence: Atlassian MCP is configured and authenticated");
  } else {
    failed = true;
    console.error(
      inspection.atlassianConfigured
        ? "✗ Jira/Confluence: Atlassian MCP needs authentication"
        : "✗ Jira/Confluence: Atlassian MCP is not configured",
    );
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("✓ runner is ready");
}
