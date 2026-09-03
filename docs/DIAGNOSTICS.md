# CLI failures and delivery receipts

## Support workflow

1. Update the coordinator and the affected desktop to 0.2.6 or newer.
2. In agent setup, run **Check connection**. A failed check includes an explanation, action hint and expandable details. Version/login checks are not a full model request.
3. For execution failures, the agent owner can open **Error details** beside the system message in the thread. A configured control operator can also inspect it, but only in spaces they belong to. Other employees, including space owners, cannot read a peer's private report.
4. Inspect the provider, stage, CLI/app versions, exit/system codes and output. Known failures have hints; exit code 1 without additional output remains an unknown cause. Do not automatically reinstall tools or re-run a potentially writing task.
5. Share the job ID and a reviewed/redacted excerpt with support. Reports can contain private tool output despite redaction. The UI escapes all report text and never executes it.

Windows Claude Desktop discovery uses `%APPDATA%/Claude/claude-code/<version>/claude.exe`, newest installed numeric version first. Missing/incomplete update directories are skipped. Native `%USERPROFILE%/.local/bin/claude.exe` is also supported. An explicit configured path or `CLAUDE_BIN` wins; an invalid explicit path is reported, never silently replaced.

## Storage and privacy

The runner converts failures into `AgentDiagnostic` before transmission. It does not attach prompts, command argument lists, full environment variables or stacks. Exact supplied prompts, known sensitive environment values, common token/password/header patterns and home-directory usernames are redacted. The coordinator validates the schema, recreates public messages from a fixed catalog, discards unknown fields and redacts again before persistence.

Reports are optional extensions of existing jobs/agents; no destructive migration is needed. A failed job's report is accepted only from its authenticated owner/device with the current lease. Repeated failure delivery cannot replace the report or dispatch another fallback. Detailed readiness reports are owner-only. Public messages/notices contain catalog text; details are excluded from agent context and ordinary participants' snapshots.

Reports are limited to 4,000 characters per stream plus a truncation marker, 200 job reports, and 14 days. Snapshots hide expired reports immediately; fail/heartbeat writes prune expired/excess reports. Each agent retains at most one readiness report. There is no raw CLI log dump to Railway stdout. Connection checks before an agent is saved remain local to that check; job delivery requires server connectivity. Summary/compaction failures still use the original-history fallback rather than failing a discussion.

Only the explicit bootstrap control credentials configured on the server define diagnostic operators; there is no newly inferred corporate admin role. Authorization tests include owner, ordinary peer, operator and outsider, across SQLite and PostgreSQL persistence.

## Immediate message feedback

The renderer inserts a local sending bubble and clears only the submitted draft. The coordinator acknowledgement is returned without waiting for a second full synchronization. Pending posts stay bound to the original account, hub, channel and thread; late responses cannot clear a newer draft or navigate away from another chat.

On delivery uncertainty, **Retry** sends the same immutable request and ID. Successful human messages carry `clientRequestId`; reconciliation replaces the pending bubble rather than adding a second copy. The coordinator's durable receipt lookup continues to work if its short response cache has been evicted, and does not invoke an agent twice. The same text deliberately sent under a fresh request ID is a new message.

The outbox is memory-only for this pilot: failed/pending bubbles survive navigation, not quitting the app. No plaintext discussion cache is added to localStorage. “Sent” means accepted by the coordinator, not read by another employee or answered by an agent.

## Verification

`npm run check` covers parsing, real process output/timeout, Windows path discovery, secret redaction, report authorization and storage, runner-to-server delivery and durable post deduplication. The installer workflow runs diagnostic tests on macOS and Windows too. The synthetic desktop UI smoke suite covers sending before acknowledgement, lost-ack retries, draft/channel isolation, details visibility and HTML escaping without real model calls or credentials.

Cursor parameter compatibility: https://cursor.com/docs/cli/reference/parameters (`--mode=ask` / `--mode=plan`, default agent mode). Claude Windows installation context: https://code.claude.com/docs/en/troubleshoot-install.
