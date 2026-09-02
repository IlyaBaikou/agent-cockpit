import "dotenv/config";
import { HubControlClient } from "./hub-client.js";
import { acquireRunnerProcessLock } from "./runner-process-lock.js";
import { loadSlackGatewayConfig, slackGatewayConfigPath } from "./slack-gateway-config.js";
import { SlackAccessibilityScanner } from "./slack/desktop-reader.js";
import { SlackAccessibilityThreadsScanner } from "./slack/desktop-threads-reader.js";
import { SlackDesktopPublisher } from "./slack/desktop-publisher.js";
import { SlackHubGateway } from "./slack/gateway.js";

const configPath = slackGatewayConfigPath();
const config = await loadSlackGatewayConfig(configPath);
const token = process.env[config.controlTokenEnv]?.trim();
if (!token) throw new Error(`${config.controlTokenEnv} is required`);
const releaseLock = acquireRunnerProcessLock(`${configPath}.lock`);
process.once("exit", releaseLock);

const gateway = new SlackHubGateway({
  rootScanner: new SlackAccessibilityScanner({ proofFile: config.proofFile, expectedChannelId: config.channelId }),
  threadsScanner: new SlackAccessibilityThreadsScanner({ channelId: config.channelId }),
  client: new HubControlClient({ serverUrl: config.serverUrl, token }),
  publisher: new SlackDesktopPublisher({ proofFile: config.proofFile, expectedChannelId: config.channelId }),
  stateFile: config.stateFile,
  allowedAuthors: config.allowedAuthors,
  publishActors: config.publishActors,
  defaults: config.defaults,
  ingress: config.ingress,
});

const pollMs = Number(process.env.HUB_SLACK_GATEWAY_POLL_MS ?? 2_000);
console.log(`Slack Gateway connected to ${config.serverUrl}; ingress=${config.ingress}; actors=${config.publishActors.join(",")}`);
do {
  try {
    const result = await gateway.poll();
    if (result.initialized) console.log("Slack Gateway state initialized; existing channel messages will not be replayed");
    if (result.opened || result.humanReplies || result.published) {
      console.log(`Slack Gateway: opened=${result.opened}, humanReplies=${result.humanReplies}, published=${result.published}`);
    }
  } catch (error) {
    console.error(`Slack Gateway error: ${error instanceof Error ? error.message : String(error)}`);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
} while (true);
