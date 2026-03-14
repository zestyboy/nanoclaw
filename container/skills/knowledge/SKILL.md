---
name: knowledge
description: Knowledge repository conventions for the Obsidian vault at /workspace/knowledge. Teaches vault structure, frontmatter schema, entity resolution, and search patterns.
---

# Knowledge Repository

The knowledge vault is an Obsidian vault mounted at `/workspace/knowledge`. Follow these conventions when reading, writing, or searching knowledge.

## Vault Structure

```
/workspace/knowledge/
  Attachments/       # Images, PDFs, media
  Categories/        # Topic overview notes that link to everything in a category
  Clippings/         # Content written by others (articles, research)
  References/        # External entities: companies, products, people, tools
  Templates/         # Obsidian templates

  # Root-level notes (your own synthesized knowledge)
  Pricing strategy.md
  Market positioning Q2 2026.md
```

## Folder Placement

- **Root** → your own synthesis, analysis, decisions
- **References/** → external entities (companies, people, products, competitors)
- **Clippings/** → someone else's content (articles, reports, docs)
- **Categories/** → hub notes that link to everything in a topic
- **Attachments/** → non-markdown files

## Frontmatter Schema

Every note MUST have YAML frontmatter:

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

## Conventions

- **Wikilinks**: Link profusely — even unresolved `[[wikilinks]]` are valuable breadcrumbs
- **Pluralize** categories and tags (e.g., `competitors` not `competitor`)
- **YYYY-MM-DD** format for all dates
- Follow obsidian-markdown conventions for formatting
- Dated entries within notes use `### YYYY-MM-DD` headings

## Entity Resolution (Mandatory Before Writing)

Never create a note without checking for existing ones first.

1. **Extract the entity/topic name** from the message
2. **List files in the target directory** — scan filenames for matches:
   ```bash
   ls /workspace/knowledge/References/   # for entities
   ls /workspace/knowledge/Clippings/    # for external content
   ls /workspace/knowledge/              # for synthesis (root)
   ```
3. **Search qmd** for the entity name (catches mentions even if filename differs):
   Call `mcp__nanoclaw__search_knowledge` with a lex search for the entity name
4. **Match with tolerance** — these all refer to the same entity:
   - `Acme Corp.md` ↔ "Acme" ↔ "ACME Corporation" ↔ "Acme Corp Inc"
   - Case-insensitive, ignore suffixes (Corp, Inc, Ltd), treat partial names as potential matches
5. **Decide:**
   - **Clear match** → read the existing file, append/update
   - **Ambiguous** (multiple candidates) → ask the user which note to update
   - **No match** → create a new note, add name variants as aliases in frontmatter

## Searching Knowledge

Use `mcp__nanoclaw__search_knowledge` with appropriate search types:

- **lex**: Exact terms, names, identifiers (e.g., `"competitor pricing"`, `"\"Acme Corp\""`)
- **vec**: Natural language questions (e.g., `"what pricing strategies are competitors using"`)
- **hyde**: Hypothetical answer text (e.g., `"competitors charge $25-35 per seat"`)

Combine `lex` + `vec` for best recall. The first search gets 2x weight. Add `intent` if the query is ambiguous.

## Template Evolution

1. **Track structure during ingestion.** Check `/workspace/knowledge/Templates/` and scan recent notes of the same type for recurring patterns
2. **Detect patterns.** After 3+ notes of the same type share a recurring structure (similar sections, same frontmatter fields, same folder), propose a template to the user
3. **Propose, don't act.** Describe the proposed template and wait for confirmation. Never create templates silently
4. **Create on approval.** Write to `/workspace/knowledge/Templates/{name}.md` using Obsidian template format with `{{date}}` and `{{title}}` placeholders
5. **Refine over time.** When usage patterns drift from an existing template, suggest updating it
