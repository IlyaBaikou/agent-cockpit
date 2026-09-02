import { expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { acceptMemory, compactionPlan, excerpt, messageFile, parseSummary, renderContext, sourceHash, validMemory, type ContextPacket } from "../src/collab/context.js";
import { contextFiles, promptArgument } from "../src/collab/context-files.js";
import type { Message } from "../src/collab/model.js";

export function longPacket(): ContextPacket {
  const messages: Message[] = Array.from({ length: 22 }, (_, i) => ({ id: `m-${i}`, space: "s", thread: "t",
    author: i === 0 || i === 21 ? "Owner" : "Agent", kind: i === 0 || i === 21 ? "human" : "agent",
    content: i === 0 ? "Never change endpoint /v1/score without my approval. Proposed is not approved."
      : i === 21 ? "Current request: explain the remaining compatibility risk; do not edit anything."
      : `Message ${i}: proposed contract; not an approval. ${"technical evidence ".repeat(100)}`, createdAt: i }));
  return { version: 1, messages };
}

it("creates an incremental, cited summary plan while retaining six recent messages", () => {
  const packet = longPacket(), plan = compactionPlan(packet)!;
  expect(plan.through).toBe("m-15"); expect(plan.input).toContain("Never change endpoint");
  expect(plan.input).not.toContain("Current request:");
  const draft = parseSummary(JSON.stringify({ summary: "Owner prohibits endpoint changes [m-0]. Compatibility remains open [m-15].", citations: ["m-0", "m-15"] }), plan)!;
  const memory = acceptMemory(packet, draft, "A", 100)!;
  expect(validMemory(packet.messages, memory)).toEqual(memory);
  const next = { ...packet, memory };
  expect(compactionPlan(next)).toBeUndefined();
  const prompt = renderContext(next, "/tmp/scoped-packet");
  expect(prompt).toContain("Never change endpoint /v1/score without my approval");
  expect(prompt).toContain("Current request:");
  expect(prompt).toContain("Compatibility remains open");
  expect(prompt.length).toBeLessThan(packet.messages.map((m) => m.content).join("").length / 2);
  expect(packet.messages).toHaveLength(22);
});

it("rejects fabricated source IDs, oversized/malformed summaries and altered source prefixes", () => {
  const packet = longPacket(), plan = compactionPlan(packet)!;
  expect(parseSummary("not json", plan)).toBeUndefined();
  expect(parseSummary(JSON.stringify({ summary: "Agreed", citations: ["other-thread-id"] }), plan)).toBeUndefined();
  expect(parseSummary(JSON.stringify({ summary: "x".repeat(6001), citations: ["m-0"] }), plan)).toBeUndefined();
  const draft = parseSummary(JSON.stringify({ summary: "Unresolved [m-0]", citations: ["m-0"] }), plan)!;
  expect(acceptMemory(packet, { ...draft, through: "m-21" }, "A", 100)).toBeUndefined();
  const memory = acceptMemory(packet, draft, "A", 100)!;
  const altered = structuredClone(packet.messages); altered[0]!.content = "Different instruction";
  expect(validMemory(altered, memory)).toBeUndefined();
  expect(sourceHash(altered)).not.toBe(sourceHash(packet.messages));
});

it("deduplicates bulky code from prompts but keeps exact source and safe file paths", async () => {
  const packet = longPacket(); const m = packet.messages[1]!;
  m.id = "../../escape"; m.content = `Review this exact contract\n\`\`\`diff\n${"+important schema\n".repeat(1000)}\`\`\``;
  expect(excerpt(m).length).toBeLessThan(500); expect(excerpt(m)).toContain("read message");
  const files = await contextFiles(packet);
  try {
    expect(await readFile(join(files.path, messageFile(m)), "utf8")).toContain(m.content);
    const index = JSON.parse(await readFile(join(files.path, "index.json"), "utf8")) as { id: string; file: string }[];
    expect(index.find((item) => item.id === m.id)?.file).toMatch(/^[a-f0-9]{64}\.txt$/);
    if (process.platform !== "win32") expect((await stat(join(files.path, messageFile(m)))).mode & 0o777).toBe(0o400);
  } finally { await files.cleanup(); }
  await expect(stat(files.path)).rejects.toThrow();
});

it("keeps variable archive paths after reusable history and makes all omissions explicit", () => {
  const packet = longPacket();
  const a = renderContext(packet, "/tmp/one"), b = renderContext(packet, "/tmp/two");
  expect(a.slice(0, a.indexOf("/tmp/one"))).toEqual(b.slice(0, b.indexOf("/tmp/two")));
  expect(a).toContain("additional messages"); expect(a).toContain("does not mean a constraint was withdrawn");
  expect(a).toContain("Current request:"); expect(a.length).toBeLessThan(23_000);
  expect(compactionPlan({ ...packet, skipCompaction: true })).toBeUndefined();
});

it("uses a read-only task file for oversized Windows arguments and cleans it up", async () => {
  const text = "Full request: ".repeat(3000);
  const posix = await promptArgument(text, "darwin"); expect(posix.prompt).toBe(text);
  const result = await promptArgument(text, "win32");
  expect(result.prompt.length).toBeLessThan(1500);
  const path = JSON.parse(result.prompt.match(/UTF-8 file (".*?")\./)![1]!) as string;
  expect(await readFile(path, "utf8")).toBe(text);
  await result.cleanup(); await expect(stat(path)).rejects.toThrow();
});
