import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { CodexAdapter } from "../agents/codex.js";
import { ClaudeCompatibleAdapter, type ClaudeExecutor } from "../agents/cursor.js";
import { loadAgentProfiles } from "../config.js";
import { ConversationHub, type ConversationSnapshot } from "../conversations.js";
import { GitWorktreeManager } from "../git.js";
import { createHubHttpServer } from "../hub-server.js";
import { RepositoryRegistry } from "../repositories.js";
import { RemoteRunner } from "../runner.js";
import { HubStore } from "../store.js";
import type { AgentId, ConversationRecord, RunnerJobMode } from "../types.js";
import {
  createPeerInviteCode,
  loadCockpitConfig,
  saveCockpitConfig,
  type CockpitConfigWithPath,
} from "./config.js";
import { CockpitClient } from "./client.js";

export type CockpitAgentState = {
  id: AgentId;
  enabled: boolean;
  status: "checking" | "ready" | "unavailable";
  detail: string;
  runnerId: string;
};

export type CockpitState = {
  mode: "host" | "peer";
  actor: string;
  serverUrl: string;
  advertiseUrl: string;
  firstRun: boolean;
  connected: boolean;
  connectionDetail: string;
  agents: CockpitAgentState[];
  repositories: string[];
  allowWrite: boolean;
  claudeExecutor: ClaudeExecutor;
  inviteCode?: string;
};

type OpenInput = {
  topic: string;
  codexRepository: string;
  claudeRepository: string;
  target: AgentId;
  mode: RunnerJobMode;
  turns: number;
};

type ReplyInput = {
  conversationId: string;
  content: string;
  target: AgentId;
  mode: RunnerJobMode;
  turns: number;
  repository?: string;
};

