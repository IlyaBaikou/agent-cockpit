import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveClaudeBinary } from "./agents/claude.js";
import { runProcess } from "./process.js";
import type { AgentId } from "./types.js";

export type SlackDesktopProof = {
  version: 1;
  source: "desktop-agent-assisted";
  workspaceId: string;
  workspaceName: string;
  channelId: string;
  channelName: string;
  userId?: string;
  userName: string;
  verifiedAt: string;
};

export type IntegrationInspection = {
  desktopInstalled: boolean;
  desktopApplication?: string;
  slackCliConfigured: boolean;
  atlassianConfigured: boolean;
  atlassianAuthenticated: boolean;
  mcpSummary: string;
  slackProof?: SlackDesktopProof;
  slackProofFresh: boolean;
};

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next known desktop application path.
    }
  }
  return undefined;
}

export async function readSlackDesktopProof(path: string): Promise<SlackDesktopProof | undefined> {
  try {
    const proof = JSON.parse(await readFile(path, "utf8")) as SlackDesktopProof;
    return proof.version === 1 && proof.source === "desktop-agent-assisted" ? proof : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSlackDesktopProof(path: string, proof: Omit<SlackDesktopProof, "version" | "source" | "verifiedAt">): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, source: "desktop-agent-assisted", ...proof, verifiedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function inspectIntegrations(input: {
  agent: AgentId;
  slackProofFile: string;
  proofMaxAgeMs?: number;
}): Promise<IntegrationInspection> {
  const desktopApplication = await firstExisting(
    input.agent === "codex"
      ? ["/Applications/ChatGPT.app", "/Applications/Codex.app"]
      : ["/Applications/Claude.app", "/Applications/Claude Desktop.app"],
  );
  const binary = input.agent === "codex" ? process.env.CODEX_BIN ?? "codex" : await resolveClaudeBinary();
  const result = await runProcess(binary, ["mcp", "list"], { timeoutMs: 30_000 });
  const mcpSummary = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const slackProof = await readSlackDesktopProof(input.slackProofFile);
  const proofAge = slackProof ? Date.now() - Date.parse(slackProof.verifiedAt) : Number.POSITIVE_INFINITY;
  const proofMaxAgeMs = input.proofMaxAgeMs ?? 30 * 24 * 60 * 60 * 1_000;
  const atlassianLine = mcpSummary
    .split("\n")
    .find((line) => /atlassian/i.test(line));

  return {
    desktopInstalled: Boolean(desktopApplication),
    ...(desktopApplication ? { desktopApplication } : {}),
    slackCliConfigured: /(^|\s)slack(\s|$|:)/im.test(mcpSummary) && !/slack.*needs authentication/i.test(mcpSummary),
    atlassianConfigured: Boolean(atlassianLine),
    atlassianAuthenticated: Boolean(atlassianLine && !/needs authentication|not connected|failed/i.test(atlassianLine)),
    mcpSummary,
    ...(slackProof ? { slackProof } : {}),
    slackProofFresh: Number.isFinite(proofAge) && proofAge >= 0 && proofAge <= proofMaxAgeMs,
  };
}

