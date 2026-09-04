import type { LiveEvent } from "./model.js";

export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export function hubUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Укажите адрес хаба без пути и пароля");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Для удалённого хаба требуется HTTPS");
  return url.origin;
}
export class CollaborationClient {
  readonly url: string;
  constructor(url: string, private token: string) { this.url = hubUrl(url); }
  async call<T = unknown>(op: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.request("/v2/rpc", { op, input });
  }
  async enroll(code: string, name?: string): Promise<{ token: string; employee: string }> { return this.request("/v2/enroll", { code, name }); }
  async typing(input: { space: string; channel: string; thread: string | null; active: boolean; version: number }): Promise<void> {
    await this.request("/v2/typing", input);
  }
  async events(signal: AbortSignal, receive: (event: LiveEvent) => void): Promise<void> {
    const result = await fetch(`${this.url}/v2/events`, {
      method: "GET", redirect: "error", headers: { accept: "text/event-stream", authorization: `Bearer ${this.token}` }, signal,
    });
    if (!result.ok) {
      const payload = await result.json().catch(() => ({})) as { error?: string };
      throw new ApiError(payload.error ?? `Hub HTTP ${result.status}`, result.status);
    }
    if (!result.body) throw new ApiError("Hub did not open the event stream", 502);
    const reader = result.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data) receive(JSON.parse(data) as LiveEvent);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally { reader.releaseLock(); }
  }
  private async request<T>(path: string, body: unknown): Promise<T> {
    const result = await fetch(`${this.url}${path}`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    const payload = await result.json() as T & { error?: string };
    if (!result.ok) throw new ApiError(payload.error ?? `Hub HTTP ${result.status}`, result.status);
    return payload;
  }
}
