import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { CodexAdapter } from "../agents/codex.js";
import { ClaudeAdapter } from "../agents/claude.js";
import { CursorAdapter } from "../agents/cursor.js";
import type { AgentAdapter } from "../agents/adapter.js";
import { GitWorktreeManager } from "../git.js";
import { ApiError, CollaborationClient } from "./client.js";
import type { Agent, Executor, Job } from "./model.js";

export type LocalAgent = {
  id: string; name: string; description: string; executor: Executor; directory: string;
  binary: string; enabled: boolean; allowWrite: boolean; fallback: string | null;
};
export function adapterFor(agent: Pick<LocalAgent, "executor" | "binary">): AgentAdapter {
  const options = agent.binary ? { binary: agent.binary } : {};
  return agent.executor === "codex" ? new CodexAdapter(options) : agent.executor === "claude" ? new ClaudeAdapter(options) : new CursorAdapter(options);
}
export async function checkLocalAgent(agent: LocalAgent): Promise<string> {
  if (!(await stat(agent.directory)).isDirectory()) throw new Error("Рабочая папка не найдена");
  return adapterFor(agent).healthCheck();
}

export class EmployeeRunner extends EventEmitter {
  #timer: NodeJS.Timeout | undefined;
  #busy = false;
  #stopped = false;
  #abort: AbortController | undefined;
  #lastHealth = 0;
  #lastHeartbeat = 0;
  #ready = false;
  #detail = "Проверка…";
  constructor(private client: CollaborationClient, readonly agent: LocalAgent, private device: string, private worktreesRoot: string,
    private dependencies = { check: checkLocalAgent, adapter: adapterFor }) { super(); }
  start(): void { void this.tick(); this.#timer = setInterval(() => void this.tick(), 5000); }
  stop(): void { this.#stopped = true; clearInterval(this.#timer); this.#abort?.abort(); }
  private async tick(): Promise<void> {
    if (this.#busy || this.#stopped || !this.agent.enabled) return;
    this.#busy = true;
    try {
      if (Date.now() - this.#lastHealth > 60_000) {
        try { this.#detail = await this.dependencies.check(this.agent); this.#ready = true; }
        catch (error) { this.#detail = error instanceof Error ? error.message : String(error); this.#ready = false; }
        this.#lastHealth = Date.now();
      }
      if (this.#stopped) return;
      if (Date.now() - this.#lastHeartbeat > 15_000) {
        await this.client.call("heartbeat", { agent: this.agent.id, device: this.device, ready: this.#ready, detail: this.#detail });
        this.#lastHeartbeat = Date.now();
      }
      this.emit("health", { id: this.agent.id, ready: this.#ready, detail: this.#detail });
      // Claim unavailable jobs too after a failed health check: the server will route
      // on its queue timeout, without ever starting this executor.
      if (!this.#ready) return;
      const result = await this.client.call<{ job: Job | null; prompt?: string; agent?: Agent }>("claim", { agent: this.agent.id, device: this.device });
      if (result.job && result.prompt) await this.execute(result.job, result.prompt);
    } catch (error) { this.emit("health", { id: this.agent.id, ready: false, detail: error instanceof Error ? error.message : String(error) }); }
    finally { this.#busy = false; }
  }
  private async execute(job: Job, prompt: string): Promise<void> {
    this.#abort = new AbortController();
    const leaseBody = { job: job.id, lease: job.lease, device: this.device };
    let leaseBusy = false;
    let lostSince = 0;
    const renew = setInterval(() => {
      if (leaseBusy) return;
      leaseBusy = true;
      void this.client.call<{ cancelled: boolean }>("lease", leaseBody).then((result) => {
        lostSince = 0;
        if (result.cancelled) this.#abort?.abort();
      }).catch((error: unknown) => {
        if (!lostSince) lostSince = Date.now();
        if (error instanceof ApiError || Date.now() - lostSince > 25_000) this.#abort?.abort();
      }).finally(() => { leaseBusy = false; });
    }, 5000);
    let workspace = this.agent.directory;
    try {
      if (this.#stopped) throw new Error("Приложение остановлено");
      if (job.mode === "write") {
        if (!this.agent.allowWrite) throw new Error("Владелец не разрешил изменения");
        const manager = new GitWorktreeManager(this.worktreesRoot);
        const worktree = await manager.create(job.id, { alias: this.agent.id, path: await realpath(this.agent.directory), baseRef: "HEAD", verify: [] });
        workspace = worktree.path;
        this.emit("workspace", { job: job.id, path: workspace });
      }
      // This durable mark precedes any agent execution. Lost acknowledgement stops
      // locally and prevents unsafe reassignment of a potentially writing job.
      const permission = await this.client.call<{ cancelled: boolean }>("lease", { ...leaseBody, started: true });
      if (permission.cancelled || this.#abort.signal.aborted) throw new Error("Задание остановлено");
      if (process.platform === "win32" && prompt.length > 24_000) throw new Error("Контекст превысил лимит запуска Windows CLI в пилоте. Начните новый тред с итогами.");
      const result = await this.dependencies.adapter(this.agent).run({ repositoryPath: workspace, prompt, mode: job.mode, signal: this.#abort.signal, protocol: "collaboration" });
      let content = result.content;
      if (job.mode === "write") {
        const diff = await new GitWorktreeManager(this.worktreesRoot).diff(workspace);
        const route = /(?:^|\n)(ROUTE: [^\n]+)\s*$/.exec(content);
        if (route) content = content.slice(0, route.index);
        content += `\n\nРабочая ветка: agent-hub/${job.id}. Изменения не закоммичены и не отправлены.\n\n\`\`\`diff\n${diff.slice(0, 60_000) || "Нет изменений"}\n\`\`\`\n${route?.[1] ?? "ROUTE: human:" + job.requestedBy}`;
      }
      // Retrying result delivery is safe (the execution itself is never repeated).
      await this.deliver("complete", { ...leaseBody, content }, 3);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("health", { id: this.agent.id, ready: false, detail: message });
      await this.deliver("fail", { ...leaseBody, error: message }, 2).catch(() => undefined);
    } finally { clearInterval(renew); this.#abort = undefined; }
  }
  private async deliver(op: string, body: Record<string, unknown>, attempts: number): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { await this.client.call(op, body); return; }
      catch (error) {
        if (error instanceof ApiError || attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
}
