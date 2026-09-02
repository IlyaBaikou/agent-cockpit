import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../process.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "./adapter.js";

export async function resolveCodexBinary(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  for (const candidate of [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Fall back to the next desktop installation or PATH.
    }
  }
  return "codex";
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly #explicitBinary: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: { binary?: string; timeoutMs?: number } = {}) {
    this.#explicitBinary = options.binary;
    this.#timeoutMs = options.timeoutMs ?? Number(process.env.AGENT_TIMEOUT_MS ?? 300_000);
  }

  async healthCheck(): Promise<string> {
    const binary = await resolveCodexBinary(this.#explicitBinary);
    const result = await runProcess(binary, ["--version"], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Codex health check failed");
    }
    const auth = await runProcess(binary, ["login", "status"], { timeoutMs: 10_000 });
    if (auth.exitCode !== 0) throw new Error("Codex установлен, но не авторизован. Выполните codex login.");
    return `${result.stdout.trim()} (authenticated)`;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const binary = await resolveCodexBinary(this.#explicitBinary);
    const tempDirectory = await mkdtemp(join(tmpdir(), "animaplay-agent-hub-codex-"));
    const outputPath = join(tempDirectory, "last-message.txt");

    try {
      const writeMode = request.mode === "write";
      const prompt = request.purpose === "summary" ? request.prompt : writeMode
        ? [
            "You are the assigned implementation agent in an isolated Git worktree.",
            "Implement the requested change completely. You may edit files and run relevant non-destructive checks inside this worktree.",
            "Do not commit, push, merge, change remotes, create another worktree, or edit files outside the current worktree.",
            "Preserve unrelated code and user changes. Finish with a concise summary of changed files, tests run, and remaining risks.",
            "",
            request.prompt,
          ].join("\n")
        : [
            "You are participating in a read-only engineering discussion or code review.",
            "Inspect the repository when useful, but do not modify files, create commits, push, or run state-changing commands.",
            "Answer with a concrete proposal, evidence from the code when available, risks, and explicit questions for the other agent or human.",
            "Keep the response under 1800 words.",
            "",
            request.prompt,
          ].join("\n");

      const result = await runProcess(
        binary,
        [
          "--sandbox",
          writeMode ? "workspace-write" : "read-only",
          "--ask-for-approval",
          "never",
          "-C",
          request.repositoryPath,
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--color",
          "never",
          "--output-last-message",
          outputPath,
          prompt,
        ],
        { cwd: request.repositoryPath, timeoutMs: this.#timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
      );

      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Codex exited with code ${result.exitCode}`);
      }

      const content = (await readFile(outputPath, "utf8")).trim();
      if (!content) {
        throw new Error("Codex returned an empty response");
      }
      return { agent: this.id, content };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}
