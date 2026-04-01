<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw runs on the Claude Agent SDK, which means you're running Claude Code directly. Claude Code is highly capable and its coding and problem-solving capabilities allow it to modify and expand NanoClaw and tailor it to each user.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Docker (macOS/Linux), [Docker Sandboxes](docs/docker-sandboxes.md) (micro VM isolation), or Apple Container (macOS)
- **Credential security** - Agents never hold raw API keys. Outbound requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects credentials at request time and enforces per-agent policies and rate limits.
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram to the core codebase. Instead, fork NanoClaw, make the code changes on a branch, and open a PR. We'll create a `skill/telegram` branch from your PR that other users can merge into their fork.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see the [documentation site](https://docs.nanoclaw.dev/concepts/architecture).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## Railway Workflow

NanoClaw uses one Railway project with two persistent environments:

- `production`: live environment, auto-deployed from GitHub `main`
- `dev`: development environment, deployed from your local checkout

This keeps deployments, environment variables, volumes, bot tokens, Syncthing
behavior, and scheduled task state isolated without splitting NanoClaw across
multiple Railway projects.

### Local target config

Set these in your local shell or `.env` file:

```bash
RAILWAY_PROJECT_ID=<railway project id for the live NanoClaw project>
RAILWAY_PROD_ENVIRONMENT=production
RAILWAY_DEV_ENVIRONMENT=dev
```

Optional:

```bash
RAILWAY_SERVICE_NAME=nanoclaw
PUSH_CHANGES_DEFAULT_BRANCH=main
PUSH_CHANGES_DIRECT_MODE=allow
```

On the `dev` environment, set `PUSH_CHANGES_DIRECT_MODE=pr-only` in Railway so
in-app `push_changes` requests cannot directly update `main`.

Before the first real deploy to `dev`, configure at least one dev channel token
for that environment. NanoClaw exits if no channels connect, so the `dev`
environment cannot be seeded or validated end to end until a dev Discord or
Telegram bot is configured there.

### Daily feature workflow

1. Create a local feature branch.
2. Make changes locally.
3. Deploy to dev with `npm run railway:dev:deploy`.
4. Validate on the Railway `dev` environment.
5. Iterate and redeploy to dev as needed.
6. Open a PR to `main`.
7. Merge to `main`.
8. The Railway `production` environment auto-deploys from GitHub `main`.

Promotion happens through Git merge, not by copying a deploy from dev into
production.

### Wrapper commands

```bash
npm run railway:dev:deploy
npm run railway:dev:status -- --json
npm run railway:dev:logs -- --lines 200
npm run railway:prod:status -- --json
npm run railway:prod:logs -- --lines 200
```

The wrappers always resolve an explicit project, environment, and service. They
do not rely on the repo being linked to the correct Railway target. Dev deploys
also refuse to run from `main` unless you pass `--allow-main`.

### Seed dev from prod

After the Railway `dev` environment exists, initialize it once with
representative data from `production`:

```bash
npm run railway:dev:seed
```

Default seed scope:

- `/data/groups`
- `/data/projects`
- `/data/public-knowledge`
- `/data/second-brain`

Optional:

```bash
node --import tsx ./scripts/seed-railway-dev-state.ts --include-state
```

Never seeded into dev:

- `/data/sessions`
- `/data/ipc`
- `/data/store/messages.db`
- `/data/syncthing`
- logs
- production auth/session state

### Cleanup note

If you created a temporary standalone `nanoclaw-dev` Railway project during the
earlier two-project attempt, treat it as migration drift. Keep it only until
the `dev` environment inside the live project is fully configured and verified,
then retire it.

## Project Sync On Railway

You can mirror NanoClaw project files from Railway to your laptop with
Syncthing. Production keeps the current Syncthing setup. Development starts
with Syncthing disabled; add a separate dev peer only if needed later.

Phase 1 intentionally syncs only `/data/projects`. It does not sync sessions,
IPC, the SQLite database, or logs.

### Railway environment variables

Set these on the Railway service:

```bash
SYNCTHING_ENABLED=true
SYNCTHING_PEER_DEVICE_ID=<your-laptop-device-id>
SYNCTHING_FOLDER_ID=nanoclaw-projects
SYNCTHING_FOLDER_PATH=/data/projects
SYNCTHING_VERSIONING_DAYS=30
```

`SYNCTHING_FOLDER_ID`, `SYNCTHING_FOLDER_PATH`, and
`SYNCTHING_VERSIONING_DAYS` are optional and default to the values above.

### Local setup

1. Install Syncthing on your laptop.
2. Create or choose the local folder you want NanoClaw projects to live in.
   The default local path used by NanoClaw is `~/development/nanoclaw-projects`.
3. In Syncthing on your laptop, create a folder with:
   - Folder ID: `nanoclaw-projects`
   - Folder Type: `Send & Receive`
   - Path: `~/development/nanoclaw-projects`
   - Ignore Permissions: enabled
   - File Versioning: `Staggered`
   - Version retention: `30` days
4. Start the production Railway service with `SYNCTHING_ENABLED=true`.
5. Read the Railway logs and copy the printed `Syncthing device ID`.
6. Add the Railway device to your local Syncthing instance and share the
   `nanoclaw-projects` folder with it.
7. Set `SYNCTHING_PEER_DEVICE_ID` on Railway to your laptop's device ID and
   redeploy if you did not set it before the first boot.

### Daily workflow

- NanoClaw edits files under `/data/projects` on Railway.
- Syncthing syncs those file changes to your laptop automatically.
- You can open the synced local project in Claude Code and work normally.
- Local edits sync back to Railway automatically.

If you want to keep that local Claude Code session reachable from your phone or
browser, start Claude Code locally and use Remote Control there. Remote Control
is not part of the Railway sync setup itself.

### Limitations

- Simultaneous edits on Railway and your laptop can still create Syncthing
  conflict files. Resolve those manually.
- This feature does not sync `/data/sessions`, `/data/ipc`, `/data/store`,
  `/data/state`, or `groups/*/logs`.
- Phase 1 supports one laptop peer.

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials never enter the container — outbound API requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects authentication at the proxy level and supports rate limits and access policies. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports any Claude API-compatible model endpoint. Set these environment variables in your `.env` file:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

This allows you to use:
- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- Custom model deployments with Anthropic-compatible APIs

Note: The model must support the Anthropic API format for best compatibility.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT
