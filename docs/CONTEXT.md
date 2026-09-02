# Thread context, pilot 0.2.1

Full chat history is retained for people. Upgraded runners use a separate, bounded working context shared across Codex, Claude Code and Cursor CLI. No API key or separate embedding service is required: the employee's selected CLI creates the summary in read-only mode.

## What is sent to an agent

- Stable instructions and the space's participant directory.
- A validated, provider-neutral thread summary when available.
- Recent messages, original human instructions where they fit, and relevant unsummarized excerpts. Omission warnings point to the archive; omitted constraints are not withdrawn.
- An exact, job-scoped read-only archive of all messages in **this thread**, including full code/diff blocks, with an index mapping immutable IDs to files. The agent can use its existing read/search tools; this is not an external connector or an automatic Jira/Confluence fetcher.
- Changing job mode, reply budget and temporary archive location at the end to preserve a reusable prefix where the provider permits it.

Large code blocks (over 1,200 characters) are replaced in the working prompt by source references. Originals are never removed from chat or the archive. Repeated replies therefore do not automatically re-ingest the same large diff. A digest identifies content; it does not convey its meaning to a model.

## Checkpoints

Compaction is considered when new substantive excerpts reach 24,000 characters and there are more than six messages. The last six remain outside the summary. A pass covers at most roughly 36,000 excerpt characters and produces up to 6,000 summary characters. Large backlogs may take several turns to consolidate; the unsummarized remainder stays retrievable, never silently discarded. There is at most one summarization call per job, not one per message.

Summaries include task/constraints, facts, proposals versus decisions, open questions, next steps and source IDs. The hub checks covered-prefix SHA-256, cursor and citation membership. This prevents stale/wrong-thread checkpoints, **not factual summarization errors**. The summary appears in a collapsible “Память треда” panel. Correct it by posting a new human message; new instructions take precedence.

A failed summary falls back to excerpts plus originals. The next seven substantive messages do not trigger another attempt, preventing expensive failure loops. Compaction has its own input/output cost and may invalidate the conversation cache; short threads do not need it.

## Authority and privacy

Summaries and all peer content are untrusted data, never approval. Server-side owner opt-in, explicit write jobs, isolated worktrees and bounded routing remain unchanged. The runner checks cancellation/revision again after summarization, before executing the task. A summary returned after human intervention is not saved. Cross-agent handoffs remain read-only.

Source hashes validate chat contents, not the current repository checkout or linked document. Agents are instructed to verify current versions and read original contracts/human decisions before acting; there is no automatic remote-document freshness check. A summary can lose detail. Original messages are the authority.

Archives contain no hub credentials and only the job's authorized thread. They use private temporary directories, read-only files and hashed filenames, and are removed after completion, failure or graceful cancellation. A process crash may leave files in OS temporary storage; this is not secure erasure. Local CLI policies are not an OS-level isolation guarantee. Revocation stops work but cannot retract information already delivered to a participant/provider.

## Measurement and compatibility

Each completed job records raw history characters, assembled task-prompt characters, summary input/output characters and whether a memory was reused/created. The panel shows these separately. They are **not token counts, billing, cache-hit measurements or subscription quota usage**. CLI instructions, tool results, reasoning, archive reads and provider compaction are additional. Measure provider usage before claiming a percentage cost saving.

Native sessions are still stateless between hub jobs in this release; local sessions are not shared across employees/providers. Provider caching can still work across calls, but is not guaranteed. On Windows, prompts over 16,000 characters are passed via a read-only task file to avoid argument limits. This requires a file-read tool and can reduce cache reuse because the bootstrap path changes. Native stdin/session optimizations are future work.

The coordinator accepts both old and upgraded runners. Old runners retain full-transcript behavior and its 200k-character guard. New runners connecting to an old coordinator fall back to its protocol. Update the coordinator and desktop apps to get shared checkpoints. No history migration or deletion is required.
