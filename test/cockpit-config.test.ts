import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPeerInviteCode, loadCockpitConfig, saveCockpitConfig } from "../src/cockpit/config.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Cockpit setup", () => {
  it("creates a protected first-run host config with distinct Codex and Claude credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-cockpit-host-"));
    temporaryPaths.push(root);
    const configPath = join(root, "state/cockpit.json");

    const config = await loadCockpitConfig({
      cwd: root,
      env: {},
      args: ["--config", configPath, "--actor", "Ilya", "--peer-actor", "Pavel"],
    });

    expect(config.mode).toBe("host");
    expect(config.firstRun).toBe(true);
    expect(config.localAgents).toEqual([]);
    expect(config.claudeExecutor).toBe("auto");
    expect(config.runnerCredentials.codex.runnerId).toBe("ilya-codex");
    expect(config.runnerCredentials.claude.runnerId).toBe("ilya-claude");
    expect(config.peerRunnerCredentials.codex.runnerId).toBe("pavel-codex");
    expect(config.runnerCredentials.codex.token).not.toBe(config.peerRunnerCredentials.codex.token);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);

    config.localAgents = ["codex", "claude"];
    config.setupComplete = true;
    config.firstRun = false;
    await saveCockpitConfig(config);
    const stored = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("configPath");
    expect(stored).not.toHaveProperty("firstRun");
  });

  it("pairs a peer with separate credentials and lets setup choose either or both agents", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "agent-cockpit-invite-host-"));
    const peerRoot = await mkdtemp(join(tmpdir(), "agent-cockpit-invite-peer-"));
    temporaryPaths.push(hostRoot, peerRoot);
    const host = await loadCockpitConfig({ cwd: hostRoot, env: {}, args: ["--actor", "Ilya", "--peer-actor", "Pavel"] });
    const invite = createPeerInviteCode(host);

    const peer = await loadCockpitConfig({
      cwd: peerRoot,
      env: {},
      args: ["--join", invite, "--actor", "Pavel", "--agents", "claude", "--claude-executor", "cursor"],
    });

    expect(peer.mode).toBe("peer");
    expect(peer.firstRun).toBe(true);
    expect(peer.localAgents).toEqual(["claude"]);
    expect(peer.claudeExecutor).toBe("cursor");
    expect(peer.controlToken).toBe(host.peerControlToken);
    expect(peer.runnerCredentials).toEqual(host.peerRunnerCredentials);
  });
});
