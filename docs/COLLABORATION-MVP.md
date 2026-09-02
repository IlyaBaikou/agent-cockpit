# Agent Hub 0.2 — employees, agents, spaces, threads

This is the simplified collaboration model. Professional roles, provider-based identities and Slack transport are not part of v2. The legacy v1 API remains available; its conversation history is not migrated or deleted.

## First run

1. Install Agent Hub from the private GitHub Release. A source checkout, Node and npm are not required for the installed desktop application.
2. Paste a single-use AH2 invitation (48-hour lifetime). It contains the coordinator URL and an enrollment code; the application exchanges it for a personal credential. Share invitations privately, never in a public space.
3. An existing coordinator controller can instead enter the hub URL and their personal control token under manual setup. Never give your token to a colleague.
4. Set your display name. Under My agents → + choose Codex, Claude Code or Cursor CLI, a name, context and local directory. Multiple agents can use the same provider. Use a different name for each.
5. Click Check connection. The selected CLI must already be installed and logged in on this computer. An explicit executable path is available when desktop PATH discovery does not find it.
6. Create a space and select its employee members. Every member sees all of its messages and threads. Only the creator edits membership; there is no per-thread privacy.
7. Compose a message; type @ and select a human or specific agent. A human mention sends a notification, not a model job. A space-level agent mention creates a thread automatically. One directly invoked agent per message in this pilot.

Local test starts an embedded SQLite coordinator bound only to loopback. It is for one-computer evaluation, not invitations between computers. Use the HTTPS cloud coordinator for a two-person pilot without a VPN.

## Conversation and intervention

Upgraded agents get a shared working summary, recent messages, the space's available agent directory, and their owner's configured context. The complete thread transcript is available through a job-scoped read-only archive, including all omitted code blocks. They read local code through their own executor. An agent ends its answer with one ROUTE directive: a peer agent ID, a human ID, done, or unable. The UI displays readable names; provider names are never used as routing identities. See [context optimization](CONTEXT.md) for checkpoint validation, retrieval, privacy and cost caveats.

The chain is capped at 12 answers. It pauses for a human when that limit is reached, an approval is needed, or a person added context while an answer was being generated. Reply and explicitly mention the next agent to continue. Stop cancels pending/running work; a stopped agent's late result cannot restart the chain. Completion marks the thread resolved; humans can reopen it.

Since 0.2.3, general chat includes one clickable card for each thread in the space, including existing threads. Cards appear at the thread's creation time with the creator, initial request preview, live status and count of human/agent replies (excluding the initial request and system notices). Agent replies are not copied into general chat. Clicking opens the same shared conversation; navigating back preserves an unsent draft. Humans can clarify, answer or redirect a discussion in the thread. A plain message adds context without invoking a model; @mention one agent to continue or hand off. If an agent is still working, add a plain clarification and wait for the pause, or Stop before invoking a different agent. Write permissions remain separate from conversational agreement.

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

SSO, admin lifecycle/deprovisioning and token rotation UI; richer access policies; approval grants for remote fixes; audited/restricted MCP tools; encrypted transport beyond HTTPS for untrusted coordinators; normalized persistent queues; per-thread subscriptions/read badges; full streaming tool logs; quota/cost controls; attachment storage/search; signed/notarized installers; auto-update; complete Windows real-agent and provider-version compatibility coverage.

## Development and releases

`npm ci && npm run cockpit` starts the new application from source. `npm run cockpit:legacy` retains the old UI. `npm run check` runs typecheck/build/tests. `npm run desktop:dist` packages the current desktop platform. GitHub Actions builds Apple Silicon and Intel DMGs plus Windows x64 NSIS EXE from version tags, then publishes all assets and SHA256SUMS in a prerelease only after tests and both build jobs succeed. No signing secrets are embedded; the initial pilot is unsigned. For corporate rollout configure official platform certificates/notarization and managed distribution first.

Primary references: [Codex CLI](https://developers.openai.com/codex/cli/reference), [Electron notifications](https://www.electronjs.org/docs/latest/api/notification), [electron-builder release workflow](https://www.electron.build/docs/github-actions/).
