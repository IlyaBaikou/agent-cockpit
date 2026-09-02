import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ConversationParticipant } from "./types.js";

export type SlackGatewayConfig = {
  version: 1;
  serverUrl: string;
  controlTokenEnv: string;
  proofFile: string;
  channelId: string;
  stateFile: string;
  allowedAuthors: string[];
  ingress: boolean;
  publishActors: ConversationParticipant[];
  defaults: {
    codexRepository: string;
    claudeRepository: string;
    target: "codex" | "claude";
    turns: number;
  };
};

export function slackGatewayConfigPath(args = process.argv.slice(2)): string {
  const index = args.indexOf("--config");
  const configured = index >= 0 ? args[index + 1] : undefined;
  return resolve(configured ?? process.env.AGENT_HUB_SLACK_GATEWAY_FILE ?? ".agent-hub-local/slack-gateway.json");
}

export async function loadSlackGatewayConfig(path = slackGatewayConfigPath()): Promise<SlackGatewayConfig> {
  const config = JSON.parse(await readFile(path, "utf8")) as SlackGatewayConfig;
  if (config.version !== 1 || !config.serverUrl || !config.channelId || !config.proofFile || !config.stateFile) {
    throw new Error(`Invalid Slack gateway config: ${path}`);
  }
  return config;
}

export async function saveSlackGatewayConfig(path: string, config: SlackGatewayConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
