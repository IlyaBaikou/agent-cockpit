import { describe, expect, it } from "vitest";
import { addressReply, mentions } from "../src/collab/addressing.js";

const reply = (content: string) => addressReply(content, "alice", "self", ["alice", "bob"], ["self", "peer", "other"]);

describe("agent reply addressing", () => {
  it("adds the human requester to final answers and the explicit human to decisions", () => {
    expect(reply("Ready\nROUTE: done")).toEqual({ content: "@{u:alice}\n\nReady", route: "done" });
    expect(reply("Approve?\nROUTE: human:bob")).toEqual({ content: "@{u:bob}\n\nApprove?", route: "human:bob" });
    expect(reply("@{u:bob} Approve?")).toEqual({ content: "@{u:bob} Approve?", route: "human:bob" });
  });
  it("makes legacy routes visible and accepts a single peer mention without ROUTE", () => {
    expect(reply("Review?\nROUTE: agent:peer")).toEqual({ content: "@{a:peer}\n\nReview?", route: "agent:peer" });
    expect(reply("@{a:peer} Review? @{a:peer}")).toEqual({ content: "@{a:peer} Review? @{a:peer}", route: "agent:peer" });
    expect(reply("@{a:peer} Review?\nROUTE: agent:peer").error).toBeUndefined();
  });
  it.each([
    "@{a:peer} @{a:other}", "@{a:self} Retry", "@{a:missing} Review",
    "@{a:peer} Review\nROUTE: agent:other", "@{a:peer} Review\nROUTE: done",
    "@{a:peer} Review\nROUTE: human:bob", "Approve\nROUTE: human:outsider", "@{u:outsider} Approve?",
  ])("fails closed on ambiguous, invalid and self targets: %s", (content) => {
    expect(reply(content).error).toBeTruthy(); expect(reply(content).content).toContain("@{u:alice}");
  });
  it.each([
    "`@{a:peer}`", "`` @{a:peer} ``", "```ts\n@{a:peer}\n```", "~~~\n@{a:peer}\n~~~",
    "> @{a:peer}", "    @{a:peer}", "[Example @{a:peer}](https://example.test)", "https://example.test/@{a:peer}",
    "```\nROUTE: agent:peer", "~~~\nROUTE: agent:peer",
  ])("does not invoke agents from examples or quotations: %s", (content) => {
    expect(mentions(content)).toHaveLength(0); expect(reply(content).route).toBeUndefined();
  });
  it("recognizes a real call after a fenced example and does not guess plain names", () => {
    expect(reply("```\n@{a:other}\n```\n@{a:peer} Review?").route).toBe("agent:peer");
    expect(reply("@Bob, @Frontend, Review?").route).toBeUndefined();
    expect(mentions("@{u:bob} `@{u:alice}`")).toEqual([{ kind: "u", id: "bob" }]);
  });
});
