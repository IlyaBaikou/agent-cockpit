# Agent Hub

A desktop collaboration pilot for employees and their agents. Each employee can connect multiple named Codex, Claude Code or Cursor CLI agents. Spaces contain ordinary human chat and threaded agent conversations, with human intervention and native notifications.

## Install

Download a matching installer from [Releases](https://github.com/IlyaBaikou/agent-cockpit/releases). This repository is public and can be shared with colleagues:

- macOS Apple Silicon: `mac-arm64.dmg`
- macOS Intel: `mac-x64.dmg`
- Windows 10/11 x64: `win-x64.exe`

The app does not need a source checkout, Node or npm. Paste a personal or shared team invitation. For a shared invitation, enter your name: the app creates your own account and opens the invited space. Install and log in to your preferred agent CLI separately, then choose a working directory for each agent.

The first release is an **unsigned pilot**, not a company-wide production deployment. Follow your organization's approved installation process. Do not disable platform security policies. See [release notes](docs/RELEASE-NOTES.md) for limitations.

## Use

Settings → Appearance offers light, dark and system-following themes. The preference is saved on your computer.

To invite a whole team, create a space, then open Settings → Invitations (or the space's member settings). Create a shared AH2 code and post it to a **closed, trusted team chat**. Default: 7 days, 100 entries; adjustable and revocable. Every recipient gets an independent account and access to that space's full history, not other spaces. Existing employees use “Join with a shared invitation” in Settings to keep their account and agents. Disabling an invitation prevents new entries; remove existing members in the space's settings if needed. Update both coordinator and desktop to 0.2.4 for shared invitations.

Create a space, select colleagues and create a thread. Type `@` to choose a person (notification) or an agent (job). Without a mention, messages never invoke a model. Agents can hand off within a thread, ask a person for a decision, or conclude it. You can stop or resume the conversation. Configured fallback agents handle unavailable executors; failures remain visible.

Write jobs require the agent owner's explicit request and local opt-in. They run in separate Git worktrees. The app shares the result/diff, but never commits, pushes, merges or deploys. Links to Jira, Confluence and pull requests are supported as discussion context; access depends on each CLI's own configured tools and credentials.

Long threads use shared working summaries, recent messages and on-demand originals instead of repeatedly sending every code block. Full chat history is preserved. Expand “Память треда” to inspect the summary and context sizes. See [context optimization](docs/CONTEXT.md) for limits and measurement caveats.

Read [the full pilot guide](docs/COLLABORATION-MVP.md) for routing, trust boundaries, background operation and deferred corporate features.

## Development

```sh
npm ci
npm run check
npm run cockpit
```

For a one-computer demo, choose Local test on first launch. For multiple computers use an HTTPS coordinator and PostgreSQL. Its required environment is in `.env.example`. `npm start` runs the coordinator after `npm run build`; the Dockerfile is ready for Railway.

`npm run desktop:dist` builds installers. The GitHub Actions workflow tests and builds Mac/Windows installers on version tags and publishes a prerelease only when all builds pass. SHA256SUMS verifies file integrity. Signing/notarization and automatic updates are not configured in the initial pilot.

v2 preserves the old v1 server endpoints without importing or deleting old history. Historical CLI source remains for compatibility; the shipped desktop starts v2.

Public source repository; no open-source license has been granted. All rights reserved. Dependencies retain their respective licenses. Do not post credentials or internal company discussions in public issues.
