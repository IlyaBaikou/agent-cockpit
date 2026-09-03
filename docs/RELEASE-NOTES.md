Employee-owned agents, spaces, channels and threads — pilot 0.2.11.

New in 0.2.11:

- Hotfix for a Mac first-launch race: an activation event can no longer reveal the initial empty window before the sandboxed renderer has loaded. The app shows and focuses the window only after its real document is ready. No coordinator, data or routing migration is needed.

New in 0.2.10:

- The recipient picker no longer offers your own employee profile: mentioning yourself cannot notify anyone useful. Existing self mentions in history remain readable but cannot be inserted by clicking.
- Recipients are grouped as other employees, their enabled agents, then your enabled agents. Filtering preserves this priority and stable order; colleagues with the same display name remain distinct by ID. Own agents remain available in solo spaces.
- This is a desktop-only UI update compatible with coordinator 0.2.8/0.2.9. It changes neither space membership nor routing permissions, and needs no server deployment or data migration.

New in 0.2.9:

- Mac bundles now receive a complete ad-hoc signature under `com.animaplay.agenthub`, including the nested helpers and sealed resources. Earlier builds skipped signing and could retain an invalid Electron signature, preventing native notification registration. No developer certificate/private key is used. This is **not Developer ID signing or Apple notarization**: it fixes bundle integrity, not trusted public distribution. Corporate Gatekeeper policies may still block installation.
- Install the app from its DMG into Applications and launch that copy. Run Settings → System notifications → Send test notification and respond to macOS's permission request yourself. On the pilot Mac, registration in System Settings → Notifications and OS acceptance were verified without a Developer ID certificate. Other machines/OS versions still need a pilot check; a visible banner also depends on Focus and notification settings.
- The test waits for the native response and shows rejection details or an explicit unconfirmed timeout. It no longer claims success just because the send function returned. Duplicate clicks are blocked while waiting.
- Windows uses the same notification test. Install using the EXE installer, launch Agent Hub from the Start Menu, and run the test with notifications enabled in Windows. Automated build/UI checks do not prove that a real Windows desktop displays the banner; that still needs confirmation on a pilot participant's PC.
- The main window loads its real document before it is shown or native menus are initialized, avoiding the visible blank startup page observed during signed-install testing. Renderer sandboxing remains enabled.
- Mac CI verifies both architecture bundle signatures; packaged smoke tests now load the renderer in an isolated temporary profile, without connecting accounts or invoking agents. This desktop-only update is compatible with coordinator 0.2.8; no server deployment or data migration is needed.

New in 0.2.8:

- Agent answers visibly tag their recipient: the requesting human for a final answer, the selected human for a decision, or the next agent for a handoff. Prompts include exact mention tokens; the coordinator adds missing recipient tags from legacy routing directives.
- A single agent mention in a reply can now hand off without a separate ROUTE line, in the same thread with the existing context, approval gate and 12-answer cap. Repeated delivery/mentions do not create duplicate jobs. Human mentions notify people, never invoke their agents.
- Conflicting routes, multiple peers, self-calls and unavailable recipients stop with a visible error. Code examples, quotes and URLs do not invoke agents, including in human messages. Plain display names are not guessed.
- Reply, mention, follower and completion notifications are deduplicated per message and employee; decision requests keep a distinct actionable title. Existing mute/read/OS preferences still apply.
- Click a mention to add that person or agent to your reply draft; clicking never sends a message or starts a model. Old history is neither rewritten nor replayed.
- The recipient picker supports Up/Down (with highlighted selection), Enter to insert and close, Escape/Tab/outside click to dismiss. Enter while the picker is open never sends the message, including Ctrl/Cmd+Enter. IME composition is respected.
- While a message awaits confirmation, the send button reads “Sending…” and blocks button/form/hotkey re-entry in that conversation. You can still type the next draft or use another conversation. Success/failure unlocks sending; retry uses the same lock and immutable request ID.
- Deploy the coordinator for new routing/notifications; update desktops for clickable mention chips. No new storage migration or credential setup is needed.

New in 0.2.7:

- Owners approve incoming requests: one task, or discussion with three tasks. No model/summary call while waiting. Automatic handoffs (including returns to the initiating employee's agent and fallbacks) need per-agent/per-thread permission. Repeated mentions cannot refill it. Explicit owner requests remain one-off.
- Grants are reserved atomically when queueing; errors, cancellations and queue timeouts are not refunded. A task may include a summary call: this controls attempts, not exact tokens. The 12-answer chain cap remains independent.
- Decisions are owner-only and check request/thread revisions. Stop, completion, archive, agent settings changes and membership removal revoke affected grants. Write fallback requires a new explicit owner write request.
- Persistent unread badges on spaces, channels, thread lists and thread cards. Reading a channel does not read its threads. Background windows and readers of older history preserve new badges. Threads open directly at the end without animated scrolling; incoming updates preserve history-reading positions.
- Inbox counts unread notices only, with read history, “Mark all read” and “Clear read”. Viewing a conversation reads its observed notices. Clearing does not remove messages, resolve approvals, affect other employees, or replay OS banners. Already displayed OS notification-center entries are not removed.
- Russian `ARCHITECTURE.md` for contributors and explicit `--profile-dir` isolation for development.
- Update coordinator **before** desktops. New desktops stop runners on servers without consent support. Old desktops cannot bypass the new server gate but lack approval controls. Migration preserves history/settings/credentials, cancels old queued jobs, and lets running jobs finish with subsequent handoffs gated. Old history becomes a read baseline; the existing inbox remains available for clearing. Do not roll back to an old server while agents are enabled: old code does not enforce grants.

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

These are pilot builds: Mac uses an ad-hoc bundle signature, Windows is unsigned. They are not notarized/enterprise-signed production installers. OS security warnings may apply. Do not disable corporate security policies; use your approved internal distribution process. SHA256SUMS.txt verifies the downloaded files, not the identity of a trusted publisher.

Jira, Confluence and PR URLs can be shared in chat. Reading them depends on the selected CLI's own configured connectors/permissions; this release does not share another app's OAuth session. There is no automatic update, SSO or centralized employee deprovisioning yet. Invite only trusted pilot participants and use non-sensitive test workspaces initially. Cursor/Claude tool policies are not an OS-level isolation guarantee.
