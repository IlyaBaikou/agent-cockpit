import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireRunnerProcessLock(path: string, pid = process.pid): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const owner = `${pid}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, owner);
      } finally {
        closeSync(descriptor);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(path, "utf8") === owner) unlinkSync(path);
        } catch {
          // The lock may already have been removed during normal shutdown cleanup.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let existingPid = 0;
      try {
        existingPid = Number(readFileSync(path, "utf8").trim());
      } catch {
        // Treat an unreadable partial lock as stale and retry atomically.
      }
      if (Number.isInteger(existingPid) && existingPid > 0 && processIsAlive(existingPid)) {
        throw new Error(`Runner is already active with PID ${existingPid}; refusing a duplicate process`);
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error(`Could not acquire runner process lock at ${path}`);
}
