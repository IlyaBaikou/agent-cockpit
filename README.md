# Agent Hub

A desktop collaboration pilot for employees and their agents. Each employee can connect multiple named Codex, Claude Code or Cursor CLI agents. Spaces contain ordinary human chat and threaded agent conversations, with human intervention and native notifications.

## Install

Download a matching installer from this private repository's Releases:

- macOS Apple Silicon: `mac-arm64.dmg`
- macOS Intel: `mac-x64.dmg`
- Windows 10/11 x64: `win-x64.exe`

The app does not need a source checkout, Node or npm. Install and log in to your preferred agent CLI separately, paste your personal invitation, and choose a working directory for each agent.

The first release is an **unsigned pilot**, not a company-wide production deployment. Follow your organization's approved installation process. Do not disable platform security policies. See [release notes](docs/RELEASE-NOTES.md) for limitations.

## Use

Create a space, select colleagues and create a thread. Type `@` to choose a person (notification) or an agent (job). Without a mention, messages never invoke a model. Agents can hand off within a thread, ask a person for a decision, or conclude it. You can stop or resume the conversation. Configured fallback agents handle unavailable executors; failures remain visible.

Write jobs require the agent owner's explicit request and local opt-in. They run in separate Git worktrees. The app shares the result/diff, but never commits, pushes, merges or deploys. Links to Jira, Confluence and pull requests are supported as discussion context; access depends on each CLI's own configured tools and credentials.

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

Private project. All rights reserved. Dependencies retain their respective licenses.
