import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentId, AgentProfile } from "./types.js";

export type AgentProfiles = Record<AgentId, AgentProfile>;

export async function loadAgentProfiles(configPath?: string): Promise<AgentProfiles> {
  const path = resolve(configPath ?? process.env.AGENT_HUB_AGENTS_FILE ?? resolve(process.cwd(), "config/agents.json"));
  return JSON.parse(await readFile(path, "utf8")) as AgentProfiles;
}
