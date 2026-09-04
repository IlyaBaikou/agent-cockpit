import spawn from "cross-spawn";
import { buildAgentEnvironment } from "./environment.js";

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
};

// Retain output in memory until the adapter builds a bounded, redacted report.
// Never log this object: arguments and environment must not enter diagnostics.
export class ProcessError extends Error {
  constructor(message: string, readonly code: string, readonly stdout = "", readonly stderr = "") { super(message); }
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new ProcessError("Agent stopped", "ABORTED")); return; }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? buildAgentEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const terminate = (): void => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
      } else {
        try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }, 2000).unref();
      }
    };
    options.signal?.addEventListener("abort", terminate, { once: true });

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-2_000_000);
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-200_000);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? 300_000);
    timer.unref();

    child.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); options.signal?.removeEventListener("abort", terminate); reject(new ProcessError(error.message, error.code ?? "SPAWN_FAILED", stdout, stderr)); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", terminate);
      if (options.signal?.aborted) { reject(new ProcessError("Agent stopped", "ABORTED", stdout, stderr)); return; }
      if (timedOut) {
        reject(new ProcessError(`${command} timed out after ${options.timeoutMs ?? 300_000}ms`, "TIMEOUT", stdout, stderr));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1, ...(signal ? { signal } : {}) });
    });
  });
}
