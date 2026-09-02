import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerToken } from "../control-auth.js";
import { CollabError, requireValue } from "./model.js";
import type { CollaborationService } from "./service.js";

export async function collaborationHttp(service: CollaborationService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const send = (status: number, value: unknown): void => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(JSON.stringify(value));
  };
  try {
    requireValue(request.method === "POST", "Method not allowed", 405);
    // No browser cookies, CORS or ambient authentication: only explicit bearer credentials.
    requireValue(!request.headers.origin, "Browser cross-origin requests are not allowed", 403);
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk); size += buffer.length;
      requireValue(size <= 1_000_000, "Request too large", 413); chunks.push(buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requireValue(body && typeof body === "object" && !Array.isArray(body), "Invalid body");
    if (request.url === "/v2/enroll") {
      requireValue(typeof body.code === "string" && body.code.length <= 200, "Invalid invite");
      send(200, await service.enroll(body.code));
    } else {
      requireValue(request.url === "/v2/rpc" && typeof body.op === "string", "Not found", 404);
      requireValue(!body.input || (typeof body.input === "object" && !Array.isArray(body.input)), "Invalid input");
      send(200, await service.call(bearerToken(request.headers.authorization), body.op, (body.input ?? {}) as Record<string, unknown>));
    }
  } catch (error) {
    if (error instanceof CollabError) send(error.status, { error: error.message });
    else if (error instanceof SyntaxError) send(400, { error: "Invalid JSON" });
    else { console.error("Collaboration request failed", error); send(500, { error: "Internal server error" }); }
  }
}
