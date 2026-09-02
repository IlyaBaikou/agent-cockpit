import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const releaseRoot = resolve(root, "release");
const bundleName = "animaplay-frontend-runner";
const bundleRoot = resolve(releaseRoot, bundleName);
const archivePath = resolve(releaseRoot, `${bundleName}.zip`);
const templateRoot = resolve(root, "distribution/frontend-runner");

const runtimeFiles = [
  "agents/adapter.js",
  "agents/claude.js",
  "agents/codex.js",
  "commands.js",
  "control-cli.js",
  "environment.js",
  "git.js",
  "hub-client.js",
  "integration-doctor.js",
  "process.js",
  "repositories.js",
  "runner-config.js",
  "runner-process-lock.js",
  "runner-doctor.js",
  "runner-setup-core.js",
  "runner.js",
  "setup-slack-gateway.js",
  "setup-runner.js",
  "slack-gateway.js",
  "slack-gateway-doctor.js",
  "slack-gateway-config.js",
  "slack-desktop-proof.js",
  "slack/format.js",
  "slack/gateway.js",
  "slack/desktop-publisher.js",
  "slack/desktop-reader.js",
  "slack/desktop-threads-reader.js",
];

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function listFiles(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const item = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(item));
    else if (entry.isFile()) result.push(item);
  }
  return result.sort();
}

await mkdir(releaseRoot, { recursive: true });
await rm(bundleRoot, { recursive: true, force: true });
await rm(archivePath, { force: true });
await rm(`${archivePath}.sha256`, { force: true });
await cp(templateRoot, bundleRoot, { recursive: true });
await mkdir(resolve(bundleRoot, "runtime/native"), { recursive: true });
await copyFile(resolve(root, "native/slack_ax_reader.swift"), resolve(bundleRoot, "runtime/native/slack_ax_reader.swift"));
await copyFile(resolve(root, "native/slack_ax_writer.swift"), resolve(bundleRoot, "runtime/native/slack_ax_writer.swift"));
await copyFile(resolve(root, "native/slack_ax_open_thread.swift"), resolve(bundleRoot, "runtime/native/slack_ax_open_thread.swift"));
await copyFile(resolve(root, "native/slack_ax_threads_reader.swift"), resolve(bundleRoot, "runtime/native/slack_ax_threads_reader.swift"));

for (const file of runtimeFiles) {
  const source = resolve(root, "dist/src", file);
  const target = resolve(bundleRoot, "runtime/dist/src", file);
  await stat(source);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

for (const file of ["LICENSE", "config.js", "package.json", "lib/cli-options.js", "lib/env-options.js", "lib/main.js"]) {
  const source = resolve(root, "node_modules/dotenv", file);
  const target = resolve(bundleRoot, "runtime/node_modules/dotenv", file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
for (const file of [
  "install.command",
  "runtime/doctor.command",
  "runtime/hub.command",
  "runtime/slack-proof.command",
  "runtime/start-slack-gateway.command",
  "runtime/start-runner.command",
]) {
  await chmod(resolve(bundleRoot, file), 0o755);
}

const git = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" });
const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
const filesBeforeManifest = await listFiles(bundleRoot);
const manifest = {
  schemaVersion: 1,
  bundle: bundleName,
  runnerId: "frontend-claude",
  agent: "claude",
  hubUrl: process.env.HUB_URL ?? "http://127.0.0.1:4317",
  sourceCommit: git.status === 0 ? git.stdout.trim() : "unknown",
  sourceDirty: gitStatus.status !== 0 || Boolean(gitStatus.stdout.trim()),
  builtAt: new Date().toISOString(),
  containsSecrets: false,
  files: Object.fromEntries(await Promise.all(filesBeforeManifest.map(async (file) => [relative(bundleRoot, file), await sha256(file)]))),
};
await writeFile(resolve(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

const zip = spawnSync("/usr/bin/zip", ["-qry", archivePath, bundleName, "-x", "*/._*", "*/.DS_Store"], {
  cwd: releaseRoot,
  encoding: "utf8",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
if (zip.status !== 0) {
  throw new Error(zip.stderr || `zip exited with ${zip.status}`);
}
const archiveSha = await sha256(archivePath);
await writeFile(`${archivePath}.sha256`, `${archiveSha}  ${bundleName}.zip\n`, { mode: 0o644 });
console.log(`${archivePath}\nSHA-256: ${archiveSha}`);
