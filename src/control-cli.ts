import "dotenv/config";
import { parseCommand } from "./commands.js";
import { HubControlClient } from "./hub-client.js";
import { loadRunnerConfig } from "./runner-config.js";
import { formatConversation, formatConversationList } from "./slack/format.js";

const runnerConfig = await loadRunnerConfig();
const serverUrl = process.env.HUB_SERVER_URL?.trim() || runnerConfig?.serverUrl;
const token = process.env.HUB_CONTROL_TOKEN?.trim();
if (!serverUrl) throw new Error("HUB_SERVER_URL is required (or configure it with runner:setup)");
if (!token) throw new Error("HUB_CONTROL_TOKEN is required and is never stored in runner.json");

const command = parseCommand(process.argv.slice(2).join(" "));
const client = new HubControlClient({ serverUrl, token });

if (command.kind === "help") {
  console.log([
    "AnimaPlay Agent Hub remote control",
    "",
    "open repo=<alias> to=codex|claude [mode=read|write] [turns=1..12] <topic>",
    "reply CHAT-0001 to=codex|claude [repo=<alias>] [mode=read|write] [turns=1..12] <message>",
    "thread CHAT-0001",
    "threads",
    "close CHAT-0001",
  ].join("\n"));
} else if (command.kind === "open") {
  const snapshot = await client.open({
    topic: command.prompt,
    codexRepository: command.codexRepository,
    claudeRepository: command.claudeRepository,
    target: command.target,
    mode: command.mode,
    turns: command.turns,
  });
  console.log(formatConversation(snapshot.conversation, snapshot.messages, snapshot.artifacts));
} else if (command.kind === "reply") {
  const snapshot = await client.reply({
    conversationId: command.conversationId,
    target: command.target,
    ...(command.repository ? { repository: command.repository } : {}),
    mode: command.mode,
    turns: command.turns,
    content: command.prompt,
  });
  console.log(formatConversation(snapshot.conversation, snapshot.messages, snapshot.artifacts));
} else if (command.kind === "thread") {
  const snapshot = await client.get(command.conversationId);
  console.log(formatConversation(snapshot.conversation, snapshot.messages, snapshot.artifacts));
} else if (command.kind === "threads") {
  console.log(formatConversationList(await client.list()));
} else if (command.kind === "close") {
  const snapshot = await client.close(command.conversationId);
  console.log(formatConversation(snapshot.conversation, snapshot.messages, snapshot.artifacts));
} else {
  throw new Error("Remote control supports only help, open, reply, thread, threads, and close");
}
