import type {
  ConversationArtifactRecord,
  ConversationMessageRecord,
  ConversationRecord,
  DiscussionMessage,
  TaskRecord,
} from "../types.js";

export function splitSlackMessage(input: string, maxLength = 3_500): string[] {
  if (input.length <= maxLength) {
    return [input];
  }
  const chunks: string[] = [];
  let remaining = input;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < Math.floor(maxLength * 0.6)) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function formatAgentMessage(message: DiscussionMessage): string {
  return `*🤖 ${message.label} · round ${message.round}*\n\n${message.content}`;
}

export function formatTask(task: TaskRecord): string {
  return [
    `*${task.id}* · \`${task.status}\``,
    `Repository: \`${task.repository}\` · base: \`${task.baseRef}\``,
    `Owner: \`${task.owner}\` · reviewer: \`${task.reviewer}\``,
    `Goal: ${task.goal}`,
    task.branchName ? `Branch: \`${task.branchName}\`` : "",
    task.worktreePath ? `Worktree: \`${task.worktreePath}\`` : "",
    task.commitSha ? `Commit: \`${task.commitSha}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "No Agent Hub tasks yet.";
  }
  return tasks
    .map((task) => `• *${task.id}* \`${task.status}\` · \`${task.repository}\` · ${task.owner} · ${task.goal}`)
    .join("\n");
}

export function formatConversation(
  conversation: ConversationRecord,
  messages: ConversationMessageRecord[] = [],
  artifacts: ConversationArtifactRecord[] = [],
): string {
  const header = [
    `*${conversation.id}* · \`${conversation.status}\` · waiting for \`${conversation.waitingFor}\``,
    `Routes: codex → \`${conversation.codexRepository}\` · claude → \`${conversation.claudeRepository}\``,
    `Topic: ${conversation.topic}`,
  ];
  const transcript = messages.map(
    (message) => `\n*${message.label}* · \`${message.kind}\`\n${message.content}`,
  );
  const files = artifacts.length
    ? [`\n*Shared artifacts*`, ...artifacts.map((artifact) => `• \`${artifact.path}\` · ${artifact.size} bytes · \`${artifact.sha256.slice(0, 12)}\``)]
    : [];
  return [...header, ...transcript, ...files].join("\n");
}

export function formatConversationList(conversations: ConversationRecord[]): string {
  if (conversations.length === 0) {
    return "No persistent Agent Hub conversations yet.";
  }
  return conversations
    .map((conversation) => `• *${conversation.id}* \`${conversation.status}\` · → ${conversation.waitingFor} · ${conversation.topic}`)
    .join("\n");
}
