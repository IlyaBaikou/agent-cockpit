import "dotenv/config";
import { HubControlClient } from "./hub-client.js";
import { readSlackDesktopProof } from "./integration-doctor.js";
import { loadSlackGatewayConfig, slackGatewayConfigPath } from "./slack-gateway-config.js";
import { SlackAccessibilityScanner } from "./slack/desktop-reader.js";
import { SlackAccessibilityThreadsScanner } from "./slack/desktop-threads-reader.js";
import { inspectSlackDesktopAutomation, prepareSlackDesktopAutomation } from "./slack/desktop-publisher.js";

const config = await loadSlackGatewayConfig(slackGatewayConfigPath());
const token = process.env[config.controlTokenEnv]?.trim();
let failed = false;

if (!token) {
  failed = true;
  console.error(`✗ Hub: ${config.controlTokenEnv} is required`);
} else {
  try {
    const client = new HubControlClient({ serverUrl: config.serverUrl, token });
    await client.health();
    await client.list(1);
    console.log(`✓ Hub: ${config.serverUrl} control access authenticated`);
  } catch (error) {
    failed = true;
    console.error(`✗ Hub: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const proof = await readSlackDesktopProof(config.proofFile);
const proofAge = proof ? Date.now() - Date.parse(proof.verifiedAt) : Number.POSITIVE_INFINITY;
if (!proof || !Number.isFinite(proofAge) || proofAge < 0 || proofAge > 30 * 24 * 60 * 60 * 1_000) {
  failed = true;
  console.error("✗ Slack Desktop: proof is missing or stale; run slack-proof.command");
} else if (proof.channelId !== config.channelId) {
  failed = true;
  console.error(`✗ Slack Desktop: proof is for ${proof.channelId}, expected ${config.channelId}`);
} else {
  console.log(`✓ Slack Desktop: ${proof.workspaceName}/#${proof.channelName} as ${proof.userName}`);
}

try {
  await prepareSlackDesktopAutomation();
  const automation = await inspectSlackDesktopAutomation();
  if (!automation.ready) throw new Error(automation.detail);
  if (config.ingress) {
    await Promise.all([
      new SlackAccessibilityScanner({ proofFile: config.proofFile, expectedChannelId: config.channelId }).prepare(),
      new SlackAccessibilityThreadsScanner({ channelId: config.channelId }).prepare(),
    ]);
  }
  console.log(`✓ Slack Gateway: helpers ready; ingress=${config.ingress}; publishes=${config.publishActors.join(",")}`);
} catch (error) {
  failed = true;
  console.error(`✗ Slack Gateway: ${error instanceof Error ? error.message : String(error)}`);
}

if (failed) process.exitCode = 1;
else console.log("✓ Slack Gateway is ready");
