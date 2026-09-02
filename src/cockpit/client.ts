import type { AgentId, ConversationRecord, RunnerJobMode } from "../types.js";
import type { ConversationSnapshot } from "../conversations.js";

export class CockpitClient {
  readonly #serverUrl: string;
  readonly #token: string;

  constructor(serverUrl: string, token: string) {
    this.#serverUrl = serverUrl;
    this.#token = token;
  }

  async health(): Promise<{ ok: boolean; service: string }> {
    return await this.#request("/health", { authenticated: false });
  }

  async list(limit = 50): Promise<ConversationRecord[]> {
    const result = await this.#request<{ conversations: ConversationRecord[] }>(`/v1/conversations?limit=${limit}`);
    return result.conversations;
  }

  async get(id: string): Promise<ConversationSnapshot> {
    return await this.#request(`/v1/conversations/${encodeURIComponent(id)}`);
  }

  async open(input: {
    topic: string;
    codexRepository: string;
    claudeRepository: string;
    target: AgentId;
    mode: RunnerJobMode;
    turns: number;
  }): Promise<ConversationSnapshot> {
    return await this.#request("/v1/conversations", { method: "POST", body: input });
  }

  async reply(input: {
    conversationId: string;
    content: string;
    target: AgentId;
    mode: RunnerJobMode;
    turns: number;
    repository?: string;
  }): Promise<ConversationSnapshot> {
    const { conversationId, ...body } = input;
    return await this.#request(`/v1/conversations/${encodeURIComponent(conversationId)}/replies`, {
      method: "POST",
      body,
    });
  }

  async close(id: string): Promise<ConversationSnapshot> {
    return await this.#request(`/v1/conversations/${encodeURIComponent(id)}/close`, { method: "POST", body: {} });
  }

  async #request<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: object; authenticated?: boolean } = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, this.#serverUrl), {
      method: options.method ?? "GET",
      headers: {
        ...(options.authenticated === false ? {} : { authorization: `Bearer ${this.#token}` }),
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const result = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Cockpit returned HTTP ${response.status}`);
    return result;
  }
}
