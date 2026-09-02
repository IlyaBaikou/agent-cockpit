# Agent Hub 0.2 — employees, agents, spaces, channels, threads

This is the simplified collaboration model. Professional roles, provider-based identities and Slack transport are not part of v2. The legacy v1 API remains available; its conversation history is not migrated or deleted.

## First run

1. Install Agent Hub from the public GitHub Release. A source checkout, Node and npm are not required for the installed desktop application.
2. Paste an AH2 invitation. A personal code is single-use and lasts 48 hours. A shared team code asks for your name and opens its chosen space automatically; default lifetime is 7 days with 100 entries. Each newcomer gets a distinct personal credential. Send personal codes privately and shared codes only to a closed, trusted team chat, never publicly.
3. An existing coordinator controller can instead enter the hub URL and their personal control token under manual setup. Never give your token to a colleague.
4. Set your display name. Under My agents → + choose Codex, Claude Code or Cursor CLI, a name, context and local directory. Multiple agents can use the same provider. Use a different name for each.
5. Click Check connection. The selected CLI must already be installed and logged in on this computer. An explicit executable path is available when desktop PATH discovery does not find it.
6. Create a space and select its members. Add topic channels using Channels → +. Every member sees all channels, messages and threads in that space. Only the space creator edits membership; private channels and per-thread access policies are not implemented.
7. Compose a message in a channel; type @ and select a human or specific agent. A human mention creates a notification, not a model job. A channel-level agent mention creates a thread in that same channel. One directly invoked agent per message in this pilot.

Local test starts an embedded SQLite coordinator bound only to loopback. It is for one-computer evaluation, not invitations between computers. Use the HTTPS cloud coordinator for a two-person pilot without a VPN.

## Channels, subscriptions and archive (0.2.5)

Space = team membership; channel = an ongoing topic; thread = one question. General remains for announcements and uncategorized questions. Each channel has its own messages and thread cards/list. Any space member can create a channel; its creator or the space owner can edit/archive/restore it. Names are unique within a space, including archived channels. General cannot be renamed or archived. Shared space invitations include all current and future channels.

Archive preserves messages, summaries and code read-only. The server blocks posting and thread actions, cancelling active channel jobs atomically. Started writes may have partial local changes; owners must inspect their worktree. Restoring permits chat again but never launches agents automatically.

Posting in a thread enables following unless explicitly unsubscribed. The header has a follow toggle; old thread owners, human participants and requesters are subscribed during migration. Followers receive new human/agent replies, with mention/follower duplicates combined per message. Direct mentions, job requests/results/failures and requests for a decision are still addressed to the relevant person. These notifications do not invoke models.

Channel mute is per employee, stored on the coordinator. It suppresses all OS banners from that channel, including mentions/decisions, but preserves the inbox. The notification cursor advances past muted notices; unmuting does not replay them. Clicks navigate to the exact channel/thread. Removed space members cannot read channels, change preferences or receive new follower notices. Explicit unsubscribe persists even when posting again. Unread/read badges are not implemented.

A once-only migration adds General and assigns existing records to it without changing IDs, timestamps, content, credentials or valid context checkpoints. New sync clients advertise channelVersion 1; older clients see only General, never flattened content from other channels. Old posts without a channel go to General or an explicitly addressed thread's own channel. Upgrade coordinator and all desktops to 0.2.5. Access remains defined by space membership.

## Appearance and shared invitations (0.2.4)

Settings → Appearance supports light, dark and OS-following themes. The choice is saved in the desktop profile, independent of notification preferences. A non-sensitive local cache applies the theme before first paint. The sign-in screen also has a theme selector.

Space owners can create reusable invitations from Settings → Invitations or their space's member settings. Choose the space, lifetime (1, 7 or 30 days) and maximum entries (1–1,000). A shared invitation grants membership with access to all existing/future chat and threads in that space and the ability to address its agents, but does not grant access to other spaces, another employee's credentials or write permission for their agents. Use a dedicated new space if its prior history should not be shared.

An existing employee can paste a shared code under “Join with a shared invitation”; this preserves their identity and local agents and rejects a different coordinator URL. Repeated joins by an existing member do not consume entries. A member removed after using a code cannot regain access by reusing that same code under that account. Owners see counts and can disable invitations; revocation/expiry stops new entries, not existing memberships. Use member management for removal.

The server stores invitation hashes, not plaintext codes. Usage limits, enrollment and membership changes share the same atomic state transaction. Shared invitation metadata is visible only to its creator. Names are self-declared: this pilot does not verify corporate identity or provide SSO. Do not use a publicly posted invitation as an access-control policy. Upgrade coordinator and desktop apps to 0.2.4; the additive optional state field needs no destructive database migration. Legacy individual codes continue to work.

## Conversation and intervention

Upgraded agents get a shared working summary, recent messages, the space's available agent directory, and their owner's configured context. The complete thread transcript is available through a job-scoped read-only archive, including all omitted code blocks. They read local code through their own executor. An agent ends its answer with one ROUTE directive: a peer agent ID, a human ID, done, or unable. The UI displays readable names; provider names are never used as routing identities. See [context optimization](CONTEXT.md) for checkpoint validation, retrieval, privacy and cost caveats.

The chain is capped at 12 answers. It pauses for a human when that limit is reached, an approval is needed, or a person added context while an answer was being generated. Reply and explicitly mention the next agent to continue. Stop cancels pending/running work; a stopped agent's late result cannot restart the chain. Completion marks the thread resolved; humans can reopen it.

Each channel's chat includes one clickable card for each of its threads. Old threads appear in General. Cards show the creator, initial request, live status and reply count, excluding the initial request and system notices. Agent replies stay inside the thread. Drafts are separate per channel/thread. Humans can clarify, answer or redirect a discussion: a plain message adds context; @mention one agent to continue. If an agent is working, add a plain clarification and wait for the pause, or Stop before invoking another. Write permissions remain separate from conversational agreement.

