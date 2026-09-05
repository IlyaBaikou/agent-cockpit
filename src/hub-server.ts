import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authenticateControl, bearerToken, parseControlCredentials, secureTokenMatch, type ControlCredential } from "./control-auth.js";
import type { ConversationStore } from "./conversation-store.js";
import type { ConversationHub, RunnerArtifactInput } from "./conversations.js";
import { parseRunnerCredentials, type RunnerCredential } from "./runner-auth.js";
import type { AgentId, RunnerJobMode } from "./types.js";
import { collaborationHttp } from "./collab/http.js";
import { collaborationMcpHttp } from "./collab/mcp.js";
import type { CollaborationService } from "./collab/service.js";

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 2_000_000) {
      throw new Error("Request body is too large");
    }
  }
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function authenticate(request: IncomingMessage, credentials: RunnerCredential[], runnerId: string): RunnerCredential {
  const token = bearerToken(request.headers.authorization);
  const credential = credentials.find((candidate) => candidate.runnerId === runnerId);
  if (!credential || !secureTokenMatch(token, credential.token)) {
    throw new Error("Unauthorized runner");
  }
  return credential;
}

export function createHubHttpServer(options: {
  store: ConversationStore;
  conversations: ConversationHub;
  credentials?: RunnerCredential[];
  controlCredentials?: ControlCredential[];
  leaseMs?: number;
  collaboration?: CollaborationService;
}): Server {
  const credentials = options.credentials ?? parseRunnerCredentials();
  const controlCredentials = options.controlCredentials ?? parseControlCredentials();
  const leaseMs = options.leaseMs ?? Number(process.env.HUB_RUNNER_LEASE_MS ?? 900_000);
  const mcp = options.collaboration ? collaborationMcpHttp(options.collaboration) : undefined;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://agent-hub.local");
      if (url.pathname === "/mcp" && mcp) {
        await mcp(request, response);
        return;
      }
      if (url.pathname.startsWith("/v2/") && options.collaboration) {
        await collaborationHttp(options.collaboration, request, response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        await options.store.ping();
        json(response, 200, { ok: true, service: "animaplay-agent-hub" });
        return;
      }

      if (url.pathname === "/v1/conversations" || url.pathname.startsWith("/v1/conversations/")) {
        const controller = authenticateControl(bearerToken(request.headers.authorization), controlCredentials);
        const segments = url.pathname.split("/").filter(Boolean);
        const conversationId = segments[2]?.toUpperCase();
        const action = segments[3];

        if (request.method === "GET" && !conversationId) {
          const limit = Number(url.searchParams.get("limit") ?? 20);
          json(response, 200, { conversations: await options.conversations.list(limit) });
          return;
        }
        if (request.method === "GET" && conversationId && !action) {
          json(response, 200, await options.conversations.get(conversationId));
          return;
        }
        if (request.method !== "POST") {
          json(response, 405, { error: "Method not allowed" });
          return;
        }
        const body = await readJson(request);
        if (!conversationId) {
          const topic = requiredString(body, "topic", 40_000);
          const codexRepository = requiredString(body, "codexRepository", 256);
          const claudeRepository = requiredString(body, "claudeRepository", 256);
          const target = agentValue(body.target);
          const mode = modeValue(body.mode);
          const turns = turnsValue(body.turns);
          json(response, 201, await options.conversations.open({
            topic, codexRepository, claudeRepository, target, mode, turns, actor: controller.actor,
          }));
          return;
        }
        if (action === "replies") {
          const content = requiredString(body, "content", 40_000);
          const repository = optionalString(body.repository, 256);
          json(response, 202, await options.conversations.reply({
            conversationId,
            target: agentValue(body.target),
            mode: modeValue(body.mode),
            turns: turnsValue(body.turns),
            content,
            actor: controller.actor,
            ...(repository ? { repository } : {}),
          }));
          return;
        }
        if (action === "close") {
          json(response, 200, await options.conversations.close(conversationId));
          return;
        }
        json(response, 404, { error: "Not found" });
        return;
      }

      if (request.method !== "POST") {
        json(response, 404, { error: "Not found" });
        return;
      }

      const body = await readJson(request);
      const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
      const credential = authenticate(request, credentials, runnerId);

      if (url.pathname === "/v1/runners/check") {
        json(response, 200, { ok: true, runnerId: credential.runnerId, agent: credential.agent });
        return;
      }

      if (url.pathname === "/v1/jobs/claim") {
        const job = await options.store.claimRunnerJob({ runnerId, agent: credential.agent, leaseMs });
        json(response, 200, { job: job ?? null });
        return;
      }

      const jobId = typeof body.jobId === "string" ? body.jobId : "";
      if (!jobId) {
        throw new Error("jobId is required");
      }
      if (url.pathname === "/v1/jobs/complete") {
        const content = typeof body.content === "string" ? body.content : "";
        if (!content) {
          throw new Error("content is required");
        }
        const artifacts = normalizeArtifacts(body.artifacts);
        const snapshot = await options.conversations.completeJob({ jobId, runnerId, content, artifacts });
        json(response, 200, { conversation: snapshot.conversation });
        return;
      }
      if (url.pathname === "/v1/jobs/fail") {
        const error = typeof body.error === "string" ? body.error : "Unknown runner failure";
        const snapshot = await options.conversations.failJob({ jobId, runnerId, error: error.slice(0, 20_000) });
        json(response, 200, { conversation: snapshot.conversation });
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((request.url ?? "").split("?")[0] === "/health") {
        json(response, 503, { ok: false, service: "animaplay-agent-hub" });
        return;
      }
      const status = expectedErrorStatus(message, error);
      if (status === undefined) {
        console.error(`Hub request failed: ${request.method ?? "UNKNOWN"} ${request.url ?? "/"}`, error);
        json(response, 500, { error: "Internal server error" });
        return;
      }
      json(response, status, { error: message });
    }
  });
}

