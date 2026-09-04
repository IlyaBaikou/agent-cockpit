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
    // No browser cookies, CORS or ambient authentication: only explicit bearer credentials.
    requireValue(!request.headers.origin, "Browser cross-origin requests are not allowed", 403);
    if (request.method === "GET" && request.url === "/v2/events") {
      let open = true;
      const unsubscribe = await service.subscribe(bearerToken(request.headers.authorization), (event) => {
        if (open && !response.destroyed) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
        connection: "keep-alive", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
      response.flushHeaders();
      response.write(`retry: 2000\nevent: ready\ndata: {"type":"ready"}\n\n`);
      const keepalive = setInterval(() => { if (open && !response.destroyed) response.write(": keepalive\n\n"); }, 15_000);
      keepalive.unref();
      await new Promise<void>((resolve) => {
        const close = (): void => { if (!open) return; open = false; clearInterval(keepalive); unsubscribe(); resolve(); };
        request.once("aborted", close); response.once("close", close);
      });
      return;
    }
    requireValue(request.method === "POST", "Method not allowed", 405);
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
      send(200, await service.enroll(body.code, body.name));
    } else if (request.url === "/v2/typing") {
      await service.typing(bearerToken(request.headers.authorization), body);
      send(200, { ok: true });
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
