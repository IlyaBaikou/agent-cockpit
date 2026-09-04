import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageFile, messageText, type ContextPacket } from "./context.js";

// This is a job-scoped, read-only source packet, not an MCP credential store.
// Never put it in the repository or retain it as an agent's cross-space memory.
export async function contextFiles(packet: ContextPacket): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "agent-hub-context-"));
  const cleanup = () => rm(path, { recursive: true, force: true });
  try {
    for (const m of packet.messages) await writeFile(join(path, messageFile(m)), messageText(m), { mode: 0o400 });
    await writeFile(join(path, "index.json"), JSON.stringify(packet.messages.map((m) => ({
      id: m.id, author: m.author, kind: m.kind, createdAt: m.createdAt,
      file: messageFile(m), chars: m.content.length, preview: m.content.slice(0, 200),
    }))), { mode: 0o400 });
    return { path, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

// Avoid shell/Windows argument limits for every provider without depending on
// provider-specific stdin flags. Tools load this exact UTF-8 file on demand.
export async function promptArgument(prompt: string, _platform = process.platform): Promise<{ prompt: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "agent-hub-prompt-"));
  const file = join(path, "request.txt");
  const cleanup = () => rm(path, { recursive: true, force: true });
  try {
    await writeFile(file, prompt, { mode: 0o400 });
    return {
      prompt: `The user task is in the UTF-8 file ${JSON.stringify(file)}. Read that entire file first (in chunks if needed), then execute its task within the granted mode and workspace. This grants read-only access to this task file and the exact thread archive it identifies, not to other temporary files or directories. Do not edit the task file.`,
      cleanup,
    };
  } catch (error) { await cleanup(); throw error; }
}
