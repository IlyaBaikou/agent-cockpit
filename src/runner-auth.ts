import type { AgentId } from "./types.js";

export type RunnerCredential = { runnerId: string; agent: AgentId; token: string };

export function parseRunnerCredentials(value = process.env.HUB_RUNNER_TOKENS ?? ""): RunnerCredential[] {
  if (!value.trim()) {
    return [];
  }
  return value.split(",").map((entry) => {
    const [runnerId, agent, ...tokenParts] = entry.split(":");
    const token = tokenParts.join(":");
    if (!runnerId || (agent !== "codex" && agent !== "claude") || token.length < 16) {
      throw new Error("HUB_RUNNER_TOKENS must contain runner-id:codex|claude:token entries; tokens need 16+ characters");
    }
    return { runnerId, agent, token };
  });
}

