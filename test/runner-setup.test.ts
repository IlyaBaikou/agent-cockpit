import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readSlackDesktopProof, writeSlackDesktopProof } from "../src/integration-doctor.js";
import { loadRunnerConfig, saveRunnerConfig, type RunnerLocalConfig } from "../src/runner-config.js";
import { discoverGitRepositories, writeRepositoriesConfig } from "../src/runner-setup-core.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runner setup", () => {
  it("discovers nested Git roots and writes local configs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-setup-"));
    temporaryDirectories.push(root);
    const api = join(root, "services", "api");
    const web = join(root, "apps", "web");
    const generatedWorktree = join(root, ".agent-hub-worktrees", "runner", "generated");
    await mkdir(api, { recursive: true });
    await mkdir(web, { recursive: true });
    await mkdir(generatedWorktree, { recursive: true });
    await execFileAsync("git", ["init", "-b", "develop", api]);
    await execFileAsync("git", ["init", "-b", "main", web]);
    await execFileAsync("git", ["init", "-b", "agent-hub/generated", generatedWorktree]);

    const repositories = await discoverGitRepositories(root);
    expect(repositories.map((repository) => `${repository.alias}:${repository.baseRef}`).sort()).toEqual([
      "api:develop",
      "web:main",
    ]);
    const repositoriesFile = join(root, "local", "repositories.json");
    await writeRepositoriesConfig(repositoriesFile, repositories);
    const configPath = join(root, "local", "runner.json");
    const config: RunnerLocalConfig = {
      version: 1,
      runnerId: "developer-codex",
      agent: "codex",
      serverUrl: "http://127.0.0.1:4317",
      tokenEnv: "HUB_RUNNER_TOKEN",
      workspaceRoot: root,
      repositoriesFile,
      worktreeRoot: join(root, "worktrees"),
      allowWrite: false,
      verifyWrites: false,
      integrations: {
        slackDesktop: { enabled: true, channelId: "C123", proofFile: join(root, "local", "proof.json") },
        atlassian: { enabled: true },
      },
    };
    await saveRunnerConfig(configPath, config);
    expect(await loadRunnerConfig(configPath)).toEqual(config);
  });

  it("records a non-secret desktop Slack proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-slack-proof-"));
    temporaryDirectories.push(root);
    const path = join(root, "proof.json");
    await writeSlackDesktopProof(path, {
      workspaceId: "T123",
      workspaceName: "Workspace",
      channelId: "C123",
      channelName: "agent-hub-lab",
      userId: "U123",
      userName: "Developer",
    });
    const proof = await readSlackDesktopProof(path);
    expect(proof).toMatchObject({
      source: "desktop-agent-assisted",
      workspaceId: "T123",
      channelId: "C123",
      userName: "Developer",
    });
    expect(Date.parse(proof?.verifiedAt ?? "")).not.toBeNaN();
  });
});
