// Explicit opt-in integration check: uses locally authenticated CLI subscriptions.
// Only synthetic messages and a temporary empty workspace are supplied.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAdapter } from "../dist/src/agents/codex.js";
import { ClaudeAdapter } from "../dist/src/agents/claude.js";
import { compactionPlan, parseSummary, renderContext, SUMMARY_INSTRUCTIONS } from "../dist/src/collab/context.js";
import { contextFiles } from "../dist/src/collab/context-files.js";

if (!process.argv.includes("--use-local-agents")) throw new Error("Pass --use-local-agents; this check consumes provider usage.");
const dir = await mkdtemp(join(tmpdir(), "hub-context-smoke-workspace-"));
const packet = { version: 1, messages: Array.from({ length: 22 }, (_, i) => ({ id: `smoke-${i}`, space: "synthetic", thread: "synthetic",
  author: i === 0 || i === 21 ? "Owner" : "Peer", kind: i === 0 || i === 21 ? "human" : "agent", createdAt: i,
  content: i === 0 ? "Do not modify files. The endpoint contract is still proposed, not approved."
    : i === 1 ? `Historical code artifact:\n\`\`\`txt\n${"fixture padding\n".repeat(200)}\nCONTRACT_SENTINEL=violet-otter-731\n\`\`\``
      : i === 21 ? "Read the full original code artifact in smoke-1 from the supplied archive. Reply with its exact CONTRACT_SENTINEL value and state whether endpoint edits were approved. End with ROUTE: done."
        : `Proposal ${i}: endpoint contract is still unapproved. ${"Compatibility and backward compatibility require verification. ".repeat(40)}`,
})) };
const archive = await contextFiles(packet);
try {
  for (const adapter of [new CodexAdapter({ timeoutMs: 180000 }), new ClaudeAdapter({ timeoutMs: 180000 })]) {
    const plan = compactionPlan(packet); assert.ok(plan);
    const result = await adapter.run({ repositoryPath: dir, mode: "read", purpose: "summary", protocol: "collaboration",
      prompt: `${SUMMARY_INSTRUCTIONS}\n\n${plan.input}` });
    const memory = parseSummary(result.content, plan); assert.ok(memory, `${adapter.id}: valid cited summary required`);
    const prompt = `Read-only synthetic integration test. Do not edit anything or access the network. You may read the exact thread archive below.\n\n${renderContext({ ...packet, memory: { ...memory, version: 1, agent: adapter.id, createdAt: Date.now() } }, archive.path)}`;
    const answer = await adapter.run({ repositoryPath: dir, mode: "read", protocol: "collaboration", prompt });
    assert.match(answer.content, /violet-otter-731/, `${adapter.id}: original artifact must be retrievable`);
    assert.match(answer.content, /not approved|unapproved|не согласован|не одобрен/i);
    assert.match(answer.content, /ROUTE: done/);
    console.log(JSON.stringify({ provider: adapter.id, validSummary: true, originalRetrieved: true, approvalPreserved: true,
      historyChars: packet.messages.reduce((n, m) => n + m.content.length, 0), promptChars: prompt.length,
      summaryInputChars: plan.input.length, summaryOutputChars: result.content.length }));
  }
} finally { await archive.cleanup(); await rm(dir, { recursive: true, force: true }); }
