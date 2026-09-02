import type { ConversationSnapshot } from "./conversations.js";
import type { AgentId, ConversationRecord, RunnerJobMode } from "./types.js";

export class HubControlClient {
  readonly #serverUrl: string;
  readonly #token: string;

  constructor(options: { serverUrl: string; token: string }) {
    this.#serverUrl = options.serverUrl.replace(/\/$/, "");
    this.#token = options.token;
    if (!/^https:\/\//.test(this.#serverUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(this.#serverUrl)) {
      throw new Error("Hub control requires HTTPS except for localhost development");
    }
  }

  async health(): Promise<void> {
    await this.#request("/health", { authenticated: false });
  }

  async open(input: {
    topic: string;
    codexRepository: string;
    claudeRepository: string;
    target: AgentId;
    mode: RunnerJobMode;
    turns: number;
  }): Promise<ConversationSnapshot> {
    return await this.#request("/v1/conversations", { method: "POST", body: input }) as ConversationSnapshot;
  }

  async reply(input: {
    conversationId: string;
    target: AgentId;
    repository?: string;
    mode: RunnerJobMode;
    turns: number;
    content: string;
  }): Promise<ConversationSnapshot> {
    const { conversationId, ...body } = input;
    return await this.#request(`/v1/conversations/${encodeURIComponent(conversationId)}/replies`, {
      method: "POST",
      body,
    }) as ConversationSnapshot;
  }

  async get(conversationId: string): Promise<ConversationSnapshot> {
    return await this.#request(`/v1/conversations/${encodeURIComponent(conversationId)}`) as ConversationSnapshot;
  }

  async list(limit = 20): Promise<ConversationRecord[]> {
    const result = await this.#request(`/v1/conversations?limit=${limit}`) as { conversations: ConversationRecord[] };
    return result.conversations;
  }

  async close(conversationId: string): Promise<ConversationSnapshot> {
    return await this.#request(`/v1/conversations/${encodeURIComponent(conversationId)}/close`, { method: "POST" }) as ConversationSnapshot;
  }

  async #request(
    path: string,
    options: { method?: string; body?: unknown; authenticated?: boolean } = {},
  ): Promise<unknown> {
    const response = await fetch(new URL(path, this.#serverUrl), {
      method: options.method ?? "GET",
      headers: {
        ...(options.authenticated === false ? {} : { authorization: `Bearer ${this.#token}` }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      throw new Error(result.error ?? `Hub returned HTTP ${response.status}`);
    }
    return result;
  }
}
