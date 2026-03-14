---
name: second-brain
description: Second Brain vault conventions for the personal Obsidian vault at /workspace/second-brain. Teaches vault structure, frontmatter schema, entity resolution, and search patterns.
---

# Second Brain

The Second Brain is a personal Obsidian vault mounted at `/workspace/second-brain`. It is separate from the work-related knowledge repository. Follow these conventions when reading, writing, or searching.

## Vault Structure

```
/workspace/second-brain/
  Attachments/       # Images, PDFs, media
  Categories/        # Topic overview notes
  Clippings/         # Content written by others (articles, research)
  References/        # External entities: people, places, products, tools
  Templates/         # Obsidian templates

  # Root-level notes (your own synthesized knowledge)
  Personal goals 2026.md
  Reading list.md
```

## Folder Placement

- **Root** → your own synthesis, analysis, decisions, personal notes
- **References/** → external entities (people, places, products, tools)
- **Clippings/** → someone else's content (articles, reports, docs)
- **Categories/** → hub notes that link to everything in a topic
- **Attachments/** → non-markdown files

## Frontmatter Schema

Every note MUST have YAML frontmatter:

```yaml
---
created: 2026-03-14
type: reference              # reference | clipping | note | category
category:                    # plural, always
  - personal
tags:
  - goals
  - ideas
author: Niven
source: https://...          # URL for clippings
aliases:                     # name variants for entity resolution
  - Alt Name
related:                     # wikilinks to connected notes
  - "[[Reading list]]"
---
```

## Conventions

- **Wikilinks**: Link profusely — even unresolved `[[wikilinks]]` are valuable breadcrumbs
- **Pluralize** categories and tags
- **YYYY-MM-DD** format for all dates
- Follow obsidian-markdown conventions for formatting
- Dated entries within notes use `### YYYY-MM-DD` headings

## Entity Resolution (Mandatory Before Writing)

Never create a note without checking for existing ones first.

1. **Extract the entity/topic name** from the message
2. **List files in the target directory** — scan filenames for matches:
   ```bash
   ls /workspace/second-brain/References/   # for entities
   ls /workspace/second-brain/Clippings/    # for external content
   ls /workspace/second-brain/              # for synthesis (root)
   ```
3. **Search qmd** for the entity name:
   Call `mcp__nanoclaw__search_second_brain` with a lex search for the entity name
4. **Match with tolerance** — case-insensitive, ignore suffixes, treat partial names as potential matches
5. **Decide:**
   - **Clear match** → read the existing file, append/update
   - **Ambiguous** (multiple candidates) → ask the user which note to update
   - **No match** → create a new note, add name variants as aliases in frontmatter

## Searching Second Brain

Use `mcp__nanoclaw__search_second_brain` with appropriate search types:

- **lex**: Exact terms, names, identifiers
- **vec**: Natural language questions
- **hyde**: Hypothetical answer text

Combine `lex` + `vec` for best recall. Add `intent` if the query is ambiguous.
