import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ? resolve(process.argv[2]) : null;
if (!target || target === root || target.startsWith(root + "/")) throw new Error("Choose a new, separate export directory");
try { await stat(target); throw new Error("Export target already exists; refusing to overwrite it"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(target, { recursive: true });
const files = ["src", "test", "scripts", "ui", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "Dockerfile", ".dockerignore", ".gitignore", "electron-builder.yml", ".github", "docs/COLLABORATION-MVP.md", "docs/RELEASE-NOTES.md", "docs/CONTEXT.md"];
for (const path of files) { await mkdir(dirname(join(target, path)), { recursive: true }); await cp(join(root, path), join(target, path), { recursive: true, errorOnExist: true }); }
await cp(join(root, "distribution/github"), join(target, "distribution/github"), { recursive: true });
await cp(join(root, "distribution/github/README.md"), join(target, "README.md"));
await cp(join(root, "distribution/github/env.example"), join(target, ".env.example"));
await cp(join(root, "distribution/github/config"), join(target, "config"), { recursive: true });

// Source allowlist: no history, local config, screenshots, caches or previous chat
// transcripts. Fail the export if recognizable credentials still appear in source.
const secretPattern = /(?:gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{35,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
let count = 0;
async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink in export: ${file}`);
    if (entry.isDirectory()) await scan(file);
    else { const text = await readFile(file, "utf8"); if (secretPattern.test(text)) throw new Error(`Possible secret in export: ${file}`); count++; }
  }
}
await scan(target);
console.log(`Exported and scanned ${count} source files to ${target}. Git history and local data were not copied.`);
