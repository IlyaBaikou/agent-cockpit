import { resolve } from "node:path";
import { writeSlackDesktopProof } from "./integration-doctor.js";
import { loadRunnerConfig, runnerConfigPathFromArgs } from "./runner-config.js";

function value(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const config = await loadRunnerConfig(runnerConfigPathFromArgs());
if (!config) {
  throw new Error("Runner config not found; run `npm run runner:setup` first");
}
const workspaceId = value("workspace-id");
const workspaceName = value("workspace");
const channelId = value("channel-id") ?? config.integrations.slackDesktop.channelId;
const channelName = value("channel");
const userName = value("user");
const userId = value("user-id");
if (!workspaceId || !workspaceName || !channelId || !channelName || !userName) {
  throw new Error("Usage: npm run runner:slack-proof -- --workspace-id T... --workspace 'Name' --channel-id C... --channel channel-name --user 'Full Name'");
}
await writeSlackDesktopProof(resolve(config.integrations.slackDesktop.proofFile), {
  workspaceId,
  workspaceName,
  channelId,
  channelName,
  ...(userId ? { userId } : {}),
  userName,
});
console.log(`✓ Recorded Desktop Slack proof for ${workspaceName}/#${channelName} as ${userName}`);
console.log("This receipt confirms an agent-assisted desktop check; it does not grant the background CLI a Slack token.");
