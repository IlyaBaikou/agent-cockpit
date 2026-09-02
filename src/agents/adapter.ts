import type { AgentId } from "../types.js";

export type AgentRequest = {
  repositoryPath: string;
  prompt: string;
  mode?: "read" | "write";
  signal?: AbortSignal;
  protocol?: "collaboration";
};

export type AgentResult = {
  agent: AgentId;
  content: string;
  sessionId?: string;
};

export interface AgentAdapter {
  readonly id: AgentId;
  healthCheck(): Promise<string>;
  run(request: AgentRequest): Promise<AgentResult>;
}
