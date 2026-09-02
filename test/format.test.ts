import { describe, expect, it } from "vitest";
import { splitSlackMessage } from "../src/slack/format.js";

describe("splitSlackMessage", () => {
  it("keeps a short message intact", () => {
    expect(splitSlackMessage("hello", 10)).toEqual(["hello"]);
  });

  it("splits a long message without losing text", () => {
    const chunks = splitSlackMessage("alpha\nbeta\ngamma", 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n").replaceAll("\n", "")).toBe("alphabetagamma");
  });
});
