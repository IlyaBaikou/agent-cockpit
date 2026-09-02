import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../process.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "./adapter.js";

type ClaudeJsonResult = {
  result?: string;
  session_id?: string;
  is_error?: boolean;
};

type ClaudeAuthStatus = {
  loggedIn?: boolean;
  authMethod?: string;
};

function parseClaudeResult(output: string): ClaudeJsonResult | undefined {
  try {
    return JSON.parse(output) as ClaudeJsonResult;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClaudeBinary(explicit?: string): Promise<string> {
  if (explicit) {
    return explicit;
  }
  if (process.env.CLAUDE_BIN) {
    return process.env.CLAUDE_BIN;
  }

  const base = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
  try {
    const versions = (await readdir(base)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(base, version, "claude.app", "Contents", "MacOS", "claude");
      if (await exists(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Fall back to PATH below.
  }
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
    const version = await runProcess(binary, ["--version"], { timeoutMs: 10_000 });
    if (version.exitCode !== 0) {
      throw new Error(version.stderr || "Claude health check failed");
    }
    const auth = await runProcess(binary, ["auth", "status"], { timeoutMs: 10_000 });
    let status: ClaudeAuthStatus | undefined;
    try {
      status = JSON.parse(auth.stdout) as ClaudeAuthStatus;
    } catch {
      // The version check above still gives a useful error if auth status changes format.
    }
    if (auth.exitCode !== 0 || status?.loggedIn === false) {
      throw new Error("Claude Code is installed but not logged in; run `claude auth login`");
    }
    return `${version.stdout.trim()} (${status?.authMethod ?? "authenticated"})`;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const binary = await resolveClaudeBinary(this.#explicitBinary);
    const writeMode = request.mode === "write";
    const prompt = writeMode
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

    const result = await runProcess(
      binary,
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
      { cwd: request.repositoryPath, timeoutMs: this.#timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
    );

    const parsed = parseClaudeResult(result.stdout) ?? { result: result.stdout.trim() };
    if (result.exitCode !== 0) {
      throw new Error(parsed.result?.trim() || result.stderr.trim() || `Claude exited with code ${result.exitCode}`);
    }
    if (parsed.is_error || !parsed.result?.trim()) {
      throw new Error(parsed.result?.trim() || "Claude returned an empty response");
    }

    return {
      agent: this.id,
      content: parsed.result.trim(),
      ...(parsed.session_id ? { sessionId: parsed.session_id } : {}),
    };
  }
}
