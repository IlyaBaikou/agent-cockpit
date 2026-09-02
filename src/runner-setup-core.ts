import { readdir, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { runProcess } from "./process.js";

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".agent-hub-worktrees",
  "runner-worktrees",
  "worktrees",
]);

export type DiscoveredRepository = { alias: string; path: string; baseRef: string };

function safeAlias(name: string): string {
  const alias = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return alias || "repository";
}

export async function discoverGitRepositories(workspaceRoot: string, maxDepth = 3): Promise<DiscoveredRepository[]> {
  const canonicalRoot = await realpath(resolve(workspaceRoot));
  if (!(await stat(canonicalRoot)).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${canonicalRoot}`);
  }
  const roots: string[] = [];

  const visit = async (path: string, depth: number): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some((entry) => entry.name === ".git")) {
      roots.push(path);
    }
    if (depth >= maxDepth) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await visit(join(path, entry.name), depth + 1);
    }
  };
  await visit(canonicalRoot, 0);

  const aliases = new Map<string, number>();
  return await Promise.all(
    roots.sort().map(async (path) => {
      const initial = safeAlias(basename(path));
      const count = (aliases.get(initial) ?? 0) + 1;
      aliases.set(initial, count);
      const branch = await runProcess("git", ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"], {
        timeoutMs: 10_000,
      });
      return { alias: count === 1 ? initial : `${initial}-${count}`, path, baseRef: branch.stdout.trim() || "HEAD" };
    }),
  );
}

export async function writeRepositoriesConfig(path: string, repositories: DiscoveredRepository[]): Promise<void> {
  const config = Object.fromEntries(
    repositories.map((repository) => [
      repository.alias,
      { path: repository.path, baseRef: repository.baseRef, verify: [] },
    ]),
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
