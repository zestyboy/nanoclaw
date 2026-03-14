# Brain Router System

A project routing layer on top of NanoClaw that turns a single messaging interface (WhatsApp/Telegram) into a multi-project command center with Discord as the project workspace.

## What It Does

You message your assistant from WhatsApp or Telegram with something like:

> "for my-project: analyze competitor pricing"

The Brain Router — a Claude agent running in the **main group** — reads the message, classifies it to the right project, and dispatches it to that project's dedicated Discord channel where a separate, isolated agent picks it up and does the work.

Think of it as a receptionist that sits in front of all your projects. You talk to one assistant, and it routes your requests to specialized workspaces.

### Core Concepts

**Main Group** — The single entry point. This is your WhatsApp or Telegram chat registered with `isMain: true`. Every message here reaches the Brain Router agent without needing a trigger word. The Brain Router's personality and behavior are defined entirely in `groups/main/CLAUDE.md`.

**Projects** — Each project gets:
- A dedicated Discord text channel (auto-created by the system)
- An isolated group folder with its own `CLAUDE.md` and `notes.md`
- A registered group entry so NanoClaw routes messages from that Discord channel to a container agent
- An entry in `groups/main/projects.yaml` with metadata (name, slug, type, brief, aliases, discord_channel_id)

**Routing** — The Brain Router classifies every incoming message against `projects.yaml` using:
1. Explicit mentions ("for my-project:" or "in marketing:")
2. Alias matching (keywords from the project's aliases list)
3. Semantic matching (message content relates to the project's brief)
4. Recent context (tiebreaker for ambiguous messages)

**Two Intents:**
- **CATALOG** (default) — Information, notes, ideas. The router writes a timestamped entry to the project's `notes.md` directly.
- **EXECUTE** — Work to be done. The router calls `execute_in_group` to dispatch the task to the project's agent container.

**One-Off Channel** — An optional `discord_one-off` group for ad-hoc tasks that don't belong to any project. It has no routing logic — just answers directly.

### Message Flow

```
User (WhatsApp/Telegram)
  │
  ▼
Main Group (isMain=true, no trigger needed)
  │
  ▼
Brain Router agent reads projects.yaml
  │
  ├─ CATALOG → writes notes.md in project folder
  │            confirms: "Cataloged in **Project Name** → <#channel_id>"
  │
  └─ EXECUTE → calls execute_in_group(target_group_folder, prompt)
               │
               ▼
          IPC file written → Host picks it up
               │
               ▼
          Synthetic message inserted into target group's chat
               │
               ▼
          Target group's container spawns
               │
               ▼
          Project agent does the work, responds in Discord channel
```

### Disambiguation

When the user prefixes a message with `?`, the router lists ALL matching projects and asks the user to choose (with clickable Discord channel links). This is for when the user isn't sure where something belongs.

### Project Creation

When no project matches, the router proposes creating a new one. The `create_project` MCP tool handles everything atomically:
1. Creates the Discord text channel (in a configured category)
2. Registers the group with NanoClaw
3. Creates the group folder with CLAUDE.md (from templates) and notes.md
4. Adds the entry to projects.yaml

---

## Implementation Guide

This section explains how to implement the Brain Router on a fresh NanoClaw fork. It separates what NanoClaw already provides from what you need to build.

### What NanoClaw Already Provides

These features exist in the upstream repo and should NOT be reimplemented:

- **IPC watcher** (`src/ipc.ts`) — Polls per-group IPC directories for task files. Handles `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, `register_group`, `refresh_groups`.
- **MCP tools** (`container/agent-runner/src/ipc-mcp-stdio.ts`) — `send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, `register_group`.
- **Container runner** (`src/container-runner.ts`) — Spawns isolated containers per group with per-group folder mounts, IPC mounts, `.claude/` session directories, global memory mount.
- **Group folder system** (`src/group-folder.ts`) — Folder validation, path resolution, IPC path resolution.
- **Channel registry** (`src/channels/registry.ts`) — Self-registration pattern for channel plugins.
- **Message loop** (`src/index.ts`) — Polls for messages, deduplicates, routes to GroupQueue.
- **Group queue** (`src/group-queue.ts`) — Manages concurrent container execution.
- **Database** (`src/db.ts`) — SQLite for messages, chats, sessions, registered groups, scheduled tasks.
- **Global memory** (`groups/global/CLAUDE.md`) — Shared read-only memory for all non-main groups.

### What You Need to Build

The Brain Router adds these capabilities on top of NanoClaw:

#### 1. Add Discord Channel

Run `/add-discord` to install the Discord channel skill. This handles:
- Creating `src/channels/discord.ts` with the discord.js integration
- Adding `DISCORD_BOT_TOKEN` to `.env`
- Registering the channel in `src/channels/index.ts`

You still need to manually:
1. Create a Discord bot at the Discord Developer Portal
2. Enable Gateway Intents: **Server Members**, **Message Content**
3. Invite the bot to your server with permissions: Send Messages, Read Messages, **Manage Channels** (needed for auto-creating project channels)
4. Get your **Guild ID** (right-click server name → Copy Server ID in Discord with Developer Mode on)
5. Optionally get a **Category ID** (right-click a channel category → Copy Channel ID) to organize project channels under
6. Add to `.env`:
   ```
   DISCORD_GUILD_ID=your_guild_id
   DISCORD_PROJECT_CATEGORY_ID=your_category_id
   ```

#### 2. Add `project:` Prefix Support to Group Folders

NanoClaw's standard `src/group-folder.ts` only handles flat folder names like `discord_general` or `whatsapp_family`. The Brain Router uses a `project:{slug}` naming convention where project folders live in a separate directory (`PROJECTS_DIR`) rather than inside `groups/`.

Modify `src/group-folder.ts`:

- Add a `PROJECTS_DIR` config value (defaults to `~/development/nanoclaw-projects`)
- Add a `project:` prefix constant
- Add `isProjectFolder(folder)` and `projectSlug(folder)` helpers
- Update `isValidGroupFolder()` to accept `project:{slug}` format (validate the slug part with a pattern like `/^[a-z0-9][a-z0-9-]{0,63}$/`)
- Update `resolveGroupFolderPath()` to resolve `project:{slug}` to `PROJECTS_DIR/{slug}` instead of `GROUPS_DIR/{folder}`
- Update `folderToFsName()` to convert `project:foo` to `project_foo` for filesystem-safe session/IPC directory names

Add the `PROJECTS_DIR` config to `src/config.ts`:
```typescript
export const PROJECTS_DIR = process.env.NANOCLAW_PROJECTS_DIR
  || path.join(HOME_DIR, 'development', 'nanoclaw-projects');
```

#### 3. Add Container Mounts for Main Group

The main group needs two additional writable mounts that standard NanoClaw doesn't provide. Modify the `buildVolumeMounts()` function in `src/container-runner.ts`:

**`/workspace/all-groups`** — Writable access to the entire `groups/` directory. This lets the main agent do cross-group file operations (like writing templates into project folders).

**`/workspace/projects`** — Writable access to `PROJECTS_DIR`. This is where the Brain Router writes catalog notes (`notes.md` files) for each project.

Add these mounts inside the `if (isMain)` block:
```typescript
// Main gets writable access to all group folders
mounts.push({
  hostPath: path.join(projectRoot, 'groups'),
  containerPath: '/workspace/all-groups',
  readonly: false,
});

// Main gets writable access to projects dir for cataloging
if (fs.existsSync(PROJECTS_DIR)) {
  mounts.push({
    hostPath: PROJECTS_DIR,
    containerPath: '/workspace/projects',
    readonly: false,
  });
}
```

#### 4. Add `execute_in_group` IPC Handler and MCP Tool

This is the core routing mechanism. When the Brain Router wants to dispatch work to a project, it calls `execute_in_group`.

**MCP tool** (in `container/agent-runner/src/ipc-mcp-stdio.ts`):
- Parameters: `target_group_folder` (string), `prompt` (string)
- Main-only: returns error if `isMain` is false
- Writes an IPC task file with `type: 'execute_in_group'`

**IPC handler** (in `src/ipc.ts`, add a new `case 'execute_in_group'`):
- Authorization: reject if source is not main group
- Look up the target group's JID by matching `target_group_folder` against registered groups
- Insert a synthetic message into the database:
  ```typescript
  storeMessage({
    id: `router-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: targetJid,
    sender: 'router',
    sender_name: 'Router',
    content: data.prompt,
    timestamp: new Date().toISOString(),
    is_from_me: true,
  });
  ```
- Enqueue the target group for processing: `deps.enqueueMessageCheck(targetJid)`

#### 5. Add `create_project` IPC Handler and MCP Tool

This automates project bootstrapping — creating the Discord channel, registering the group, setting up files, and updating the project registry.

**MCP tool** (in `container/agent-runner/src/ipc-mcp-stdio.ts`):
- Parameters: `name` (string), `slug` (string), `type` (enum: code/planning/research/general), `brief` (string), `aliases` (comma-separated string)
- Main-only
- Writes an IPC task file with `type: 'create_project'`

**IPC handler** (in `src/ipc.ts`, add a new `case 'create_project'`):
1. Read `DISCORD_GUILD_ID` and `DISCORD_PROJECT_CATEGORY_ID` from env
2. Call `deps.createDiscordChannel(slug)` to create a text channel in the guild (under the category if configured)
3. Construct the JID: `dc:{channelId}`
4. Construct the folder: `project:{slug}`
5. Register the group via `deps.registerGroup(jid, { name, folder, trigger: '@Router', requiresTrigger: false, ... })`
6. Create the project directory at the resolved path (via `resolveGroupFolderPath(folder)`)
7. Load a CLAUDE.md template from `groups/main/templates/` based on project type, replacing `{PROJECT_NAME}`, `{BRIEF}`, `{SLUG}` placeholders. Fall back to a minimal template if none exists.
8. Write `CLAUDE.md` and an empty `notes.md` to the project directory
9. Read the existing `groups/main/projects.yaml`, append the new project entry, write it back
10. Send a confirmation message to the main group: `"Project {name} created → <#{channelId}>"`

**IpcDeps interface** — Add `createDiscordChannel?: (name: string) => Promise<string | null>` to the `IpcDeps` interface.

**Wiring in `src/index.ts`** — When starting the IPC watcher, pass a `createDiscordChannel` callback that calls the Discord channel's `createTextChannel(guildId, name, categoryId)` method. The Discord channel class needs a `createTextChannel` method that calls `guild.channels.create({ name, type: ChannelType.GuildText, parent: categoryId })`.

#### 6. Create the Main Group CLAUDE.md (Brain Router Prompt)

Replace `groups/main/CLAUDE.md` with the Brain Router instructions. This is the entire "brain" — it's a prompt, not code.

```markdown
# Brain Router

You are Brain Router, a project routing assistant. Your job is to triage
incoming messages to the right project and either catalog information or
trigger execution.

**MANDATORY: To create new projects, you MUST call the
`mcp__nanoclaw__create_project` MCP tool. Do NOT create project folders
or files manually — only the tool can create Discord channels and
register groups with the host process.**

## On Every Message

1. Read `/workspace/group/projects.yaml` to get the current project list
2. Classify the message to the best-matching project using name, aliases,
   and brief
3. Determine intent: CATALOG (default) or EXECUTE

## Routing Logic

Match incoming messages against projects:
- Explicit project mention ("for project-name:" or "in alias:") → direct match
- Alias match: keywords match a project's aliases
- Semantic match: message content relates to a project's brief
- Recent context: if ambiguous and no `?` prefix, prefer the most recently
  routed project

**`?` prefix — force disambiguation:** When a message starts with `?`,
the user is TELLING you they don't know which project it belongs to. You
MUST:
1. Strip the `?` prefix
2. Re-read projects.yaml
3. List EVERY project that could even loosely relate to the message
4. Ask the user to pick one — show each option with its channel link
5. Do NOT auto-route. Do NOT say "clear match." The `?` means "I need
   help deciding."
6. Ignore conversation history, prior notes, and prior handling completely.

Confidence handling:
- **Clear match:** Route immediately. Confirm with a clickable channel link.
- **Ambiguous (2-3 matches), no `?` prefix:** Use recent context as
  tiebreaker. If still ambiguous, ask.
- **Ambiguous with `?` prefix:** ALWAYS ask. Say: "This could go in **A**
  or **B**. Which one?" Include channel links for each. Never auto-pick.
- **No match:** Propose new project. If user confirms, use
  `mcp__nanoclaw__create_project` to create it automatically (Discord
  channel, group registration, folder, CLAUDE.md, everything). Then
  catalog/execute to the new project.

## Intent Detection

- **CATALOG** (default): User is sharing information, ideas, notes, context.
  - Signals: informational statements, "catalog", "note", "remember",
    "add to", or no action verb
- **EXECUTE**: User wants work done.
  - Signals: "execute", "work on", "build", "do", "create", "write",
    "analyze", "run"

## Catalog Mode

Write a timestamped entry to `/workspace/projects/{slug}/notes.md`
(where `slug` is the project's slug from projects.yaml):

    [YYYY-MM-DD HH:MM]

    [User's message, cleaned up and organized]

Create the file if it doesn't exist. Adapt format to project type:
- Code: technical specs, requirements, implementation notes
- Planning: timeline, decisions, contacts, costs
- Research: sources, findings, analysis

After cataloging, confirm with a channel link:
"Cataloged in **[project-name]** → <#DISCORD_CHANNEL_ID>"

## Execute Mode

Use `mcp__nanoclaw__execute_in_group`:
- target_group_folder: project's folder from projects.yaml
- prompt: execution task with full context

After dispatching:
"Executing in **[project-name]** → <#DISCORD_CHANNEL_ID>"

IMPORTANT: Always use `<#channel_id>` format for Discord channel links —
Discord renders these as clickable links. Get the channel_id from the
project's discord_channel_id field in projects.yaml.

## New Project Creation

CRITICAL: You MUST use `mcp__nanoclaw__create_project` to create
projects. NEVER create project folders, CLAUDE.md files, or
projects.yaml entries manually. The `create_project` tool is the ONLY
way to create Discord channels — manual file creation skips channel
creation and breaks routing.

When no match found and user confirms (or provides "new project: ..."
details):

1. Extract or ask for: name, type (code/planning/research/general),
   brief description
2. If code project, ask for host repo path
3. Generate a slug from the name (lowercase, hyphens, no special chars)
4. Generate relevant aliases from the name and brief
5. Call `mcp__nanoclaw__create_project` with all the details
6. The tool handles everything: Discord channel, group registration,
   folder, CLAUDE.md, projects.yaml
7. Re-read projects.yaml to pick up the new entry
8. Then catalog or execute the original message to the new project

## Status Queries

- "status of [project]": Read project's notes.md, summarize, include
  channel link
- "what am I working on?": Scan projects, summarize recent activity
  with channel links
- "list projects": Formatted list with channel links

## Rules

- Re-read projects.yaml every interaction. Stay stateless.
- Keep responses concise — mobile-first interface.
- ALWAYS include clickable channel links (<#channel_id>) when
  referencing a project.
- When uncertain, ask. Don't guess.
- Default to catalog. Only execute when explicitly asked.
- Never hold important state in conversation. Write to files.
- NEVER create projects manually. Always use
  `mcp__nanoclaw__create_project`.

## Admin Commands

- "new project: [description]" → create new project
- "archive [project]" → mark archived in projects.yaml
- "move [item] to [project]" → re-route content
- "rename [project] to [name]" → update projects.yaml
```

#### 7. Create Project Templates

Create `groups/main/templates/` with two files. The `create_project` handler loads these and replaces `{PROJECT_NAME}`, `{BRIEF}`, and `{SLUG}` placeholders.

**`groups/main/templates/general-project-claude.md`:**
```markdown
# {PROJECT_NAME}

You are an assistant helping with {PROJECT_NAME}: {BRIEF}

## Workspace

- Project directory: `/workspace/group/` — all project files and notes
  live here
- Notes: `/workspace/group/notes.md` — read for context, update after work

## What You Can Do

- Organize plans and timelines
- Research topics and summarize findings
- Draft documents and communications
- Track decisions and action items
- Manage structured data (contacts, costs, resources)

## Communication

- Keep Discord responses concise
- Use `mcp__nanoclaw__send_message` for progress updates on longer tasks
- Use `<internal>` tags for reasoning not meant for the user
```

**`groups/main/templates/code-project-claude.md`:**
```markdown
# {PROJECT_NAME}

You are an assistant working on {PROJECT_NAME}: {BRIEF}

## Workspace

- Project directory: `/workspace/group/` — all project files and notes
  live here
- Notes: `/workspace/group/notes.md` — always read before starting work

## Workflow

1. Read `notes.md` for context before starting any task
2. Do the work
3. Update `notes.md` after completing work with what was done

## Communication

- Keep Discord responses concise
- Use `mcp__nanoclaw__send_message` for progress updates on longer tasks
- Use `<internal>` tags for reasoning not meant for the user

## Capabilities

- Run bash commands in sandbox
- Read and write files in workspace
- Search the web and fetch URLs
- Browse the web with `agent-browser`
```

#### 8. Initialize projects.yaml

Create an empty `groups/main/projects.yaml`:
```yaml
[]
```

This file is auto-maintained by the `create_project` IPC handler. Each entry gets this structure:
```yaml
- name: Project Display Name
  slug: project-slug
  type: code          # code | planning | research | general
  brief: One-line description
  aliases:
    - keyword1
    - keyword2
  folder: "project:project-slug"
  discord_channel_id: "1234567890123456"
  created_at: "2026-03-09T00:00:00.000Z"
```

#### 9. Create the Projects Directory

```bash
mkdir -p ~/development/nanoclaw-projects
```

Or set `NANOCLAW_PROJECTS_DIR` in `.env` for a custom path.

#### 10. (Optional) Create a One-Off Discord Channel

For ad-hoc tasks that don't belong to any project:

1. Create a `#one-off` text channel in your Discord server
2. Register it via the main agent: tell it to register the group with JID `dc:{channel_id}`, folder `discord_one-off`, and trigger `@{ASSISTANT_NAME}`
3. Create `groups/discord_one-off/CLAUDE.md`:

```markdown
# One-Off Assistant

You are a general-purpose assistant in a Discord channel. Handle any
ad-hoc task: answer questions, do research, draft messages, summarize
content, write code, brainstorm ideas, or anything else asked of you.

You are NOT a router. Do not triage or forward messages. Just answer
directly.

## Tools

- **Web search**: Use WebSearch and WebFetch
- **Bash**: Run shell commands
- **Files**: Read and write files in your workspace
- **Browser**: Run `agent-browser open <url>` then
  `agent-browser snapshot -i`
- **Progress updates**: Use `mcp__nanoclaw__send_message` for interim
  updates

## Style

- Keep responses concise — this is Discord
- Use markdown formatting
- For code, use fenced code blocks with language tags
- Skip preamble — lead with the answer

## Memory

The `conversations/` folder has searchable history from past sessions.
```

#### 11. Build, Rebuild Container, and Start

```bash
npm run build
./container/build.sh
npm run dev
```

### Verification

1. Send a message to your main chat: "new project: Test Project, type: general, brief: testing the brain router"
2. The Brain Router should call `create_project`, which creates a `#test-project` Discord channel, creates the project folder with CLAUDE.md and notes.md, adds an entry to projects.yaml, and confirms with a clickable channel link
3. Send "for test-project: remember that the sky is blue" — should catalog to notes.md and confirm
4. Send "for test-project: what color is the sky?" — should dispatch to the project agent via `execute_in_group`, and the agent responds in the `#test-project` Discord channel

---

## Architecture Reference

### Security Model

- **Per-group isolation**: Each project agent runs in its own container with access only to its own group folder
- **Main-only privileges**: Only the main group can create projects, register groups, or execute in other groups
- **IPC identity**: Source group identity is determined by the IPC directory path (filesystem-enforced), not by user input
- **Read-only codebase**: Main group mounts the NanoClaw project root read-only to prevent sandbox escape

### Container Mounts

**Main group container:**
| Mount | Container Path | Access |
|-------|---------------|--------|
| NanoClaw project root | `/workspace/project` | Read-only |
| `groups/main/` | `/workspace/group` | Read-write |
| `groups/` (all groups) | `/workspace/all-groups` | Read-write |
| Projects directory | `/workspace/projects` | Read-write |
| Per-group IPC | `/workspace/ipc` | Read-write |

**Project group container:**
| Mount | Container Path | Access |
|-------|---------------|--------|
| Project folder | `/workspace/group` | Read-write |
| `groups/global/` | `/workspace/global` | Read-only |
| Per-group IPC | `/workspace/ipc` | Read-write |

### Group Folder Naming

- Main group: `main`
- Project groups: `project:{slug}` (e.g., `project:my-saas`)
- Discord utility channels: `discord_{name}` (e.g., `discord_one-off`)
- Telegram groups: `telegram_{name}`
- WhatsApp groups: `whatsapp_{name}`

### JID Format

Each channel uses a prefix for JIDs:
- Discord: `dc:{channel_id}`
- Telegram: `tg:{chat_id}`
- WhatsApp: `{phone}@s.whatsapp.net` or `{group_id}@g.us`

### How execute_in_group Works Internally

1. Brain Router agent calls `mcp__nanoclaw__execute_in_group(target_group_folder, prompt)`
2. Agent writes IPC file to `/workspace/ipc/tasks/{timestamp}.json`
3. Host IPC watcher picks it up within 1 second
4. Host verifies the source is the main group (authorized)
5. Host looks up the target group's JID from registered groups
6. Host inserts a synthetic message with `sender: 'router'` into the database
7. Host enqueues the target group for processing via `GroupQueue`
8. GroupQueue spawns a container for the target group
9. Target agent processes the message and responds in its Discord channel

### Dependencies

The only npm dependency added beyond standard NanoClaw is `discord.js` (installed by `/add-discord`). The `yaml` package is already a NanoClaw dependency and is used for reading/writing `projects.yaml`.

### Summary of Code Changes

| File | Change |
|------|--------|
| `src/config.ts` | Add `PROJECTS_DIR` constant |
| `src/group-folder.ts` | Add `project:` prefix handling, `isProjectFolder()`, `projectSlug()`, resolve project paths to `PROJECTS_DIR` |
| `src/container-runner.ts` | Add `/workspace/all-groups` and `/workspace/projects` mounts for main group |
| `src/ipc.ts` | Add `execute_in_group` and `create_project` case handlers; add `createDiscordChannel` to `IpcDeps` |
| `src/index.ts` | Wire `createDiscordChannel` callback to IPC deps |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `execute_in_group` and `create_project` MCP tools |
| `groups/main/CLAUDE.md` | Brain Router prompt (new file content) |
| `groups/main/templates/*.md` | Project CLAUDE.md templates (new files) |
| `groups/main/projects.yaml` | Project registry (new file, auto-maintained) |