An unavailable executor is handled by its explicitly configured fallback. Fallbacks are limited to agents owned by the same employee, have a five-hop bound and cannot form configuration cycles. If no fallback is available, an error is recorded in the thread and the requester is notified. Queued requests time out after two minutes; claimed work has a renewable 90-second lease.

## Writes and trust boundary

Other space members may ask your enabled agents to inspect your configured workspaces. Enabling an agent is consent to that pilot workflow; do not enable access to directories whose content those members must not see. The transcript, referenced documents and incoming agent messages are untrusted task data.

Writes require both the agent's local allow-write setting and an explicit write-mode request from its owner. Someone else requesting a fix triggers an owner decision, not an automatic write. Changes run in a separate Git worktree starting at the configured repo's current HEAD; uncommitted checkout changes are not copied. Results include the diff and branch name. Open working copy reveals it on the owner's computer. The app does not commit, push, merge, open PRs or deploy. Tests are only those actually run and reported by the executor; the app does not claim automatic validation. Claude's adapter has no shell tools and does not run tests.

Handoffs start the next agent in read mode, never carry write permission forward. After a writing executor might have started, failure/timeout/stop does not trigger fallback or re-execution: partial files remain for the owner to inspect. Result-delivery retries do not rerun the executor. Cancellation requests terminate the local process tree; offline/disconnected work is conservatively reported uncertain. Git worktrees are never automatically deleted.

Codex uses explicit read-only/workspace-write sandbox modes and noninteractive approvals. Claude uses a bounded tools list; Cursor uses ask/agent modes. Those latter policies are not an OS security boundary. Configured CLI MCPs/plugins can have independent privileges. This pilot does not impose corporate tool allowlists or audit every external tool action. Use trusted employees and approved workspaces; introduce sandboxed workers/tool policies before expanding to untrusted participants.

## Notifications and background operation

Native desktop notices cover human mentions, incoming requests to your agent, replies, errors, completed discussions and human decisions. Clicking opens the corresponding space/thread. Notice bodies intentionally omit code and transcript content for lock-screen privacy. The app records a per-account cursor; initial login does not flood historic notices and later reconnects do not duplicate already delivered notices. The full notification history is in the app. Reconnect bursts show at most five banners.

Enable notifications in the app and in the OS. The test button verifies OS delivery; Focus/Do Not Disturb may suppress banners. Closing the window hides it in the tray; Quit stops runners. There is no login-start agent service, mobile push or notification delivery while the application is fully closed.

## Jira, Confluence, Bitbucket and GitHub

Share ordinary links and Markdown/code snippets in messages. An agent may inspect a PR via local git or read a linked document using its own available connectors. URLs do not grant access. The app neither proxies Slack Desktop OAuth nor promises that CLI agents inherit desktop connectors. If a CLI cannot read a link, it must request the text or report missing access. This release does not include a central MCP gateway or Jira/Confluence connection wizard.

## Coordinator and persistence

Cloud: Node 22.13+ / 24 and PostgreSQL, deployed using the existing Railway service. DATABASE_URL stays server-side. Existing HUB_CONTROL_TOKENS bootstrap employee identities. The legacy runner credentials still serve v1; v2 runners are authenticated by the employee credential and bound to the exact agent/device ID. Never send these credentials to the model environment.

The additive collaboration_state table stores a versioned JSONB document. A transaction with SELECT FOR UPDATE serializes claims, completions, handoffs, member revocation and idempotent posts. SQLite uses BEGIN IMMEDIATE for the local pilot. Idle sync/empty claim reads do not lock or rewrite state; mutations serialize under one row lock. This deliberately small pilot store is not a horizontally scalable messaging design: histories are unpaginated and all mutations rewrite the document. Move to normalized tables, indexed events, incremental synchronization and retention before a company-wide rollout. Version 0.2.1 adds optional thread memories and per-job context-size diagnostics without deleting history. Upgraded runners use bounded excerpts and original-message archives; old runners retain their 200k-character guard. Oversized Windows prompts use a temporary task file.

Desktop settings live in the OS user-data directory, never in the installation folder. Credentials are encrypted through Electron safeStorage (Keychain on Mac, DPAPI on Windows). Enrollment/session credentials on the server are stored as hashes; environment bootstrap secrets stay in deployment configuration. No credentials, local settings, workspaces, prior internal chat transcripts or installer caches are included in GitHub source exports.

## Deferred before company-wide adoption

SSO, admin lifecycle/deprovisioning and token rotation UI; richer access policies; approval grants for remote fixes; audited/restricted MCP tools; encrypted transport beyond HTTPS for untrusted coordinators; normalized persistent queues; unread/read badges; full streaming tool logs; quota/cost controls; attachment storage/search; signed/notarized installers; auto-update; complete Windows real-agent and provider-version compatibility coverage.

## Development and releases

`npm ci && npm run cockpit` starts the new application from source. `npm run cockpit:legacy` retains the old UI. `npm run check` runs typecheck/build/tests. `npm run desktop:dist` packages the current desktop platform. GitHub Actions builds Apple Silicon and Intel DMGs plus Windows x64 NSIS EXE from version tags, then publishes all assets and SHA256SUMS in a prerelease only after tests and both build jobs succeed. No signing secrets are embedded; the initial pilot is unsigned. For corporate rollout configure official platform certificates/notarization and managed distribution first.

Primary references: [Codex CLI](https://developers.openai.com/codex/cli/reference), [Electron notifications](https://www.electronjs.org/docs/latest/api/notification), [electron-builder release workflow](https://www.electron.build/docs/github-actions/).
