# Second Brain System Analysis: Platform-Agnostic Blueprint

> Based on Thomas Frank's Ultimate Brain v3 + Creator's Companion, as implemented in Niven's Notion workspace. This document describes the **mechanics, philosophy, and organizational structure** of the system in platform-agnostic terms so it can be faithfully recreated in any tool (Obsidian, Logseq, Tana, Apple Notes + Reminders, etc.).

---

## 1. Foundational Philosophy

### 1.1 Methodological Hybrid: PARA + GTD + Daily Planning

The system is not a pure implementation of any single methodology. It blends three frameworks:

- **PARA** (Tiago Forte) provides the **organizational taxonomy** — how information and projects are categorized and stored.
- **GTD** (David Allen) provides the **task processing workflow** — how tasks are captured, clarified, organized, and executed.
- **Daily Planning** provides the **execution rhythm** — how you decide what to work on today and reflect on what happened.

The key insight is that these three operate at different layers and are complementary:

| Layer | Framework | Answers |
|-------|-----------|---------|
| Organization | PARA | "Where does this belong?" |
| Task Processing | GTD | "What do I do with this?" |
| Execution | Daily Planning | "What am I doing today?" |

### 1.2 Core Design Principles

1. **Single Source of Truth**: Every entity type (task, note, project, tag) exists in exactly one canonical location. It is then _surfaced contextually_ through views, queries, and links in many places throughout the system. A task lives in the Tasks collection but appears on its Project page, its Area page, in the GTD processing view, and in My Day.

2. **Archive, Never Delete**: Following PARA's archive principle, nothing is destroyed. Items are flagged as archived and filtered out of active views. They remain searchable and recoverable. This applies to projects, notes, tags, and goals.

3. **Progressive Complexity**: The system ships with many advanced features disabled by default (time tracking, sub-task syncing, recurring task history). Users opt in as their needs grow. A beginner can use it as a simple task + notes system; a power user can enable automations, time tracking, and CRM features.

4. **Goals ≠ Projects ≠ Tasks**: These are distinct entity types with a strict hierarchy. Goals are aspirational and may be vague. Projects are concrete and outcome-defined. Tasks are atomic actions. Tasks never relate directly to Goals — Projects bridge that gap.

5. **Contextual Views Over Folder Hierarchies**: Rather than nesting items in folders, the system uses metadata (properties, relations, tags) and filtered views to show the right items in the right context. The same data appears differently depending on where you're looking at it.

6. **Side Peek as Primary Navigation** (v3.0): The entire system is designed around opening items in a side panel without leaving the current page. This means you can open a project, review its tasks and notes, close it, and immediately open something else — all from the homepage. This drove the v3.0 redesign to single-column layouts with List views, which resize responsively when the side panel opens.

7. **Run Your Life From One Page**: The v3.0 homepage contains Tasks, Notes, Projects, and Tags with tabbed views for each. The goal is that most daily work can happen without ever navigating away from the homepage. Additional dashboards (My Day, Process/GTD, Goals, etc.) exist for specialized workflows but are optional.

8. **Pulled References**: Items can be loosely associated with projects as reference material without establishing a hard ownership relation. This supports research-oriented workflows where you want to gather relevant notes without implying those notes "belong" to the project.

9. **Friction-Free Capture**: The system prioritizes speed of capture above all else. Inboxes for both tasks and notes are accessible from the homepage. Web clipping via Flylighter (or any clipper) can send items directly to the inbox or bypass it by specifying an Area/Resource during capture.

10. **PARA as Starting Point, Not Rigid Structure**: Thomas Frank explicitly describes PARA as a "top-level starting point" rather than a rigid system. The key innovation in Notion is that PARA's traditionally flat, separate lists (Projects, Areas, Resources, Archive) become a relational hierarchy where Areas can contain Projects and Resources, but nothing is forced — items can exist independently without any PARA categorization. This flexibility is the whole point of using databases over folders.

---

## 2. The Eight Core Collections

The system is built on **8 interconnected collections** (called "databases" in Notion, "Bases" in Obsidian, "boards" in Trello, etc.). Each collection has a defined schema and relates to the others.

### 2.1 Tasks

The primary task management collection. Every actionable item in the system lives here.

**Key Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| Name | Text (title) | The task description |
| Status | Status | To Do → Doing → Done |
| Priority | Status | Critical (P1), High (P2), Medium (P3), Low (P4) |
| Due | Date | When the task is due |
| Start Date | Date | When the task becomes relevant |
| Snooze | Date | Deferred until this date (GTD "Tickler") |
| Wait Date | Date | Date task was delegated (GTD "Waiting For") |
| Smart List | Select | Do Next, Delegated, Someday (GTD lists) |
| My Day | Boolean | Flagged for today's execution |
| Project | Relation → Projects | Which project this belongs to |
| People | Relation → People | Associated contacts |
| Contexts | Multi-select | High-Energy, Low-Energy, Errand, Home, Office, Social, Shopping |
| Energy | Select | High, Low |
| P/I | Select | Process (routine/quick) vs. Immersive (deep work) |
| Description | Rich text | Supporting details |
| Parent Task | Self-relation → Tasks | For sub-task nesting (one level only) |
| Sub-Tasks | Self-relation → Tasks | Child tasks |
| Assigned To | Select | Team member delegation |
| Labels | Multi-select | Custom categorization (e.g., Dev, Marketing) |
| Location | Select | Home, Car, Moving |
| Days | Multi-select | Mon–Sun (for recurring pattern) |
| Recur Interval | Number | Recurrence frequency |
| Recur Unit | Select | Day(s), Week(s), Month(s), Year(s), Nth Weekday of Month, etc. |
| Enforce Schedule | Boolean | Forces recurrence on calendar cadence even when overdue |
| Completed | Date | Timestamp of completion |
| Sessions | Relation → Work Sessions | Time tracking entries |
| Start / End | Button | Start/stop time tracking (creates/ends Work Sessions) |
| Occurrences | Self-relation → Tasks | Past completed instances of recurring tasks (task history) |
| Shopping List | Boolean | Shows task in Recipe shopping list view |
| Content | Relation → Content | Creator's Companion integration |

