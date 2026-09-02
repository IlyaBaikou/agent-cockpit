import { access, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "./process.js";
import type { RepositoryDefinition, VerificationCommand } from "./repositories.js";

export type WorktreeInfo = {
  branchName: string;
  path: string;
  baseCommit: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safeTaskName(taskId: string): string {
  const safe = taskId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  if (!safe) {
    throw new Error(`Invalid task id: ${taskId}`);
  }
  return safe;
}

function truncate(input: string, maxLength = 120_000): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength)}\n\n[diff truncated by Agent Hub]`;
}

export class GitWorktreeManager {
  readonly #root: string;

  constructor(root?: string) {
    const projectRoot = resolve(process.cwd());
    this.#root = resolve(root ?? process.env.HUB_WORKTREE_ROOT ?? resolve(projectRoot, "worktrees"));
  }

  async create(taskId: string, repository: RepositoryDefinition, requestedBase?: string): Promise<WorktreeInfo> {
    const baseRef = requestedBase || repository.baseRef;
    const repositoryRoot = await this.#git(repository.path, ["rev-parse", "--show-toplevel"]);
    if (resolve(repositoryRoot) !== resolve(repository.path)) {
      throw new Error(`Repository alias '${repository.alias}' must point to its Git root: ${repositoryRoot}`);
    }
    const baseCommit = await this.#git(repository.path, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    const name = safeTaskName(taskId);
    const branchName = `agent-hub/${name}`;
    const worktreePath = resolve(this.#root, `${repository.alias}-${name}`);

    const pathExists = await exists(worktreePath);
    const branchCheck = await runProcess("git", ["-C", repository.path, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      timeoutMs: 10_000,
    });
    if (branchCheck.exitCode !== 0 && branchCheck.exitCode !== 1) {
      throw new Error(branchCheck.stderr.trim() || `Could not inspect branch ${branchName}`);
    }
    const branchExists = branchCheck.exitCode === 0;

    if (pathExists && branchExists) {
      const rootCheck = await runProcess("git", ["-C", worktreePath, "rev-parse", "--show-toplevel"], { timeoutMs: 10_000 });
      const branchNameCheck = await runProcess("git", ["-C", worktreePath, "symbolic-ref", "--short", "HEAD"], {
        timeoutMs: 10_000,
      });
      const canonicalExpectedPath = await realpath(worktreePath);
      const canonicalReportedPath = rootCheck.exitCode === 0 ? await realpath(rootCheck.stdout.trim()) : "";
      if (
        rootCheck.exitCode === 0 &&
        canonicalReportedPath === canonicalExpectedPath &&
        branchNameCheck.exitCode === 0 &&
        branchNameCheck.stdout.trim() === branchName
      ) {
        return { branchName, path: worktreePath, baseCommit };
      }
      throw new Error(
        `Approval recovery found branch '${branchName}' and path '${worktreePath}', but the path is not a valid worktree for that branch`,
      );
    }

    if (pathExists || branchExists) {
      const existing = [pathExists ? `path '${worktreePath}'` : "", branchExists ? `branch '${branchName}'` : ""]
        .filter(Boolean)
        .join(" and ");
      const missing = pathExists ? `branch '${branchName}'` : `path '${worktreePath}'`;
      throw new Error(`Partial approval state: ${existing} exists but ${missing} does not; inspect it manually before retrying`);
    }

    await mkdir(this.#root, { recursive: true });
    await this.#git(repository.path, ["worktree", "add", "-b", branchName, worktreePath, baseCommit], 60_000);
    return { branchName, path: worktreePath, baseCommit };
  }

  async status(worktreePath: string): Promise<string> {
    return await this.#git(worktreePath, ["status", "--short"]);
  }

  async diff(worktreePath: string): Promise<string> {
    await this.#git(worktreePath, ["add", "--intent-to-add", "--all"]);
    try {
      return truncate(await this.#git(worktreePath, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]));
    } finally {
      await this.#git(worktreePath, ["reset", "--mixed", "HEAD", "--"]);
    }
  }

  async verify(worktreePath: string, commands: VerificationCommand[]): Promise<string> {
    if (commands.length === 0) {
      return "No verification commands are configured for this repository.";
    }
    const summaries: string[] = [];
    for (const item of commands) {
      const args = item.args ?? [];
      const result = await runProcess(item.command, args, {
        cwd: worktreePath,
        timeoutMs: Number(process.env.HUB_VERIFY_TIMEOUT_MS ?? 600_000),
      });
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      summaries.push(`$ ${[item.command, ...args].join(" ")}\n${truncate(output, 12_000) || "(no output)"}`);
      if (result.exitCode !== 0) {
        throw new Error(`Verification failed (${item.command}, exit ${result.exitCode}):\n${truncate(output, 4_000)}`);
      }
    }
    return summaries.join("\n\n");
  }

  async commit(worktreePath: string, message: string): Promise<string> {
    const changes = await this.status(worktreePath);
    if (!changes) {
      throw new Error("There are no changes to commit");
    }
    await this.#git(worktreePath, ["add", "--all"]);
    await this.#git(worktreePath, ["commit", "-m", message], 60_000);
    return await this.#git(worktreePath, ["rev-parse", "HEAD"]);
  }

  async #git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
    const result = await runProcess("git", ["-C", cwd, ...args], { timeoutMs });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} exited with code ${result.exitCode}`);
    }
    return result.stdout.trim();
  }
}
