# Notion Import Handoff - 2026-03-15

## Executive Summary

The original filename and export-root blockers were fixed earlier on March 15, 2026, and the remaining failure was confirmed to be V8 heap retention in one long-lived Node process using `jsdom`.

That recommendation was implemented in this follow-up session:

- the converter now supports:
  - listing discovered databases
  - converting one database at a time
  - appending into one shared output vault
- the Railway entrypoint now:
  - discovers database folders once
  - runs one fresh Node process per database
  - copies infrastructure once
  - uploads once at the end
- the entrypoint was also hardened to fail fast on errors before upload

Current state as of March 15, 2026:

- the new `notion-import` Railway deployment completed successfully
- the prior OOM failure was real
- the prior deployment uploaded a partial vault because the entrypoint used `set -uo pipefail` instead of `set -euo pipefail`
- the main remaining concern is not memory; it is classification quality for several unrecognized Notion databases that currently fall back to `kind: note`

## Attachment Follow-up

The converter now handles exported local attachments inside the existing import pass instead of relying on a second repair step.

Current attachment strategy:

- local `.html` and `.md` links are still treated as internal page links
- local non-HTML and non-CSV references from `<img src>` and `<a href>` are treated as attachments
- attachment source files are resolved through the byte-safe source index
- target paths preserve cleaned nested subpaths under `Attachments/`
  - example: `Attachments/Notes/assets/photo.png`
- Notion UUID suffixes are stripped from every path segment, not only the basename
- if two cleaned target paths still collide, the later file gets a deterministic short hash suffix
- image references are rewritten to Obsidian embeds:
  - `![[Attachments/...]]`
- local file links such as PDFs are rewritten to Obsidian wikilinks:
  - `[[Attachments/...|Label]]`
- unresolved or ambiguous local attachment refs are left unchanged and logged as warnings

Operationally:

- there is still only one Railway service:
  - `notion-import`
- there is still no second markdown repair pass
- attachment copy conflicts now fail the converter instead of silently continuing

## Recommendation

Do not split this into multiple Railway services.

Keep one `notion-import` service and one sequential per-database import flow.

Recommended next work:

1. review the imported vault content for correctness
2. tighten database name mappings for obviously misclassified folders
3. only re-run the import if those mappings matter enough to justify replacing the current uploaded vault

If memory issues reappear even with per-database splitting, the next escalation should be:

1. replace `jsdom` with a lighter parser such as `cheerio` or `node-html-parser`
2. only after that, consider larger Railway resources or a different execution environment

## What Was Already Done Before This Session

### Earlier code changes

Modified previously:

- `scripts/notion-to-obsidian.ts`
- `scripts/notion-to-obsidian.test.ts`
- `scripts/notion-import-entrypoint.sh`
- `scripts/notion-import-r2.sh`

Implemented earlier in `scripts/notion-to-obsidian.ts`:

- raw byte-path traversal using `Buffer` paths
- `fs.readdirSync(..., { encoding: 'buffer', withFileTypes: true })`
- tolerant filename decoding with Windows-1252 fallback for smart quotes
- logical-path indexing for source files and attachments
- attachment resolution by logical relative path first, basename fallback only when unique
- direct `convert()` export for tests
- incremental file writing instead of buffering all converted pages in memory
- explicit `dom.window.close()` after each page parse
- improved `Databases & Components` candidate ranking so live `[v3] ...` outranks archived `[v3 - fresh] ...`

Implemented earlier in `scripts/notion-to-obsidian.test.ts`:

- switched from spawning `npx tsx` to direct module invocation
- added decoder regression coverage
- added logical-path attachment resolution tests
- added basename-fallback ambiguity test

Implemented earlier in shell scripts:

- fixed zip discovery to use only top-level files:
  - `rclone lsf ... --files-only --max-depth 1 --include "*.zip"`
- removed the old bash symlink workaround from `scripts/notion-import-entrypoint.sh`
  - the converter now handles bad filenames itself and chooses the right v3 root directly