**Computed Properties:**
- Next Due — calculated from Due + recurrence settings + Enforce Schedule
- Time Tracked / Time Tracked (Mins) — rolled up from Work Sessions
- Time Tracking Status — "Active Now", "Not Tracking", or "Done"
- Meta Labels — visual indicators (🔁 recurring, ⏱️ tracking, sub-task arrow)
- Project Active — whether this task's project is in Doing/Ongoing status
- Project Area — rollup of the project's Tag (Area)
- Smart List (Formula) — computed GTD list assignment (Calendar > Do Next > Delegated > Snoozed > Someday > Inbox)
- Due Stamp (Parent) / Sub-Task Sorter — sorting formulas to keep sub-tasks beneath parents
- Localization Key — multi-dimensional array enabling translated Status/Recur Unit/Days option names

**Sub-Task Rules:**
- Only one level of nesting (parent → children, no grandchildren)
- Sub-tasks inherit the parent's project and people (optionally, via automation)
- Completing a parent can auto-complete all open sub-tasks (optional automation)
- Sorting formulas keep sub-tasks visually grouped beneath their parent

**Recurring Task Rules:**
- Two modes: Simple (resets status and advances due date) and Advanced (creates a historical record page via Occurrences relation for each completion, enabling habit/streak tracking)
- Recurrence is configured by combining Interval + Unit + Days
- **Enforce Schedule** (boolean) forces the next due date to follow the original calendar pattern even when overdue. Example: if a daily task was due Monday and it's now Thursday, Next Due = Friday normally, but with Enforce Schedule = Tuesday (the next day in sequence after Monday)
- Recur Unit options: Day(s), Week(s), Month(s), Year(s), Month(s) on the First/Last Weekday, Month(s) on the Last Day, Nth Weekday of Month

### 2.2 Notes

The knowledge capture collection. All written information, journal entries, meeting notes, web clips, and reference material lives here.

**Key Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| Name | Text (title) | Note title |
| Type | Select | Journal, Meeting, Web Clip, Lecture, Reference, Book, Idea, Plan, Recipe, Voice Note, Daily, Topic Research, Outlier Content, Creator Tips, Tools |
| Tag | Relation → Tags | PARA categorization |
| Project | Relation → Projects | Direct project association |
| Pulls | Relation → Projects | Projects that pulled this note as reference |
| People | Relation → People | Associated contacts (esp. for meetings) |
| Favorite | Boolean | Surfaces in favorites views |
| Archived | Boolean | Sends to archive |
| Note Date | Date | Manual date (for meetings, journals) |
| Review Date | Date | Schedule future review |
| URL | URL | Source link for web clips |
| Image | File | Image attachment |
| Topic | Multi-select | Topic categorization |
| Updated | Timestamp | Last edit time |
| Channel | Relation → Channels | Creator's Companion integration |
| Keywords | Relation → Keywords | SEO/content keywords |
| Sponsor | Relation → Sponsors | Creator's Companion integration |

**Note Templates:**
- **Journal: [Date]** — daily entry with planning section, review section, and free-form writing
- **Week Journal: [Date]** — weekly planning and review
- **Meeting: [Date]** — meeting notes with attendees, agenda, action items
- **Note with Tasks** — note page with embedded task views

**Computed Properties:**
- URL Base — extracts the base domain from the URL (e.g., "barbell.com") for grouping web clips by source site
- URL Icon — clickable 🔗 icon linking to the URL, useful in condensed list views
- Updated (Short) — styled label showing days since last edit (e.g., "3d" in blue)
- Root Tag — rollup showing the parent tag of this note's tag (enables notes in Resources to appear on Area dashboards)
- Project Tag — rollup showing the tag of this note's project
- Project Archived / Project People — rollups for filtering and display on People pages

