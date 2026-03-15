# Second Brain Build Guide

> Instructions for the agent building the Second Brain integration. Read `SYSTEM-OVERVIEW.md` first for full system context.

---

## Goal

Migrate Niven's Notion "Ultimate Brain v3.0" personal productivity system into an Obsidian vault that:

1. Lives on **Cloudflare R2** as the source of truth
2. Syncs to Railway deployment via `rclone` (already wired — see `docker-entrypoint-railway.sh`)
3. Has a **local dummy vault** (with fake data) for development and testing
4. Is searchable via **qmd** (lexical + vector + hybrid search)
5. Is accessible to the **Brain Router** (read-write) and project agents (read-only)

---

## What Already Exists

The NanoClaw codebase already has Second Brain support wired in. You are building the **vault contents**, not the plumbing.

### Already implemented:

| Component | File | Status |
|-----------|------|--------|
| `SECOND_BRAIN_DIR` config | `src/config.ts` | Done — defaults to `/data/second-brain` on Railway, empty locally |
| Container mounts | `src/container-runner.ts` | Done — main=rw, others=ro |
| `search_second_brain` MCP tool | `container/agent-runner/src/ipc-mcp-stdio.ts` | Done |
| `reindex_second_brain` MCP tool | `container/agent-runner/src/ipc-mcp-stdio.ts` | Done |
| `search_second_brain` IPC handler | `src/ipc.ts` | Done |
| `reindex_second_brain` IPC handler | `src/ipc.ts` | Done |
| Second Brain vault skill | `container/skills/second-brain/SKILL.md` | Done |
| Brain Router SECOND_BRAIN intent | `groups/main/CLAUDE.md` | Done |
| Railway R2 sync | `docker-entrypoint-railway.sh` | Done (syncs `second-brain` bucket) |
| Railway Dockerfile | `Dockerfile.railway` | Done (includes rclone, qmd) |

### What you need to build:

1. **The actual Obsidian vault** on R2 — migrated from Notion export
2. **A local dummy vault** — fake data matching the same structure, for testing
3. **Obsidian Bases** (`.base` files) — the database views
4. **Templates** — note creation templates
5. **Homepage** — the central MOC

---

## Architecture: Where the Vault Lives

```
Cloudflare R2 (source of truth)
  └── second-brain bucket
       ├── 00 Inbox/
       ├── 01 Tasks/
       ├── 02 Notes/
       ├── 03 Projects/
       ├── 04 Tags/
       ├── 05 Goals/
       ├── 06 Milestones/
       ├── 07 People/
       ├── 09 Books/
       ├── Bases/
       ├── Templates/
       ├── Attachments/
       ├── Dashboards/
       └── Home.md
            │
    ┌───────┴───────────────────────┐
    │                               │
    ▼                               ▼
Railway (/data/second-brain)    Local dummy (~/.../second-brain-dev)
  rclone sync every 5 min          Fake data, same structure
  qmd collection: second-brain     qmd collection: second-brain
  Agents read/write here            For local dev/testing
```

### R2 Bucket Setup

The R2 bucket needs these environment variables (Railway dashboard or `.env`):

```
R2_ACCOUNT_ID=<cloudflare account id>
R2_ACCESS_KEY_ID=<r2 api token key id>
R2_SECRET_ACCESS_KEY=<r2 api token secret>
R2_SECOND_BRAIN_BUCKET=second-brain
```

The `docker-entrypoint-railway.sh` already handles:
- Configuring rclone with these credentials
- Initial sync on startup: `rclone sync r2:${R2_SECOND_BRAIN_BUCKET} /data/second-brain`
- Background sync loop every 5 minutes
- qmd collection initialization and reindexing

### Local Dummy Vault

Set `NANOCLAW_SECOND_BRAIN_DIR` in `.env` to point to the dummy vault:

```
NANOCLAW_SECOND_BRAIN_DIR=~/development/second-brain-dev
```

The dummy vault has the same folder structure, Bases, and Templates as the real vault, but with fake content for testing.

---

## Vault Structure

The Second Brain maps the Notion Ultimate Brain's 8 core collections into an Obsidian vault using `kind` frontmatter properties and Bases for views.

