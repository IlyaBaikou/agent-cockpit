import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentId } from "./types.js";

export type RunnerLocalConfig = {
  version: 1;
  runnerId: string;
  agent: AgentId;
  serverUrl: string;
  tokenEnv: string;
  workspaceRoot: string;
  repositoriesFile: string;
  worktreeRoot: string;
  allowWrite: boolean;
  verifyWrites: boolean;
  integrations: {
    slackDesktop: {
      enabled: boolean;
      publishResponses?: boolean;
      readCommands?: boolean;
      allowedAuthors?: string[];
      readerStateFile?: string;
      channelId?: string;
      proofFile: string;
    };
    atlassian: { enabled: boolean };
  };
};

export function projectRoot(): string {
  return resolve(process.cwd());
}

export function defaultRunnerConfigPath(): string {
  return resolve(projectRoot(), ".agent-hub-local/runner.json");
}

export function runnerConfigPathFromArgs(args = process.argv.slice(2)): string {
  const index = args.indexOf("--config");
  const configured = index >= 0 ? args[index + 1] : undefined;
  return resolve(configured ?? process.env.AGENT_HUB_RUNNER_FILE ?? defaultRunnerConfigPath());
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadRunnerConfig(path = runnerConfigPathFromArgs()): Promise<RunnerLocalConfig | undefined> {
  if (!(await fileExists(path))) {
    return undefined;
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as RunnerLocalConfig;
  if (parsed.version !== 1 || !parsed.runnerId || (parsed.agent !== "codex" && parsed.agent !== "claude")) {
    throw new Error(`Invalid runner config: ${path}`);
  }
  return parsed;
}

export async function saveRunnerConfig(path: string, config: RunnerLocalConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function resolveRunnerToken(config?: RunnerLocalConfig): string {
  const tokenEnv = config?.tokenEnv || "HUB_RUNNER_TOKEN";
  const token = process.env[tokenEnv]?.trim();
  if (!token) {
    throw new Error(`${tokenEnv} is required; the setup intentionally does not store runner tokens on disk`);
  }
  return token;
}
