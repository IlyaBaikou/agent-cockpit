import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CursorAdapter } from "../src/agents/cursor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CursorAdapter", () => {
  it("checks an authenticated Cursor CLI and parses its headless JSON result", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-cursor-"));
    temporaryDirectories.push(root);
    const binary = join(root, "cursor-agent");
    await writeFile(binary, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2026.08.25-test"; exit 0; fi
if [ "$1" = "status" ]; then echo "Authenticated"; exit 0; fi
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Cursor reviewed the contract.\\nHANDOFF: human","session_id":"cursor-session"}'
`);
    await chmod(binary, 0o700);

    const adapter = new CursorAdapter({ binary });
    expect(await adapter.healthCheck()).toContain("Cursor CLI 2026.08.25-test");
    const result = await adapter.run({ repositoryPath: root, prompt: "Review the API", mode: "read" });
    expect(result).toEqual({
      agent: "claude",
      content: "Cursor reviewed the contract.\nHANDOFF: human",
      sessionId: "cursor-session",
    });
  });
});
