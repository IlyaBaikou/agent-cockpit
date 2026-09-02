import "dotenv/config";
import { helpText, parseCommand } from "./commands.js";
import { createRuntime } from "./runtime.js";
import {
  formatAgentMessage,
  formatConversation,
  formatConversationList,
  formatTask,
  formatTaskList,
} from "./slack/format.js";

const input = process.argv.slice(2).join(" ");
const runtime = await createRuntime();

try {
  const command = parseCommand(input, Number(process.env.HUB_MAX_ROUNDS ?? 2));
  if (command.kind === "help") {
    console.log(helpText(runtime.repositories.aliases()));
  } else if (command.kind === "ask" || command.kind === "discuss") {
    const repositoryPath = runtime.repositories.resolve(command.repository);
    if (command.kind === "ask") {
      await runtime.orchestrator.ask({
        agent: command.agent,
        repositoryAlias: command.repository,
        repositoryPath,
        prompt: command.prompt,
        onMessage: (message) => console.log(`\n${formatAgentMessage(message)}\n`),
      });
    } else {
      await runtime.orchestrator.discuss({
        repositoryAlias: command.repository,
        repositoryPath,
        prompt: command.prompt,
        rounds: command.rounds,
        onMessage: (message) => console.log(`\n${formatAgentMessage(message)}\n`),
      });
    }
  } else if (command.kind === "propose") {
    console.log(
      formatTask(
        runtime.taskFlow.propose({
          repository: command.repository,
          owner: command.owner,
          baseRef: command.baseRef,
          goal: command.goal,
          actor: "local-cli",
        }),
      ),
    );
  } else if (command.kind === "approve") {
    console.log(formatTask(await runtime.taskFlow.approve(command.taskId, "local-cli")));
  } else if (command.kind === "implement") {
    console.log(
      formatTask(
        await runtime.taskFlow.implement(command.taskId, "local-cli", (message) =>
          console.log(`\n${formatAgentMessage(message)}\n`),
        ),
      ),
    );
  } else if (command.kind === "review") {
    console.log(
      formatTask(
        await runtime.taskFlow.review(command.taskId, "local-cli", (message) =>
          console.log(`\n${formatAgentMessage(message)}\n`),
        ),
      ),
    );
  } else if (command.kind === "revise") {
    console.log(
      formatTask(
        await runtime.taskFlow.revise(command.taskId, "local-cli", (message) =>
          console.log(`\n${formatAgentMessage(message)}\n`),
        ),
      ),
    );
  } else if (command.kind === "commit") {
    console.log(formatTask(await runtime.taskFlow.commit(command.taskId, "local-cli")));
  } else if (command.kind === "status") {
    console.log(formatTask(runtime.taskFlow.get(command.taskId)));
  } else if (command.kind === "tasks") {
    console.log(formatTaskList(runtime.taskFlow.list()));
  } else if (command.kind === "open") {
    const snapshot = await runtime.conversations.open({
      topic: command.prompt,
      codexRepository: command.codexRepository,
      claudeRepository: command.claudeRepository,
      target: command.target,
      mode: command.mode,
      turns: command.turns,
      actor: "local-cli",
    });
    console.log(formatConversation(snapshot.conversation, snapshot.messages, snapshot.artifacts));
  } else if (command.kind === "reply") {
    const snapshot = await runtime.conversations.reply({
      conversationId: command.conversationId,
      target: command.target,
      ...(command.repository ? { repository: command.repository } : {}),
      mode: command.mode,
      turns: command.turns,
      content: command.prompt,
      actor: "local-cli",
    });
    console.log(formatConversation(snapshot.conversation, snapshot.messages, snapshot.artifacts));
  } else if (command.kind === "thread") {
    const snapshot = await runtime.conversations.get(command.conversationId);
    console.log(formatConversation(snapshot.conversation, snapshot.messages, snapshot.artifacts));
  } else if (command.kind === "threads") {
    console.log(formatConversationList(await runtime.conversations.list()));
  } else if (command.kind === "close") {
    const snapshot = await runtime.conversations.close(command.conversationId);
    console.log(formatConversation(snapshot.conversation, snapshot.messages, snapshot.artifacts));
  }
} finally {
  runtime.store.close();
}
