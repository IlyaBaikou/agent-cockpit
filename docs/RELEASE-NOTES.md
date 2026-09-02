Employee-owned agents, spaces and threads — pilot 0.2.4.

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
