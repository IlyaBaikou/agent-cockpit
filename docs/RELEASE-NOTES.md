Employee-owned agents, spaces and threads — pilot 0.2.1.

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
