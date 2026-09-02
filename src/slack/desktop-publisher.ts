import { spawn } from "node:child_process";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readSlackDesktopProof, type SlackDesktopProof } from "../integration-doctor.js";
import { splitSlackMessage } from "./format.js";

const PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export type DesktopSlackPost = {
  workspaceId: string;
  channelId: string;
  channelName: string;
  text: string;
  threadRootMessageId?: string;
};

export type DesktopSlackAutomation = (post: DesktopSlackPost) => Promise<void>;

function run(command: string, args: string[], input?: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 1}`));
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

async function nativeHelperPath(name: "writer" | "open-thread"): Promise<string> {
  const sourceName = name === "writer" ? "slack_ax_writer.swift" : "slack_ax_open_thread.swift";
  const binaryName = name === "writer" ? "slack-ax-writer" : "slack-ax-open-thread";
  const source = resolve(process.cwd(), `native/${sourceName}`);
  const binary = resolve(process.cwd(), `.agent-hub-local/bin/${binaryName}`);
  const sourceMetadata = await stat(source);
  const binaryMetadata = await stat(binary).catch(() => undefined);
  if (!binaryMetadata || binaryMetadata.mtimeMs < sourceMetadata.mtimeMs) {
    await mkdir(dirname(binary), { recursive: true });
    await run("/usr/bin/swiftc", [source, "-o", binary], undefined, 60_000);
    await chmod(binary, 0o700);
  }
  return binary;
}

export async function prepareSlackDesktopAutomation(): Promise<void> {
  await Promise.all([nativeHelperPath("writer"), nativeHelperPath("open-thread")]);
}

export async function postThroughSlackDesktop(post: DesktopSlackPost): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Slack Desktop publishing currently requires macOS");
  const writer = await nativeHelperPath("writer");
  if (post.threadRootMessageId) {
    const openThread = await nativeHelperPath("open-thread");
    await run(openThread, [post.threadRootMessageId], undefined, 20_000);
  }
  await run(writer, [post.channelName, ...(post.threadRootMessageId ? ["thread"] : [])], post.text, 20_000);
}

export async function inspectSlackDesktopAutomation(): Promise<{ ready: boolean; detail: string }> {
  if (process.platform !== "darwin") return { ready: false, detail: "macOS is required" };
  try {
    const output = await run("/usr/bin/osascript", [
      "-e",
      'tell application "System Events" to return UI elements enabled',
    ]);
    return output.trim().toLowerCase() === "true"
      ? { ready: true, detail: "macOS Accessibility UI scripting is enabled" }
      : { ready: false, detail: "enable Accessibility for the terminal that starts the runner" };
  } catch (error) {
    return { ready: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function formatDesktopAgentResponse(input: {
  conversationId: string;
  agentLabel: string;
  content: string;
}): string[] {
  const content = input.content.replace(/^HANDOFF:\s*(?:codex|claude|human|done)\s*$/gim, "").trim();
  return splitSlackMessage(
    `*AgentHub · ${input.agentLabel} · ${input.conversationId}*\n${content}\n\n_Sent using ${input.agentLabel}_`,
  );
}

function validateProof(proof: SlackDesktopProof | undefined, expectedChannelId?: string): SlackDesktopProof {
  if (!proof) throw new Error("Slack Desktop proof is missing; run runner:slack-proof first");
  const age = Date.now() - Date.parse(proof.verifiedAt);
  if (!Number.isFinite(age) || age < 0 || age > PROOF_MAX_AGE_MS) {
    throw new Error("Slack Desktop proof is stale; run runner:slack-proof again");
  }
  if (expectedChannelId && proof.channelId !== expectedChannelId) {
    throw new Error(`Slack proof channel ${proof.channelId} does not match configured channel ${expectedChannelId}`);
  }
  return proof;
}

export class SlackDesktopPublisher {
  readonly #proofFile: string;
  readonly #expectedChannelId: string | undefined;
  readonly #automation: DesktopSlackAutomation;

  constructor(options: { proofFile: string; expectedChannelId?: string; automation?: DesktopSlackAutomation }) {
    this.#proofFile = options.proofFile;
    this.#expectedChannelId = options.expectedChannelId;
    this.#automation = options.automation ?? postThroughSlackDesktop;
  }

  async publish(input: { conversationId: string; agentLabel: string; content: string; threadRootMessageId?: string }): Promise<void> {
    const proof = validateProof(await readSlackDesktopProof(this.#proofFile), this.#expectedChannelId);
    for (const text of formatDesktopAgentResponse(input)) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await this.#automation({
            workspaceId: proof.workspaceId,
            channelId: proof.channelId,
            channelName: proof.channelName,
            text,
            ...(input.threadRootMessageId ? { threadRootMessageId: input.threadRootMessageId } : {}),
          });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }
      if (lastError) throw lastError;
    }
  }
}
