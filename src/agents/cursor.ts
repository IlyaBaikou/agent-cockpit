import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { ClaudeAdapter } from "./claude.js";
import { runProcess } from "../process.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "./adapter.js";

export type ClaudeExecutor = "auto" | "claude" | "cursor";

type CursorJsonResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
};

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCursorBinary(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.CURSOR_AGENT_BIN) return process.env.CURSOR_AGENT_BIN;
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [
    join(homedir(), ".local/bin/cursor-agent"),
    join(homedir(), ".local/bin/agent"),
    ...pathEntries.flatMap((path) => [join(path, "cursor-agent"), join(path, "agent")]),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await executable(candidate)) return candidate;
  }
  return "cursor-agent";
}

export class CursorAdapter implements AgentAdapter {
  readonly id = "claude" as const;
  readonly #explicitBinary: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: { binary?: string; timeoutMs?: number } = {}) {
    this.#explicitBinary = options.binary;
    this.#timeoutMs = options.timeoutMs ?? Number(process.env.AGENT_TIMEOUT_MS ?? 300_000);
  }

  async healthCheck(): Promise<string> {
    const binary = await resolveCursorBinary(this.#explicitBinary);
    const version = await runProcess(binary, ["--version"], { timeoutMs: 10_000 });
    if (version.exitCode !== 0) throw new Error(version.stderr.trim() || "Cursor CLI health check failed");
    const status = await runProcess(binary, ["status"], { timeoutMs: 15_000 });
    if (status.exitCode !== 0 || /not authenticated|not logged in/i.test(`${status.stdout}\n${status.stderr}`)) {
      throw new Error("Cursor CLI is installed but not authenticated; run `cursor-agent login`");
    }
    return `Cursor CLI ${version.stdout.trim()} (authenticated)`;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const binary = await resolveCursorBinary(this.#explicitBinary);
    const writeMode = request.mode === "write";
    const prompt = request.protocol === "collaboration" ? request.prompt : [
      writeMode
        ? "You are the frontend implementation agent in an isolated Git worktree. You may edit files, but do not commit, push, merge, alter remotes, or touch anything outside this worktree."
        : "You are the frontend peer in a read-only engineering discussion. Inspect source when useful, but do not edit files or run state-changing commands.",
      "Continue from the complete Agent Cockpit transcript. Answer the latest message directly, resolve settled points, and call out API contract risks.",
      "Finish with exactly one routing line: HANDOFF: codex, HANDOFF: claude, HANDOFF: human, or HANDOFF: done.",
      "Use HANDOFF: human for approvals or missing product decisions. Keep the response under 1800 words.",
      "",
      request.prompt,
    ].join("\n");
    const args = [
      "--print",
      ...(writeMode ? ["--force", "--mode=agent"] : ["--mode=ask"]),
      "--output-format",
      "json",
      prompt,
    ];
    const result = await runProcess(binary, args, { cwd: request.repositoryPath, timeoutMs: this.#timeoutMs, ...(request.signal ? { signal: request.signal } : {}) });
    let parsed: CursorJsonResult | undefined;
    try {
      parsed = JSON.parse(result.stdout) as CursorJsonResult;
    } catch {
      // Older Cursor builds may return plain text despite the requested format.
    }
    const content = parsed?.result?.trim() || result.stdout.trim();
    if (result.exitCode !== 0 || parsed?.is_error || !content) {
      throw new Error(parsed?.result?.trim() || result.stderr.trim() || `Cursor CLI exited with code ${result.exitCode}`);
    }
    return { agent: this.id, content, ...(parsed?.session_id ? { sessionId: parsed.session_id } : {}) };
  }
}

export class ClaudeCompatibleAdapter implements AgentAdapter {
  readonly id = "claude" as const;
  readonly #preference: ClaudeExecutor;
  #selected: AgentAdapter | undefined;

  constructor(preference: ClaudeExecutor = "auto") {
    this.#preference = preference;
  }

  async healthCheck(): Promise<string> {
    const candidates: AgentAdapter[] = this.#preference === "claude"
      ? [new ClaudeAdapter()]
      : this.#preference === "cursor"
        ? [new CursorAdapter()]
        : [new ClaudeAdapter(), new CursorAdapter()];
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        const detail = await candidate.healthCheck();
        this.#selected = candidate;
        return detail;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(failures.join("; "));
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    if (!this.#selected) await this.healthCheck();
    return await this.#selected!.run(request);
  }
}