**Web Clipping:** The URL property stores the source. Flylighter (Thomas Frank's web clipper) or any web clipper can populate this, including capturing highlights directly into the note body.

**Voice Notes:** Properties for AI Cost, Duration, and Duration (Seconds) support a workflow where audio is transcribed externally and the transcript is stored as a note.

### 2.3 Projects

Outcome-oriented containers that group tasks and notes toward a defined result. A project should have a clear definition of "done."

**Key Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| Name | Text (title) | Project name |
| Status | Status | Planned, On Hold → Doing, Ongoing → Done |
| Project Type | Select | Personal, Work |
| Priority | Select | Critical (P1), High (P2), Medium (P3), Low (P4) |
| Target Deadline | Date | Planned completion |
| Completed | Date | Actual completion |
| Tag | Relation → Tags | The Area or Resource this serves |
| Goal | Relation → Goals | The goal this project advances |
| Tasks | Relation → Tasks | All associated tasks |
| Notes | Relation → Notes | All associated notes |
| Pulled Notes | Relation → Notes | Reference material pulled in |
| Pulled Tags | Relation → Tags | Entire tag collections pulled as reference |
| People | Relation → People | Associated contacts |
| Sub-Projects | Self-relation → Projects | Nested projects |
| Parent Project | Self-relation → Projects | Parent project |
| Review Notes | Rich text | Quick notes about the project |
| Archived | Boolean | Sends to archive |

**Computed Properties:**
- **Progress** — percentage of completed tasks (done tasks / total tasks), respects localized Status names
- **Meta** — active task count + overdue count with colored styling (blue for active, red for overdue)
- **Latest Activity** — most recent edit across the project, its tasks, and its notes
- **Localization Key** — multi-dimensional array for translating Status option names while preserving filter logic
- **Quarter** — derived from Target Deadline for planning views
- **This Quarter / This Year** — boolean filters for planning
- **Time Tracked / Time Tracked (Mins)** — total duration from all related task work sessions, formatted HH:MM:SS
- **Goal Tag** — rollup showing the Tag of this project's Goal (if any)

**The "Ongoing" Status:** This is a critical distinction. Projects marked "Ongoing" represent maintenance work that belongs to an Area but never truly completes (e.g., "Home Maintenance," "Work Ongoing"). They remain in the "In Progress" group perpetually.

**Research Projects:** A specialized pattern using the Pulls relation. You pull in notes and entire tag collections as reference material, creating a research workspace without modifying the notes' actual project ownership.

### 2.4 Tags (PARA Taxonomy)

The organizational backbone of the system. Tags replace the traditional PARA folder structure with a flat, relational taxonomy.

**Key Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| Name | Text (title) | Tag name |
| Type | Status | Area, Resource, Entity |
| Parent Tag | Self-relation → Tags | Hierarchy (e.g., Resource under Area) |
| Sub-Tags | Self-relation → Tags | Child tags |
| Notes | Relation → Notes | All notes tagged with this |
| Projects | Relation → Projects | All projects tagged with this |
| Goals | Relation → Goals | Goals associated with this area |
| People | Relation → People | People associated with this |
| Pulls | Relation → Projects | Projects that pulled this tag as reference |
| Favorite | Boolean | Pin to favorites |
| Archived | Boolean | Sends to archive |
| URL | URL | Reference link |

**Computed Properties:**
- Note Count — number of related notes
- Latest Note — title of most recently edited note
- Latest Activity — most recent change across all related items
- Tag Projects — count of active projects

**Tag Types Explained:**

| Type | PARA Role | Description | Displays |
|------|-----------|-------------|----------|
| **Area** | Areas of Responsibility | Ongoing spheres of life you maintain (Health, Work, Home, Faith) | Projects, Tasks, Notes, Web Clips, People, Goals, Sub-Tags |
| **Resource** | Resources | Topics or interests useful for future reference (RSNA 2024, Prompt Library, Reading List) | Notes, Web Clips |
| **Entity** | N/A (Extension) | Meta-collections organized by type rather than topic (Apps, Essays, Tools) | Notes |

**Hierarchy Rules:**
- Tags can nest one level via Parent Tag / Sub-Tags (e.g., "Spin Classes" under "Working Out")
- Resources can be Sub-Tags of Areas
- Areas are typically top-level (no parent)

**Niven's Active Tags (Examples):**

*Areas:* Team Meetings, Shopping, Sales Coaching and Improvement, Next Level Marketing, HubSpot, Working Out, Continuous Learning, Daniel and Wesley Education, Eating Healthy, Managing Anger and Impatience, Walk with Jesus, Perform at High Level at Work, Tech Tinkering, Social Media, Team Effectiveness, Website, Work Maintenance

*Resources:* Prompt Library, Reading List, US Growth, RSNA 2024, Productivity Tools, Getting a Job, Key Initiatives, Digital Photo Storage, Friend Anecdotes, PARA

*Entities:* Ultimate Tools

### 2.5 Goals

Aspirational objectives that sit above Projects in the hierarchy. Goals may be vague or ambitious — that's fine. Projects make them actionable.

**Key Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| Name | Text (title) | Goal description |
| Status | Status | Dream → Active → Achieved |
| Goal Set | Date | When the goal was established |
| Target Deadline | Date | Aspirational target |
| Achieved | Date | When completed |
| Tag | Relation → Tags | Best linked to Area-type tags |
| Projects | Relation → Projects | Projects that advance this goal |
| Milestones | Relation → Milestones | Measurable checkpoints |
| Archived | Boolean | Sends to archive |

**Computed Properties:**
- **Progress** — percentage of completed milestones (visual progress bar)
- **Latest Activity** — most recent change across goal, projects, and milestones
- **This Quarter / This Year** — boolean filters for planning views

**The Hierarchy:** Goal → Milestones (measurable checkpoints) → Projects (actionable work) → Tasks (atomic actions). Tasks never connect directly to Goals.

### 2.6 Milestones

Measurable checkpoints within Goals. Progress on a Goal equals the ratio of completed milestones.

**Key Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| Name | Text (title) | Milestone description |
| Goal | Relation → Goals | Parent goal |
| Target Deadline | Date | When this should be hit |
| Date Completed | Date | When achieved |
| Goal Area | Rollup | Shows the goal's tag (Area) |

### 2.7 People (CRM)

A contact database for tracking relationships, meetings, and interactions.

**Key Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| Full Name | Text (title) | Contact name |
| Surname | Text | Last name (separate for sorting) |
| Company | Text | Organization |
| Title | Text | Job title |
| Email | Email | Contact email |
| Phone | Phone | Contact phone |
| Birthday | Date | Birthday |
| Location | Text | Where they are |
| LinkedIn, Instagram, Twitter/X, Website | URL | Social links |
| Relationship | Multi-select | Family, Friend, Colleague, Client, Customer, Business Partner, Vendor, Senpai, Teacher |
| Interests | Multi-select | Shared interests |
| Check-In | Date | Next planned check-in |
| Last Check-In | Date | Most recent contact |
| Pipeline Status | Status | Prospect → Contacted → Negotiating → Rejected/Closed |
| Notes | Relation → Notes | All associated notes |
| Projects | Relation → Projects | Shared projects |
| Tasks | Relation → Tasks | Related tasks |
| Tags | Relation → Tags | Area associations |

**Computed Properties:**
- Name (Last, First) — for alphabetical sorting
- Next Birthday — calculated from birthday for reminder views

**Person Page Template displays:** Meeting Notes, all related Notes, Project Notes, Projects, Tasks, and sections for quick notes and gift ideas.

### 2.8 Work Sessions (Time Tracking)

A ledger of time spent on tasks. Created automatically when you start a timer on a task.

**Key Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| Name | Text (title) | Auto-generated session name |
| Task | Relation → Tasks | What was worked on (limit 1) |
| Start | Date/time | Session start |
| End | Date/time | Session end |
| Team Member | Person | Who did the work |

**Computed Properties:**
- Duration (Mins) — calculated from Start to End
- Duration — formatted as HH:MM:SS
- Project — rolled up from the related task

---

## 3. The Relationship Map

This is the most critical part of the system. The power comes from how collections relate to each other. Here is the complete relationship graph:

```
                    ┌─────────────┐
                    │   Goals     │
                    │ Dream→Active│
                    │  →Achieved  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │Milestones│ │   Tags   │ │ Projects │
        │          │ │Area/Res/ │ │Planned→  │
        │          │ │ Entity   │ │Doing→Done│
        └──────────┘ └────┬─────┘ └────┬─────┘
                          │            │
                    ┌─────┼─────┐ ┌────┼────┐
                    │     │     │ │    │    │
                    ▼     ▼     ▼ ▼    ▼    ▼
              ┌───────┐ ┌───────────┐ ┌───────────┐
              │People │ │   Notes   │ │   Tasks   │
              │       │ │           │ │To Do→Doing│
              │       │ │           │ │  →Done    │
              └───────┘ └───────────┘ └─────┬─────┘
                                            │
                                            ▼
                                     ┌─────────────┐
                                     │Work Sessions │
                                     └─────────────┘
```

**All Bidirectional Relations:**

| From | To | Relation Name | Purpose |
|------|----|---------------|---------|
| Tasks | Projects | Project | Task belongs to a project |
| Tasks | People | People | Task involves these contacts |
| Tasks | Tasks | Parent Task / Sub-Tasks | One-level nesting |
| Tasks | Work Sessions | Sessions | Time tracking entries |
| Tasks | Content | Content | Creator's Companion link |
| Notes | Tags | Tag | PARA categorization |
| Notes | Projects | Project | Note belongs to a project |
| Notes | Projects | Pulls | Projects that referenced this note |
| Notes | People | People | Note involves these contacts |
| Notes | Channels | Channel | Creator's Companion link |
| Notes | Keywords | Keywords | SEO keywords |
| Notes | Sponsors | Sponsor | Creator's Companion link |
| Projects | Tags | Tag | PARA categorization |
| Projects | Goals | Goal | Goal this project serves |
| Projects | Notes | Pulled Notes | Research reference material |
| Projects | Tags | Pulled Tags | Research tag collections |
| Projects | People | People | Project involves these contacts |
| Projects | Projects | Parent/Sub-Projects | Project nesting |
| Goals | Tags | Tag | Area association |
| Goals | Milestones | Milestones | Measurable checkpoints |
| People | Tags | Tags | Area association |
| Tags | Tags | Parent Tag / Sub-Tags | Tag hierarchy |

---

## 4. GTD Task Processing Workflow

The system implements GTD through a series of views and properties on the Tasks collection:

### 4.1 The GTD Pipeline

```
┌─────────┐    ┌──────────┐    ┌───────────────────────────┐
│ CAPTURE  │───▶│ CLARIFY  │───▶│       ORGANIZE            │
│ (Inbox)  │    │          │    │                           │
└─────────┘    └──────────┘    │  Has Due Date? → Calendar │
                               │  Delegated? → Delegated   │
                               │  Snoozed? → Deferred      │
                               │  Someday? → Someday       │
                               │  Otherwise → Do Next      │
                               └───────────────────────────┘
                                            │
                                            ▼
                                    ┌──────────────┐
                                    │   EXECUTE    │
                                    │  (My Day)    │
                                    └──────────────┘
```

### 4.2 GTD Lists (via Smart List property + date properties)

| GTD List | How Items Get Here | Key Property |
|----------|--------------------|--------------|
| **Inbox** | New tasks with no project, no smart list, no due date | Default state |
| **Do Next** | Smart List = "Do Next" | Actionable now, grouped by Context |
| **Calendar** | Has a Due date | Date-based view |
| **Delegated** | Smart List = "Delegated" | Wait Date tracks delegation date |
| **Deferred** | Has a Snooze date | Hidden until Snooze date arrives |
| **Someday** | Smart List = "Someday" | Low priority, future consideration |

### 4.3 Contexts (for the Do Next list)

Tasks on the Do Next list can be grouped by Context to answer "given where I am and what energy I have, what should I do?":

- **High-Energy** / **Low-Energy** — energy-based filtering
- **Errand** — out and about
- **Home** / **Office** — location-based
- **Social** — requires other people
- **Shopping** — purchase-related

### 4.4 Process vs. Immersive Work

Tasks can be classified using the **P/I** property as either:

- **Process** — Tasks requiring initial input to get a process started (e.g., delegating a task, replying to an email, sending a quick message). These are quick-touch items that don't demand sustained focus — you do the initial action and then the ball is in someone else's court or in a system's hands.
- **Immersive** — Tasks requiring your sustained focus and energy for their entire duration (e.g., writing a report, editing a video, deep research). These are deep work items that need protected time blocks.

This classification helps the user plan their day in two ways:

1. **Batching**: Process tasks can be grouped and knocked out in a single low-energy session (e.g., "spend 30 minutes clearing all process tasks"). This prevents context-switching between quick-touch and deep work.
2. **Time blocking**: Immersive tasks signal that the user needs to carve out an uninterrupted block. Seeing a task marked "Immersive" is a cue to schedule it during peak energy hours and protect it from interruptions.

**For platform migration:** This is a simple select property (Process / Immersive) on tasks. The real value comes from creating views that group or filter by this property — e.g., a "Quick Wins" view showing only Process tasks, or an "Immersive Work" view for deep focus planning.

### 4.5 Quick Capture (Reducing Friction)

The system provides a dedicated Quick Capture page optimized for speed:

- **Two inboxes side by side**: Task Inbox and Note Inbox
- **Designed for mobile**: intended to be pinned as a favorite or added as a phone home screen widget
- **Self-cleaning**: items older than 24 hours disappear from the Quick Capture view (but remain in the actual inbox until processed)
- **Web Clipping**: browser extensions (Flylighter, Save to Notion, Notion Web Clipper) can clip directly into the Note Inbox or bypass the inbox entirely by specifying an Area/Resource during capture
- **Highlights**: web clips support in-page highlighting that syncs back to the note in the system

**The Inbox Processing Rule**: A task stays in the Inbox until it's assigned to a Project. A note stays in the Inbox until it's assigned to an Area/Resource or a Project. The inbox is simply "anything not yet organized."

### 4.6 My Day (Daily Planning)

My Day is an opinionated, rigid day planner designed to enforce deliberate daily prioritization. It follows a strict three-phase process:

1. **Plan** — Review your task views (Today, Overdue, Inbox, Do Next). For each task you intend to do today, check the **My Day** checkbox. This sends it to the Execute section.
2. **Execute** — The Execute section shows ONLY tasks with My Day checked, grouped by Status (To Do / Done). Work through them, checking off as you go. The goal: all tasks in the Done group by end of day.
3. **Wrap Up** — Update any task details (reschedule due dates, etc.). Then click the **Clear My Day** button to uncheck My Day on ALL tasks regardless of status.

**The Clear My Day button is crucial.** It resets the Execute section to blank, ensuring tomorrow morning you start fresh with a clean slate. You must deliberately re-add tasks each day — nothing carries over automatically. This prevents task pile-up and forces daily intentionality.

**Why this matters for platform migration:** The core mechanic is a boolean "My Day" flag on tasks, a filtered view showing only flagged items, and a bulk-reset mechanism. Any platform needs these three pieces: a flag, a filtered view, and a way to clear the flag in bulk.

### 4.7 My Week (Weekly Review)

My Week is designed to combat "digital cruft" — the gradual gumming-up of your system as items pile up. It guides you through a weekly **clearing to neutral** process:

1. **Clear & Reset** — Clear out inboxes, reschedule or delete overdue tasks, ensure Projects/Tags/Goals are organized
2. **Reflect & Set Intent** — Review past week's Journal and Meeting notes, review all notes from the last week, optionally create a Week Journal entry
3. **Plan the Week** — Look at the upcoming week, schedule task due dates as needed

### 4.8 Fleeting Notes (Auto-Archiving)

Notes that haven't been edited for one month are automatically archived. This is designed for ephemeral notes like meeting action items or quick thoughts that have a natural shelf life. The note moves to the Archive's "Old Fleeting Notes" section — recoverable but out of active views.

---

## 5. PARA Implementation Details

### 5.1 How PARA Maps to the System

| PARA Component | System Implementation |
|----------------|----------------------|
| **Projects** | Projects collection with Status ≠ Done and Archived = false |
| **Areas** | Tags with Type = "Area" |
| **Resources** | Tags with Type = "Resource" |
| **Archive** | Any item with Archived = true (across all collections) |

### 5.2 Why PARA Uses a Single Database (Not Folders)

Traditional PARA implementations use four separate folder hierarchies. This system merges Areas and Resources into a single "Tags" collection with a Type property because:

1. **Single relation property**: When processing a task or note, you click one property to assign it an Area or Resource — no need for two separate fields or deciding which folder to file into.
2. **Visual differentiation**: The Type status (Area/Resource/Entity) provides clear visual distinction without physical separation.
3. **Cross-cutting views**: A single collection enables views like "all Areas" or "all Resources" or "everything" from the same data source.
4. **Hierarchical nesting**: Resources can live inside Areas via the Parent Tag relation, something impossible with separate folders.
5. **No forced categorization**: Items can exist in the system without any Area/Resource assignment. The inbox holds them until you decide.

### 5.3 The Area Page Pattern

When you open an Area tag page, you see:
- **Active Projects** — Projects related to this Area that aren't archived/done
- **Tasks** — Tasks belonging to this Area's projects (rolled up)
- **Notes** — Notes tagged with this Area
- **Web Clips** — Notes of Type "Web Clip" tagged here
- **People** — Contacts associated with this Area
- **Goals** — Goals linked to this Area
- **Sub-Tags** — Resources nested under this Area

**Key Note**: Area notes include both notes directly tagged with the Area AND notes tagged with any Resource whose root area is this Area. This is achieved via a rollup — the system reaches through the note's Resource relation to find that Resource's root Area. This means a note filed under a "Fitness" Resource automatically appears on the "Health" Area dashboard.

### 5.4 The Resource Page Pattern

When you open a Resource tag page, you see:
- **Notes** — Notes tagged with this Resource
- **Web Clips** — Notes of Type "Web Clip" tagged here

Resources are lighter than Areas — they don't have Projects, Tasks, or Goals sections because Resources are reference-only, not responsibility-driven.

### 5.5 Archive Behavior

Archiving is implemented as a boolean flag on Projects, Notes, Tags, and Goals. When `Archived = true`:
- The item disappears from all active views (filtered out)
- It appears in the dedicated Archive section
- It remains fully searchable and recoverable
- All its relations are preserved (nothing is orphaned)

---

## 6. The Goal → Project → Task Hierarchy

This hierarchy is deliberately strict:

```
Goal: "Become a recognized thought leader in AI radiology"
  │
  ├── Milestone: "Speak at 3 industry conferences"
  ├── Milestone: "Publish 5 LinkedIn articles on AI in radiology"
  │
  ├── Project: "RSNA 2024 Presentation"
  │     ├── Task: "Draft abstract"
  │     ├── Task: "Create slide deck"
  │     └── Task: "Rehearse presentation"
  │
  └── Project: "Personal Branding"
        ├── Task: "Set up LinkedIn content calendar"
        └── Task: "Write first article draft"
```

**Rules:**
- Goals have Milestones (measurable checkpoints) and Projects (actionable work)
- Projects have Tasks (atomic actions) and Notes (reference/thinking)
- Tasks are the atomic unit — they do NOT relate to Goals or Milestones
- Goal progress = completed milestones / total milestones
- Project progress = completed tasks / total tasks
- A Project can exist without a Goal (standalone work)
- A Task can exist without a Project (quick standalone action)

---

## 7. Niven's Actual Usage Patterns

Based on analysis of the live workspace:

### 7.1 Project Status Distribution
- **Ongoing** — heavily used for maintenance categories (Work Ongoing, Home Ongoing, Life Maintenance, People Management, Social)
- **Doing** — active focused projects (Maximize NTAP, Website Refresh, Brand Refresh Comms)
- **Planned** — queued work (Process Returns, Executive Presence Development, Personal Branding)

### 7.2 Tag Usage
- Areas are used for both life domains (Working Out, Eating Healthy, Walk with Jesus, Managing Anger and Impatience) and work domains (HubSpot, Social Media, Team Effectiveness, Sales Coaching)
- Resources are used for reference collections (Prompt Library, Reading List, RSNA 2024, US Growth)
- Entity type is rarely used (one entry: "Ultimate Tools")

### 7.3 Note Types in Use
- **Journal** — daily journaling is active and consistent (near-daily entries)
- **Untyped notes** — many notes don't have a Type set, used for quick capture (Board Presentations, Meeting notes, Research)
- Tags and Projects are sparsely applied to notes — most recent notes have no tag or project relation

### 7.4 Task Patterns
- Work-heavy task load with professional focus (marketing, sales, team management)
- Most tasks are in "To Do" status (no "Doing" observed — suggests checkbox-toggle workflow where tasks go directly To Do → Done)
- Smart Lists and Contexts appear unused in sampled data
- Sub-tasks are used moderately
- Project assignment is common on tasks

---

## 8. Dashboard Patterns and Navigation

The system uses multiple dashboards that surface the same underlying data in different contexts. Understanding these patterns is essential for recreating the system.

### 8.1 The Dashboard Hierarchy

| Dashboard | Purpose | What It Shows |
|-----------|---------|---------------|
| **Homepage** | The central hub — run your life from here | Tasks (tabbed: Inbox, Today, Week, Month, etc.), Notes (tabbed: Inbox, Favorites, Recents, Clips, Voice, Journal), Projects (tabbed: Active, Ongoing, Planned, Done), Tags (tabbed: Areas, Resources) |
| **My Day** | Deliberate daily planning & execution | Plan section (task views), Execute section (My Day flagged tasks only), Wrap Up, Clear My Day button |
| **My Week** | Weekly review & reset | Clear & Reset, Reflect & Set Intent, Plan the Week |
| **Process (GTD)** | Full GTD workflow | Intake, Do Next, Calendar, Delegated, Deferred, Someday tabs |
| **Task Manager** | Comprehensive task views | Calendar, Inbox, Today, Next 7 Days, Next Month, Priority Projects, Completed |
| **Notes** | Note management | Inbox, Favorites, Recents, Fleeting Notes, Daily Journal history |
| **Projects** | All projects overview | Projects grouped by Status, then by Area |
| **Tags** | PARA taxonomy | All Areas and Resources with their dashboards |
| **Goals** | Goal tracking | Goals with milestones, projects, and progress |
| **People** | Personal CRM | Contacts, meeting notes, check-ins, pipeline |
| **Books** | Reading tracker | Library, reading log, reading charts |
| **Recipes** | Recipe & meal planning | Recipes, recipe tags, meal plans with calendar |
| **My Year** | Future planning | Goals and Projects with Target Deadlines, grouped by Quarter/Year |
| **Archive** | Inactive items | Completed Tasks, Archived Notes, Archived Projects, Archived Tags |

**Note:** The homepage is intentionally the only page most users need day-to-day. All other dashboards are specialized views for specific workflows. The v3.0 design philosophy is that additional complexity is opt-in — you go to My Day only if you want rigid daily planning, to Process only if you use GTD, etc.

### 8.2 The Dashboard Component Library

v3.0 includes a library of pre-built dashboard components (for Goals, People, Books, Recipes) that users can optionally copy-paste onto their homepage. This modular approach means the homepage starts minimal but can be extended. For platform migration, this translates to: build the core homepage first, then create optional "widgets" or embedded queries that users can add as they adopt more features.

### 8.3 The Self-Referential Filter Pattern

Every template page (Area, Resource, Project) contains embedded views of related collections that automatically filter to show only relevant items. When you create a new Project from the template, its embedded Tasks view automatically filters to "Project = this project." This is the fundamental pattern that makes contextual dashboards work. In Obsidian, this maps directly to Bases' embedded view with a `this file` filter — embed a Base view in a Project note with a filter like "project contains this file" and it dynamically shows only that project's tasks, notes, and people.

### 8.4 The Synced Block Pattern

Key planning content (like the daily priorities callout) is placed in a synced block that appears across multiple dashboards — My Day, the general Dashboard, the Task Manager. Edit it anywhere, and it updates everywhere. This enables a consistent planning surface regardless of which dashboard you're currently using.

### 8.5 Notes Dashboard Special Views

| View | Filter Logic | Purpose |
|------|-------------|---------|
| **Inbox** | Area/Resource is empty AND Project is empty AND not archived | Unprocessed notes |
| **Favorites** | Favorite = true AND not archived | Quick access to pinned notes |
| **Recents** | Not archived, sorted by Updated descending | Recently touched notes |
| **Fleeting Notes** | Updated more than 1 month ago → auto-archives | Ephemeral notes with a shelf life |
| **Daily Journal** | Type = Journal, sorted by date | Chronological journal history |
| **By Type** | Grouped by Type property | Matrix view (Lectures, References, Meetings, etc.) |

### 8.6 Web Clips Organization

Web clips (notes with a URL) are separated from regular notes in views. They appear in dedicated "Web Clips" sections on Resource and Area pages. A computed Base URL property extracts the domain from the full URL, enabling grouping by source site (e.g., all clips from "barbell.com" together).

---

## 9. Supplementary Collections (Creator's Companion)

Beyond the 8 core collections, the workspace includes specialized databases from the Creator's Companion add-on:

| Collection | Purpose | Key Properties |
|------------|---------|----------------|
| **Content** | Content production pipeline | Status workflow, Channel, Media Type, Publish Date, Sponsor, Focus Keywords, Views/Likes/Comments stats |
| **Channels** | Publication outlets | Type, Link, Content relation |
| **Sponsors** | Sponsorship management | Status, Pay Structure, Total Paid/Outstanding |
| **Keywords** | SEO keyword tracking | Volume, Difficulty, Parent keyword, Research URL |
| **B-Roll** | Visual assets | (Standalone visual asset library) |
| **Swipes** | Inspiration/reference content | Creator, URL, Tags |
| **Wiki** | Internal documentation | Doc Type, Channel, Tags |
| **Audience Submissions** | Audience interaction tracking | Submitter, Created |

### Sponsor Financial Tracking Workflow

The Content and Sponsors collections work together to form a complete sponsorship financial pipeline. Here is the end-to-end flow:

1. **Create or link a Sponsor** — Add a Sponsor record to the Sponsors collection with their name, status (Prospective → Reached Out → Negotiating → Active), and **Pay Structure** (e.g., Net 30, Net 60, On Publish, EOM).
2. **Associate Sponsor with Content** — On a Content project, set the **Sponsor** relation and enter the **Sponsor Rate** (dollar amount) and **Sponsor URL** (the promo/landing page link).
3. **Pay Due Date auto-calculates** — A formula on the Content project combines the **Publish Date** with the Sponsor's **Pay Structure** to compute when payment is expected. For example: a video published on March 1 with a Net 30 sponsor shows a Pay Due Date of March 31. Net 30 (EOM) would show the end of April.
4. **Track payment** — Once the sponsor pays, check the **Paid** checkbox on the Content project. The **Sponsor Performance** select (Great / Good / Okay / Poor) can also be recorded for future negotiation reference.
5. **Sponsor-level rollups** — On the Sponsor record, rollup properties automatically aggregate across all related Content projects:
   - **Spot Count** — Total number of sponsored content pieces
   - **Paid Spots** — Number of content pieces where Paid = true
   - **Total Booked** — Sum of all Sponsor Rates across related content
   - **Total Paid** — Sum of Sponsor Rates where Paid = true
   - **Total Outstanding** — Total Booked minus Total Paid (formula)

This creates a self-maintaining financial dashboard where you can see at a glance: which sponsors owe you money, how much is outstanding, which content is unpaid past its Pay Due Date, and the total revenue per sponsor over time.

**For platform migration:** The core mechanic is a relation between Content and Sponsors, a formula that computes payment dates from publish dates + payment terms, a boolean for payment status, and rollup aggregations on the Sponsor record. Any platform with relations and computed/aggregated fields can replicate this.

### Standalone Lifestyle Systems (v3.0 — separate from Notes):

In v3.0, Books and Recipes were extracted from the Notes database into their own independent database sets. This allows them to be shared with others without exposing the rest of your system.

| Collection | Purpose | Key Properties |
|------------|---------|----------------|
| **Books** | Reading tracker & library | Author, Status (Want to Read → Currently Reading → Read → Paused), Rating, Pages, ISBN, Publish Year, Owned Formats, Shelf (custom collections like "Favorites", "Books to Gift"), Genres, Image, Reading Logs |
| **Reading Log** | Per-session reading journal | Book, Start/End Page, Pages Read, Log Date, Month Index |
| **Genres** | Book categorization | Books relation, Stats |
| **Recipes** | Recipe collection | Recipe Tags, Servings, Prep Time, Cook Time, Total Time (computed), URL, Instructions, Ingredients |
| **Recipe Tags** | Recipe categorization | Recipes relation, Type (Course, Style, etc.) |
| **Meal Planner** | Combine recipes into dated meals | Recipes (relation, multiple), Date (for calendar planning), Time estimate (auto or override) |

---

## 10. Automation Rules (Event-Driven Behaviors)

The system includes automations that can be enabled/disabled independently:

### Tasks Automations:
1. **Recurring Tasks (Simple)** — When a task is marked Done and has recurrence settings: reset Status to To Do, advance Due date by the recurrence interval
2. **Recurring Tasks (Advanced)** — Same as Simple, but also creates a historical record page for each completion (enables habit/streak tracking)
3. **Task Done → End Active Work Session** — When a task is marked Done, automatically end any running time-tracking session
4. **Set Completion Dates** — Timestamp when tasks are completed
5. **Clear Completion Dates** — Remove timestamp when tasks are reopened
6. **Change Project → Remove Parent** — When a task moves to a new project, detach it from its parent task
7. **Sync Parent/Sub-Item Projects & People** — Keep sub-task metadata aligned with parent
8. **Task Done → Close All Open Sub-Tasks** — Cascading completion

### Tags Automations:
9. **Create Ongoing Project for Areas** — When a new Area-type tag is created and named, auto-create an "[Area Name] Ongoing" project linked to it

---

## 11. Platform Migration Guide

When recreating this system in another platform, these are the essential mechanics to preserve:

### 11.1 Must-Have (Core System)
1. **8 distinct collections** with their property schemas (Tasks, Notes, Projects, Tags, Goals, Milestones, People, Work Sessions)
2. **Bidirectional relations** between collections — this is the system's backbone
3. **Tag types** (Area, Resource, Entity) with different display behaviors
4. **Task status workflow** (To Do → Doing → Done) with checkbox shortcut
5. **Project status workflow** (Planned, On Hold → Doing, Ongoing → Done)
6. **Archive flag** on Projects, Notes, Tags, Goals
7. **Inboxes** for both tasks (unassigned to project) and notes (unassigned to tag/project)
8. **My Day flag** with plan/execute/clear cycle for daily planning
9. **Goal → Milestone → Project → Task hierarchy** (with no Goal↔Task shortcut)
10. **Computed progress** (goal = milestones, project = tasks)
11. **A single "home" view** that surfaces tasks, notes, projects, and tags with tabbed/filtered sub-views — the system should be operable from one screen

### 11.2 Should-Have (Power Features)
1. **Recurring tasks** with interval + unit configuration
2. **Sub-tasks** (one level of nesting)
3. **Time tracking** via Work Sessions
4. **Pulled references** (loose association of notes/tags to projects)
5. **GTD processing views** (Do Next with Contexts, Calendar, Delegated, Deferred, Someday)
6. **My Week** weekly review workflow (Clear & Reset, Reflect, Plan)
7. **People/CRM** with meeting notes and relationship tracking
8. **Note types** (Journal, Meeting, Web Clip, etc.) with templates
9. **Tag hierarchy** (parent/child for nesting Resources under Areas)
10. **Web clipping** with URL capture, base URL extraction, and highlight support

### 11.3 Nice-to-Have (Convenience)
1. **Computed formulas** (Latest Activity, Meta labels, Duration formatting)
2. **Localization support** for non-English users
3. **Creator's Companion** databases (Content, Channels, Sponsors, etc.)
4. **Book/Reading tracker**
5. **Recipe/Meal planner**
6. **Pipeline Status on People** for sales/CRM workflows

### 11.4 Platform-Specific Considerations

**For Obsidian specifically:**
- **Collections become Bases** — Obsidian's core Bases plugin (`.base` files) is the strongest analog to Notion databases. A Base queries the entire vault and filters notes by their frontmatter properties, producing database-like views without moving files into specific folders. Each of the 8 core collections (Tasks, Notes, Projects, Tags, Goals, Milestones, People, Work Sessions) becomes a Base with appropriate filters (e.g., a `kind: task` property filter for the Tasks base). Notes live wherever makes sense in the vault; Bases surface them contextually — exactly mirroring Notion's "single source of truth with contextual views" pattern.
- **Views become Base views** — A single Base supports multiple views (table, cards, list, map) with independent filters, sorting, and grouping per view. This directly replaces Notion's view tabs. For example, the Tasks collection's GTD views (Inbox, Next Actions, Waiting For, Calendar, Someday) each become a view within the Tasks Base, filtered by the relevant status/list properties. Kanban-style boards are on the Bases roadmap; in the meantime, the Kanban plugin can supplement.
- **Embedded views replace Notion's linked databases** — Bases can be embedded in any note using `![[my-base.base#view-name]]` syntax. When embedded, a special `this file` filter dynamically scopes results to the current note. This is how Area/Resource/Project dashboard pages work: embed the Tasks base with a filter like "project contains this file" and it auto-populates with only that project's tasks. This directly mirrors Notion's template pattern where each Project page has embedded, auto-filtered views of related Tasks, Notes, and People.
- **Formulas replace Notion's computed properties** — Bases support formula properties with arithmetic, date functions (`today()`, `now()`, `duration()`), string manipulation, list operations, conditionals (`if()`), and file introspection (`file.links`, `file.tags`, `file.mtime`). Notion rollups and formula columns translate to Base formulas.
- Relations become `[[wikilinks]]` or YAML frontmatter link properties (e.g., `project: "[[My Project]]"`)
- Properties/metadata live in YAML frontmatter — Bases read and can edit these directly from the table view (a key advantage over Dataview, which is read-only)
- GTD workflow can use the Tasks plugin for due dates, recurrence, and status
- Templates (or Templater plugin) replace database templates — Bases can also act as template generators: clicking "New" in a filtered view creates a note pre-populated with matching properties
- The Daily Notes plugin maps naturally to the Journal note type and My Day workflow
- Tag Types (Area/Resource/Entity) can be frontmatter properties or nested tag hierarchies (`#tags/area/health`)
- Archive can be a folder or an `archived: true` frontmatter property — an Archive Base view simply filters for `status: completed` or `archived: true`
- The "homepage" pattern maps to a single MOC (Map of Content) note with embedded Base views for tasks, notes, projects, and tags
- Side Peek → Obsidian's hover preview or the "Open in new pane" functionality
- My Day's "Clear My Day" button → a Templater script or task query that bulk-resets a `my_day: true` property
- Web clipping → Obsidian Web Clipper extension or Readwise integration
- Books and Recipes → separate Bases filtered by `kind: book` / `kind: recipe` with their own frontmatter schemas, shareable as standalone vaults if needed
- **Dataview as fallback** — For advanced queries beyond what Bases currently supports (complex JavaScript, deeply nested rollups), Dataview remains available as a community plugin. However, Bases covers ~80% of use cases with a much better UX (live editing, GUI filters, no query syntax to learn). As Bases matures (API for plugins, grouping, more view types on the roadmap), the need for Dataview will further diminish.

---

## 12. Summary: The System in One Paragraph

This is a personal productivity system (Ultimate Brain v3.0) that organizes all of life's information and commitments using a **PARA taxonomy** (Areas, Resources, Archive) implemented through a relational **Tags** collection, processes tasks through a **GTD workflow** (Inbox → Clarify → Organize into lists → Execute via My Day), and maintains a strict **Goal → Milestone → Project → Task hierarchy** where goals are aspirational, projects are outcome-defined, and tasks are atomic. Every item lives in exactly one canonical collection and is surfaced contextually through filtered views and relations — ideally from a single homepage. The **My Day** page enforces deliberate daily planning through a plan/execute/clear cycle, while **My Week** provides a structured weekly review. Nothing is deleted — only archived. The system is designed for progressive adoption: the homepage alone covers 80% of daily needs, while specialized dashboards (GTD Process, Goals, CRM, Books, Recipes, Meal Planning) layer on complexity only when sought out.
