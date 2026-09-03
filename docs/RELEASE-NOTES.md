Employee-owned agents, spaces, channels and threads — pilot 0.2.6.

New in 0.2.6:

- Messages appear immediately with “Sending…”, then a coordinator acknowledgement. New drafts stay intact. Unconfirmed messages remain in their original chat with a retry button while the app is open; the outbox is not persisted across quitting the app.
- Retries reuse the original request ID. Durable receipts in message history prevent duplicate messages, threads and agent launches even after the short RPC response cache expires. An acknowledgement is not a read receipt.
- Human-readable CLI failures distinguish missing executables/folders, authentication, unsupported arguments, trust prompts, network errors, quotas, timeouts, empty output and unsupported response formats. Unknown failures are explicitly labelled unknown rather than blamed on authentication.
- “Error details” shows stage, platform, app/CLI versions, exit/system codes and bounded redacted stdout/stderr. The connection check also displays details and clears its progress indicator on failure.
- Detailed job reports are stored on the coordinator, visible only to the agent owner or a configured bootstrap control operator who also has access to the thread's space. Other participants see only a short safe explanation. Space ownership alone does not grant access to someone else's diagnostics.
- Reports retain at most 4,000 characters per output stream (plus a truncation marker), up to 200 job reports for 14 days. Expired details are hidden and pruned during report/heartbeat writes; original chat history is preserved. Prompts, command arguments and environment snapshots are not collected. Known secrets and home-directory names are redacted, but arbitrary CLI output can still contain private data: inspect before sharing.
- Claude discovery supports versioned Windows Desktop installations under AppData/Roaming and native .local/bin installations. Explicit binary overrides remain authoritative. Empty/malformed Claude auth status no longer incorrectly counts as a successful login.
- Claude/Cursor parsing handles final-result objects, arrays and newline-delimited JSON without treating partial tool events as completed answers. Failure diagnostics preserve plain stdout, stderr even on exit 0, and structured provider errors. Cursor write mode no longer passes unsupported --mode=agent (agent mode is the default).
- Update **both the coordinator and desktop apps** for server-side reports. Existing PostgreSQL/SQLite history, credentials and agent settings remain in place. Previously discarded error output cannot be recovered; repeat the failed request after updating. This release improves diagnostics and known compatibility issues, but does not claim to resolve every provider-side failure.

New in 0.2.5:

- Spaces contain named channels (General, Gamification, Game 1, Mathematics, etc.), each with its own chat, threads and live thread cards. Creating a channel never invokes a model.
- Existing chat and threads migrate into General once, preserving IDs, timestamps, content, credentials and context checkpoints. No history is deleted.
- All space members see all channels and may create them. A channel's creator or the space owner can edit/archive/restore it. General cannot be renamed or archived.
- Archived channels remain readable; posting and thread actions are blocked, queued/running jobs are cancelled. Restoring does not automatically restart agents.
- Thread participation enables following unless explicitly unsubscribed. Follow/unfollow and per-channel mute controls are available. Mute suppresses all OS banners for that channel, including mentions and decisions, but keeps the in-app inbox. Direct requests/results/failures remain addressable independently of following.
- Notifications open their exact channel/thread; drafts stay separate. Agent context remains scoped to its thread and includes the channel name.
- Update both coordinator and all desktop apps. Older clients see General only instead of flattening other channels into the old chat.

New in 0.2.4:

- Light, dark and system-following themes in Settings → Appearance and on the sign-in screen. Preferences survive restarts; changing theme does not change notification preferences. Cards, code, dialogs and enrollment are themed.
- Space owners can create one reusable AH2 invitation for a team chat. Each newcomer supplies a display name, receives an independent personal credential and automatically joins the selected space only.
- Default invitation limits: 7 days and 100 entries; configurable up to 30 days and 1,000 entries. Owners see usage counts and can disable new entries. Disabling a code does not remove existing members.
- Existing employees can join another space in the same hub with the shared code without replacing their account or local agents. Individual 48-hour invitations still work.
- Update the coordinator **and** desktop applications. Existing PostgreSQL/SQLite state is extended in place without deleting history or credentials. Older clients retain personal invitations; shared invitation enrollment requires 0.2.4.
- Shared codes grant access to the chosen space's full history and its available agents. Share only in a trusted, closed team chat, never publicly. This is bearer-code enrollment, not SSO or verified corporate identity.

New in 0.2.3:

- General chat shows a clickable thread card with its creator, initial request, live status and reply count. Existing threads are included automatically; replies stay inside their thread.
- Thread cards open the conversation and preserve unsent drafts when switching back.
- Waiting/paused threads explain how to continue: post a clarification or decision and @mention the next agent. Humans can continue the cross-agent conversation in the same thread.
- The 0.2.3 card-only change required no coordinator or database migration.

0.2.2 hardens the Windows CI interface check with best-effort temporary-profile cleanup, software rendering, a direct local Electron launcher and a bounded timeout. Application context behavior is unchanged from 0.2.1.

New in 0.2.1:

- Shared, cited working summaries for long threads, compatible with Codex, Claude Code and Cursor CLI.
- Recent messages plus on-demand original code/diffs; full human-visible history is retained.
- Collapsible thread-memory panel and honest context-size diagnostics, including summarization overhead (characters, not billed tokens).
- Validated source cursors/hashes, failed-summary backoff and cancellation/revision checks before task execution.
- Temporary read-only task files avoid oversized Windows command arguments.
- Public source repository and publicly downloadable pilot installers. Update both coordinator and desktop apps for shared checkpoints.

- Employees can connect multiple named Codex, Claude Code or Cursor CLI agents.
- Shared spaces, human chat, threaded agent discussions and explicit mentions.
- Configured fallback agents, visible failures, bounded handoff chains and human decisions.
- Native notifications with thread navigation; background tray operation.
- Owner-approved writes in separate Git worktrees, with a diff in the discussion.
- Single-use invitations; credentials protected by OS storage on desktop.

Install the DMG matching your Mac (arm64 = Apple Silicon, x64 = Intel), or the Windows x64 EXE. The source repository is not needed to run the installed app. Install and sign in to your preferred CLI separately, then choose its working directory in Agent Hub.

These are unsigned pilot builds, not notarized/enterprise-signed production installers. OS security warnings may apply. Do not disable corporate security policies; use your approved internal distribution process. SHA256SUMS.txt verifies the downloaded files, not the identity of a trusted publisher.

Jira, Confluence and PR URLs can be shared in chat. Reading them depends on the selected CLI's own configured connectors/permissions; this release does not share another app's OAuth session. There is no automatic update, SSO or centralized employee deprovisioning yet. Invite only trusted pilot participants and use non-sensitive test workspaces initially. Cursor/Claude tool policies are not an OS-level isolation guarantee.
