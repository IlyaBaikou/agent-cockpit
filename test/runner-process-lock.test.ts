import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRunnerProcessLock } from "../src/runner-process-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runner process lock", () => {
  it("rejects a second local process and permits a clean restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-runner-lock-"));
    temporaryDirectories.push(root);
    const path = join(root, "runner.lock");
    const release = acquireRunnerProcessLock(path);
    expect(() => acquireRunnerProcessLock(path)).toThrow("Runner is already active");
    release();
    const releaseRestarted = acquireRunnerProcessLock(path);
    releaseRestarted();
  });
});