### Earlier Railway changes

Service scope used during debugging:

- project: `fulfilling-adventure`
- environment: `production`
- service: `notion-import`

Operational pattern used throughout:

- all deploys were explicitly scoped to `notion-import`
- the live `nanoclaw` service was never redeployed during this work
- command pattern used:
  - `railway up --service notion-import --environment production ...`
- log checks were also scoped to `notion-import`

Environment changes applied earlier:

- `NODE_OPTIONS=--max-old-space-size=1024`
- later raised to `NODE_OPTIONS=--max-old-space-size=2048`

## Why Iteration Got Faster

Compared with the earliest attempts, iteration sped up for concrete reasons:

- deploys were scoped only to the one-off `notion-import` service
- the main `nanoclaw` service was left alone, avoiding project-wide churn
- the R2 zip-selection bug was fixed early
  - earlier runs could fail before conversion by selecting a folder like `01 Tasks/`
  - after the fix, every run exercised the real import path
- the bash-side symlink workaround was removed once Node had byte-safe traversal
- log checks were narrowed to high-signal events:
  - chosen export root
  - database counts
  - `=== Database ...`
  - `Import Complete`
  - OOM and fatal error lines

In practice, the speedup came from tighter scoping and better failure isolation, not from any special Railway feature.

## What Was Verified Before This Session

### Local verification before follow-up work

Previously passed:

- `npm run typecheck`
- `npx vitest run scripts/notion-to-obsidian.test.ts`

At that earlier handoff point:

- `22` tests were passing

### Earlier Railway verification progression

Observed sequence before this session:

1. Initial failure before converter:
   - zip selector grabbed `01 Tasks/` instead of the export zip
2. After zip-selector fix:
   - converter ran against the real export
   - original Unicode path traversal issue was gone
3. After memory-streaming fix:
   - converter completed on a smaller wrong subtree
   - this exposed root-selection bias toward archived `[v3 - fresh]`
4. After v3 root-ranking fix:
   - converter selected:
     - `[v3] Niven’s Ultimate Brain + Creator’s Companion/Databases & Components`
   - source index size increased to:
     - `4268 source paths`
   - it processed large real databases:
     - `Notes [New] (515 files)`
     - `Tasks [New] (356 files)`
     - `Projects [New] (45 files)`
     - `Tags [New] (41 files)`
5. Failure state at that time:
   - still OOMed at about `2 GB` heap while processing the full live export

## What Was Done In This Session

### Code changes made in this session

Modified in this session:

- `scripts/notion-to-obsidian.ts`
- `scripts/notion-to-obsidian.test.ts`
- `scripts/notion-import-entrypoint.sh`

Implemented in `scripts/notion-to-obsidian.ts`:

- added `--list-databases <input-dir>` CLI mode
- added `--database <logical-path> <input-dir> <output-dir>` CLI mode
- added exported `listDatabases()` helper for discovery and tests
- added `ConvertOptions` so one run can target exactly one logical database
- added quiet discovery mode so shell automation can consume machine-readable database lists
- added `ensureVaultFolders()` to support repeated per-database runs into the same output vault
- changed duplicate filename handling to check real filesystem state, not only in-process memory
  - this matters because each database now runs in a fresh process
- preserved optional infrastructure copying so only the first per-database run copies Bases/Templates/Dashboards/Home

Implemented in `scripts/notion-to-obsidian.test.ts`:

- added regression coverage for sequential single-database conversions
- verified two separate runs can safely append into the same target folder and suffix duplicate filenames

Implemented in `scripts/notion-import-entrypoint.sh`:

- changed the import flow from one long converter invocation to:
  - discover database folders once
  - loop through them sequentially
  - invoke `npx tsx scripts/notion-to-obsidian.ts --database ...` for each
  - skip infrastructure copy after the first run
- changed shell safety from:
  - `set -uo pipefail`
  - to `set -euo pipefail`

That last change is important. Without `-e`, a failed conversion could still fall through to upload and publish a partial vault.

