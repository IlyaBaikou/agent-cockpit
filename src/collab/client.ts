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