function requiredString(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} is required and must contain at most ${max} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`Value must contain at most ${max} characters`);
  return value;
}

function agentValue(value: unknown): AgentId {
  if (value !== "codex" && value !== "claude") throw new Error("target must be codex or claude");
  return value;
}

function modeValue(value: unknown): RunnerJobMode {
  if (value !== "read" && value !== "write") throw new Error("mode must be read or write");
  return value;
}

function turnsValue(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 12) {
    throw new Error("turns must be an integer between 1 and 12");
  }
  return Number(value);
}

function normalizeArtifacts(value: unknown): RunnerArtifactInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error("Artifact upload limit exceeded");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid artifact");
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.path !== "string" || !candidate.path || candidate.path.length > 512) {
      throw new Error("Invalid artifact path");
    }
    if (typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256)) {
      throw new Error("Invalid artifact sha256");
    }
    if (!Number.isInteger(candidate.size) || Number(candidate.size) < 0 || Number(candidate.size) > 20_000_000) {
      throw new Error("Invalid artifact size");
    }
    if (candidate.content !== undefined && (typeof candidate.content !== "string" || candidate.content.length > 512_000)) {
      throw new Error("Artifact upload limit exceeded");
    }
    return {
      path: candidate.path,
      sha256: candidate.sha256,
      size: Number(candidate.size),
      ...(typeof candidate.content === "string" ? { content: candidate.content } : {}),
    };
  });
}

function expectedErrorStatus(message: string, error: unknown): number | undefined {
  if (message === "Unauthorized runner" || message === "Unauthorized controller") return 401;
  if (message.startsWith("Unknown conversation") || message.startsWith("Unknown runner job")) return 404;
  if (message.includes("active runner job") || message.includes("already has") || message.includes("does not own claimed job")) return 409;
  const databaseCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (databaseCode === "23505") return 409;
  if (
    error instanceof SyntaxError ||
    /^(jobId|content|topic|codexRepository|claudeRepository|target|mode|turns|Artifact|Invalid|Request body|Value)/.test(message)
  ) return 400;
  return undefined;
}
