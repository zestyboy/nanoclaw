# NanoClaw System Overview

> Complete reference for the NanoClaw system: architecture, Brain Router, knowledge vaults, Second Brain, deployment, and conventions.

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

## 3. Brain Router

The Brain Router is a Claude agent running in the **main group** — the user's primary messaging channel (WhatsApp or Telegram). Its behavior is defined entirely in `groups/main/CLAUDE.md`. It receives every message without a trigger word and acts as an intelligent triage layer.

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
  ├─ CATALOG → writes timestamped entry to project's notes.md
  │            confirms: "Cataloged in **Project Name** → <#channel_id>"
  │
  ├─ EXECUTE → calls execute_in_group(target_group_folder, prompt)
  │            project agent picks up work in its Discord channel
  │
  ├─ PUBLIC_KNOWLEDGE → stores/searches work knowledge vault
  │
  └─ SECOND_BRAIN → stores/searches personal knowledge vault
```

### Intent Detection

Every incoming message is classified into one of four intents:

| Intent | Trigger Signals | What Happens |
|--------|----------------|-------------|
| **CATALOG** (default) | Informational statements, "note", "remember" | Writes timestamped entry to project's `notes.md` |
| **EXECUTE** | "build", "do", "create", "analyze", "run" | Dispatches work to project agent via IPC |
| **PUBLIC_KNOWLEDGE** | "save to knowledge", "search knowledge", "what do I know about" | Stores/retrieves from public knowledge vault |
| **SECOND_BRAIN** | "save to second brain", "search second brain", "personal note" | Stores/retrieves from personal vault |

Slash prefixes (`/catalog`, `/execute`, `/knowledge`, `/second-brain`, `/ask`) override signal-word heuristics for deterministic routing.

### Project Routing

1. User sends a message
2. Brain Router reads `projects.yaml` (stateless — re-reads every time)
3. Matches message to a project via: explicit mention → alias match → semantic match → recent context
4. If no match: proposes creating a new project

**Confidence handling:**
- **Clear match:** Route immediately, confirm with clickable channel link
- **Ambiguous (2-3 matches), no `?` prefix:** Use recent context as tiebreaker; if still ambiguous, ask
- **`?` prefix (force disambiguation):** Always list all matching projects and ask the user to pick
- **No match:** Propose new project; if confirmed, use `create_project` MCP tool

### Project Creation

The `create_project` MCP tool handles everything atomically:
1. Creates a Discord text channel (in a configured category)
2. Registers the group with NanoClaw
3. Creates the group folder with CLAUDE.md (from templates) and notes.md
4. Adds the entry to projects.yaml

Projects are never created manually — always through the tool.

### Projects Registry

`groups/main/projects.yaml` — auto-maintained by the system:

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

### Catalog Mode

Writes a timestamped entry to `/workspace/projects/{slug}/notes.md`. Format adapts to project type:
- Code: technical specs, requirements, implementation notes
- Planning: timeline, decisions, contacts, costs
- Research: sources, findings, analysis

### Execute Mode

Uses `mcp__nanoclaw__execute_in_group`:
1. Brain Router writes IPC task file
2. Host verifies source is main group
3. Host inserts synthetic message into target group's chat
4. Target group's container spawns and processes the work
5. Project agent responds in its Discord channel

---

## 4. Public Knowledge Repository

A searchable Obsidian vault for work-related knowledge. Information is ingested via the Brain Router's messaging interface and organized following [Kepano's vault methodology](https://stephango.com/vault). Search is powered by [qmd](https://github.com/tobi/qmd).

### Paths

| Environment | Path | Source |
|-------------|------|--------|
| Local (macOS) | `~/development/nanoclaw-knowledge` | Filesystem (configurable via `NANOCLAW_PUBLIC_KNOWLEDGE_DIR`) |
| Railway | `/data/public-knowledge` | Synced from Cloudflare R2 |

**Access:** Brain Router = read-write, all other agents = read-only.

### Vault Structure

```
~/knowledge/
  .obsidian/              # Obsidian config
  Attachments/            # Images, PDFs, media
  Categories/             # Topic overview notes (hub notes linking everything in a category)
  Clippings/              # Content written by others (articles, research, reports)
  References/             # External entities: companies, products, people, tools
  Templates/              # Obsidian templates (evolve organically — see Template Evolution)

  # Root-level notes (your own synthesized knowledge)
  Pricing strategy.md
  Market positioning Q2 2026.md
