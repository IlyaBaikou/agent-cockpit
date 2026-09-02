import { App } from "@slack/bolt";
import { helpText, parseCommand } from "../commands.js";
import type { ConversationHub } from "../conversations.js";
import type { Orchestrator } from "../orchestrator.js";
import type { RepositoryRegistry } from "../repositories.js";
import type { TaskFlow } from "../task-flow.js";
import type { DiscussionMessage } from "../types.js";
import {
  formatAgentMessage,
  formatConversation,
  formatConversationList,
  formatTask,
  formatTaskList,
  splitSlackMessage,
} from "./format.js";

function envSet(name: string): Set<string> {
  return new Set((process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
}

export function createSlackApp(options: {
  orchestrator: Orchestrator;
  taskFlow: TaskFlow;
  repositories: RepositoryRegistry;
  conversations: ConversationHub;
}): App {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!token || !appToken) {
    throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required for Slack mode");
  }

  const app = new App({ token, appToken, socketMode: true });
  const inFlight = new Set<string>();
  const maxRounds = Number(process.env.HUB_MAX_ROUNDS ?? 2);
  const allowedChannels = envSet("HUB_ALLOWED_CHANNEL_IDS");
  const approvers = envSet("HUB_APPROVER_IDS");

  app.event("app_mention", async ({ event, client, logger }) => {
    if (allowedChannels.size > 0 && !allowedChannels.has(event.channel)) {
      return;
    }
    const eventKey = `${event.channel}:${event.ts}`;
    if (inFlight.has(eventKey)) {
      return;
    }
    inFlight.add(eventKey);
    const threadTs = event.thread_ts ?? event.ts;

    const post = async (text: string): Promise<void> => {
      for (const chunk of splitSlackMessage(text)) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: chunk });
      }
    };
    const postAgent = async (message: DiscussionMessage): Promise<void> => {
      await post(formatAgentMessage(message));
    };

    try {
      const command = parseCommand(event.text ?? "", maxRounds);
      if (command.kind === "help") {
        await post(helpText(options.repositories.aliases()));
        return;
      }

      if (command.kind === "ask" || command.kind === "discuss") {
        const repositoryPath = options.repositories.resolve(command.repository);
        await post(`:eyes: Starting read-only *${command.kind}* in \`${command.repository}\`...`);
        if (command.kind === "ask") {
          await options.orchestrator.ask({
            discussionId: `${event.channel}:${threadTs}`,
            agent: command.agent,
            repositoryAlias: command.repository,
            repositoryPath,
            prompt: command.prompt,
            onMessage: postAgent,
          });
        } else {
          await options.orchestrator.discuss({
            discussionId: `${event.channel}:${threadTs}`,
            repositoryAlias: command.repository,
            repositoryPath,
            prompt: command.prompt,
            rounds: command.rounds,
            onMessage: postAgent,
          });
        }
        await post(":white_check_mark: Read-only agent run finished.");
        return;
      }

      const actor = event.user ?? "unknown-slack-user";
      if ((command.kind === "approve" || command.kind === "commit") && approvers.size > 0 && !approvers.has(actor)) {
        throw new Error(`Slack user ${actor} is not in HUB_APPROVER_IDS`);
      }

      if (command.kind === "propose") {
        const task = options.taskFlow.propose({
          sourceKey: eventKey,
          repository: command.repository,
          owner: command.owner,
          baseRef: command.baseRef,
          goal: command.goal,
          actor,
        });
        await post(`:memo: Task proposed.\n${formatTask(task)}\n\nApprove with \`@AgentHub approve ${task.id}\`.`);
      } else if (command.kind === "approve") {
        const task = await options.taskFlow.approve(command.taskId, actor);
        await post(`:white_check_mark: Worktree approved and created.\n${formatTask(task)}`);
      } else if (command.kind === "implement") {
        await post(`:hammer_and_wrench: Starting implementation for *${command.taskId}*...`);
        await post(formatTask(await options.taskFlow.implement(command.taskId, actor, postAgent)));
      } else if (command.kind === "review") {
        await post(`:mag: Starting peer review for *${command.taskId}*...`);
        await post(formatTask(await options.taskFlow.review(command.taskId, actor, postAgent)));
      } else if (command.kind === "revise") {
        await post(`:repeat: Starting revision for *${command.taskId}*...`);
        await post(formatTask(await options.taskFlow.revise(command.taskId, actor, postAgent)));
      } else if (command.kind === "commit") {
        await post(`:test_tube: Running verification and committing *${command.taskId}*...`);
        await post(formatTask(await options.taskFlow.commit(command.taskId, actor)));
      } else if (command.kind === "status") {
        await post(formatTask(options.taskFlow.get(command.taskId)));
      } else if (command.kind === "tasks") {
        await post(formatTaskList(options.taskFlow.list()));
      } else if (command.kind === "open") {
        const snapshot = await options.conversations.open({
          topic: command.prompt,
          codexRepository: command.codexRepository,
          claudeRepository: command.claudeRepository,
          target: command.target,
          mode: command.mode,
          turns: command.turns,
          actor,
        });
        await post(`:speech_balloon: Persistent conversation queued.\n${formatConversation(snapshot.conversation)}`);
      } else if (command.kind === "reply") {
        const snapshot = await options.conversations.reply({
          conversationId: command.conversationId,
          target: command.target,
          ...(command.repository ? { repository: command.repository } : {}),
          mode: command.mode,
          turns: command.turns,
          content: command.prompt,
          actor,
        });
        await post(`:outbox_tray: Reply queued.\n${formatConversation(snapshot.conversation)}`);
      } else if (command.kind === "thread") {
        const snapshot = await options.conversations.get(command.conversationId);
        await post(formatConversation(snapshot.conversation, snapshot.messages, snapshot.artifacts));
      } else if (command.kind === "threads") {
        await post(formatConversationList(await options.conversations.list()));
      } else if (command.kind === "close") {
        const snapshot = await options.conversations.close(command.conversationId);
        await post(formatConversation(snapshot.conversation));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(error);
      await post(`:warning: Agent Hub failed: ${message}`);
    } finally {
      inFlight.delete(eventKey);
    }
  });

  return app;
}
