import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { ClaudeAdapter } from "./claude.js";
import { agentFailure, runAgentProcess, checkWorkspace } from "./diagnostics.js";
import { parseCliOutput } from "./cli-output.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "./adapter.js";

export type ClaudeExecutor = "auto" | "claude" | "cursor";

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
    const version = await runAgentProcess("cursor", "version", binary, ["--version"], { timeoutMs: 10_000 });
    if (version.exitCode !== 0 || !version.stdout.trim()) throw agentFailure({ provider: "cursor", stage: "version", binary, result: version });
    const status = await runAgentProcess("cursor", "auth", binary, ["status"], { timeoutMs: 15_000 });
    if (status.exitCode !== 0 || /not authenticated|not logged in/i.test(`${status.stdout}\n${status.stderr}`)) {
      throw agentFailure({ provider: "cursor", stage: "auth", binary, result: status, code: "auth" });
    }
    if (!status.stdout.trim() && !status.stderr.trim()) throw agentFailure({ provider: "cursor", stage: "auth", binary, result: status, code: "empty_response" });
    return `Cursor CLI ${version.stdout.trim()} (authenticated)`;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const binary = await resolveCursorBinary(this.#explicitBinary);
    await checkWorkspace("cursor", request.repositoryPath);
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
      ...(writeMode ? ["--force"] : ["--mode=ask"]),
      "--output-format",
      "json",
      prompt,
    ];
    const result = await runAgentProcess("cursor", "run", binary, args, { cwd: request.repositoryPath, timeoutMs: this.#timeoutMs, ...(request.signal ? { signal: request.signal } : {}) }, [prompt, request.prompt]);
    const parsed = parseCliOutput(result.stdout);
    if (result.exitCode !== 0 || parsed.failed || !parsed.content) {
      throw agentFailure({ provider: "cursor", stage: "response", binary, result, detail: parsed.error,
        code: result.exitCode !== 0 || parsed.failed ? "cli_failed" : !parsed.complete ? "invalid_response" : "empty_response", sensitive: [prompt, request.prompt] });
    }
    return { agent: this.id, content: parsed.content, ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}) };
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