### Folder Layout

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
├── 08 Work Sessions/       # Time tracking (kind: work-session) — optional
├── 09 Books/               # Book notes (kind: book)
├── 10 Recipes/             # Recipe notes (kind: recipe) — optional
├── Bases/                  # All .base files (database views)
├── Templates/              # Note creation templates
├── Attachments/            # Images, PDFs, etc.
├── Dashboards/             # My Day, GTD Process, My Week, Archive
└── Home.md                 # Central homepage MOC
```

**Key principle:** Folders are for human browsability only. Bases filter by the `kind` frontmatter property, not by folder location.

### The `kind` Property

Every note has a `kind` property that identifies which collection it belongs to:

| Kind | Notion Collection | Folder |
|------|------------------|--------|
| `task` | Tasks | `01 Tasks/` |
| `note` | Notes | `02 Notes/` |
| `project` | Projects | `03 Projects/` |
| `tag` | Tags | `04 Tags/` |
| `goal` | Goals | `05 Goals/` |
| `milestone` | Milestones | `06 Milestones/` |
| `person` | People | `07 People/` |
| `work-session` | Work Sessions | `08 Work Sessions/` |
| `book` | Books | `09 Books/` |
| `recipe` | Recipes | `10 Recipes/` |

### Property Naming Convention

- All property names: `snake_case`
- All `kind` values: lowercase
- Status values: Title Case (`To Do`, `Doing`, `Done`)
- Priority values: include code (`Critical (P1)`, `High (P2)`, etc.)
- Dates: `YYYY-MM-DD`
- Links/relations: `"[[Note Name]]"` format with quotes in YAML
- Lists: YAML arrays `["[[A]]", "[[B]]"]`

---

## Bases (Database Views)

Each collection gets a `.base` file in the `Bases/` folder. These are YAML files that define filters, formulas, properties, and views.

See the full Base specifications in `/Users/niven/development/notion-analysis/obsidian-migration-plan.md` (Phase 2), which defines:

- **tasks.base** — 11 views (All Tasks, Inbox, My Day, Do Next, Calendar, Delegated, Deferred, Someday, Today, This Week, Completed, Project Tasks)
- **notes.base** — 9 views (All Notes, Inbox, Favorites, Recents, Journal, Web Clips, By Type, Tag Notes, Project Notes)
- **projects.base** — 8 views (Active, Ongoing, Planned, On Hold, Done, All Projects, Project Board, Archive)
- **tags.base** — 5 views (Areas, Resources, Entities, All Tags, Area Dashboard)
- **goals.base** — 5 views (Active Goals, Dreams, Achieved, All Goals, Goal Detail)
- **milestones.base** — 1 view
- **people.base** — 4 views (All People, Check-ins Due, By Relationship, Person Detail)
- **books.base** — 5 views (Library, Currently Reading, Want to Read, Read, All Books)
- **recipes.base** — 3 views

### Critical Pattern: Embedded Views with `this file`

Bases can be embedded in notes using `![[my-base.base#view-name]]`. When embedded, a `this file` filter dynamically scopes results. This is how contextual dashboards work:

- Open a Project note → embedded `![[tasks.base#Project Tasks]]` shows only that project's tasks
- Open an Area tag → embedded `![[notes.base#Tag Notes]]` shows only that area's notes

### Important: Validate Base Syntax First

The exact `.base` YAML schema should be validated by creating a minimal test file first. Create `Bases/rollup-test.base`, open it in Obsidian, and confirm the syntax works before building all bases.

---

## Templates

See `/Users/niven/development/notion-analysis/obsidian-migration-plan.md` (Phase 3) for the 11 template files:

1. `task.md` — Task with GTD properties
2. `note.md` — Basic note
3. `journal.md` — Daily journal with Plan/Journal/Review sections
4. `meeting.md` — Meeting notes with Attendees/Agenda/Notes/Action Items
5. `project.md` — Project with embedded task and note views
6. `area.md` — Area tag with embedded projects, tasks, notes, people, goals views
7. `resource.md` — Resource tag with embedded notes and web clips views
8. `goal.md` — Goal with embedded milestones and projects views
9. `person.md` — Person with embedded meeting notes, projects, tasks
10. `book.md` — Book with notes and highlights sections
11. `weekly-review.md` — Weekly review with Clear & Reset / Reflect / Plan sections

---

## The Dummy Vault (For Local Testing)

Create a dummy vault at `~/development/second-brain-dev/` with the same structure but fake data. Include enough variety to test all Base views and embedded views:

### Minimum fake data:

**Tasks (5-10):**
- 2 in inbox (no project, no smart_list)
- 1 flagged for My Day
- 1 with due date today
- 1 delegated (smart_list: Delegated)
- 1 deferred (snooze date in future)
- 1 someday (smart_list: Someday)
- 1 completed (status: Done)
- 1 with a parent_task relation (sub-task)

**Notes (5-8):**
- 1 in inbox (no tag, no project)
- 1 journal entry
- 1 meeting note
- 1 web clip (with URL)
- 1 favorited note
- 1 tagged with an Area

**Projects (4-5):**
- 1 Active (status: Doing), with tasks and notes linked
- 1 Ongoing
- 1 Planned
- 1 Done
- 1 Archived

**Tags (3-4):**
- 2 Areas (e.g., "Work", "Health")
- 1 Resource under an Area (e.g., "Fitness" with parent_tag: "[[Health]]")
- 1 Entity

**Goals (2):**
- 1 Active with milestones
- 1 Dream

**Milestones (2-3):**
- Linked to the active goal, 1 completed and 1 pending

**People (2):**
- With relationship, company, and linked notes

**Books (2):**
- 1 Currently Reading, 1 Want to Read

This gives enough data to verify:
- All Base views filter correctly
- Embedded views with `this file` scope properly
- Formulas compute (progress, overdue, days_until_due)
- The homepage renders all sections
- qmd search returns results

### Initialize qmd for the dummy vault:

```bash
qmd collection add ~/development/second-brain-dev --name second-brain
qmd embed
```

---

## How the Brain Router Interacts with the Second Brain

When a user messages the Brain Router with Second Brain intent:

### Storing

```
User: "save to second brain: I want to start running 3x/week. Goal is to run a half marathon by December."

Brain Router:
1. Detects SECOND_BRAIN intent (signal: "save to second brain")
2. Entity resolution: "running" / "half marathon" → personal goal → root of vault
3. Lists /workspace/second-brain/ for existing files
4. Searches qmd: lex search for "running" and "half marathon"
5. No match → creates new note

Writes /workspace/second-brain/Half marathon goal.md:
---
created: 2026-03-14
type: note
category:
  - fitness
  - goals
tags:
  - running
  - health
related:
  - "[[Health]]"
---

# Half marathon goal

Target: run a half marathon by December 2026.
Plan: build up to running 3x/week.

6. Calls reindex_second_brain (fire-and-forget)
7. Responds: "Saved to Second Brain → Half marathon goal (root)"
```

### Searching

```
User: "search second brain for my fitness goals"

Brain Router:
1. Detects SECOND_BRAIN search intent
2. Calls search_second_brain with:
   - lex: "fitness goals"
   - vec: "what are my personal fitness and health goals"
3. Returns results
4. Summarizes: "Found 2 notes: Half marathon goal, Weekly workout plan"
```

### Injecting into Execute

```
User: "for health-tracker: build the dashboard, pull from my second brain about fitness goals"

Brain Router:
1. Detects EXECUTE + SECOND_BRAIN search
2. Searches second brain for fitness-related notes
3. Prepends results to the execute prompt
4. Dispatches to health-tracker project agent
```

---

## Migration Workflow

### Phase 1: Build the vault structure + Bases + Templates

This is the main agent work — creating the Obsidian vault that will live on R2. Follow the 8-phase plan in `obsidian-migration-plan.md`.

### Phase 2: Populate the dummy vault

Create fake data matching the structure above. This is for local development testing.

### Phase 3: Import real Notion data into the vault

The user exports from Notion (HTML format), uses Obsidian Importer plugin, then the agent audits and normalizes the imported data per Phase 1 of the migration plan.

### Phase 4: Upload to R2

```bash
# Create the R2 bucket (via wrangler or Cloudflare dashboard)
# Then sync the vault up
rclone sync ~/path/to/second-brain r2:second-brain
```

### Phase 5: Verify end-to-end

1. Local: Set `NANOCLAW_SECOND_BRAIN_DIR` to dummy vault, run `npm run dev`, test Brain Router search/store
2. Railway: Deploy, verify R2 sync, test Brain Router through messaging channel

---

## Reference Documents

| Document | Location | What It Contains |
|----------|----------|-----------------|
| System Overview | `docs/SYSTEM-OVERVIEW.md` | Full NanoClaw architecture and purpose |
| Second Brain Analysis | `/Users/niven/development/notion-analysis/second-brain-analysis-new.md` | Platform-agnostic blueprint of the Ultimate Brain system — all 8 collections, properties, relationships, workflows, dashboards |
| Obsidian Migration Plan | `/Users/niven/development/notion-analysis/obsidian-migration-plan.md` | Step-by-step agent implementation plan — Base specifications, templates, folder structure, plugin configs |
| Knowledge Repo Plan | `docs/KNOWLEDGE-REPO.md` | Public knowledge vault implementation (same patterns apply to second brain) |
| Brain Router Guide | `docs/BRAIN-ROUTER.md` | How the Brain Router works — routing, intents, project creation |
| Second Brain Skill | `container/skills/second-brain/SKILL.md` | Vault conventions taught to container agents |
| Brain Router Prompt | `groups/main/CLAUDE.md` | The actual Brain Router prompt with SECOND_BRAIN intent handling |
