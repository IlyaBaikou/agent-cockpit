import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import type { AgentId } from "../types.js";
import type { ClaudeExecutor } from "../agents/cursor.js";

export type CockpitMode = "host" | "peer";

export type CockpitRunnerCredential = {
  runnerId: string;
  token: string;
};

export type CockpitConfig = {
  version: 1;
  setupComplete: boolean;
  mode: CockpitMode;
  actor: string;
  peerActor: string;
  peerAgent: AgentId;
  listenHost: string;
  port: number;
  serverUrl: string;
  advertiseUrl: string;
  controlToken: string;
  peerControlToken: string;
  runnerCredentials: Record<AgentId, CockpitRunnerCredential>;
  peerRunnerCredentials: Record<AgentId, CockpitRunnerCredential>;
  localAgents: AgentId[];
  claudeExecutor: ClaudeExecutor;
  databasePath: string;
  repositoriesFile: string;
  agentsFile: string;
  worktreeRoot: string;
  allowWrite: boolean;
  verifyWrites: boolean;
};

export type CockpitConfigWithPath = CockpitConfig & { configPath: string; firstRun: boolean };

export type CockpitInvite = {
  version: 1;
  serverUrl: string;
  actor: string;
  controlToken: string;
  runnerCredentials: Record<AgentId, CockpitRunnerCredential>;
};

type LoadOptions = {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

function token(): string {
  return randomBytes(32).toString("base64url");
}

function parseArguments(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current?.startsWith("--")) continue;
    const inline = current.indexOf("=");
    if (inline > 2) {
      values.set(current.slice(2, inline), current.slice(inline + 1));
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(current.slice(2), next);
      index += 1;
    } else {
      values.set(current.slice(2), "true");
    }
  }
  return values;
}

function agents(value: string | undefined, fallback: AgentId[]): AgentId[] {
  if (!value) return fallback;
  const parsed = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (parsed.some((item) => item !== "codex" && item !== "claude")) {
    throw new Error("--agents accepts only codex and claude");
  }
  return parsed as AgentId[];
}

function port(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("Cockpit port must be an integer between 1 and 65535");
  }
  return parsed;
}

function claudeExecutor(value: string | undefined, fallback: ClaudeExecutor): ClaudeExecutor {
  const selected = value ?? fallback;
  if (selected !== "auto" && selected !== "claude" && selected !== "cursor") {
    throw new Error("Claude executor must be auto, claude, or cursor");
  }
  return selected;
}

function assertServerUrl(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Peer connection must use HTTPS; plain HTTP is allowed only for localhost testing");
  }
  return url.toString().replace(/\/$/, "");
}

function encodeInvite(invite: CockpitInvite): string {
  return Buffer.from(JSON.stringify(invite), "utf8").toString("base64url");
}

function decodeInvite(value: string): CockpitInvite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid Cockpit invite code");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid Cockpit invite code");
  const invite = parsed as Partial<CockpitInvite>;
  if (
    invite.version !== 1 ||
    typeof invite.serverUrl !== "string" ||
    typeof invite.actor !== "string" ||
    typeof invite.controlToken !== "string" ||
    invite.controlToken.length < 24 ||
    !validRunnerCredentials(invite.runnerCredentials)
  ) {
    throw new Error("Invalid Cockpit invite code");
  }
  return {
    version: 1,
    serverUrl: assertServerUrl(invite.serverUrl),
    actor: invite.actor,
    controlToken: invite.controlToken,
    runnerCredentials: invite.runnerCredentials,
  };
}

function validRunnerCredentials(value: unknown): value is Record<AgentId, CockpitRunnerCredential> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Record<AgentId, Partial<CockpitRunnerCredential>>>;
  return ["codex", "claude"].every((agent) => {
    const credential = candidate[agent as AgentId];
    return typeof credential?.runnerId === "string" && typeof credential.token === "string" && credential.token.length >= 24;
  });
}

function defaultHostConfig(root: string, actor: string, peerActor: string, configuredPort: number): CockpitConfig {
  const localUrl = `http://127.0.0.1:${configuredPort}`;
  return {
    version: 1,
    setupComplete: false,
    mode: "host",
    actor,
    peerActor,
    peerAgent: "claude",
    listenHost: "127.0.0.1",
    port: configuredPort,
    serverUrl: localUrl,
    advertiseUrl: localUrl,
    controlToken: token(),
    peerControlToken: token(),
    runnerCredentials: {
      codex: { runnerId: `${slug(actor)}-codex`, token: token() },
      claude: { runnerId: `${slug(actor)}-claude`, token: token() },
    },
    peerRunnerCredentials: {
      codex: { runnerId: `${slug(peerActor)}-codex`, token: token() },
      claude: { runnerId: `${slug(peerActor)}-claude`, token: token() },
    },
    localAgents: [],
    claudeExecutor: "auto",
    databasePath: resolve(root, ".agent-hub-local/cockpit.sqlite"),
    repositoriesFile: resolve(root, "config/repositories.json"),
    agentsFile: resolve(root, "config/agents.json"),
    worktreeRoot: resolve(root, ".agent-hub-worktrees/cockpit"),
    allowWrite: false,
    verifyWrites: false,
  };
}

function peerConfig(root: string, actor: string, invite: CockpitInvite): CockpitConfig {
  return {
    version: 1,
    setupComplete: false,
    mode: "peer",
    actor,
    peerActor: invite.actor,
    peerAgent: "claude",
    listenHost: "127.0.0.1",
    port: 4318,
    serverUrl: invite.serverUrl,
    advertiseUrl: invite.serverUrl,
    controlToken: invite.controlToken,
    peerControlToken: token(),
    runnerCredentials: invite.runnerCredentials,
    peerRunnerCredentials: {
      codex: { runnerId: "unused-peer-codex", token: token() },
      claude: { runnerId: "unused-peer-claude", token: token() },
    },
    localAgents: [],
    claudeExecutor: "auto",
    databasePath: resolve(root, ".agent-hub-local/peer-unused.sqlite"),
    repositoriesFile: resolve(root, "config/repositories.json"),
    agentsFile: resolve(root, "config/agents.json"),
    worktreeRoot: resolve(root, ".agent-hub-worktrees/cockpit-peer"),
    allowWrite: false,
    verifyWrites: false,
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "developer";
}

async function save(path: string, config: CockpitConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function loadCockpitConfig(options: LoadOptions = {}): Promise<CockpitConfigWithPath> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const args = parseArguments(options.args ?? process.argv.slice(2));
  const configPath = resolve(args.get("config") ?? env.COCKPIT_CONFIG ?? resolve(cwd, ".agent-hub-local/cockpit.json"));
  const actor = args.get("actor") ?? env.COCKPIT_ACTOR ?? userInfo().username;
  const peerActor = args.get("peer-actor") ?? env.COCKPIT_PEER_ACTOR ?? "Peer developer";

  const joinCode = args.get("join") ?? env.COCKPIT_JOIN;
  if (joinCode) {
    const config = peerConfig(cwd, actor, decodeInvite(joinCode));
    if (args.get("repositories-file")) config.repositoriesFile = resolve(args.get("repositories-file")!);
    config.localAgents = agents(args.get("agents") ?? env.COCKPIT_AGENTS, config.localAgents);
    config.claudeExecutor = claudeExecutor(args.get("claude-executor") ?? env.COCKPIT_CLAUDE_EXECUTOR, "auto");
    if (args.get("allow-write") === "true" || env.COCKPIT_ALLOW_WRITE === "true") config.allowWrite = true;
    if (args.get("verify-writes") === "true" || env.COCKPIT_VERIFY_WRITES === "true") config.verifyWrites = true;
    await save(configPath, config);
    return { ...config, configPath, firstRun: !config.setupComplete };
  }

  let config: CockpitConfig;
  let firstRun = false;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as CockpitConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    config = defaultHostConfig(cwd, actor, peerActor, port(args.get("port") ?? env.COCKPIT_PORT, 4318));
    await save(configPath, config);
    firstRun = true;
  }

  if (config.version !== 1 || (config.mode !== "host" && config.mode !== "peer")) {
    throw new Error(`Unsupported Cockpit config at ${configPath}`);
  }
  config.setupComplete ??= false;
  config.claudeExecutor = claudeExecutor(args.get("claude-executor") ?? env.COCKPIT_CLAUDE_EXECUTOR, config.claudeExecutor ?? "auto");
  if (!validRunnerCredentials(config.runnerCredentials)) {
    throw new Error(`Invalid local runner credentials at ${configPath}`);
  }
  if (!validRunnerCredentials(config.peerRunnerCredentials)) {
    config.peerRunnerCredentials = {
      codex: { runnerId: `${slug(config.peerActor)}-codex`, token: token() },
      claude: { runnerId: `${slug(config.peerActor)}-claude`, token: token() },
    };
    await save(configPath, config);
  }
  config.localAgents = agents(args.get("agents") ?? env.COCKPIT_AGENTS, config.localAgents);
  if (args.get("advertise-url") ?? env.COCKPIT_ADVERTISE_URL) {
    config.advertiseUrl = assertServerUrl((args.get("advertise-url") ?? env.COCKPIT_ADVERTISE_URL)!);
  }
  if (args.get("server-url") ?? env.COCKPIT_SERVER_URL) {
    config.serverUrl = assertServerUrl((args.get("server-url") ?? env.COCKPIT_SERVER_URL)!);
  }
  if (args.get("repositories-file") ?? env.COCKPIT_REPOSITORIES_FILE) {
    config.repositoriesFile = resolve((args.get("repositories-file") ?? env.COCKPIT_REPOSITORIES_FILE)!);
  }
  if (args.get("allow-write") === "true" || env.COCKPIT_ALLOW_WRITE === "true") config.allowWrite = true;
  if (args.get("verify-writes") === "true" || env.COCKPIT_VERIFY_WRITES === "true") config.verifyWrites = true;
  return { ...config, configPath, firstRun: firstRun || !config.setupComplete };
}

export async function saveCockpitConfig(config: CockpitConfigWithPath): Promise<void> {
  const { configPath, firstRun: _firstRun, ...persisted } = config;
  await save(configPath, persisted);
}

export function createPeerInvite(config: CockpitConfig): CockpitInvite {
  if (config.mode !== "host") throw new Error("Only the host can create a peer invite");
  return {
    version: 1,
    serverUrl: assertServerUrl(config.advertiseUrl),
    actor: config.actor,
    controlToken: config.peerControlToken,
    runnerCredentials: config.peerRunnerCredentials,
  };
}

export function createPeerInviteCode(config: CockpitConfig): string {
  return encodeInvite(createPeerInvite(config));
}