### Partial-upload bug discovered in this session

The previous Railway deployment from March 15, 2026:

- deployment: `f78f2520-4ee0-409d-b2e8-3afb714c1208`
- message: `retry notion import with 2GB node heap`

did **not** complete conversion successfully.

What the logs proved:

- conversion OOMed while processing `Tasks [New]`
- the shell trap logged:
  - `FAILED — sleeping 10 min for SSH debugging...`
- after the 10-minute sleep, the script still reached:
  - `Uploading converted vault to R2...`
  - `=== Import Complete ===`

Conclusion:

- the previous deployment uploaded a partial vault
- that happened because the entrypoint did not exit on converter failure

This is now fixed by `set -euo pipefail`.

## What Was Verified In This Session

### Local verification

Passed in this session:

- `bash -n scripts/notion-import-entrypoint.sh`
- `npx vitest run scripts/notion-to-obsidian.test.ts`

Current local test count:

- `23` passing tests

### Railway verification

Railway context verified in this session:

- workspace: `My Projects`
- project: `fulfilling-adventure`
- environment: `production`
- target service: `notion-import`

Deployment performed in this session:

- deployment: `3b2b8ad7-49dd-412f-9706-2d3859071a26`
- message: `split notion import by database and fail fast on errors`

Result:

- deployment status: `SUCCESS`
- created at: `2026-03-15T16:11:32.202Z`
- reported duration in Railway status: `130`

This confirms the per-database deployment shipped successfully.

## Current Runtime Evidence

As of the end of this session:

- filename decoding is no longer the blocker
- zip extraction is no longer the blocker
- wrong-root selection is no longer the blocker
- single-process memory retention is no longer the active blocker
- partial-upload-on-failure is fixed

The main remaining runtime concern is classification fallback for unrecognized folders.

## Remaining Concern: Unrecognized Folders Defaulting To Notes

The converter currently uses explicit mappings for only a small set of known database names. Any unrecognized database folder that contains HTML pages is currently imported as:

- `kind: note`
- target folder: `02 Notes`

Examples seen in logs:

- `Data Transfer Center`
- `Swipes`
- `Genres`
- `Wiki`
- `Keywords`
- `Meal Planner`

This behavior is safe in the sense that content still imports, but it may be wrong semantically:

- the pages may land in the wrong vault folder
- the frontmatter `kind` may be wrong
- the wrong Bases/Templates assumptions may apply later

My current assessment:

- probably safe as notes:
  - `Wiki`
  - `Swipes`
  - `Data Transfer Center`
  - possibly `Meal Planner`, depending on the actual contents
- likely worth explicit mapping review:
  - `Genres`
  - `Keywords`

Most likely next mapping follow-up:

- map `genres` to `kind: tag`, folder `04 Tags`
- map `keywords` to `kind: tag`, folder `04 Tags`

`Meal Planner` should be inspected before remapping. It may belong in notes, or it may deserve a recipe/planner-specific mapping depending on how those pages are used.

## Current Git State

Relevant modified files at handoff:

- `scripts/notion-import-entrypoint.sh`
- `scripts/notion-to-obsidian.ts`
- `scripts/notion-to-obsidian.test.ts`
- `docs/notion-import-handoff-2026-03-15.md`

This workspace may also contain unrelated untracked files outside this task.

## Recommended Next Steps

1. review the current uploaded vault in Obsidian and confirm the per-database import looks structurally correct
2. inspect the imported output for:
   - `Genres`
   - `Keywords`
   - `Meal Planner`
   - any other unrecognized folders that matter
3. if classification is wrong, add explicit aliases in `DATABASE_MAP`
4. only re-run `notion-import` after those mapping decisions if you want the uploaded vault corrected

## Decision

Based on everything observed across both sessions, the correct direction was:

- **Yes** to splitting the workload into multiple sequential Node processes
- **No** to splitting into multiple Railway services

That approach is now implemented and successfully deployed.
