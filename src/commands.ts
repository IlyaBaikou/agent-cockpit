import type { AgentId, HubCommand } from "./types.js";

function removeSlackMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, " ").replace(/\s+/g, " ").trim();
}

function takeOption(tokens: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const index = tokens.findIndex((token) => token.startsWith(prefix));
  if (index === -1) {
    return undefined;
  }
  const [token] = tokens.splice(index, 1);
  return token?.slice(prefix.length);
}

function takeTaskId(tokens: string[], usage: string): string {
  const taskId = tokens.shift()?.toUpperCase();
  if (!taskId || !/^AH-\d+$/.test(taskId) || tokens.length > 0) {
    throw new Error(`Usage: ${usage}`);
  }
  return taskId;
}

function takeConversationId(tokens: string[], usage: string): string {
  const id = tokens.shift()?.toUpperCase();
  if (!id || !/^CHAT-\d+$/.test(id)) {
    throw new Error(`Usage: ${usage}`);
  }
  return id;
}

function takeAgentOption(tokens: string[], name: string): AgentId {
  const agent = (takeOption(tokens, name) ?? "").toLowerCase();
  if (agent !== "codex" && agent !== "claude") {
    throw new Error(`${name} must be codex or claude`);
  }
  return agent;
}

function takeModeOption(tokens: string[]): "read" | "write" {
  const mode = (takeOption(tokens, "mode") ?? "read").toLowerCase();
  if (mode !== "read" && mode !== "write") {
    throw new Error("mode must be read or write");
  }
  return mode;
}

function takeTurnsOption(tokens: string[]): number {
  const turns = Number(takeOption(tokens, "turns") ?? 1);
  if (!Number.isInteger(turns) || turns < 1 || turns > 12) {
    throw new Error("turns must be an integer between 1 and 12");
  }
  return turns;
}

export function parseCommand(input: string, maxRounds = 2): HubCommand {
  const normalized = removeSlackMentions(input);
  if (!normalized || normalized === "help") {
    return { kind: "help" };
  }

  const tokens = normalized.split(" ");
  const kind = tokens.shift()?.toLowerCase();

  if (kind === "ask") {
    const agent = tokens.shift()?.toLowerCase();
    if (agent !== "codex" && agent !== "claude") {
      throw new Error("Usage: ask codex|claude repo=<alias> <question>");
    }
    const repository = takeOption(tokens, "repo") ?? "agent-hub";
    const prompt = tokens.join(" ").trim();
    if (!prompt) {
      throw new Error("Question is required");
    }
    return { kind: "ask", agent: agent as AgentId, repository, prompt };
  }

  if (kind === "discuss") {
    const repository = takeOption(tokens, "repo") ?? "agent-hub";
    const requestedRounds = Number(takeOption(tokens, "rounds") ?? 1);
    if (!Number.isInteger(requestedRounds) || requestedRounds < 1 || requestedRounds > maxRounds) {
      throw new Error(`rounds must be an integer between 1 and ${maxRounds}`);
    }
    const prompt = tokens.join(" ").trim();
    if (!prompt) {
      throw new Error("Discussion prompt is required");
    }
    return { kind: "discuss", repository, prompt, rounds: requestedRounds };
  }

  if (kind === "propose") {
    const repository = takeOption(tokens, "repo") ?? "agent-hub";
    const owner = (takeOption(tokens, "owner") ?? "codex").toLowerCase();
    if (owner !== "codex" && owner !== "claude") {
      throw new Error("owner must be codex or claude");
    }
    const baseRef = takeOption(tokens, "base") ?? "";
    const goal = tokens.join(" ").trim();
    if (!goal) {
      throw new Error("Usage: propose repo=<alias> owner=codex|claude [base=<ref>] <goal>");
    }
    return { kind: "propose", repository, owner: owner as AgentId, baseRef, goal };
  }

  if (kind === "approve" || kind === "implement" || kind === "review" || kind === "revise" || kind === "commit") {
    return { kind, taskId: takeTaskId(tokens, `${kind} AH-0001`) };
  }

  if (kind === "status") {
    return { kind, taskId: takeTaskId(tokens, "status AH-0001") };
  }

  if (kind === "tasks") {
    if (tokens.length > 0) {
      throw new Error("Usage: tasks");
    }
    return { kind: "tasks" };
  }

  if (kind === "open") {
    const target = takeAgentOption(tokens, "to");
    const repository = takeOption(tokens, "repo") ?? "agent-hub";
    const codexRepository = takeOption(tokens, "codex_repo") ?? repository;
    const claudeRepository = takeOption(tokens, "claude_repo") ?? repository;
    const mode = takeModeOption(tokens);
    const turns = takeTurnsOption(tokens);
    const prompt = tokens.join(" ").trim();
    if (!prompt) {
      throw new Error("Usage: open to=codex|claude [repo=<alias>] [codex_repo=<alias>] [claude_repo=<alias>] [mode=read|write] [turns=1..12] <topic>");
    }
    return { kind: "open", target, codexRepository, claudeRepository, mode, turns, prompt };
  }

  if (kind === "reply") {
    const conversationId = takeConversationId(tokens, "reply CHAT-0001 to=codex|claude <message>");
    const target = takeAgentOption(tokens, "to");
    const repository = takeOption(tokens, "repo");
    const mode = takeModeOption(tokens);
    const turns = takeTurnsOption(tokens);
    const prompt = tokens.join(" ").trim();
    if (!prompt) {
      throw new Error("Reply text is required");
    }
    return { kind: "reply", conversationId, target, ...(repository ? { repository } : {}), mode, turns, prompt };
  }

  if (kind === "thread" || kind === "close") {
    const conversationId = takeConversationId(tokens, `${kind} CHAT-0001`);
    if (tokens.length > 0) {
      throw new Error(`Usage: ${kind} CHAT-0001`);
    }
    return { kind, conversationId };
  }

  if (kind === "threads") {
    if (tokens.length > 0) {
      throw new Error("Usage: threads");
    }
    return { kind: "threads" };
  }

  throw new Error("Unknown command. Use: help, ask, discuss, open, reply, thread, threads, close, propose, approve, implement, review, revise, commit, status, or tasks");
}

export function helpText(repositories: string[]): string {
  return [
    "*AnimaPlay Agent Hub Lab*",
    "",
    "*Read-only discussion*",
    "`@AgentHub ask codex repo=agent-hub <question>`",
    "`@AgentHub ask claude repo=gameengine <question>`",
    "`@AgentHub discuss repo=gameengine rounds=1 <topic>`",
    "",
    "*Managed implementation flow*",
    "`@AgentHub propose repo=selfplatform owner=codex <goal>`",
    "`@AgentHub approve AH-0001`",
    "`@AgentHub implement AH-0001`",
    "`@AgentHub review AH-0001`",
    "`@AgentHub revise AH-0001` (when changes were requested)",
    "`@AgentHub commit AH-0001` (only after approval)",
    "`@AgentHub status AH-0001` · `@AgentHub tasks`",
    "",
    "*Persistent two-runner conversations*",
    "`open repo=gameengine to=claude turns=6 <topic>`",
    "`open codex_repo=backoffice-api claude_repo=selfplatform to=claude turns=6 <topic>`",
    "`reply CHAT-0001 to=codex mode=write turns=4 <approved edit>`",
    "`thread CHAT-0001` · `threads` · `close CHAT-0001`",
    "",
    `Repositories: ${repositories.map((name) => `\`${name}\``).join(", ")}`,
    "Writes happen only in per-task Git worktrees. The hub never pushes or merges.",
  ].join("\n");
}
