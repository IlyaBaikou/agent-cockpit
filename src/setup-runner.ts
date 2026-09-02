import "dotenv/config";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { inspectIntegrations } from "./integration-doctor.js";
import { RepositoryRegistry } from "./repositories.js";
import {
  defaultRunnerConfigPath,
  fileExists,
  projectRoot,
  saveRunnerConfig,
  type RunnerLocalConfig,
} from "./runner-config.js";
import { discoverGitRepositories, writeRepositoriesConfig } from "./runner-setup-core.js";
import type { AgentId } from "./types.js";

function argument(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

const terminal = createInterface({ input: process.stdin, output: process.stdout });

async function answer(label: string, fallback: string): Promise<string> {
  const value = (await terminal.question(`${label} [${fallback}]: `)).trim();
  return value || fallback;
}

async function yesNo(label: string, fallback: boolean): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  const value = (await terminal.question(`${label} [${hint}]: `)).trim().toLowerCase();
  return value ? value === "y" || value === "yes" || value === "д" || value === "да" : fallback;
}

try {
  const nonInteractive = flag("non-interactive");
  const configuredAgent = argument("agent");
  const agentInput = configuredAgent ?? (nonInteractive ? "codex" : await answer("Agent (codex/claude)", "codex"));
  if (agentInput !== "codex" && agentInput !== "claude") {
    throw new Error("Agent must be codex or claude");
  }
  const agent = agentInput as AgentId;
  const configPath = resolve(argument("config") ?? defaultRunnerConfigPath());
  if ((await fileExists(configPath)) && !flag("force")) {
    if (nonInteractive || !(await yesNo(`Runner config already exists at ${configPath}. Replace it`, false))) {
      throw new Error("Setup stopped without replacing the existing runner config; use --force to replace it");
    }
  }
  const localDirectory = dirname(configPath);
  const workspaceRoot = resolve(
    argument("workspace") ?? (nonInteractive ? resolve(projectRoot(), "..") : await answer("Workspace folder", resolve(projectRoot(), ".."))),
  );
  const runnerId = argument("runner-id") ?? (nonInteractive ? `${userInfo().username}-${agent}` : await answer("Runner id", `${userInfo().username}-${agent}`));
  const serverUrl = argument("hub-url") ?? (nonInteractive ? "http://127.0.0.1:4317" : await answer("Hub URL", "http://127.0.0.1:4317"));
  const slackEnabled = flag("slack") || (!flag("no-slack") && (nonInteractive || (await yesNo("Use Slack Desktop relay", true))));
  const slackChannel = slackEnabled
    ? argument("slack-channel") ?? (nonInteractive ? "C0BSWGTLCK0" : await answer("Slack channel id", "C0BSWGTLCK0"))
    : undefined;
  const slackPublishResponses = slackEnabled && flag("slack-post");
  const slackReadCommands = slackEnabled && flag("slack-read");
  const slackAllowedAuthors = (argument("slack-allow-authors") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const atlassianEnabled = flag("atlassian") || (!flag("no-atlassian") && (nonInteractive || (await yesNo("Check Jira/Confluence through Atlassian MCP", true))));
  const allowWrite = flag("allow-write") || (!nonInteractive && (await yesNo("Allow explicitly approved write jobs", false)));

  const existingRepositoriesFile = argument("repositories-file");
  const repositoriesFile = resolve(existingRepositoriesFile ?? resolve(localDirectory, "repositories.json"));
  let repositories;
  if (existingRepositoriesFile) {
    const registry = new RepositoryRegistry(repositoriesFile);
    await registry.load();
    repositories = registry.aliases().map((alias) => {
      const repository = registry.get(alias);
      return { alias, path: repository.path, baseRef: repository.baseRef };
    });
    console.log(`Using existing repositories config ${repositoriesFile}...`);
  } else {
    console.log(`Scanning Git repositories under ${workspaceRoot}...`);
    repositories = await discoverGitRepositories(workspaceRoot);
    if (repositories.length === 0) {
      throw new Error(`No Git repositories found under ${workspaceRoot}`);
    }
    await writeRepositoriesConfig(repositoriesFile, repositories);
  }
  const proofFile = resolve(localDirectory, "slack-desktop-proof.json");

  const config: RunnerLocalConfig = {
    version: 1,
    runnerId,
    agent,
    serverUrl,
    tokenEnv: "HUB_RUNNER_TOKEN",
    workspaceRoot,
    repositoriesFile,
    worktreeRoot: resolve(workspaceRoot, ".agent-hub-worktrees", runnerId),
    allowWrite,
    verifyWrites: false,
    integrations: {
      slackDesktop: {
        enabled: slackEnabled,
        publishResponses: slackPublishResponses,
        readCommands: slackReadCommands,
        ...(slackAllowedAuthors.length > 0 ? { allowedAuthors: slackAllowedAuthors } : {}),
        readerStateFile: resolve(localDirectory, "slack-reader-state.json"),
        ...(slackChannel ? { channelId: slackChannel } : {}),
        proofFile,
      },
      atlassian: { enabled: atlassianEnabled },
    },
  };
  await saveRunnerConfig(configPath, config);
  const inspection = await inspectIntegrations({ agent, slackProofFile: proofFile });

  console.log(`\n✓ Runner config: ${configPath}`);
  console.log(`✓ Repositories config: ${repositoriesFile}`);
  for (const repository of repositories) {
    console.log(`  • ${repository.alias}: ${repository.path} (base ${repository.baseRef})`);
  }
  console.log(inspection.desktopInstalled ? `✓ Desktop app: ${inspection.desktopApplication}` : "✗ Desktop app not found");
  if (slackEnabled) {
    console.log(inspection.slackProofFresh ? "✓ Slack Desktop relay proof is fresh" : "○ Slack Desktop relay still needs an agent-assisted proof");
    console.log(inspection.slackCliConfigured ? "✓ Slack is directly available to the background CLI" : "○ Slack is desktop-assisted only; the CLI session does not expose it");
    console.log(slackPublishResponses ? "✓ Slack Desktop response publishing enabled" : "○ Slack Desktop response publishing disabled; rerun setup with --slack-post to enable it");
    console.log(slackReadCommands ? `✓ Slack Desktop command reader enabled for: ${slackAllowedAuthors.join(", ") || "no authors configured"}` : "○ Slack Desktop command reader disabled; rerun setup with --slack-read --slack-allow-authors='Name' to enable it");
  }
  if (atlassianEnabled) {
    console.log(inspection.atlassianAuthenticated ? "✓ Atlassian MCP is authenticated" : inspection.atlassianConfigured ? "○ Atlassian MCP needs authentication" : "✗ Atlassian MCP is not configured");
  }
  console.log("\nNext: set HUB_RUNNER_TOKEN, complete the Desktop Slack proof if requested, then run `npm run runner:doctor`.");
} finally {
  terminal.close();
}
