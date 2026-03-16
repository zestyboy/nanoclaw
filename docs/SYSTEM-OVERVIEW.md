# NanoClaw System Overview — Agent Reference Document

> This document provides a complete understanding of NanoClaw for an agent tasked with building or extending it. It covers architecture, purpose, implementation details, and the Second Brain migration plan.

---

## 1. What NanoClaw Is

NanoClaw is a **personal Claude AI assistant** that runs as a single Node.js process. You message it from WhatsApp, Telegram, Discord, or other channels, and it routes your messages to Claude agents running in isolated Linux containers. Each conversation group gets its own sandboxed agent with persistent memory.

**The core purpose has evolved into two things:**

1. **Knowledge Repository** — Two Obsidian vaults (public-knowledge for work, second-brain for personal) where your knowledge lives, searchable via [qmd](https://github.com/tobi/qmd)
2. **Brain Router** — An intelligent triage layer that receives your thoughts via messaging and routes them to the right project, stores them as knowledge, or kicks off agent work

Think of it as: you text a thought to your assistant, and the Brain Router decides whether to file it as knowledge, catalog it in a project, or spin up an agent to do work.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                     HOST (macOS / Linux / Railway)                  │
│                      (Single Node.js Process)                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─────────────────┐        ┌──────────────────┐                  │
│  │ Channel Registry │───────▶│  SQLite Database  │                  │
│  │ (self-register)  │◀──────│  (messages.db)    │                  │
│  │                  │        └────────┬─────────┘                  │
│  │ • WhatsApp       │                 │                            │
│  │ • Telegram       │                 │                            │
│  │ • Discord        │                 ▼                            │
│  │ • Slack          │        ┌──────────────────┐                  │
│  │ • Gmail          │        │  Message Loop     │                  │
│  └─────────────────┘        │  (polls SQLite)    │                  │
│                              └────────┬─────────┘                  │
│                                       │                            │
│  ┌──────────────────┐                 │     ┌──────────────────┐   │
│  │ Task Scheduler    │                 │     │  IPC Watcher     │   │
│  │ (checks due tasks)│                 │     │  (file-based)    │   │
│  └────────┬─────────┘                 │     └──────────────────┘   │
│           │                           │                            │
│           └───────────┬───────────────┘                            │
│                       │ spawns container                           │
│                       ▼                                            │
├────────────────────────────────────────────────────────────────────┤
│              CONTAINER (Linux VM / child process on Railway)       │
├────────────────────────────────────────────────────────────────────┤
│  Agent Runner (Claude Agent SDK)                                   │
│  • Working dir: /workspace/group (mounted from host)               │
│  • Tools: Bash, files, web, browser, MCP tools (IPC-based)        │
│  • Skills: loaded from container/skills/                           │
│  • Session: persisted in data/sessions/{group}/.claude/            │
└────────────────────────────────────────────────────────────────────┘
```

### Key Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher: processes tasks from containers (search, execute, create project, reindex) |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Paths, ports, intervals, Railway detection |
| `src/container-runner.ts` | Spawns agent containers with volume mounts |
| `src/railway-runner.ts` | Spawns agents as child processes on Railway (no Docker-in-Docker) |
| `src/container-runtime.ts` | Runtime abstraction (Docker vs Apple Container) |
| `src/task-scheduler.ts` | Runs scheduled tasks at due times |
| `src/db.ts` | SQLite: messages, chats, sessions, groups, tasks |
| `src/mount-security.ts` | Validates additional mounts against allowlist |
| `src/credential-proxy.ts` | HTTP proxy that injects API keys without exposing them to containers |
| `container/agent-runner/src/index.ts` | Agent entry point inside containers |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tools available to agents (schedule, send, search, execute, create project) |

### Technology Stack

- **Runtime**: Node.js 20+, TypeScript (ES2020)
- **Agent**: `@anthropic-ai/claude-agent-sdk`
- **Database**: SQLite via `better-sqlite3`
- **Container**: Docker / Apple Container (local), child process (Railway)
- **Search**: [qmd](https://github.com/tobi/qmd) CLI for vault search (lexical + vector + hybrid)
- **Browser**: agent-browser + Chromium inside containers
- **Channels**: discord.js, grammy (Telegram), baileys (WhatsApp), nodemailer (Gmail)

---

## 3. The Brain Router

The Brain Router is the intelligence layer. It's a Claude agent running in the **main group** (the user's primary messaging channel). Its entire behavior is defined in a prompt file at `groups/main/CLAUDE.md`.

### How It Works

```
User (WhatsApp/Telegram)
  │
  ▼
Main Group (isMain=true, no trigger word needed)
  │
  ▼
Brain Router agent reads projects.yaml
  │
  ├─ CATALOG → writes timestamped entry to project's notes.md
  │            confirms: "Cataloged in **Project Name** → <#channel_id>"
  │
  ├─ EXECUTE → calls execute_in_group(target_group_folder, prompt)
  │            project agent picks up work in its Discord channel
  │
  ├─ PUBLIC_KNOWLEDGE → stores/searches work knowledge vault
  │                     entity resolution, vault conventions, qmd search
  │
  └─ SECOND_BRAIN → stores/searches personal knowledge vault
                    same mechanics as public knowledge, separate vault
```

### Intent Detection

The Brain Router classifies every incoming message into one of four intents:

| Intent | Trigger | What Happens |
|--------|---------|-------------|
| **CATALOG** (default) | Informational statements, "note", "remember" | Writes timestamped entry to project's `notes.md` |
| **EXECUTE** | "build", "do", "create", "analyze", "run" | Dispatches work to project agent via IPC |
| **PUBLIC_KNOWLEDGE** | "save to knowledge", "search knowledge", "what do I know about" | Stores/retrieves from public knowledge vault |
| **SECOND_BRAIN** | "save to second brain", "search second brain", "personal note" | Stores/retrieves from personal vault |

Slash prefixes (`/catalog`, `/execute`, `/knowledge`, `/second-brain`, `/ask`) override signal-word heuristics.

### Project Routing

1. User sends a message
2. Brain Router reads `projects.yaml` (stateless — re-reads every time)
3. Matches message to a project via: explicit mention → alias match → semantic match → recent context
4. If no match: proposes creating a new project (Discord channel + folder + registration, all automated via `create_project` MCP tool)

### Projects Registry

`groups/main/projects.yaml` — auto-maintained by the system:

```yaml
- name: SaaS MVP
  slug: saas-mvp
  type: code
  brief: Build the SaaS product MVP
  aliases: [saas, mvp, product]
  folder: "project:saas-mvp"
  discord_channel_id: "1234567890123456"
  created_at: "2026-03-09T00:00:00.000Z"
```

Each project gets: a Discord text channel, an isolated group folder with CLAUDE.md, notes.md, and a registered group entry in the database.

---

## 4. Knowledge Vaults

NanoClaw integrates two Obsidian vaults — both following [Kepano's vault methodology](https://stephango.com/vault):

### Public Knowledge (Work-Related, Shareable)

- **Local path**: `~/development/nanoclaw-knowledge` (configurable via `NANOCLAW_PUBLIC_KNOWLEDGE_DIR`)
- **Railway path**: `/data/public-knowledge` (synced from Cloudflare R2)
- **qmd collection**: `public-knowledge`
- **Access**: Brain Router = read-write, all other agents = read-only

### Second Brain (Personal)

- **Local path**: configurable via `NANOCLAW_SECOND_BRAIN_DIR` (empty string = disabled)
- **Railway path**: `/data/second-brain` (synced from Cloudflare R2)
- **qmd collection**: `second-brain`
- **Access**: Brain Router = read-write, all other agents = read-only

### Vault Structure (Both Vaults)

```
vault/
  Attachments/       # Images, PDFs, media
  Categories/        # Topic overview notes (hub notes)
  Clippings/         # Content written by others (articles, research)
  References/        # External entities: companies, people, products, tools
  Templates/         # Obsidian templates (evolve organically)

  # Root-level notes (your own synthesized knowledge)
  Pricing strategy.md
  Personal goals 2026.md
```

### Frontmatter Schema

Every note MUST have YAML frontmatter:

```yaml
---
created: 2026-03-14
type: reference              # reference | clipping | note | category
category:                    # plural, always
  - competitors
tags:
  - pricing
  - saas
author: Niven
source: https://...          # URL for clippings
aliases:                     # name variants for entity resolution
  - ACME
  - Acme Corporation
related:                     # wikilinks to connected notes
  - "[[Product roadmap]]"
---
```

### Entity Resolution (Critical Pattern)

The Brain Router is stateless between sessions. Without explicit lookup, "Acme Corp" on Monday and "Acme" on Thursday would create duplicates. The mandatory process:

1. Extract entity/topic name from the message
2. List files in the target directory for filename matches
3. Search qmd with a lex query for the entity name
4. Match with tolerance (case-insensitive, ignore Corp/Inc/Ltd suffixes)
5. **Clear match** → read existing file, append/update
6. **Ambiguous** → ask user which note to update
7. **No match** → create new note, add name variants as aliases

### Search (qmd)

qmd provides three search types:
- **lex**: Exact terms/keywords (fast, ~200-500ms)
- **vec**: Natural language semantic search (slower, ~1-3s, uses embeddings)
- **hyde**: Hypothetical answer text

Search flow: Agent calls MCP tool → IPC task file → host runs `qmd query ... --json` → results returned to agent.

Reindexing: After writing, Brain Router calls `reindex_*` which spawns `qmd update && qmd embed` as a detached background process (fire-and-forget).

### Template Evolution

Vaults start with no custom templates. After the Brain Router creates 3+ notes of the same type with recurring structure, it proposes a template to the user. Templates are never created silently. They refine over time as usage patterns drift.

---

## 5. Container Isolation & Security

### Trust Model

| Boundary | Mechanism |
|----------|-----------|
| Container isolation | Agents run in Linux VMs (Docker/Apple Container) or child processes (Railway) |
| Mount security | Allowlist at `~/.config/nanoclaw/mount-allowlist.json` |
| Credential proxy | Real API keys never enter containers; injected via HTTP proxy |
| IPC authorization | Source group identity determined by filesystem path, not user input |
| Session isolation | Each group has its own Claude session data |

### Mount Privileges

**Main group (Brain Router):**
| Mount | Container Path | Access |
|-------|---------------|--------|
| NanoClaw project root | `/workspace/project` | Read-only |
| `groups/main/` | `/workspace/group` | Read-write |
| `groups/` (all groups) | `/workspace/all-groups` | Read-write |
| Projects directory | `/workspace/projects` | Read-write |
| Public knowledge vault | `/workspace/public-knowledge` | Read-write |
| Second brain vault | `/workspace/second-brain` | Read-write |
| Per-group IPC | `/workspace/ipc` | Read-write |

**Non-main groups (project agents):**
| Mount | Container Path | Access |
|-------|---------------|--------|
| Own group folder | `/workspace/group` | Read-write |
| `groups/global/` | `/workspace/global` | Read-only |
| Public knowledge vault | `/workspace/public-knowledge` | Read-only |
| Second brain vault | `/workspace/second-brain` | Read-only |
| Per-group IPC | `/workspace/ipc` | Read-write |

---

## 6. IPC System

Agents communicate with the host via filesystem IPC. The agent writes a JSON task file; the host IPC watcher picks it up within 1 second.

### Available IPC Operations

| Operation | Who Can Call | What It Does |
|-----------|-------------|-------------|
| `send_message` | Any group | Send a message to the group's chat |
| `schedule_task` | Any group (own), main (any) | Schedule a recurring or one-time task |
| `execute_in_group` | Main only | Dispatch work to another group's agent |
| `create_project` | Main only | Create Discord channel + group folder + registration + projects.yaml entry |
| `search_public_knowledge` | Any group | Search public knowledge vault via qmd |
| `search_second_brain` | Any group | Search second brain vault via qmd |
| `reindex_public_knowledge` | Main only | Trigger qmd reindex (fire-and-forget) |
| `reindex_second_brain` | Main only | Trigger qmd reindex (fire-and-forget) |

### IPC Flow (execute_in_group example)

1. Brain Router agent calls `mcp__nanoclaw__execute_in_group(target_group_folder, prompt)`
2. Agent writes IPC file to `/workspace/ipc/tasks/{timestamp}.json`
3. Host IPC watcher picks it up
4. Host verifies source is main group
5. Host looks up target group's JID from registered groups
6. Host inserts synthetic message with `sender: 'router'` into database
7. Host enqueues target group for processing via GroupQueue
8. GroupQueue spawns a container for the target group
9. Target agent processes the message and responds in its Discord channel

---

## 7. Deployment

### Local (macOS)

- Runs as a launchd service (`~/Library/LaunchAgents/com.nanoclaw.plist`)
- Container runtime: Apple Container (Linux VMs on macOS vnet `192.168.64.0/24`)
- Knowledge vaults: local filesystem
- qmd: installed globally, collections pointed at vault directories

### Railway (Cloud)

- Single container deployment via `Dockerfile.railway`
- No Docker-in-Docker — agents run as child processes (`src/railway-runner.ts`)
- Knowledge vaults synced from **Cloudflare R2** via `rclone`:
  - On startup: `rclone sync` pulls both vaults from R2
  - Background loop (every 5 minutes): pulls from R2, reindexes with qmd
  - After writes: Brain Router calls reindex, rclone syncs back to R2
- Railway persistent volume at `/data` for vault storage between deploys

### Config Constants (`src/config.ts`)

```typescript
export const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
export const RAILWAY_DATA_DIR = '/data';

export const PUBLIC_KNOWLEDGE_DIR =
  process.env.NANOCLAW_PUBLIC_KNOWLEDGE_DIR ||
  (IS_RAILWAY ? '/data/public-knowledge' : path.join(HOME_DIR, 'development', 'nanoclaw-knowledge'));

export const SECOND_BRAIN_DIR =
  process.env.NANOCLAW_SECOND_BRAIN_DIR ||
  (IS_RAILWAY ? '/data/second-brain' : '');
```

### Railway Entrypoint (`docker-entrypoint-railway.sh`)

The entrypoint script:
1. Configures rclone with R2 credentials from environment variables
2. Syncs public-knowledge and second-brain vaults from R2
3. Initializes qmd collections and builds embeddings
4. Starts a background sync loop (pull from R2 every 5 minutes + reindex)
5. Launches the Node.js host process

---

## 8. Brain Router & Knowledge System

For detailed documentation on the Brain Router, Public Knowledge repository, and Second Brain vault (architecture, vault conventions, property schemas, Bases, templates, workflows), see [`docs/BRAIN-ROUTER-AND-KNOWLEDGE.md`](BRAIN-ROUTER-AND-KNOWLEDGE.md).

---

## 9. Skills System

NanoClaw uses Claude Code skills (`.claude/skills/`) for setup and customization. Skills are prompts that guide Claude Code to transform the codebase.

| Skill | Purpose |
|-------|---------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/add-whatsapp` | Add WhatsApp channel |
| `/add-telegram` | Add Telegram channel |
| `/add-discord` | Add Discord channel |
| `/add-slack` | Add Slack channel |
| `/add-gmail` | Add Gmail integration |
| `/add-knowledge` | Add public knowledge repository |
| `/convert-to-apple-container` | Switch from Docker to Apple Container |
| `/update-nanoclaw` | Bring upstream updates into customized install |

### Container Skills

Inside containers, agents have access to skill prompts at `/app/container/skills/`:

| Skill | Purpose |
|-------|---------|
| `public-knowledge/SKILL.md` | Vault conventions, frontmatter schema, entity resolution, search patterns |
| `second-brain/SKILL.md` | Same as public-knowledge but for personal vault |
| `agent-browser/SKILL.md` | Browser automation tool documentation |

---

## 10. Channel System

Channels self-register at startup via a factory pattern (`src/channels/registry.ts`). Missing credentials = channel skipped with a WARN log.

### Channel JID Format

| Channel | JID Format | Example |
|---------|-----------|---------|
| Discord | `dc:{channel_id}` | `dc:1234567890123456` |
| Telegram | `tg:{chat_id}` | `tg:-1001234567890` |
| WhatsApp | `{phone}@s.whatsapp.net` | `1234567890@s.whatsapp.net` |
| Slack | `sl:{channel_id}` | `sl:C1234567890` |

### Group Folder Naming

| Type | Pattern | Example |
|------|---------|---------|
| Main group | `main` | `main` |
| Project groups | `project:{slug}` | `project:saas-mvp` |
| Discord utility | `discord_{name}` | `discord_one-off` |
| Telegram | `telegram_{name}` | `telegram_home` |
| WhatsApp | `whatsapp_{name}` | `whatsapp_family` |

---

## 11. Database Schema

SQLite database at `store/messages.db`. Key tables:

- **messages** — All messages across all channels (id, chat_jid, sender, content, timestamp)
- **chats** — Registered groups (jid, folder, name, trigger, requiresTrigger, isMain, containerConfig)
- **scheduled_tasks** — Task scheduler entries (cron/interval/once schedules, group context)
- **sessions** — Agent session metadata (group, last active, token counts)
- **task_runs** — History of scheduled task executions

---

## 12. Apple Container Specifics (Current Local Runtime)

This install uses Apple Container (not Docker). Key differences:

- `CONTAINER_HOST_GATEWAY` resolves to `192.168.64.1` (not `host.docker.internal`)
- `PROXY_BIND_HOST` binds to `192.168.64.1` (not `127.0.0.1`)
- No host-side `/dev/null` bind mount (VirtioFS can't mount character devices)
- `.env` shadow handled inside container entrypoint via `mount --bind /dev/null`

After upstream merges, always verify these haven't been reverted.

---

## 13. Development Commands

```bash
npm run dev          # Run with hot reload (tsx watch)
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container image

# macOS service management (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart
```

---

## 14. Design Philosophy

From `docs/REQUIREMENTS.md`:

- **Small enough to understand** — One Node.js process, handful of source files, no microservices
- **Security through true isolation** — OS-level container isolation, not application-level permissions
- **Built for one user** — Working software for specific needs, not a framework
- **Customization = code changes** — No configuration sprawl; modify the code directly
- **AI-native development** — Assumes Claude Code is always available for setup, debugging, monitoring
- **Skills over features** — Contributors add skills that transform the codebase, not monolithic features