```

### Folder Placement Rules

| Content Type | Folder | Example |
|-------------|--------|---------|
| Your own synthesis, analysis, decisions | Root | `Mid-market pricing convergence.md` |
| External entities (companies, people, products, competitors) | `References/` | `References/Acme Corp.md` |
| Someone else's content (articles, reports, docs) | `Clippings/` | `Clippings/State of SaaS Pricing 2026.md` |
| Hub notes that link to everything in a topic | `Categories/` | `Categories/Competitor Analysis.md` |
| Non-markdown files | `Attachments/` | `Attachments/chart.png` |

### Frontmatter Schema

Every note has YAML frontmatter:

```yaml
---
created: 2026-03-13
type: reference              # reference | clipping | note | category
category:                    # plural, always (e.g., competitors, products)
  - competitors
tags:
  - pricing
  - saas
author: Niven                # or source author for clippings
source: https://...          # URL for clippings
aliases:                     # name variants for entity resolution
  - ACME
  - Acme Corporation
related:                     # wikilinks to connected notes
  - "[[Product roadmap]]"
  - "[[Competitor A]]"
---
```

### Entity Resolution

The Brain Router is stateless between sessions. Without explicit lookup, "Acme Corp" on Monday and "Acme" on Thursday would create duplicate notes. The mandatory lookup-before-write process:

1. **Extract the entity/topic name** from the user's message
2. **List files in the target directory** for filename matches
3. **Search qmd** with a lex query for the entity name (catches notes where the entity is mentioned but the filename differs)
4. **Match with tolerance:** case-insensitive, ignore corporate suffixes (Corp, Inc, Ltd), treat partial names as potential matches
5. **Decide:**
   - **Clear match** → read existing file, append/update
   - **Ambiguous** (multiple candidates) → ask the user which note to update
   - **No match** → create new note, add name variants as aliases in frontmatter

### Template Evolution

Vaults start with no custom templates — just defaults from the [kepano-obsidian](https://github.com/kepano/kepano-obsidian) template. Templates emerge from actual usage:

1. **Track structure during ingestion.** The Brain Router reads `Templates/` and scans recent notes of the same type for recurring patterns
2. **Detect patterns.** After 3+ notes of the same type share a recurring structure (similar sections, same frontmatter fields), the Brain Router proposes a template
3. **Propose, don't act.** Describes the proposed template and waits for confirmation — never creates templates silently
4. **Refine over time.** When usage patterns drift, the Brain Router may suggest updating existing templates

### Conventions

- Link profusely — even unresolved `[[wikilinks]]` are valuable breadcrumbs for future notes
- Pluralize categories and tags (`competitors` not `competitor`)
- YYYY-MM-DD format for all dates
- Follow [obsidian-markdown](https://github.com/kepano/obsidian-skills) conventions for formatting

---

## 5. Second Brain (Personal Knowledge Vault)

A personal Obsidian vault migrated from Thomas Frank's "Ultimate Brain v3.0" Notion system. It combines PARA (organizational taxonomy), GTD (task processing workflow), and Daily Planning (execution rhythm). Lives on Railway with R2 as backup.

### Architecture

```
Railway /data/second-brain (working copy)
  ├── NanoClaw agents read/write here
  ├── qmd indexes for search (lexical + vector)
  └── Backs up to R2 every 12 hours
        │
        ▼
Cloudflare R2: second-brain bucket (backup)
  └── Restores to Railway only if volume is empty
