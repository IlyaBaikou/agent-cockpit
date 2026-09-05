import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer, createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeIncomingMessageLike, type NodeServerResponseLike } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { bearerToken } from "../control-auth.js";
import { CollabError } from "./model.js";
import type { CollaborationService } from "./service.js";

const instructions = [
  "Use hub_reply exactly once when your discussion turn is complete. The tool atomically publishes the visible answer to the shared Agent Hub thread and selects the next participant. Do not print a ROUTE line after a successful call. MCP never grants code-write, commit, push, merge, deploy, participation approval, or access outside this one leased thread.",
  "Choose next=agent with the exact peer agent ID to continue the cross-agent discussion, next=human with the exact employee ID when a decision or approval is needed, next=done only when the issue is settled, or next=unable when you cannot process it. The Hub applies participation consent, turn limits, mentions, notifications, thread revision checks, and fallback routing.",
].join(" ");

const inputSchema = z.object({
  content: z.string().min(1).max(180_000).describe("The complete human-readable answer that everyone in the shared thread should see."),
  next: z.enum(["agent", "human", "done", "unable"]).describe("Who should act after this answer."),
  target: z.string().min(1).max(200).optional().describe("Exact peer agent ID for next=agent or employee ID for next=human. Omit for done/unable."),
});

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

export function collaborationMcpHttp(service: CollaborationService): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const handler = createMcpHandler((context) => {
    const token = context.authInfo?.token;
    if (!token) throw new Error("Agent Hub MCP request is missing job authorization");
    const server = new McpServer(
      { name: "animaplay-agent-hub", version: "0.2.15" },
      { instructions },
    );
    server.registerTool("hub_reply", {
      title: "Publish Agent Hub reply and choose the next participant",
      description: "Finish the current read-only Agent Hub turn. Atomically posts one visible agent answer to the shared thread and either calls one peer agent, requests one human, resolves the thread, or reports inability. It cannot approve participation or authorize code changes.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => {
      try {
        const result = await service.completeMcp(token, { content: input.content, next: input.next, ...(input.target ? { target: input.target } : {}) });
        return {
          content: [{ type: "text" as const, text: `Reply published in Agent Hub. Thread status: ${result.status}. Stop this turn; do not emit ROUTE.` }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof CollabError ? error.message : "Agent Hub could not publish this reply";
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    });
    return server;
  }, { legacy: "stateless", onerror: (error) => console.error("Agent Hub MCP protocol error", error) });
  const serve = toNodeHandler(handler, { onerror: (error) => console.error("Agent Hub MCP transport error", error) });

  return async (request, response) => {
    try {
      if (request.headers.origin) throw new Error("Browser origins are not accepted");
      const token = bearerToken(request.headers.authorization);
      const access = await service.authorizeMcp(token);
      (request as AuthenticatedRequest).auth = {
        token,
        clientId: `agent-hub-job:${access.job}`,
        scopes: ["agent:reply"],
        expiresAt: Math.floor(access.expiresAt / 1000),
        extra: { job: access.job, agent: access.agent, thread: access.thread },
      };
      await serve(request as unknown as NodeIncomingMessageLike, response as unknown as NodeServerResponseLike);
    } catch {
      response.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "www-authenticate": "Bearer",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify({ error: "MCP job token is missing, expired, or not valid for a read-only Agent Hub turn" }));
    }
  };
}
