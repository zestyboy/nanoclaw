# NanoClaw Slash Commands Cheat Sheet

Quick reference for all slash commands available in Discord.

---

## Session Management

| Command | What It Does |
|---------|-------------|
| `/clear` | Wipe session context and start fresh. Also works as a text message. |
| `/compact [instructions]` | Compact conversation context. Optional instructions guide what to preserve (e.g., `/compact keep the auth flow context`). |
| `/rename [name]` | Name the current session. Omit name to auto-generate from first prompt. |
| `/work [n\|name]` | List all sessions (no args) or switch to session by number or name. |
| `/branch [name]` | Fork the current conversation at this point. Requires an active container. Switch to the branch with `/work`. |
| `/effort [low\|medium\|high\|max]` | Set agent effort level. `max` is Opus 4.6 only. No args shows current level and available options. Persists across sessions. |
| `/model` | Show current model (API-confirmed), context window size, and effort level. Requires at least one message in the session. |

## Monitoring

| Command | What It Does |
|---------|-------------|
| `/context` | Show API-confirmed model, context window, effort, session metrics (transcript size, context %, token counts, rate limits). |
| `/cost` | Show token count and USD cost for the current session. |
| `/diff` | Show uncommitted file changes in the group workspace (`git diff --stat`). |
| `/export` | Export the latest archived conversation as markdown. |
| `/tasks` | List scheduled tasks for this group. |
| `/hooks` | Show active hook configurations (PreCompact, MCP, group-level). |
| `/skills` | List installed agent skills with descriptions. |

## Actions

| Command | What It Does |
|---------|-------------|
| `/reload` | Close the active container so CLAUDE.md and skills are reloaded on next message. |
| `/rewind` | Revert all uncommitted file changes (`git checkout . && git clean -fd`). Works with or without an active container. |

## Brain Router

| Command | What It Does |
|---------|-------------|
| `/catalog <text>` | Catalog information to a project (injected into Brain Router). |
| `/execute <text>` | Dispatch work to a project agent (injected into Brain Router). |
| `/knowledge <text>` | Store or search the public knowledge repository. |
| `/ask <text>` | Force disambiguation — list matching projects and ask user to pick. |

---

## How Commands Work

### Invocation Paths

Commands reach the system through four different paths:

```
Discord Slash Command UI
  │
  ├─ onSlashCommand handler ──── Most commands (instant response)
  │
  ├─ Brain Router passthrough ── /catalog, /execute, /knowledge, /ask
  │                               (injected as synthetic messages)
  │
  ├─ Session interception ────── /compact (intercepted in message loop,
  │                               forwarded to SDK as session command)
  │
  └─ IPC Control Channel ─────── /rewind, /branch (sent to active
                                  container via _control-*.json files)
```

### State Modifications

| Category | Commands | What Changes |
|----------|----------|-------------|
| **Read-only** | `/context`, `/cost`, `/diff`, `/export`, `/tasks`, `/hooks`, `/skills` | Nothing — safe to run anytime |
| **Session state** | `/clear`, `/rename`, `/work`, `/effort`, `/compact`, `/branch` | SQLite DB (sessions, session_history, group_settings) |
| **Filesystem** | `/rewind` | Git checkout + clean in group workspace |
| **Container** | `/clear`, `/reload`, `/work`, `/compact` | Closes active container stdin |
| **Synthetic messages** | `/catalog`, `/execute`, `/knowledge`, `/ask` | Inserts messages into Brain Router's chat |

### IPC Control Protocol

`/rewind` and `/branch` use the IPC control channel when a container is active:

1. Host writes `_control-{timestamp}-{random}.json` to the IPC input directory
2. Container's `drainIpcInput()` processes control files **before** regular messages
3. `processControlCommand()` executes the action and returns a result
4. For `/rewind`: result text is injected into the agent's message stream
5. For `/branch`: structured `controlResponse` is sent back via `writeOutput()`

If no container is active, `/rewind` falls back to host-side git operations. `/branch` requires an active container (the SDK's `forkSession` must run where session files exist).