```

**Access:** Brain Router = read-write, all other agents = read-only.

### Vault Structure

```
second-brain/
├── .obsidian/              # Obsidian settings and plugin configs
├── 00 Inbox/               # Landing zone for new captures
├── 01 Tasks/               # All task notes (kind: task)
├── 02 Notes/               # All note-type notes (kind: note)
├── 03 Projects/            # All project notes (kind: project)
├── 04 Tags/                # All tag notes — Areas, Resources, Entities (kind: tag)
├── 05 Goals/               # Goal notes (kind: goal)
├── 06 Milestones/          # Milestone notes (kind: milestone)
├── 07 People/              # People/CRM notes (kind: person)
├── 08 Work Sessions/       # Time tracking (kind: work-session)
├── 09 Books/               # Book notes (kind: book)
├── 10 Recipes/             # Recipe notes (kind: recipe)
├── Bases/                  # All .base files (database views)
├── Templates/              # Note creation templates
├── Attachments/            # Images, PDFs, etc.
├── Dashboards/             # My Day, GTD Process, My Week, Archive
└── Home.md                 # Central homepage MOC with embedded views
```

**Key principle:** Folders are for human browsability only. Bases filter by the `kind` frontmatter property, not by folder location.

### The `kind` Property

Every note has a `kind` property identifying its collection:

| Kind | Collection | Folder |
|------|-----------|--------|
| `task` | Tasks | `01 Tasks/` |
| `note` | Notes | `02 Notes/` |
| `project` | Projects | `03 Projects/` |
| `tag` | Tags (Areas, Resources, Entities) | `04 Tags/` |
| `goal` | Goals | `05 Goals/` |
| `milestone` | Milestones | `06 Milestones/` |
| `person` | People | `07 People/` |
| `work-session` | Work Sessions | `08 Work Sessions/` |
| `book` | Books | `09 Books/` |
| `recipe` | Recipes | `10 Recipes/` |

### Property Naming Conventions

- All property names: `snake_case`
- All `kind` values: lowercase
- Status values: Title Case (`To Do`, `Doing`, `Done`)
- Priority values: include code (`Critical (P1)`, `High (P2)`, `Medium (P3)`, `Low (P4)`)
- Dates: `YYYY-MM-DD`
- Relations/links: `"[[Note Name]]"` format with quotes in YAML
- Lists: YAML arrays `["[[A]]", "[[B]]"]`

### Property Reference

#### Tasks

| Property | Type | Description |
|----------|------|-------------|
| `kind` | text | Always `task` |
| `status` | text | `To Do`, `Doing`, `Done` |
| `priority` | text | `Critical (P1)`, `High (P2)`, `Medium (P3)`, `Low (P4)` |
| `due` | date | Due date |
| `start_date` | date | When to start |
| `snooze` | date | Deferred until this date |
| `wait_date` | date | Waiting on someone until this date |
| `smart_list` | text | GTD bucket: `Do Next`, `Delegated`, `Someday` |
| `my_day` | boolean | Flagged for today's focus |
| `project` | link | `"[[Project Name]]"` |
| `tag` | link/list | Area/Resource/Entity tag(s) |
| `people` | list | `["[[Person]]"]` |
| `contexts` | list | Energy/location contexts |
| `energy` | text | `High`, `Low` |
| `parent_task` | link | Sub-task relationship |
| `labels` | list | Additional labels |
| `archived` | boolean | Soft-deleted |

#### Notes

| Property | Type | Description |
|----------|------|-------------|
| `kind` | text | Always `note` |
| `note_type` | text | `Journal`, `Meeting`, `Web Clip`, `Reference`, `Idea`, `Plan`, `Voice Note` |
| `tag` | link/list | Area/Resource/Entity tag(s) |
| `project` | link | Associated project |
| `people` | list | Related people |
| `favorite` | boolean | Starred |
| `url` | text | Source URL for web clips |
| `archived` | boolean | Soft-deleted |

#### Projects

| Property | Type | Description |
|----------|------|-------------|
| `kind` | text | Always `project` |
| `status` | text | `Planned`, `On Hold`, `Doing`, `Ongoing`, `Done` |
| `project_type` | text | Project category |
| `priority` | text | Same scale as tasks |
| `target_deadline` | date | Target completion |
| `completed` | date | Actual completion date |
| `tag` | link/list | Area/Resource tag(s) |
| `goal` | link | Associated goal |
| `people` | list | Team members |
| `parent_project` | link | Parent project for sub-projects |
| `archived` | boolean | Soft-deleted |

#### Tags (Areas, Resources, Entities)

| Property | Type | Description |
|----------|------|-------------|
| `kind` | text | Always `tag` |
| `tag_type` | text | `area`, `resource`, `entity` |
| `parent_tag` | link | Hierarchical parent (Resources nest under Areas) |
| `archived` | boolean | Soft-deleted |

**Tag type meanings:**
- **Area**: A sphere of responsibility (e.g., Health, Finance, Career) — ongoing, never "done"
- **Resource**: A topic or theme nested under an Area (e.g., Fitness under Health)
- **Entity**: An external entity (company, product, concept) worth tracking

#### Goals

| Property | Type | Description |
|----------|------|-------------|
| `kind` | text | Always `goal` |
| `status` | text | `Dream`, `Active`, `Achieved` |
| `goal_set` | text | Grouping for related goals |
| `target_deadline` | date | Target date |
| `achieved` | date | Completion date |
| `tag` | link | Associated Area |
| `archived` | boolean | Soft-deleted |

#### People

| Property | Type | Description |
|----------|------|-------------|
| `kind` | text | Always `person` |
| `surname` | text | Last name (for sorting) |
| `company` | text | Organization |
| `title_role` | text | Job title |
| `email` | text | Email address |
| `phone` | text | Phone number |
| `birthday` | date | Birthday |
| `location` | text | City/region |
| `relationship` | list | `Family`, `Friend`, `Colleague`, `Client`, `Business Partner` |
| `interests` | list | Topics of interest |
| `check_in` | date | Next check-in due |
| `last_check_in` | date | Last check-in date |
| `archived` | boolean | Soft-deleted |

#### Books

| Property | Type | Description |
|----------|------|-------------|
| `kind` | text | Always `book` |
| `author` | text | Book author |
| `status` | text | `Want to Read`, `Currently Reading`, `Read` |
| `rating` | number | 1-5 rating |
| `pages` | number | Page count |
| `isbn` | text | ISBN |
| `publish_year` | number | Year published |
| `genres` | list | Genre tags |
| `cover` | text | Cover image path |
| `archived` | boolean | Soft-deleted |

### Bases (Database Views)

Each collection has a `.base` file in the `Bases/` folder — YAML files that define filters, formulas, properties, and views.

#### tasks.base — 11 views

| View | Filter | Sort |
|------|--------|------|
| All Tasks | `status != "Done" && !archived` | `due` asc, `priority` asc |
| Inbox | No project, no smart_list, no due date | `file.ctime` desc |
| My Day | `my_day == true` | `status` asc, `priority` asc |
| Do Next | `smart_list == "Do Next"` | `contexts` asc, `priority` asc |
| Calendar | Has due date | `due` asc |
| Delegated | `smart_list == "Delegated"` | `wait_date` asc |
| Deferred | `snooze > today()` | `snooze` asc |
| Someday | `smart_list == "Someday"` | `priority` asc |
| Today | `due <= today()` | `priority` asc |
| This Week | `due <= today() + 7d` | `due` asc |
| Completed | `status == "Done"` | `completed` desc |
| Project Tasks | `project` contains `this file` | `status` asc, `priority` asc |

#### notes.base — 9 views

| View | Filter | Sort |
|------|--------|------|
| All Notes | `!archived` | `file.mtime` desc |
| Inbox | No tag, no project | `file.ctime` desc |
| Favorites | `favorite == true` | `file.mtime` desc |
| Recents | (none, limit 25) | `file.mtime` desc |
| Journal | `note_type == "Journal"` | `file.ctime` desc |
| Web Clips | Has URL | `file.ctime` desc |
| By Type | (group by `note_type`) | `file.mtime` desc |
| Tag Notes | `tag` contains `this file` | `file.mtime` desc |
| Project Notes | `project` contains `this file` | `file.mtime` desc |

#### projects.base — 8 views

| View | Filter | Sort |
|------|--------|------|
| Active | `status == "Doing" && !archived` | `priority` asc |
| Ongoing | `status == "Ongoing" && !archived` | `tag` asc |
| Planned | `status == "Planned" && !archived` | `target_deadline` asc |
| On Hold | `status == "On Hold" && !archived` | `file.mtime` desc |
| Done | `status == "Done"` | `completed` desc |
| All Projects | `!archived` | `status` asc, `priority` asc |
| Project Board | Cards, `!archived` | `priority` asc |
| Archive | `archived == true` | `file.mtime` desc |

**Formula properties:**
- `task_count` — counts inlinks with `kind == "task"`
- `done_tasks` — counts done tasks
- `progress` — `(done_tasks / task_count * 100)%`
- `overdue_tasks` — tasks with `due < today()` and `status != "Done"`

#### tags.base — 5 views

| View | Filter | Sort |
|------|--------|------|
| Areas | `tag_type == "area"` | name asc |
| Resources | `tag_type == "resource"` | name asc |
| Entities | `tag_type == "entity"` | name asc |
| All Tags | (none) | `tag_type` asc, name asc |
| Area Dashboard | `tag_type == "area"` contains `this file` | — |

**Formula properties:** `note_count`, `project_count` (via inlinks)

#### goals.base — 5 views

Active Goals, Dreams, Achieved, All Goals, Goal Detail. Formula properties: `milestone_count`, `done_milestones`, `progress`.

#### Other bases

- **milestones.base** — 1 view (All Milestones, sorted by `target_deadline`)
- **people.base** — 4 views (All People, Check-ins Due, By Relationship, Person Detail)
- **books.base** — 5 views (Library cards, Currently Reading, Want to Read, Read, All Books)
- **recipes.base** — 3 views (All Recipes, By Tag, Quick Meals)

### Embedded Views with `this file`

Bases can be embedded in notes using `![[my-base.base#view-name]]`. When embedded, a `this file` filter dynamically scopes results:

- Open a **Project** note → embedded `![[tasks.base#Project Tasks]]` shows only that project's tasks
- Open an **Area** tag → embedded `![[notes.base#Tag Notes]]` shows only that area's notes
- Open a **Goal** → embedded `![[milestones.base]]` shows that goal's milestones

This is how contextual dashboards work — items live in one canonical location and are surfaced contextually through embedded views.

### Templates

11 template files in `Templates/`:

| Template | Kind | Key Sections |
|----------|------|-------------|
| `task.md` | task | GTD properties (status, priority, smart_list, my_day, contexts) |
| `note.md` | note | Basic note with tag/project links |
| `journal.md` | note (Journal) | Plan / Journal / Review sections |
| `meeting.md` | note (Meeting) | Attendees / Agenda / Notes / Action Items |
| `project.md` | project | Overview + embedded task and note views |
| `area.md` | tag (area) | Embedded projects, tasks, notes, people, goals views |
| `resource.md` | tag (resource) | Embedded notes and web clips views |
| `goal.md` | goal | Embedded milestones and projects views |
| `person.md` | person | Embedded meeting notes, projects, tasks + Gift Ideas |
| `book.md` | book | Notes / Highlights sections |
| `weekly-review.md` | note (Week Journal) | Clear & Reset / Reflect / Plan sections |

### Dashboards

4 dashboard pages in `Dashboards/`:

- **My Day** — Plan (Today, Overdue, Inbox, Do Next) → Execute (My Day view) → Wrap Up
- **Process (GTD)** — Inbox, Do Next, Calendar, Delegated, Deferred, Someday
- **My Week** — Weekly review with embedded Journal and This Week views
- **Archive** — Completed/archived items across all collections

### Key Workflows

**My Day (daily planning):**
1. Review Today and Overdue views
2. Flag tasks for today (`my_day: true`)
3. Execute throughout the day
4. Clear all `my_day` flags at end of day

**My Week (weekly review):**
1. Clear & Reset: process inboxes, review overdue tasks, review projects and areas
2. Reflect: review journal entries, note wins and lessons
3. Plan: set priorities, review upcoming deadlines

**GTD Pipeline:**
Inbox → Clarify → Organize into smart lists (Do Next / Calendar / Delegated / Deferred / Someday) → Execute

**Goal Hierarchy:**
Goal → Milestone → Project → Task (strict chain, no shortcuts)

### Design Principles

- **Single source of truth:** Items live in one place, surfaced via filtered views in many places
- **Archive, never delete:** Set `archived: true` instead of deleting
- **Contextual views over folder hierarchies:** Bases + embedded views replace navigating folders
- **Progressive complexity:** Advanced features (Work Sessions, Recipes) are optional

---

## 6. Search (qmd)

Both vaults are searchable via [qmd](https://github.com/tobi/qmd), which provides three search types:

| Type | Use For | Speed |
|------|---------|-------|
| `lex` | Exact terms, names, identifiers | Fast (~200-500ms) |
| `vec` | Natural language semantic questions | Slower (~1-3s, uses embeddings) |
| `hyde` | Hypothetical answer text | Slower |

**Search flow:** Agent calls MCP tool → IPC task file → host runs `qmd query ... --json` → results returned to agent.

**Reindexing:** After writing, Brain Router calls `reindex_*` which spawns `qmd update && qmd embed` as a detached background process (fire-and-forget). On Railway, the reindex also triggers an rclone sync back to R2.

### MCP Tools

| Tool | Available To | Collection |
|------|-------------|-----------|
| `search_public_knowledge` | Any group | `public-knowledge` |
| `search_second_brain` | Any group | `second-brain` |
| `reindex_public_knowledge` | Main only | `public-knowledge` |
| `reindex_second_brain` | Main only | `second-brain` |

### Search Examples

```json
// Keyword search
{ "searches": [{ "type": "lex", "query": "competitor pricing" }], "limit": 5 }

// Hybrid search (best recall)
{
  "searches": [
    { "type": "lex", "query": "competitor pricing" },
    { "type": "vec", "query": "what pricing strategies are competitors using" }
  ],
  "limit": 5
}

// With disambiguation
{
  "searches": [{ "type": "lex", "query": "API access pricing" }],
  "intent": "competitor pricing for API features",
  "limit": 5
}
```

---

## 7. Container Isolation & Security

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

| Host Path | Container Path | Access |
|-----------|---------------|--------|
| NanoClaw project root | `/workspace/project` | Read-only |
| `groups/main/` | `/workspace/group` | Read-write |
| `groups/` (all groups) | `/workspace/all-groups` | Read-write |
| Projects directory | `/workspace/projects` | Read-write |
| Public knowledge vault | `/workspace/public-knowledge` | Read-write |
| Second brain vault | `/workspace/second-brain` | Read-write |
| Per-group IPC | `/workspace/ipc` | Read-write |

**Non-main groups (project agents):**

| Host Path | Container Path | Access |
|-----------|---------------|--------|
| Own group folder | `/workspace/group` | Read-write |
| `groups/global/` | `/workspace/global` | Read-only |
| Public knowledge vault | `/workspace/public-knowledge` | Read-only |
| Second brain vault | `/workspace/second-brain` | Read-only |
| Per-group IPC | `/workspace/ipc` | Read-write |

---

## 8. IPC System

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

## 9. Deployment

### Local (macOS)

- Runs as a launchd service (`~/Library/LaunchAgents/com.nanoclaw.plist`)
- Container runtime: Apple Container (Linux VMs on macOS vnet `192.168.64.0/24`)
- Knowledge vaults: local filesystem
- qmd: installed globally, collections pointed at vault directories

### Railway (Cloud)

- Single container deployment via `Dockerfile.railway`
- No Docker-in-Docker — agents run as child processes (`src/railway-runner.ts`)
- Knowledge vaults synced from **Cloudflare R2** via `rclone`:
  - On startup: restore from R2 if volume is empty
  - Background loop: Railway → R2 backup every 12 hours
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
4. Starts a background sync loop (backup to R2 every 12 hours + reindex)
5. Launches the Node.js host process

### Apple Container Specifics (Current Local Runtime)

This install uses Apple Container (not Docker). Key differences:

- `CONTAINER_HOST_GATEWAY` resolves to `192.168.64.1` (not `host.docker.internal`)
- `PROXY_BIND_HOST` binds to `192.168.64.1` (not `127.0.0.1`)
- No host-side `/dev/null` bind mount (VirtioFS can't mount character devices)
- `.env` shadow handled inside container entrypoint via `mount --bind /dev/null`

After upstream merges, always verify these haven't been reverted.

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

## 12. Skills System

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

## 13. Key Files Reference

| File | Purpose |
|------|---------|
| `groups/main/CLAUDE.md` | Brain Router prompt (all routing, intent detection, vault interaction logic) |
| `groups/main/projects.yaml` | Project registry (auto-maintained) |
| `groups/main/templates/` | Project CLAUDE.md templates (general-project, code-project) |
| `container/skills/public-knowledge/SKILL.md` | Public knowledge vault conventions for agents |
| `container/skills/second-brain/SKILL.md` | Second Brain vault conventions for agents |
| `docker-entrypoint-railway.sh` | Railway startup: R2 sync, qmd indexing, backup loop |
| `scripts/notion-to-obsidian.ts` | Custom Notion HTML → Obsidian converter |

---

## 14. Development Commands

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

## 15. Design Philosophy

From `docs/REQUIREMENTS.md`:

- **Small enough to understand** — One Node.js process, handful of source files, no microservices
- **Security through true isolation** — OS-level container isolation, not application-level permissions
- **Built for one user** — Working software for specific needs, not a framework
- **Customization = code changes** — No configuration sprawl; modify the code directly
- **AI-native development** — Assumes Claude Code is always available for setup, debugging, monitoring
- **Skills over features** — Contributors add skills that transform the codebase, not monolithic features

---

## 16. Remaining Work

### Multi-Device Sync (Not Yet Implemented)

The Second Brain vault currently lives only on Railway and R2 (backup). There is no device sync. The planned approach:

- **Web access:** Run [Silver Bullet](https://github.com/silverbulletmd/silverbullet) as a Railway service sharing the `/data` volume, exposed via Tailscale. View and edit vault from any browser without storing files locally.
- **Phone sync:** Run [Syncthing](https://syncthing.net/) as a Railway service for real-time bidirectional file sync to Obsidian mobile on phone. Explicit peer config (no auto-discovery — Railway doesn't support UDP). Conflict resolution: keep both versions with `.sync-conflict-*` suffix.

Implementation order: Silver Bullet first (immediate value), Syncthing second (when needed).

### Notion Import Cleanup (Low Priority)

The Notion import converter (`scripts/notion-to-obsidian.ts`) successfully processed ~1,050 pages. Minor remaining issues:

- **Misclassified folders:** `Genres` and `Keywords` defaulted to `kind: note` but likely belong as `kind: tag` in `04 Tags/`. `Meal Planner` should be inspected before reclassifying.
- **15 unresolved image refs** in Notes — left unchanged, low priority
- **0 milestones** imported (likely none existed in the Notion workspace)

To re-run the import if needed: export from Notion (HTML), upload zip to R2, redeploy the `notion-import` Railway service.

### Public Knowledge Vault Setup (Not Yet Populated)

The public knowledge integration code is implemented (IPC handlers, MCP tools, Brain Router intent, container mounts) but the vault at `~/development/nanoclaw-knowledge` may not yet have significant content. The `/add-knowledge` setup skill handles initialization (clone kepano-obsidian template, install qmd, wire NanoClaw integration).