type SettingsInput = {
  agents: AgentId[];
  allowWrite: boolean;
  claudeExecutor: ClaudeExecutor;
  advertiseUrl?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class CockpitRuntime extends EventEmitter {
  readonly #config: CockpitConfigWithPath;
  readonly #client: CockpitClient;
  readonly #repositories: RepositoryRegistry;
  readonly #store: HubStore | undefined;
  readonly #server: Server | undefined;
  readonly #agentStates = new Map<AgentId, CockpitAgentState>();
  readonly #runningLoops = new Set<AgentId>();
  readonly #runnerVersions = new Map<AgentId, number>();
  #stopping = false;
  #connected = false;
  #connectionDetail = "Connecting…";

  private constructor(options: {
    config: CockpitConfigWithPath;
    client: CockpitClient;
    repositories: RepositoryRegistry;
    store?: HubStore;
    server?: Server;
  }) {
    super();
    this.#config = options.config;
    this.#client = options.client;
    this.#repositories = options.repositories;
    this.#store = options.store;
    this.#server = options.server;
    for (const id of ["codex", "claude"] as const) {
      this.#agentStates.set(id, {
        id,
        enabled: this.#config.localAgents.includes(id),
        status: "checking",
        detail: "Checking installation and sign-in…",
        runnerId: this.#config.runnerCredentials[id].runnerId,
      });
    }
  }

  static async create(options: { args?: string[]; cwd?: string } = {}): Promise<CockpitRuntime> {
    const config = await loadCockpitConfig(options);
    const repositories = new RepositoryRegistry(config.repositoriesFile);
    await repositories.load();

    let store: HubStore | undefined;
    let server: Server | undefined;
    if (config.mode === "host") {
      store = new HubStore(config.databasePath);
      const profiles = await loadAgentProfiles(config.agentsFile);
      const conversations = new ConversationHub({ store, profiles });
      const runnerCredentials = (["codex", "claude"] as const).flatMap((agent) => [
        { ...config.runnerCredentials[agent], agent },
        { ...config.peerRunnerCredentials[agent], agent },
      ]);
      server = createHubHttpServer({
        store,
        conversations,
        credentials: runnerCredentials,
        controlCredentials: [
          { actor: config.actor, token: config.controlToken },
          { actor: config.peerActor, token: config.peerControlToken },
        ],
      });
      server.requestTimeout = 30_000;
      server.headersTimeout = 35_000;
      await new Promise<void>((resolvePromise, reject) => {
        server!.once("error", reject);
        server!.listen(config.port, config.listenHost, () => {
          server!.off("error", reject);
          resolvePromise();
        });
      });
    }

    const runtime = new CockpitRuntime({
      config,
      client: new CockpitClient(config.serverUrl, config.controlToken),
      repositories,
      ...(store ? { store } : {}),
      ...(server ? { server } : {}),
    });
    await runtime.#checkConnection();
    void runtime.#checkAgents();
    if (!config.firstRun) runtime.#startEnabledRunners();
    return runtime;
  }

  state(): CockpitState {
    let inviteCode: string | undefined;
    if (this.#config.mode === "host") {
      try {
        inviteCode = createPeerInviteCode(this.#config);
      } catch {
        // A localhost-only host can still be used locally before a shareable URL is configured.
      }
    }
    return {
      mode: this.#config.mode,
      actor: this.#config.actor,
      serverUrl: this.#config.serverUrl,
      advertiseUrl: this.#config.advertiseUrl,
      firstRun: this.#config.firstRun,
      connected: this.#connected,
      connectionDetail: this.#connectionDetail,
      agents: [...this.#agentStates.values()],
      repositories: this.#repositories.aliases(),
      allowWrite: this.#config.allowWrite,
      claudeExecutor: this.#config.claudeExecutor,
      ...(inviteCode ? { inviteCode } : {}),
    };
  }

  async list(): Promise<ConversationRecord[]> {
    return await this.#client.list(100);
  }

  async get(id: string): Promise<ConversationSnapshot> {
    return await this.#client.get(id);
  }

  async open(input: OpenInput): Promise<ConversationSnapshot> {
    return await this.#client.open(input);
  }

  async reply(input: ReplyInput): Promise<ConversationSnapshot> {
    return await this.#client.reply(input);
  }

  async closeConversation(id: string): Promise<ConversationSnapshot> {
    return await this.#client.close(id);
  }

  async updateSettings(input: SettingsInput): Promise<CockpitState> {
    const requested = [...new Set(input.agents)];
    if (requested.some((agent) => agent !== "codex" && agent !== "claude")) {
      throw new Error("Choose Codex, Claude, or both");
    }
    if (input.claudeExecutor !== "auto" && input.claudeExecutor !== "claude" && input.claudeExecutor !== "cursor") {
      throw new Error("Choose Auto, Claude Code, or Cursor CLI as the frontend executor");
    }
    for (const id of ["codex", "claude"] as const) {
      this.#runnerVersions.set(id, (this.#runnerVersions.get(id) ?? 0) + 1);
    }
    this.#config.localAgents = requested;
    this.#config.allowWrite = input.allowWrite;
    this.#config.claudeExecutor = input.claudeExecutor;
    if (input.advertiseUrl?.trim()) {
      const url = new URL(input.advertiseUrl.trim());
      const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
        throw new Error("The connection URL must use HTTPS (localhost may use HTTP)");
      }
      this.#config.advertiseUrl = url.toString().replace(/\/$/, "");
    }
    this.#config.firstRun = false;
    this.#config.setupComplete = true;
    for (const state of this.#agentStates.values()) state.enabled = requested.includes(state.id);
    await saveCockpitConfig(this.#config);
    this.#startEnabledRunners();
    this.emit("changed");
    return this.state();
  }

  async refreshHealth(): Promise<CockpitState> {
    await Promise.all([this.#checkConnection(), this.#checkAgents()]);
    return this.state();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#server) {
      await new Promise<void>((resolvePromise) => this.#server!.close(() => resolvePromise()));
    }
    this.#store?.close();
  }

  async #checkConnection(): Promise<void> {
    try {
      const health = await this.#client.health();
      this.#connected = health.ok;
      this.#connectionDetail = health.ok ? "Shared conversation store is online" : "Coordinator is not ready";
    } catch (error) {
      this.#connected = false;
      this.#connectionDetail = error instanceof Error ? error.message : String(error);
    }
    this.emit("changed");
  }

  async #checkAgents(): Promise<void> {
    await Promise.all(
      (["codex", "claude"] as const).map(async (id) => {
        const state = this.#agentStates.get(id)!;
        state.status = "checking";
        state.detail = "Checking installation and sign-in…";
        this.emit("changed");
        try {
          const adapter = id === "codex" ? new CodexAdapter() : new ClaudeCompatibleAdapter(this.#config.claudeExecutor);
          state.detail = await adapter.healthCheck();
          state.status = "ready";
        } catch (error) {
          state.status = "unavailable";
          state.detail = error instanceof Error ? error.message : String(error);
        }
        this.emit("changed");
      }),
    );
  }

  #startEnabledRunners(): void {
    for (const id of this.#config.localAgents) {
      if (this.#runningLoops.has(id)) continue;
      this.#runningLoops.add(id);
      const version = this.#runnerVersions.get(id) ?? 0;
      void this.#runnerLoop(id, version);
    }
  }

  async #runnerLoop(id: AgentId, version: number): Promise<void> {
    const credential = this.#config.runnerCredentials[id];
    const runner = new RemoteRunner({
      serverUrl: this.#config.serverUrl,
      runnerId: credential.runnerId,
      token: credential.token,
      agentId: id,
      agent: id === "codex" ? new CodexAdapter() : new ClaudeCompatibleAdapter(this.#config.claudeExecutor),
      repositories: this.#repositories,
      worktrees: new GitWorktreeManager(this.#config.worktreeRoot),
      allowWrite: this.#config.allowWrite,
      verifyWrites: this.#config.verifyWrites,
    });
    while (
      !this.#stopping &&
      this.#config.localAgents.includes(id) &&
      (this.#runnerVersions.get(id) ?? 0) === version
    ) {
      try {
        const worked = await runner.runOnce();
        if (worked) this.emit("changed");
        if (!worked) await sleep(1_500);
      } catch (error) {
        const state = this.#agentStates.get(id)!;
        state.detail = `Runner connection: ${error instanceof Error ? error.message : String(error)}`;
        this.emit("changed");
        await sleep(3_000);
      }
    }
    this.#runningLoops.delete(id);
    if (!this.#stopping && this.#config.localAgents.includes(id)) this.#startEnabledRunners();
  }
}
