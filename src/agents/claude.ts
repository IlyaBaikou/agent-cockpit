import { stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentFailure, runAgentProcess, checkWorkspace } from "./diagnostics.js";
import { parseCliOutput } from "./cli-output.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "./adapter.js";

type ClaudeAuthStatus = {
  loggedIn?: boolean;
  authMethod?: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function resolveClaudeBinary(explicit?: string, environment = process.env, platform = process.platform, home = homedir()): Promise<string> {
  if (explicit) {
    return explicit;
  }
  if (environment.CLAUDE_BIN) {
    return environment.CLAUDE_BIN;
  }

  const base = platform === "win32"
    ? join(environment.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude-code")
    : join(home, "Library", "Application Support", "Claude", "claude-code");
  try {
    const versions = (await readdir(base)).filter((v) => /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = platform === "win32" ? join(base, version, "claude.exe") : join(base, version, "claude.app", "Contents", "MacOS", "claude");
      if (await exists(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Fall back to PATH below.
  }
  const native = join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude");
  if (await exists(native)) return native;
  return "claude";
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude" as const;
  readonly #explicitBinary: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: { binary?: string; timeoutMs?: number } = {}) {
    this.#explicitBinary = options.binary;
    this.#timeoutMs = options.timeoutMs ?? Number(process.env.AGENT_TIMEOUT_MS ?? 300_000);
  }

  async healthCheck(): Promise<string> {
    const binary = await resolveClaudeBinary(this.#explicitBinary);
    const version = await runAgentProcess("claude", "version", binary, ["--version"], { timeoutMs: 10_000 });
    if (version.exitCode !== 0 || !version.stdout.trim()) {
      throw agentFailure({ provider: "claude", stage: "version", binary, result: version, code: "empty_response" });
    }
    const auth = await runAgentProcess("claude", "auth", binary, ["auth", "status"], { timeoutMs: 10_000 });
    let status: ClaudeAuthStatus | undefined;
    try {
      status = JSON.parse(auth.stdout) as ClaudeAuthStatus;
    } catch {
      // The version check above still gives a useful error if auth status changes format.
    }
    if (auth.exitCode !== 0 || status?.loggedIn !== true) {
      throw agentFailure({ provider: "claude", stage: "auth", binary, result: auth, code: status?.loggedIn === false ? "auth" : "invalid_response" });
    }
    return `${version.stdout.trim()} (${status?.authMethod ?? "authenticated"})`;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const binary = await resolveClaudeBinary(this.#explicitBinary);
    await checkWorkspace("claude", request.repositoryPath);
    const writeMode = request.mode === "write";
    const prompt = request.purpose === "summary" ? request.prompt : writeMode
      ? [
          "You are the assigned implementation agent in an isolated Git worktree.",
          "Implement the requested change by editing files in the current worktree.",
          "Do not commit, push, merge, change Git metadata, or touch files outside the current worktree.",
          "Shell access is disabled; the Agent Hub will run verification commands after your edits.",
          "Finish with a concise summary of changed files and remaining risks.",
          "",
          request.prompt,
        ].join("\n")
      : [
          "You are participating in a read-only engineering discussion or code review.",
          "Inspect the repository when useful, but do not modify files, create commits, push, or run state-changing commands.",
          "Act as a critical peer reviewer: identify contract and implementation risks, answer the other agent, and propose a concrete resolution.",
          "Keep the response under 1800 words.",
          "",
          request.prompt,
        ].join("\n");

    const result = await runAgentProcess(
      "claude", "run", binary,
      [
        "--print",
        "--output-format",
        "json",
        "--permission-mode",
        writeMode ? "acceptEdits" : "plan",
        "--tools",
        writeMode ? "Read,Glob,Grep,Edit,Write" : "Read,Glob,Grep",
        "--no-session-persistence",
        prompt,
      ],
      { cwd: request.repositoryPath, timeoutMs: this.#timeoutMs, ...(request.signal ? { signal: request.signal } : {}) }, [prompt, request.prompt],
    );

    const parsed = parseCliOutput(result.stdout);
    if (result.exitCode !== 0 || parsed.failed || !parsed.content) {
      throw agentFailure({ provider: "claude", stage: "response", binary, result, detail: parsed.error,
        code: result.exitCode !== 0 || parsed.failed ? "cli_failed" : !parsed.complete ? "invalid_response" : "empty_response", sensitive: [prompt, request.prompt] });
    }

    return {
      agent: this.id,
      content: parsed.content,
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    };
  }
}
