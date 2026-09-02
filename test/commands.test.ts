import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands.js";

describe("parseCommand", () => {
  it("parses a Slack discussion mention", () => {
    expect(parseCommand("<@U123> discuss repo=gameengine rounds=2 Review the API contract", 2)).toEqual({
      kind: "discuss",
      repository: "gameengine",
      rounds: 2,
      prompt: "Review the API contract",
    });
  });

  it("parses a direct agent question", () => {
    expect(parseCommand("ask claude repo=selfplatform Check loading states")).toEqual({
      kind: "ask",
      agent: "claude",
      repository: "selfplatform",
      prompt: "Check loading states",
    });
  });

  it("rejects too many rounds", () => {
    expect(() => parseCommand("discuss rounds=3 topic", 2)).toThrow(/rounds/);
  });

  it("parses a managed implementation proposal", () => {
    expect(parseCommand("propose repo=selfplatform owner=claude base=develop Fix loading state")).toEqual({
      kind: "propose",
      repository: "selfplatform",
      owner: "claude",
      baseRef: "develop",
      goal: "Fix loading state",
    });
  });

  it("parses task lifecycle commands", () => {
    expect(parseCommand("approve ah-12")).toEqual({ kind: "approve", taskId: "AH-12" });
    expect(parseCommand("review AH-12")).toEqual({ kind: "review", taskId: "AH-12" });
    expect(parseCommand("tasks")).toEqual({ kind: "tasks" });
  });

  it("parses persistent conversation commands and repository routes", () => {
    expect(
      parseCommand(
        "open codex_repo=backoffice-api claude_repo=selfplatform to=claude turns=6 Review gamification",
      ),
    ).toEqual({
      kind: "open",
      target: "claude",
      codexRepository: "backoffice-api",
      claudeRepository: "selfplatform",
      mode: "read",
      turns: 6,
      prompt: "Review gamification",
    });
    expect(parseCommand("reply chat-1 to=codex repo=backoffice-api mode=write turns=3 Update the doc")).toEqual({
      kind: "reply",
      conversationId: "CHAT-1",
      target: "codex",
      repository: "backoffice-api",
      mode: "write",
      turns: 3,
      prompt: "Update the doc",
    });
    expect(parseCommand("thread CHAT-1")).toEqual({ kind: "thread", conversationId: "CHAT-1" });
  });
});
