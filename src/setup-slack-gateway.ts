import "dotenv/config";
import { dirname, resolve } from "node:path";
import { defaultRunnerConfigPath, loadRunnerConfig } from "./runner-config.js";
import { saveSlackGatewayConfig, slackGatewayConfigPath } from "./slack-gateway-config.js";
import type { ConversationParticipant } from "./types.js";

function argument(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

const runnerPath = resolve(argument("runner-config") ?? defaultRunnerConfigPath());
const runner = await loadRunnerConfig(runnerPath);
const gatewayPath = slackGatewayConfigPath();
const localDirectory = dirname(gatewayPath);
const channelId = argument("channel") ?? runner?.integrations.slackDesktop.channelId;
if (!channelId) throw new Error("--channel C... is required");

const target = (argument("target") ?? runner?.agent ?? "codex").toLowerCase();
if (target !== "codex" && target !== "claude") throw new Error("--target must be codex or claude");
const turns = Number(argument("turns") ?? 6);
if (!Number.isInteger(turns) || turns < 1 || turns > 12) throw new Error("--turns must be between 1 and 12");

const publishActors = (argument("publish-actors") ?? runner?.agent ?? "codex")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
if (publishActors.length === 0 || publishActors.some((actor) => actor !== "codex" && actor !== "claude" && actor !== "system")) {
  throw new Error("--publish-actors must contain codex, claude, or system");
}

await saveSlackGatewayConfig(gatewayPath, {
  version: 1,
  serverUrl: argument("hub-url") ?? runner?.serverUrl ?? "http://127.0.0.1:4317",
  controlTokenEnv: argument("token-env") ?? "HUB_CONTROL_TOKEN",
  proofFile: resolve(argument("proof-file") ?? runner?.integrations.slackDesktop.proofFile ?? resolve(localDirectory, "slack-desktop-proof.json")),
  channelId,
  stateFile: resolve(argument("state-file") ?? resolve(localDirectory, "slack-gateway-state.json")),
  allowedAuthors: (argument("allow-authors") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ingress: flag("ingress") && !flag("no-ingress"),
  publishActors: publishActors as ConversationParticipant[],
  defaults: {
    codexRepository: argument("codex-repo") ?? "gameengine",
    claudeRepository: argument("claude-repo") ?? "ccp-library-core",
    target,
    turns,
  },
});

console.log(`✓ Slack Gateway config: ${gatewayPath}`);
console.log(`  ingress: ${flag("ingress") && !flag("no-ingress")}`);
console.log(`  publish actors: ${publishActors.join(", ")}`);
