import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { CodexAdapter } from "./agents/codex.js";
import { ClaudeAdapter } from "./agents/claude.js";
import type { AgentAdapter } from "./agents/adapter.js";
import { GitWorktreeManager } from "./git.js";
import { RepositoryRegistry } from "./repositories.js";
import { loadRunnerConfig, resolveRunnerToken, runnerConfigPathFromArgs } from "./runner-config.js";
import { acquireRunnerProcessLock } from "./runner-process-lock.js";
import type { ConversationArtifactRecord, RunnerJobRecord } from "./types.js";

type UploadedArtifact = Pick<ConversationArtifactRecord, "path" | "sha256" | "size" | "content">;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function postJson(
  serverUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(new URL(path, serverUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new NonRetryableHubError(typeof result.error === "string" ? result.error : `Hub returned HTTP ${response.status}`);
      }
      return result;
    } catch (error) {
      if (error instanceof NonRetryableHubError) throw error;
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

class NonRetryableHubError extends Error {}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function collectArtifacts(content: string, repositoryPath: string): Promise<UploadedArtifact[]> {
  const paths = [...content.matchAll(/^ARTIFACT:\s*(.+?)\s*$/gim)]
    .map((match) => match[1]?.replace(/^`|`$/g, "").trim())
    .filter((value): value is string => Boolean(value));
  const unique = [...new Set(paths)].slice(0, 19);
  const artifacts: UploadedArtifact[] = [];
  for (const path of unique) {
    if (isAbsolute(path)) {
      continue;
    }
    const absolute = resolve(repositoryPath, path);
    const inside = relative(repositoryPath, absolute);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      continue;
    }
    try {
      const metadata = await stat(absolute);
      if (!metadata.isFile() || metadata.size > 512_000) {
        continue;
      }
      const artifactContent = await readFile(absolute, "utf8");
      artifacts.push({ path: inside, sha256: sha256(artifactContent), size: metadata.size, content: artifactContent });
    } catch {
      // An invalid or binary artifact declaration is ignored; the textual response remains available.
    }
  }
  return artifacts;
}

export class RemoteRunner {
  readonly #serverUrl: string;
  readonly #runnerId: string;
  readonly #token: string;
  readonly #agentId: "codex" | "claude";
  readonly #repositories: RepositoryRegistry;
  readonly #worktrees: GitWorktreeManager;
  readonly #agent: AgentAdapter;
  readonly #allowWrite: boolean;
  readonly #verifyWrites: boolean;

  constructor(options: {
    serverUrl: string;
    runnerId: string;
    token: string;
    agentId: "codex" | "claude";
    repositories: RepositoryRegistry;
    worktrees?: GitWorktreeManager;
    agent?: AgentAdapter;
    allowWrite?: boolean;
    verifyWrites?: boolean;
  }) {
    if (!/^https:\/\//.test(options.serverUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(options.serverUrl)) {
      throw new Error("Remote runners require HTTPS except for localhost development");
    }
    this.#serverUrl = options.serverUrl;
    this.#runnerId = options.runnerId;
    this.#token = options.token;
    this.#agentId = options.agentId;
    this.#repositories = options.repositories;
    const projectRoot = resolve(process.cwd());
    this.#worktrees =
      options.worktrees ??
      new GitWorktreeManager(process.env.HUB_RUNNER_WORKTREE_ROOT ?? resolve(projectRoot, "runner-worktrees"));
    this.#agent = options.agent ?? (options.agentId === "codex" ? new CodexAdapter() : new ClaudeAdapter());
    this.#allowWrite = options.allowWrite ?? process.env.HUB_RUNNER_ALLOW_WRITE === "true";
    this.#verifyWrites = options.verifyWrites ?? process.env.HUB_RUNNER_VERIFY_WRITES === "true";
  }

  async runOnce(): Promise<boolean> {
    const claimed = await postJson(this.#serverUrl, this.#token, "/v1/jobs/claim", { runnerId: this.#runnerId });
    const job = claimed.job as RunnerJobRecord | null;
    if (!job) {
      return false;
    }
    try {
      if (job.targetAgent !== this.#agentId) {
        throw new Error(`Hub assigned ${job.targetAgent} job to ${this.#agentId} runner`);
      }
      if (job.mode === "write" && !this.#allowWrite) {
        throw new Error("Write job rejected: set HUB_RUNNER_ALLOW_WRITE=true on this runner after developer approval");
      }
      const repository = this.#repositories.get(job.repository);
      const workspace = job.mode === "write"
        ? await this.#worktrees.create(`${job.conversationId}-${this.#runnerId}`, repository, repository.baseRef)
        : undefined;
      const repositoryPath = workspace?.path ?? repository.path;
      const result = await this.#agent.run({
        repositoryPath,
        prompt: job.prompt,
        mode: job.mode,
      });
      const artifacts = await collectArtifacts(result.content, repositoryPath);
      if (job.mode === "write") {
        if (!workspace) throw new Error("Write job has no isolated worktree");
        const diff = await this.#worktrees.diff(workspace.path);
        if (!diff) {
          throw new Error(`${this.#agentId} write job completed without file changes`);
        }
        artifacts.push({
          path: `.agent-hub/${job.conversationId}.patch`,
          sha256: sha256(diff),
          size: Buffer.byteLength(diff),
          content: diff.slice(0, 512_000),
        });
        if (this.#verifyWrites) {
          await this.#worktrees.verify(workspace.path, repository.verify);
        }
      }
      await postJson(this.#serverUrl, this.#token, "/v1/jobs/complete", {
        runnerId: this.#runnerId,
        jobId: job.id,
        content: result.content,
        artifacts,
      });
      console.log(`${this.#runnerId}: completed ${job.id} (${job.conversationId})`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await postJson(this.#serverUrl, this.#token, "/v1/jobs/fail", {
        runnerId: this.#runnerId,
        jobId: job.id,
        error: message,
      });
      console.error(`${this.#runnerId}: failed ${job.id}: ${message}`);
      return true;
    }
  }
}

async function main(): Promise<void> {
  const configPath = runnerConfigPathFromArgs();
  const config = await loadRunnerConfig(configPath);
  const repositories = new RepositoryRegistry(config?.repositoriesFile);
  await repositories.load();
  const agentId = config?.agent ?? required("HUB_RUNNER_AGENT");
  if (agentId !== "codex" && agentId !== "claude") {
    throw new Error("HUB_RUNNER_AGENT must be codex or claude");
  }
  const runnerId = config?.runnerId ?? required("HUB_RUNNER_ID");
  const releaseProcessLock = acquireRunnerProcessLock(resolve(dirname(configPath), `${runnerId}.lock`));
  process.once("exit", releaseProcessLock);
  const serverUrl = config?.serverUrl ?? required("HUB_SERVER_URL");
  const runner = new RemoteRunner({
    serverUrl,
    runnerId,
    token: resolveRunnerToken(config),
    agentId,
    repositories,
    ...(config ? { worktrees: new GitWorktreeManager(config.worktreeRoot), allowWrite: config.allowWrite, verifyWrites: config.verifyWrites } : {}),
  });
  const pollMs = Number(process.env.HUB_RUNNER_POLL_MS ?? 2_000);
  console.log(`Runner ${runnerId} (${agentId}) connected to ${serverUrl}`);
  do {
    let worked = false;
    try {
      worked = await runner.runOnce();
    } catch (error) {
      console.error(`Runner connection error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (process.env.HUB_RUNNER_ONCE === "true") {
      break;
    }
    if (!worked) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  } while (true);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
