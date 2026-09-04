# Agent Hub

A desktop collaboration pilot for employees and their agents. Each employee can connect multiple named Codex, Claude Code or Cursor CLI agents. Spaces contain topic channels, each with human chat and threaded agent conversations, human intervention and native notifications.

## Install

Download a matching installer from [Releases](https://github.com/IlyaBaikou/agent-cockpit/releases). This repository is public and can be shared with colleagues:

- macOS Apple Silicon: `mac-arm64.dmg`
- macOS Intel: `mac-x64.dmg`
- Windows 10/11 x64: `win-x64.exe`

The app does not need a source checkout, Node or npm. Paste a personal or shared team invitation. For a shared invitation, enter your name: the app creates your own account and opens the invited space. Install and log in to your preferred agent CLI separately, then choose a working directory for each agent.

These are **pilot builds**, not a company-wide production deployment. Since 0.2.9 the Mac app has a complete ad-hoc bundle signature (no Developer ID certificate or notarization); Windows installers remain unsigned. Follow your organization's approved installation process. Do not disable platform security policies. See [release notes](docs/RELEASE-NOTES.md) for limitations.

On Mac, open the DMG and drag Agent Hub into **Applications**, then launch that copy. Settings → System notifications → Send test notification checks the OS response; approve the macOS request yourself if you want notifications. The app then appears in System Settings → Notifications → Agent Hub. An accepted request does not guarantee a banner if permissions, Focus or screen-sharing settings suppress it. A DMG is packaging, not a signature or proof of a trusted publisher; corporate policies may still block this pilot.

## Use

Settings → Appearance offers light, dark and system-following themes. The preference is saved on your computer.

To invite a whole team, create a space, then open Settings → Invitations (or the space's member settings). Create a shared AH2 code and post it to a **closed, trusted team chat**. Default: 7 days, 100 entries; adjustable and revocable. Every recipient gets an independent account and access to that space's full history, not other spaces. Existing employees use “Join with a shared invitation” in Settings to keep their account and agents. Disabling an invitation prevents new entries; remove existing members in the space's settings if needed. Update both coordinator and desktop to 0.2.4 for shared invitations.

Create a space and select colleagues. Use **Channels → +** for topics such as Gamification, Game 1 and Mathematics. Every channel has its own chat and question-specific threads. The existing history moves into General automatically. All channels inherit space membership. Any member can create a channel; its creator or the space owner manages it. Archive preserves history read-only and stops active channel jobs; restore does not restart agents.

Type `@` to choose a person (notification) or their agent (job). These remain separate addresses: mentioning the employee never starts a model. Each owner selects one default agent; coworkers and peer agents address that default automatically instead of choosing among the owner's local executors. Owners can still explicitly invoke any of their own agents, with the default shown first. An agent mention in channel chat creates a thread with a card in the same channel. Without a mention, messages never invoke a model. Agents can hand off within a thread, ask a person for a decision, or conclude it. Configured fallback agents handle unavailable executors; failures remain visible.

Participation follows a thread automatically unless explicitly unfollowed. Follow/unfollow in its header; mute/unmute below the channel list. Mute suppresses all channel banners, including mentions, but keeps the in-app inbox. Explicit requests/results/failures still create notices independently of following. Notification clicks open the correct channel/thread. Upgrade coordinator and **all desktops to 0.2.5**; old clients see General only.

Write jobs require the agent owner's explicit request and local opt-in. They run in separate Git worktrees. The app shares the result/diff, but never commits, pushes, merges or deploys. Links to Jira, Confluence and pull requests are supported as discussion context; access depends on each CLI's own configured tools and credentials.

Long threads use shared working summaries, recent messages and on-demand originals instead of repeatedly sending every code block. Full chat history is preserved. Expand “Память треда” to inspect the summary and context sizes. See [context optimization](docs/CONTEXT.md) for limits and measurement caveats.

Read [the full pilot guide](docs/COLLABORATION-MVP.md) for routing, trust boundaries, background operation and deferred corporate features.

## Realtime delivery and typing (0.2.13)

Desktop clients receive change signals over an authenticated server-sent event stream and immediately refresh their access-filtered view. Messages still use acknowledged, idempotent HTTPS POST; a 30-second sync remains as recovery after network/proxy interruptions. Human typing presence is scoped to the exact conversation, expires after five seconds, is not persisted and never enters model context. This pilot transport assumes one coordinator replica; add a shared event bus before horizontal scaling. See [architecture](ARCHITECTURE.md) for the protocol and rollout notes.

## Agent mentions and handoffs (0.2.8)

Agent replies visibly tag the person who should respond or the next agent. Human tags create notifications; a single peer tag hands off in the same thread, subject to owner approval and the remaining budget. The coordinator also adds missing tags from existing `ROUTE` directives. Code examples and quotes never call agents; conflicting/multiple targets stop with a visible error. Click a tag to prepare a reply, without sending it automatically. See [architecture](ARCHITECTURE.md) for the exact addressing and notification rules.

## Consent, unread badges and inbox (since 0.2.7)

Incoming requests and automatic handoffs wait for that agent owner's permission: one task or three tasks in this thread. Repeat mentions do not refill grants. Queue reservations, errors and cancellation count as attempts; context summarization can add a model call, so this is not a token budget. Your own explicit mention permits one task, not unlimited automatic returns. Fallbacks need their own permission; write jobs always need an explicit owner request.

Unread badges aggregate spaces/channels while keeping each thread's cursor separate. Active visible views read messages at the end; background windows and history readers preserve new badges. Threads open at the end without animated scrolling. The inbox counts unread notices only, with “Mark all read” and “Clear read”; clearing notices never deletes messages or approves agents.

Update **coordinator first, then all desktops to 0.2.8**. When upgrading from versions before 0.2.7, old queued tasks are cancelled during migration; running tasks may finish with subsequent handoffs gated. Old history becomes a read baseline, without clearing the existing inbox. New desktops stop runners on servers without consent support. The 0.2.7 → 0.2.8 update needs no new data migration. See [architecture](ARCHITECTURE.md) for exact rules and rollout precautions.

## Development

Start with [ARCHITECTURE.md](ARCHITECTURE.md) (Russian): component map, consent invariants, RPC/job flow, read cursors, migrations, tests, isolated profiles and release/deployment guidance.

```sh
npm ci
npm run check
npm run cockpit
```

For a one-computer demo, choose Local test on first launch. For multiple computers use an HTTPS coordinator and PostgreSQL. Its required environment is in `.env.example`. `npm start` runs the coordinator after `npm run build`; the Dockerfile is ready for Railway.

`npm run desktop:dist` builds installers. The GitHub Actions workflow tests and builds Mac/Windows installers on version tags and publishes a prerelease only when all builds pass. SHA256SUMS verifies file integrity. Signing/notarization and automatic updates are not configured in the initial pilot.

v2 preserves the old v1 server endpoints without importing or deleting old history. Historical CLI source remains for compatibility; the shipped desktop starts v2.

Public source repository; no open-source license has been granted. All rights reserved. Dependencies retain their respective licenses. Do not post credentials or internal company discussions in public issues.
