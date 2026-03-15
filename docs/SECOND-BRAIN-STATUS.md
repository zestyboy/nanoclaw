# Second Brain: Migration Status & Operations Guide

> Summary of the Notion → Obsidian migration and ongoing operational details for the Second Brain vault.

---

## What Was Built

Niven's personal Notion "Ultimate Brain v3.0" productivity system was migrated into an Obsidian vault. The vault lives on Railway's persistent volume as the working copy, with Cloudflare R2 as a 12-hour backup.

## Architecture

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

Both `public-knowledge` and `second-brain` vaults follow this same pattern.

---

## Vault Contents

~1,393 objects on R2:
- 359 tasks, 577 notes, 46 projects, 42 tags, 2 goals, 2 people, 9 work sessions, 4 books, 6 recipes
- 314 attachments (images, PDFs) under `Attachments/`
- 10 Bases (`.base` files), 11 Templates, 4 Dashboards, `Home.md`
- The original Notion export zip (excluded from sync)

## Vault Structure

```
second-brain/
├── 00 Inbox/          ← new captures
├── 01 Tasks/          ← kind: task
├── 02 Notes/          ← kind: note
├── 03 Projects/       ← kind: project
├── 04 Tags/           ← kind: tag (Areas, Resources, Entities)
├── 05 Goals/          ← kind: goal
├── 06 Milestones/     ← kind: milestone
├── 07 People/         ← kind: person
├── 08 Work Sessions/  ← kind: work-session
├── 09 Books/          ← kind: book
├── 10 Recipes/        ← kind: recipe
├── Attachments/       ← images, PDFs
├── Bases/             ← .base files (database views)
├── Templates/         ← note creation templates
├── Dashboards/        ← My Day, GTD Process, My Week, Archive
└── Home.md            ← central MOC with embedded views
```

**Key principle:** The `kind` frontmatter property is the primary discriminator, not folders. Bases filter by `kind`.

---

## Sync Model

| Vault | Startup | Background | On-demand |
|-------|---------|------------|-----------|
| public-knowledge | Restore from R2 if volume empty | Railway → R2 backup every 12h | Agent reindex after writes |
| second-brain | Restore from R2 if volume empty | Railway → R2 backup every 12h | Agent reindex after writes |

Railway volume is the working copy. R2 is only a backup. NanoClaw agents write directly to `/data/second-brain` on Railway. If the Railway volume is ever wiped (infrastructure change, redeployment with volume reset), it restores from the latest R2 backup on startup.

Configured in: `docker-entrypoint-railway.sh`

---

## Key Files

| File | Purpose |
|------|---------|
| `docker-entrypoint-railway.sh` | Startup restore from R2, 12h backup loop, qmd indexing |
| `scripts/notion-to-obsidian.ts` | Custom Notion HTML → Obsidian converter (byte-safe paths, per-database processing, attachment extraction) |
| `scripts/normalize-vault.ts` | Post-import cleanup (strip Notion formula properties, normalize dates) |
| `scripts/notion-import-entrypoint.sh` | Railway import service entrypoint |
| `Dockerfile.notion-import` | One-off Railway service for running imports |
| `docs/SECOND-BRAIN-BUILD-GUIDE.md` | Master build guide (vault architecture, folder layout, dummy vault specs) |
| `docs/obsidian-migration-plan.md` | 8-phase implementation plan (Base specs, templates, property mappings) |
| `docs/second-brain-analysis-new.md` | Platform-agnostic blueprint of the Ultimate Brain system (8 collections, properties, relationships) |
| `docs/notion-import-handoff-2026-03-15.md` | Detailed handoff notes from the import process |

---

## Railway Services

| Service | Purpose | Status |
|---------|---------|--------|
| **nanoclaw** | Live NanoClaw service, reads/writes `/data/second-brain` | Running |
| **notion-import** | One-off import service for processing Notion exports | Can be torn down |

---

## Property Naming Conventions

- All property names: `snake_case`
- All `kind` values: lowercase (`task`, `note`, `project`, `tag`, `goal`, `milestone`, `person`, `work-session`, `book`, `recipe`)
- Status values: Title Case (`To Do`, `Doing`, `Done`)
- Priority values: include code (`Critical (P1)`, `High (P2)`, `Medium (P3)`, `Low (P4)`)
- Dates: `YYYY-MM-DD`
- Relations/links: `"[[Note Name]]"` format with quotes in YAML
- Lists: YAML arrays `["[[A]]", "[[B]]"]`

---

## How NanoClaw Agents Interact with the Vault

### Storing
The Brain Router detects `SECOND_BRAIN` intent and writes markdown files with proper frontmatter to `/data/second-brain/`. After writing, it calls `reindex_second_brain` (fire-and-forget) to update the qmd search index.

### Searching
Agents call `search_second_brain` MCP tool which uses qmd for lexical + vector + hybrid search across the vault.

### Key integration points
| Component | File | Purpose |
|-----------|------|---------|
| `SECOND_BRAIN_DIR` config | `src/config.ts` | Path to vault (defaults to `/data/second-brain` on Railway) |
| Container mounts | `src/container-runner.ts` | Main group = read-write, others = read-only |
| `search_second_brain` MCP tool | `container/agent-runner/src/ipc-mcp-stdio.ts` | Search via qmd |
| `reindex_second_brain` MCP tool | `container/agent-runner/src/ipc-mcp-stdio.ts` | Trigger reindex after writes |
| Brain Router prompt | `groups/main/CLAUDE.md` | SECOND_BRAIN intent handling |
| Second Brain skill | `container/skills/second-brain/SKILL.md` | Vault conventions for agents |

---

## How to Re-run the Notion Import

If you ever need to re-import from Notion:

1. Export from Notion (HTML format) on a personal device
2. Upload zip to `r2:second-brain` via Cloudflare dashboard
3. Redeploy the `notion-import` Railway service: `railway redeploy --service notion-import --yes`
4. It processes the zip and uploads the vault back to R2
5. Clear the Railway volume and restart the main nanoclaw service to restore from R2

---

## Known Gaps

- **0 milestones** imported — likely none existed in the Notion workspace
- **15 unresolved image refs** in Notes [New] — left unchanged, low priority
- **Misclassified folders** — Wiki, Swipes, Keywords, Genres, Meal Planner defaulted to `kind: note`. Genres/Keywords could be reclassified to `kind: tag` if desired
- **No local vault with real data** — the local `second-brain-dev/` vault has only infrastructure (Bases, Templates, Dashboards) with no imported content, to keep personal data off the work laptop

---

## R2 Credentials

Account API token (created 2026-03-15), set on Railway as `R2_ACCESS_KEY` / `R2_SECRET_KEY`. The same token covers both `public-knowledge` and `second-brain` buckets (scoped to all buckets in the account).

---

## Migration Timeline

| Date | Milestone |
|------|-----------|
| 2026-03-14 | Dummy vault built (Bases, Templates, Dashboards, Home.md, 38 fake data files) |
| 2026-03-14 | All Base views validated in Obsidian (17+ views, rollup chains, `this` file scoping) |
| 2026-03-15 | Custom Notion HTML converter built and tested (29 tests) |
| 2026-03-15 | Railway `notion-import` service created and deployed |
| 2026-03-15 | Notion export processed on Railway — 1,050+ pages converted |
| 2026-03-15 | Post-import normalization (975 files cleaned: junk properties stripped, dates normalized) |
| 2026-03-15 | Attachment extraction (314 files, image/file refs rewritten to Obsidian format) |
| 2026-03-15 | Sync model flipped: Railway = working copy, R2 = 12h backup |
| 2026-03-15 | Feature branch merged to main |
