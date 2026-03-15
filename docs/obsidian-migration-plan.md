# Obsidian Migration Plan: Ultimate Brain v3.0

> A step-by-step implementation plan for recreating the Notion Ultimate Brain v3.0 system in Obsidian, based on [second-brain-analysis.md](./second-brain-analysis.md). Designed to be executed by an AI agent, with manual steps clearly marked for the user.

---

## Prerequisites (User Must Do)

These steps require the Obsidian GUI or Notion web app and cannot be done by an agent.

### Step 1: Export from Notion

1. Open your Notion workspace in a browser
2. Go to **Settings & Members → Settings → Export all workspace content**
3. Choose **HTML** format (not Markdown — the Importer plugin handles HTML better, preserving relations as links)
4. Include subpages: **Yes**
5. Download the `.zip` file
6. Unzip it to a known location (e.g., `~/Downloads/notion-export/`)

### Step 2: Create the Obsidian Vault

1. Open Obsidian
2. Click **Create new vault**
3. Name it (e.g., `Second Brain`) and choose a location
4. This is where all your migrated data will live

### Step 3: Enable Core Plugins

In Obsidian → Settings → Core plugins, enable:
- [x] **Bases** (critical — this is the backbone)
- [x] **Daily notes**
- [x] **Templates** (we'll use this alongside Templater)
- [x] **Tags**
- [x] **Outgoing links**
- [x] **Backlinks**
- [x] **Page preview**
- [x] **Format converter** (for post-import property cleanup)

### Step 4: Install Community Plugins

In Obsidian → Settings → Community plugins → Browse, install and enable these:

| Plugin | Downloads | Purpose in This System |
|--------|-----------|----------------------|
| **Templater** | ~3.9M | Advanced templates with variables, JS, auto-triggers. Powers note creation workflows |
| **Tasks** | ~3.2M | Recurring tasks, due dates, done dates, priorities, task queries. Supplements Bases for task-specific features |
| **QuickAdd** | ~1.7M | One-click capture macros for tasks, notes, journal entries from anywhere |
| **Calendar** | ~2.4M | Sidebar calendar for daily note navigation |
| **Periodic Notes** | ~609K | Weekly/monthly/yearly notes for My Week review cycle |
| **Homepage** | ~1.0M | Sets a note as the vault's start page (our MOC homepage) |
| **Metadata Menu** | ~249K | Typed property fields (select, date, boolean) with dropdown menus — makes editing frontmatter feel like Notion |
| **Tag Wrangler** | ~907K | Rename/merge tags in bulk — essential for post-import cleanup |
| **Linter** | ~834K | Auto-format markdown files for consistency after import |
| **Book Search** | ~204K | Google Books lookup to auto-populate book note metadata |
| **Iconize** | ~1.9M | File/folder icons to visually replicate Notion's page icons |
| **Kanban** | ~2.2M | Board views for project status tracking (until Bases gets native kanban) |

**Not needed** (because Bases replaces them):
- ~~Dataview~~ — Bases handles 80%+ of views natively with better UX. Only install later if you hit a formula limitation.
- ~~DB Folder~~ — Archived/removed from community plugins.
- ~~Projects~~ — Maintainer stepped down. Bases + embedded views covers this.

### Step 5: Run the Import

1. In Obsidian, open Command Palette (Cmd+P) → **Importer: Import data**
2. Select **Notion** as the source
3. Point it to your unzipped export folder
4. Choose import options:
   - Import attachments: **Yes**
   - Destination folder: **Import** (we'll reorganize after)
5. Click **Import** and wait for completion
6. Review the import log for any errors

### Step 6: Hand Off to Agent

Once the import is complete and all plugins are installed, the agent takes over. Point the agent at:
- This plan (`obsidian-migration-plan.md`)
- The system analysis (`second-brain-analysis.md`)
- The vault path (wherever you created it)

---

## Agent Implementation Plan

Everything below can be executed by an agent working in the vault directory. The vault contains imported Notion data as markdown files with YAML frontmatter.

---

### Phase 1: Audit & Normalize Imported Data

**Goal:** Ensure all imported notes have clean, consistent frontmatter that Bases can query.

#### 1.1 Inventory the Import

- Scan the `Import/` folder structure
- Catalog all unique frontmatter property names across all files
- Identify the 8 collection types by folder structure or properties (Tasks, Notes, Projects, Tags, Goals, Milestones, People, Work Sessions)
- Report: how many files per collection, which properties are present/missing

#### 1.2 Add `kind` Property

Every note needs a `kind` property identifying which collection it belongs to. This is the primary filter for Bases.

- Files from the Tasks database → `kind: task`
- Files from the Notes database → `kind: note`
- Files from the Projects database → `kind: project`
- Files from the Tags database → `kind: tag`
- Files from the Goals database → `kind: goal`
- Files from the Milestones database → `kind: milestone`
- Files from the People database → `kind: person`
- Files from the Work Sessions database → `kind: work-session`
- Files from Books → `kind: book`
- Files from Recipes → `kind: recipe`

Detection strategy: Use folder names from the Notion export (each database exports as a folder), or look for characteristic properties (e.g., files with `due` + `status` + `smart_list` are Tasks).

#### 1.3 Normalize Property Names

The Notion Importer may produce inconsistent property names. Standardize to snake_case:

| Notion Property | Obsidian Frontmatter Key | Type |
|----------------|--------------------------|------|
| Name/Title | `title` (use filename) | — |
| Status | `status` | text |
| Priority | `priority` | text |
| Due | `due` | date |
| Start Date | `start_date` | date |
| Snooze | `snooze` | date |
| Wait Date | `wait_date` | date |
| Smart List | `smart_list` | text |
| My Day | `my_day` | boolean |
| Project | `project` | link (`"[[Project Name]]"`) |
| Tag | `tag` | link or list of links |
| Parent Tag | `parent_tag` | link |
| Goal | `goal` | link |
| People | `people` | list of links |
| Archived | `archived` | boolean |
| Favorite | `favorite` | boolean |
| Type (on Notes) | `note_type` | text |
| Type (on Tags) | `tag_type` | text (area/resource/entity) |
| Target Deadline | `target_deadline` | date |
| Completed | `completed` | date |
| Recur Interval | `recur_interval` | number |
| Recur Unit | `recur_unit` | text |
| Enforce Schedule | `enforce_schedule` | boolean |
| URL | `url` | text |
| Image / Cover | `cover` | text |
| Parent Task | `parent_task` | link |
| Sub-Projects | `sub_projects` | list of links |
| Parent Project | `parent_project` | link |
| Contexts | `contexts` | list |
| Energy | `energy` | text |
| Labels | `labels` | list |
| Project Type | `project_type` | text |

Write a script or use direct file edits to rename all frontmatter keys consistently across all files.

#### 1.4 Normalize Relations to Wikilinks

Ensure all relation properties are `[[wikilinks]]` format, not plain strings. The Importer usually handles this, but verify:
- `project: "[[My Project]]"` ✓
- `project: "My Project"` ✗ → fix to wikilink
- `people: ["[[John Doe]]", "[[Jane Smith]]"]` ✓ for lists

#### 1.5 Reorganize Folder Structure

Move files from the flat `Import/` dump into a clean structure:

```
/
├── 00 Inbox/              ← landing zone for new captures
├── 01 Tasks/              ← all task notes
├── 02 Notes/              ← all note-type notes
├── 03 Projects/           ← all project notes
├── 04 Tags/               ← all tag notes (Areas, Resources, Entities)
├── 05 Goals/              ← goal notes
├── 06 Milestones/         ← milestone notes
├── 07 People/             ← people/CRM notes
├── 08 Work Sessions/      ← time tracking entries
├── 09 Books/              ← book notes
├── 10 Recipes/            ← recipe notes
├── Bases/                 ← all .base files
├── Templates/             ← all template files
├── Attachments/           ← images, PDFs, etc.
└── Home.md                ← the homepage MOC
```

**Important:** Folder structure is for human browsability only. Bases filter by the `kind` property, not by folder. But having folders helps with template auto-triggers and keeps the file explorer manageable.

After moving files, verify all `[[wikilinks]]` still resolve (Obsidian auto-updates links on rename/move, but the agent should verify).

#### 1.6 Compute Derived Properties

Add properties that Notion computed but Obsidian needs pre-populated (or that Bases formulas will handle):

- `root_area`: For notes tagged with a Resource, resolve the chain Note → Resource tag → parent_tag to find the root Area. Store as a wikilink in frontmatter. This enables Area dashboards to show notes filed under child Resources.
  - Only needed if the Bases formula `note.tag.asFile().properties.parent_tag` proves unreliable in testing. Test first (see Phase 2.1).

---

### Phase 2: Build the 8 Core Bases

**Goal:** Create `.base` files that replicate each Notion database's views.

Each `.base` file lives in the `Bases/` folder. Bases use YAML syntax with filters, formulas, properties, and views.

#### 2.0 Validate Rollup Chain (Do This First)

Before building all bases, create a test base that validates the rollup-through-relations pattern:

1. Create `Bases/rollup-test.base` with a simple table view
2. Filter: `kind == "note"`
3. Add a formula property: `root_area = note.tag.asFile().properties.parent_tag`
4. Also test the guarded version: `root_area = if(note.tag.asFile().hasProperty("parent_tag"), note.tag.asFile().properties.parent_tag, "")`
5. Also test with list tags: `root_areas = note.tag.map(value.asFile().properties.parent_tag).unique()`
6. Verify results against known data (e.g., a note tagged "Fitness" should show "Health" as root_area if Fitness has `parent_tag: "[[Health]]"`)

If the chain works → use formulas in Bases for rollups (no pre-computation needed).
If the chain fails → fall back to pre-computing `root_area` in frontmatter during Phase 1.6.

#### 2.1 Tasks Base (`Bases/tasks.base`)

**All-views filter:** `kind == "task" && status != "Done" && archived != true`

**Views:**

| View Name | Layout | View-specific Filter | Sort | Properties Shown |
|-----------|--------|---------------------|------|-----------------|
| All Tasks | Table | — | `due` asc, `priority` asc | status, priority, project, due, smart_list, contexts, my_day |
| Inbox | Table | `project` is empty AND `smart_list` is empty AND `due` is empty | `file.ctime` desc | status, priority, due |
| My Day | Table | `my_day == true` | `status` asc, `priority` asc | status, priority, project, due |
| Do Next | Table | `smart_list == "Do Next"` | `contexts` asc, `priority` asc | status, priority, project, contexts, energy |
| Calendar | Table | `due` is not empty | `due` asc | status, priority, project, due |
| Delegated | Table | `smart_list == "Delegated"` | `wait_date` asc | status, project, people, wait_date |
| Deferred | Table | `snooze` is not empty AND `snooze > today()` | `snooze` asc | status, project, snooze |
| Someday | Table | `smart_list == "Someday"` | `priority` asc | status, priority, project |
| Today | Table | `due <= today()` | `priority` asc | status, priority, project, due |
| This Week | Table | `due <= today() + duration("7d")` | `due` asc | status, priority, project, due |
| Completed | Table | Override all-views: `kind == "task" && status == "Done"` | `completed` desc | project, completed |
| Project Tasks | Table | `project` contains `this file` | `status` asc, `priority` asc | status, priority, due, smart_list |

**Formula properties:**
- `days_until_due = if(note.due, (note.due - today()).toString(), "")`
- `overdue = if(note.due, note.due < today() && note.status != "Done", false)`
- `project_area = if(note.project.asFile().hasProperty("tag"), note.project.asFile().properties.tag, "")`

#### 2.2 Notes Base (`Bases/notes.base`)

**All-views filter:** `kind == "note" && archived != true`

**Views:**

| View Name | Layout | View-specific Filter | Sort | Properties Shown |
|-----------|--------|---------------------|------|-----------------|
| All Notes | Table | — | `file.mtime` desc | note_type, tag, project, favorite |
| Inbox | Table | `tag` is empty AND `project` is empty | `file.ctime` desc | note_type |
| Favorites | Table | `favorite == true` | `file.mtime` desc | note_type, tag, project |
| Recents | Table | — | `file.mtime` desc, limit 25 | note_type, tag, project |
| Journal | Table | `note_type == "Journal"` | `file.ctime` desc | — |
| Web Clips | Table | `url` is not empty | `file.ctime` desc | url, tag |
| By Type | Table | — (group by `note_type`) | `file.mtime` desc | tag, project |
| Tag Notes | Table | `tag` contains `this file` | `file.mtime` desc | note_type, project, favorite |
| Project Notes | Table | `project` contains `this file` | `file.mtime` desc | note_type, tag, favorite |

**Formula properties:**
- `url_domain = if(note.url, note.url.replace(/https?:\/\/([^\/]+).*/, "$1"), "")`
- `days_since_edit = (today() - file.mtime).toString()`
- `root_area = note.tag.asFile().properties.parent_tag` (validated in 2.0)

#### 2.3 Projects Base (`Bases/projects.base`)

**All-views filter:** `kind == "project"`

**Views:**

| View Name | Layout | View-specific Filter | Sort |
|-----------|--------|---------------------|------|
| Active | Table | `status == "Doing" && archived != true` | `priority` asc |
| Ongoing | Table | `status == "Ongoing" && archived != true` | `tag` asc |
| Planned | Table | `status == "Planned" && archived != true` | `target_deadline` asc |
| On Hold | Table | `status == "On Hold" && archived != true` | `file.mtime` desc |
| Done | Table | `status == "Done"` | `completed` desc |
| All Projects | Table | `archived != true` | `status` asc, `priority` asc |
| Project Board | Cards | `archived != true` | `priority` asc |
| Archive | Table | `archived == true` | `file.mtime` desc |

**Formula properties:**
- `task_count = file.inlinks.filter(value.asFile().hasProperty("kind") && value.asFile().properties.kind == "task").length` (counts tasks linking to this project)
- `done_tasks = file.inlinks.filter(value.asFile().properties.kind == "task" && value.asFile().properties.status == "Done").length`
- `progress = if(task_count > 0, (done_tasks / task_count * 100).toFixed(0) + "%", "—")`
- `overdue_tasks = file.inlinks.filter(value.asFile().properties.kind == "task" && value.asFile().properties.due < today() && value.asFile().properties.status != "Done").length`

#### 2.4 Tags Base (`Bases/tags.base`)

**All-views filter:** `kind == "tag" && archived != true`

**Views:**

| View Name | Layout | View-specific Filter | Sort |
|-----------|--------|---------------------|------|
| Areas | Table | `tag_type == "area"` | name asc |
| Resources | Table | `tag_type == "resource"` | name asc |
| Entities | Table | `tag_type == "entity"` | name asc |
| All Tags | Table | — | `tag_type` asc, name asc |
| Area Dashboard | Table | `tag_type == "area"` contains `this file` | — |

**Properties shown:** tag_type, parent_tag, note_count (formula), project_count (formula)

**Formula properties:**
- `note_count = file.inlinks.filter(value.asFile().hasProperty("kind") && value.asFile().properties.kind == "note").length`
- `project_count = file.inlinks.filter(value.asFile().hasProperty("kind") && value.asFile().properties.kind == "project").length`

#### 2.5 Goals Base (`Bases/goals.base`)

**All-views filter:** `kind == "goal" && archived != true`

**Views:**

| View Name | Layout | View-specific Filter | Sort |
|-----------|--------|---------------------|------|
| Active Goals | Table | `status == "Active"` | `target_deadline` asc |
| Dreams | Table | `status == "Dream"` | name asc |
| Achieved | Table | `status == "Achieved"` | `achieved` desc |
| All Goals | Table | — | `status` asc |
| Goal Detail | Table | `goal` contains `this file` | — |

**Formula properties:**
- `milestone_count = file.inlinks.filter(value.asFile().properties.kind == "milestone").length`
- `done_milestones = file.inlinks.filter(value.asFile().properties.kind == "milestone" && value.asFile().properties.date_completed).length`
- `progress = if(milestone_count > 0, (done_milestones / milestone_count * 100).toFixed(0) + "%", "—")`

#### 2.6 Milestones Base (`Bases/milestones.base`)

**All-views filter:** `kind == "milestone"`

**Views:** All Milestones (table), sorted by `target_deadline` asc. Properties: goal, target_deadline, date_completed.

#### 2.7 People Base (`Bases/people.base`)

**All-views filter:** `kind == "person"`

**Views:**

| View Name | Layout | View-specific Filter | Sort |
|-----------|--------|---------------------|------|
| All People | Table | — | surname asc |
| Check-ins Due | Table | `check_in` is not empty AND `check_in <= today() + duration("7d")` | `check_in` asc |
| By Relationship | Table | — (group by `relationship`) | surname asc |
| Person Detail | Table | `people` contains `this file` | — |

**Properties shown:** company, title, email, relationship, check_in, last_check_in

#### 2.8 Books Base (`Bases/books.base`)

**All-views filter:** `kind == "book"`

**Views:**

| View Name | Layout | View-specific Filter | Sort |
|-----------|--------|---------------------|------|
| Library | Cards | — | `rating` desc |
| Currently Reading | Table | `status == "Currently Reading"` | `file.mtime` desc |
| Want to Read | Table | `status == "Want to Read"` | `file.ctime` desc |
| Read | Table | `status == "Read"` | `rating` desc |
| All Books | Table | — | `author` asc |

**Properties shown:** author, status, rating, genres, cover (image for cards view)

#### 2.9 Recipes Base (`Bases/recipes.base`)

**All-views filter:** `kind == "recipe"`

**Views:** All Recipes (table, sorted by name), By Tag (grouped by `recipe_tags`), Quick Meals (`total_time < 30`).

**Properties shown:** recipe_tags, servings, prep_time, cook_time, total_time (formula: `note.prep_time + note.cook_time`), url

---

### Phase 3: Build Templates

**Goal:** Create template files that replicate Notion's database templates. Each template has the right frontmatter and embedded Base views.

All templates go in `Templates/`.

#### 3.1 Task Template (`Templates/task.md`)

```yaml
---
kind: task
status: To Do
priority: ""
due:
start_date:
snooze:
wait_date:
smart_list: ""
my_day: false
project:
people: []
contexts: []
energy: ""
parent_task:
labels: []
archived: false
---
```

#### 3.2 Note Template (`Templates/note.md`)

```yaml
---
kind: note
note_type: ""
tag:
project:
people: []
favorite: false
archived: false
url: ""
---
```

#### 3.3 Journal Template (`Templates/journal.md`)

```yaml
---
kind: note
note_type: Journal
tag:
project:
favorite: false
archived: false
---

## Plan

- [ ]

## Journal



## Review

```

#### 3.4 Meeting Template (`Templates/meeting.md`)

```yaml
---
kind: note
note_type: Meeting
tag:
project:
people: []
favorite: false
archived: false
note_date: <% tp.date.now("YYYY-MM-DD") %>
---

## Attendees



## Agenda



## Notes



## Action Items

- [ ]
```

#### 3.5 Project Template (`Templates/project.md`)

```yaml
---
kind: project
status: Planned
project_type: ""
priority: ""
target_deadline:
completed:
tag:
goal:
people: []
parent_project:
archived: false
---

## Overview



## Tasks

![[tasks.base#Project Tasks]]

## Notes

![[notes.base#Project Notes]]

## Review Notes

```

#### 3.6 Area Template (`Templates/area.md`)

```yaml
---
kind: tag
tag_type: area
parent_tag:
archived: false
---

## Active Projects

![[projects.base#Active]]

## Tasks

![[tasks.base#Project Tasks]]

## Notes

![[notes.base#Tag Notes]]

## Web Clips

![[notes.base#Web Clips]]

## People

![[people.base#Person Detail]]

## Goals

![[goals.base#Goal Detail]]

## Sub-Tags


```

Note: The embedded views with `this file` filter will auto-scope to show only items related to this specific Area. The view definitions in each Base include a view specifically designed for embedding (e.g., "Project Tasks" filters where `project` contains `this file`; "Tag Notes" filters where `tag` contains `this file`).

#### 3.7 Resource Template (`Templates/resource.md`)

```yaml
---
kind: tag
tag_type: resource
parent_tag:
archived: false
---

## Notes

![[notes.base#Tag Notes]]

## Web Clips

![[notes.base#Web Clips]]
```

#### 3.8 Goal Template (`Templates/goal.md`)

```yaml
---
kind: goal
status: Dream
goal_set:
target_deadline:
achieved:
tag:
archived: false
---

## Milestones

![[milestones.base]]

## Projects

![[projects.base#Active]]

## Progress

```

#### 3.9 Person Template (`Templates/person.md`)

```yaml
---
kind: person
surname: ""
company: ""
title_role: ""
email: ""
phone: ""
birthday:
location: ""
relationship: []
interests: []
check_in:
last_check_in:
linkedin: ""
archived: false
---

## Meeting Notes

![[notes.base#Project Notes]]

## Related Projects

![[projects.base#Active]]

## Tasks

![[tasks.base#Project Tasks]]

## Quick Notes



## Gift Ideas

```

#### 3.10 Book Template (`Templates/book.md`)

```yaml
---
kind: book
author: ""
status: Want to Read
rating:
pages:
isbn: ""
publish_year:
genres: []
cover: ""
archived: false
---

## Notes



## Highlights

```

#### 3.11 Weekly Review Template (`Templates/weekly-review.md`)

```yaml
---
kind: note
note_type: Week Journal
tag:
archived: false
---

## 1. Clear & Reset

- [ ] Process Task Inbox
- [ ] Process Note Inbox
- [ ] Review overdue tasks — reschedule or complete
- [ ] Review active projects — any stalled?
- [ ] Review Areas — anything neglected?

## 2. Reflect & Set Intent

### Last Week's Journal Entries

![[notes.base#Journal]]

### Wins



### Lessons



## 3. Plan the Week

### Key Priorities

1.
2.
3.

### Upcoming Deadlines

![[tasks.base#This Week]]
```

---

### Phase 4: Build the Homepage

**Goal:** Create a single `Home.md` that serves as the central hub, replicating Notion's Ultimate Brain homepage.

#### 4.1 Homepage (`Home.md`)

```markdown
# 🏠 Home

## ⚡ Quick Capture

> Use Cmd+P → QuickAdd to capture tasks and notes instantly.

---

## Tasks

### Inbox
![[tasks.base#Inbox]]

### Today
![[tasks.base#Today]]

### My Day
![[tasks.base#My Day]]

### This Week
![[tasks.base#This Week]]

---

## Notes

### Note Inbox
![[notes.base#Inbox]]

### Favorites
![[notes.base#Favorites]]

### Recent Notes
![[notes.base#Recents]]

### Journal
![[notes.base#Journal]]

---

## Projects

### Active
![[projects.base#Active]]

### Ongoing
![[projects.base#Ongoing]]

### Planned
![[projects.base#Planned]]

---

## Tags

### Areas
![[tags.base#Areas]]

### Resources
![[tags.base#Resources]]

---

## Goals

![[goals.base#Active Goals]]
```

#### 4.2 Configure Homepage Plugin

Create/edit the Homepage plugin config to point to `Home.md` as the start page. This may need to be done in Obsidian settings, but the agent can create the note itself.

#### 4.3 Specialized Dashboard Pages

Create these additional dashboard notes:

**`Dashboards/My Day.md`:**
- Plan section: embedded Tasks views (Today, Overdue, Inbox, Do Next)
- Execute section: embedded Tasks My Day view
- Wrap Up section: instructions to review and clear

**`Dashboards/Process (GTD).md`:**
- Embedded views: Inbox, Do Next, Calendar, Delegated, Deferred, Someday

**`Dashboards/My Week.md`:**
- Embed the weekly review template pattern

**`Dashboards/Archive.md`:**
- Embedded views of completed/archived items across all collections

---

### Phase 5: Configure QuickAdd Macros

**Goal:** Set up one-click capture for common actions.

Create QuickAdd configuration for:

1. **Quick Task** — Creates a new task note in `01 Tasks/` using the task template, prompts for title
2. **Quick Note** — Creates a new note in `02 Notes/` using the note template, prompts for title
3. **New Project** — Creates in `03 Projects/` using project template
4. **Journal Entry** — Creates a daily journal note using journal template with today's date
5. **Meeting Note** — Creates in `02 Notes/` using meeting template, prompts for title and attendees
6. **New Book** — Creates in `09 Books/` using book template (or triggers Book Search plugin)

Note: QuickAdd configuration is stored in `.obsidian/plugins/quickadd/data.json`. The agent can write this file directly.

---

### Phase 6: Configure Metadata Menu

**Goal:** Define property types so editing frontmatter feels like Notion dropdowns.

Create Metadata Menu field definitions for:

| Property | Field Type | Options |
|----------|-----------|---------|
| `status` (tasks) | Select | To Do, Doing, Done |
| `status` (projects) | Select | Planned, On Hold, Doing, Ongoing, Done |
| `status` (goals) | Select | Dream, Active, Achieved |
| `priority` | Select | Critical (P1), High (P2), Medium (P3), Low (P4) |
| `smart_list` | Select | Do Next, Delegated, Someday |
| `contexts` | Multi-select | High-Energy, Low-Energy, Errand, Home, Office, Social, Shopping |
| `energy` | Select | High, Low |
| `note_type` | Select | Journal, Meeting, Web Clip, Reference, Idea, Plan, Voice Note |
| `tag_type` | Select | area, resource, entity |
| `relationship` | Multi-select | Family, Friend, Colleague, Client, Business Partner |
| `my_day` | Boolean | — |
| `archived` | Boolean | — |
| `favorite` | Boolean | — |
| `kind` | Select | task, note, project, tag, goal, milestone, person, work-session, book, recipe |

Metadata Menu config is stored in `.obsidian/plugins/metadata-menu/data.json`. The agent can write this.

---

### Phase 7: Templater Configuration

**Goal:** Set up folder-based auto-templates so new files in collection folders automatically get the right template.

Configure Templater's folder templates:

| Folder | Template |
|--------|----------|
| `01 Tasks/` | `Templates/task.md` |
| `02 Notes/` | `Templates/note.md` |
| `03 Projects/` | `Templates/project.md` |
| `04 Tags/` | `Templates/area.md` (default; manually choose resource.md when needed) |
| `05 Goals/` | `Templates/goal.md` |
| `06 Milestones/` | (minimal — just `kind: milestone` frontmatter) |
| `07 People/` | `Templates/person.md` |
| `09 Books/` | `Templates/book.md` |

Templater config is in `.obsidian/plugins/templater-obsidian/data.json`. The agent can write this.

---

### Phase 8: Verification & Testing

**Goal:** Validate the system works end-to-end.

#### 8.1 Base View Tests

For each of the 8 Bases, verify:
- [ ] All-views filter returns the correct set of notes
- [ ] Each view's filter narrows correctly
- [ ] Formula properties compute without errors
- [ ] Sorting works as expected

#### 8.2 Embedded View Tests

- [ ] Open a Project note → embedded Tasks and Notes views show only that project's items
- [ ] Open an Area tag note → embedded views show related projects, notes, people
- [ ] Open the Homepage → all embedded views load and show correct data

#### 8.3 Rollup Chain Test

- [ ] Notes tagged with a Resource show the correct root Area via the formula
- [ ] Notes tagged with an Area show the Area directly
- [ ] Notes with multiple tags show all root areas

#### 8.4 Template Tests

- [ ] Create a new task via QuickAdd → appears in Tasks Base Inbox view
- [ ] Create a new project → embedded task/note views are present and show `this file` filtered results
- [ ] Create a new Area → embedded views work

#### 8.5 Edge Cases

- [ ] Notes with no tag or project appear in Inbox views
- [ ] Archived items disappear from active views, appear in Archive views
- [ ] Completed tasks appear in Completed view, not in active views

---

## Implementation Notes for the Agent

### Working with .base Files

Base files are plain text YAML files with a `.base` extension. They can be created directly by writing the file. Refer to the Bases syntax documentation for the exact YAML schema.

The general structure of a `.base` file:

```yaml
filters:
  conjunction: "and"
  conditions:
    - field: "note.kind"
      operator: "eq"
      value: "task"
formulas:
  - name: "days_until_due"
    formula: "if(note.due, (note.due - today()).toString(), \"\")"
properties:
  - name: "status"
  - name: "priority"
  - name: "project"
  - name: "due"
  - name: "days_until_due"
    type: "formula"
views:
  - name: "All Tasks"
    type: "table"
    filters: []
    order:
      - property: "due"
        direction: "asc"
  - name: "Inbox"
    type: "table"
    filters:
      conjunction: "and"
      conditions:
        - field: "note.project"
          operator: "empty"
        - field: "note.smart_list"
          operator: "empty"
```

**Important:** The exact YAML schema may differ from what's shown above. The agent should:
1. Create a minimal test `.base` file first
2. Open it in Obsidian to verify the syntax
3. Use the working syntax as a template for all other bases
4. Alternatively, create bases via Obsidian's command palette (Cmd+P → "Create new base") and then edit the resulting files

### Working with Plugin Configs

Plugin configurations live in `.obsidian/plugins/<plugin-name>/data.json`. The agent can read existing configs to understand the schema, then write updated configs. Obsidian reads these on startup or when reloading plugins.

### Property Naming Convention

- All property names: `snake_case`
- All `kind` values: lowercase (`task`, `note`, `project`, etc.)
- All status values: Title Case (`To Do`, `Doing`, `Done`)
- All priority values: include code (`Critical (P1)`, `High (P2)`, etc.)
- Dates: `YYYY-MM-DD` format
- Links: `"[[Note Name]]"` format with quotes in YAML

### What NOT to Automate

- Do not set up recurring task automations (user said not important)
- Do not build time tracking / Work Sessions infrastructure (user said not important)
- Do not create synced block equivalents (use simple note embeds instead)
- Do not install or configure plugins (user does this manually per Step 4)
- Do not create Creator's Companion databases (Content, Channels, Sponsors, etc.) unless specifically requested
