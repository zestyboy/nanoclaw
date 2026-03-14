# Knowledge Repository — Implementation Plan

A searchable Obsidian vault integrated into the Brain Router system. Information is ingested via the Brain Router's messaging interface and organized following [Kepano's vault methodology](https://stephango.com/vault). Search is powered by [qmd](https://github.com/tobi/qmd) running as a local HTTP server. Both the Brain Router and project agents can query the knowledge base.

---

## Prerequisites

Before implementing, read these files to understand the existing system and the patterns this plan builds on:

| File | Why |
|------|-----|
| `docs/BRAIN-ROUTER.md` | Full architecture of the Brain Router system — routing, intents, project creation, message flow. This plan adds a KNOWLEDGE intent alongside the existing CATALOG and EXECUTE intents. |
| `src/ipc.ts` | IPC handler structure. Study the `execute_in_group` and `create_project` cases — the new `search_knowledge` and `reindex_knowledge` handlers follow the same pattern. Note the `IpcDeps` interface and authorization model (`sourceGroup.isMain`). |
| `src/container-runner.ts` | Container mount system. Study `buildVolumeMounts()`, especially the `isMain` block where main group gets extra mounts (`/workspace/all-groups`, `/workspace/projects`). The knowledge vault mount follows this same pattern. |
| `src/config.ts` | Configuration constants. `PROJECTS_DIR` is the model for `KNOWLEDGE_DIR`. |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tool definitions. Study existing tools (`execute_in_group`, `create_project`) for the pattern — each tool writes an IPC task file that the host picks up. `search_knowledge` and `reindex_knowledge` follow the same structure. |
| `groups/main/CLAUDE.md` | Current Brain Router prompt. This plan adds KNOWLEDGE intent detection, entity resolution, knowledge storage/search sections, and template evolution instructions to this file. |
| `container/skills/agent-browser/SKILL.md` | Example container skill. The knowledge skill (`container/skills/knowledge/SKILL.md`) follows this format — a SKILL.md prompt document that teaches agents conventions and capabilities. |

**External references:**
- [kepano-obsidian vault](https://github.com/kepano/kepano-obsidian) — Template vault to clone for initialization
- [qmd SKILL.md](https://github.com/tobi/qmd/blob/main/skills/qmd/SKILL.md) — qmd's full API reference (query types, HTTP endpoint, CLI commands, MCP tools)
- [Kepano's vault methodology](https://stephango.com/vault) — Vault organization philosophy (folder structure, properties, linking, templates)
- [obsidian-skills](https://github.com/kepano/obsidian-skills) — Agent skills for Obsidian markdown, defuddle, CLI, bases, canvas (separate upstream skills referenced by the knowledge skill)

---

## Architecture Overview

```
User (WhatsApp/Telegram)
  │
  ▼
Brain Router (main group)
  │
  ├─ KNOWLEDGE intent → writes to knowledge vault (Obsidian markdown)
  │                      triggers qmd re-embed (fire-and-forget)
  │
  ├─ EXECUTE + "pull from knowledge" → searches qmd, prepends results
  │                                     to execute_in_group prompt
  │
  └─ CATALOG / EXECUTE (no knowledge signal) → existing behavior unchanged

Project Agent (any group)
  │
  ├─ /workspace/knowledge (read-only mount)
  ├─ search_knowledge MCP tool → host IPC → qmd HTTP API
  └─ Only searches when user explicitly asks
```

---

## Components

### 1. Knowledge Vault Directory

**Location:** `~/knowledge` (configurable via `NANOCLAW_KNOWLEDGE_DIR` env var)

**Structure (Kepano's system):**
```
~/knowledge/
  .obsidian/              # Obsidian config (from kepano-obsidian template)
  Attachments/            # Images, PDFs, media
  Categories/             # Topic overview notes that link to everything in a category
  Clippings/              # Content written by others (articles, research)
  References/             # External entities: companies, products, people, tools
  Templates/              # Obsidian templates (shipped with kepano-obsidian)

  # Root-level notes (your own synthesized knowledge)
  Pricing strategy.md
  Market positioning Q2 2026.md
```

**Folder placement rules:**
- Root → your own synthesis, analysis, decisions
- `References/` → external entities (companies, people, products, competitors)
- `Clippings/` → someone else's content (articles, reports, docs)
- `Categories/` → hub notes that link to everything in a topic
- `Attachments/` → non-markdown files

**Templates:** Start with whatever ships in the kepano-obsidian vault. Templates evolve organically as usage patterns emerge — the knowledge skill teaches conventions, not rigid structures.

**Initialize** via the `/add-knowledge` setup skill (see Phase 1).

### 2. Knowledge Container Skill

**File:** `container/skills/knowledge/SKILL.md`

A prompt document that teaches container agents the vault conventions. Loaded by both the Brain Router agent (for writing) and project agents (for reading/interpreting search results).

**Contents:**
- Vault structure and folder placement rules
- Frontmatter schema (based on Kepano's property system)
- Wikilink conventions — link profusely, even unresolved links
- Naming conventions (pluralize categories/tags, YYYY-MM-DD dates)
- Entity resolution and deduplication (lookup-before-write process, see below)
- Category maintenance (when to update category hub notes)
- qmd search patterns (how to construct good queries using lex/vec/hyde types)
- Template evolution process (see below)

**Frontmatter schema:**
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
related:                     # wikilinks to connected notes
  - "[[Product roadmap]]"
  - "[[Competitor A]]"
---
```

**Entity resolution (lookup-before-write):**

The Brain Router is stateless between sessions — it has no memory of what it named a file last week. Without an explicit lookup step, saying "Acme Corp" on Monday and "Acme" on Thursday could create duplicate notes. The knowledge skill encodes a mandatory lookup-before-write process:

1. **Extract the entity/topic name** from the user's message. Identify what the note would be *about* (e.g., "Acme Corp", "SaaS pricing trends", "the design system").

2. **List files in the target directory.** If the entity looks like a company → `ls /workspace/knowledge/References/`. If it's a clipping → `ls /workspace/knowledge/Clippings/`. If synthesis → `ls /workspace/knowledge/` (root). Scan filenames for matches.

3. **Search qmd for the entity name.** This catches notes that mention the entity even if the filename differs. Use a lex search with the entity name:
   ```json
   { "searches": [{ "type": "lex", "query": "\"Acme Corp\"" }], "limit": 3 }
   ```

4. **Match with tolerance.** The agent must recognize that these all refer to the same entity:
   - `Acme Corp.md` ↔ "Acme" ↔ "ACME Corporation" ↔ "Acme Corp Inc"
   - Matching is case-insensitive, ignores suffixes (Corp, Inc, Ltd), and treats partial names as potential matches

5. **Decide:**
   - **Clear match** (one file, name is obviously the same entity) → read the file, append/update
   - **Ambiguous** (multiple possible matches) → ask the user: "Did you mean **Acme Corp** (References) or **Acme Analytics** (References)?"
   - **No match** → create a new note

6. **Use Obsidian aliases for variant names.** When creating a new note, if the user's phrasing differs from the chosen filename, add the variant as an alias in frontmatter:
   ```yaml
   aliases:
     - ACME
     - Acme Corporation
   ```
   This helps both Obsidian (link suggestions) and future lookups.

This process is part of the knowledge skill instructions, not application code. The Brain Router agent follows it on every KNOWLEDGE intent before writing anything.

**Template evolution process:**

The vault starts with no custom templates — just the defaults from kepano-obsidian. Templates emerge from actual usage patterns rather than upfront design. The knowledge skill includes instructions for this feedback loop:

1. **Track structure during ingestion.** Every time the Brain Router creates or updates a knowledge note, it reads `/workspace/knowledge/Templates/` to see what templates exist. It also scans recent notes of the same type (e.g., `References/` files with `category: competitors`) to see what sections and frontmatter they share.

2. **Detect patterns.** When the Brain Router notices it has created 3+ notes of the same type with a recurring structure (similar sections, same frontmatter fields, same folder), it flags this to the user:

   > "I've now created 3 competitor reference notes with similar structure (Overview, Products, Pricing, Positioning). Want me to create a **Competitor** template so future notes start from a consistent base?"

3. **Propose, don't act.** The Brain Router describes the proposed template (sections, frontmatter fields, folder placement) and waits for confirmation. It never creates templates silently.

4. **Create on approval.** If the user confirms, the Brain Router writes the template to `/workspace/knowledge/Templates/{name}.md` using Obsidian's template format. Future notes of that type use it as a starting point.

5. **Refine over time.** When the user stores knowledge that deviates from an existing template (adds new sections, drops unused ones), the Brain Router may suggest updating the template:

   > "Your last 2 company notes included a 'Funding History' section that isn't in the Competitor template. Want me to add it?"

The skill encodes these rules so the Brain Router knows when to suggest, what threshold to use (3+ similar notes), and how to phrase the proposal. The goal is that the template library reflects how you *actually* organize knowledge, not how someone predicted you would.

**Relationship to obsidian skills:**
The knowledge skill references the [obsidian-skills](https://github.com/kepano/obsidian-skills) package for markdown syntax (obsidian-markdown) and web content extraction (defuddle). These are separate, upstream-updatable skills. The knowledge skill adds vault-specific conventions and Brain Router integration on top.

The Obsidian CLI skill is not part of this system — Obsidian's built-in search is rudimentary and qmd is the primary search path. If an Obsidian community plugin with advanced search is later installed manually, the CLI could serve as a backup search path, but that's a future consideration outside this plan.

### 3. Config & Environment

**File:** `src/config.ts`

Add:
```typescript
export const KNOWLEDGE_DIR =
  process.env.NANOCLAW_KNOWLEDGE_DIR ||
  path.join(HOME_DIR, 'knowledge');
```

**File:** `.env` / `.env.example`

Add:
```
# Knowledge repository
NANOCLAW_KNOWLEDGE_DIR=~/knowledge
QMD_HTTP_URL=http://127.0.0.1:8181
```

### 4. Container Mounts

**File:** `src/container-runner.ts` — `buildVolumeMounts()`

**Main group** — read-write access for ingestion:
```typescript
// Main gets writable access to knowledge vault for ingestion
if (fs.existsSync(KNOWLEDGE_DIR)) {
  mounts.push({
    hostPath: KNOWLEDGE_DIR,
    containerPath: '/workspace/knowledge',
    readonly: false,
  });
}
```

**Non-main groups** — read-only access (opt-in search):
```typescript
// All groups get read-only access to knowledge vault
if (fs.existsSync(KNOWLEDGE_DIR)) {
  mounts.push({
    hostPath: KNOWLEDGE_DIR,
    containerPath: '/workspace/knowledge',
    readonly: true,
  });
}
```

### 5. qmd Setup & Background Service

**Installation:**
```bash
npm install -g @tobilu/qmd
```

**Add collection and build embeddings:**
```bash
qmd collection add ~/knowledge --name knowledge
qmd embed
```

**Run as HTTP server** (persistent, keeps models loaded):
```bash
qmd serve
```

Default port is 8181. The HTTP API endpoint:
```bash
curl -X POST http://localhost:8181/query \
  -H "Content-Type: application/json" \
  -d '{"searches": [{"type": "lex", "query": "competitor pricing"}], "collections": ["knowledge"], "limit": 5}'
```

**Background service (launchd):**

Create `~/Library/LaunchAgents/com.nanoclaw.qmd.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nanoclaw.qmd</string>
  <key>ProgramArguments</key>
  <array>
    <string>qmd</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/qmd.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/qmd.err</string>
</dict>
</plist>
```

**Why HTTP and not qmd's MCP server mode:**
qmd also supports running as an MCP server directly. However, NanoClaw containers communicate with the host exclusively through IPC files — there's no MCP transport bridge from container to host services. Using qmd's HTTP API through the existing IPC handler pattern keeps everything within the NanoClaw framework. The host process calls qmd's HTTP endpoint on behalf of the container agent, same as how `execute_in_group` and `create_project` work. If NanoClaw later gains MCP-over-network support for containers, qmd's MCP mode could replace the HTTP+IPC approach.

### 6. `search_knowledge` MCP Tool

**File:** `container/agent-runner/src/ipc-mcp-stdio.ts`

Add a new MCP tool available to all groups:

```typescript
{
  name: 'search_knowledge',
  description: 'Search the knowledge repository using qmd. Returns relevant documents and snippets. Only use when the user explicitly asks to search or pull from the knowledge base.',
  inputSchema: {
    type: 'object',
    properties: {
      searches: {
        type: 'array',
        description: 'Array of search objects. Each has "type" (lex|vec|hyde) and "query". Use lex for exact terms/keywords, vec for natural language questions, hyde for hypothetical answer text. First search gets 2x weight.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['lex', 'vec', 'hyde'] },
            query: { type: 'string' },
          },
          required: ['type', 'query'],
        },
      },
      intent: {
        type: 'string',
        description: 'Optional disambiguation hint when query terms are ambiguous (e.g., "web page performance" vs "team performance")',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default: 10)',
      },
    },
    required: ['searches'],
  },
}
```

**IPC flow:**
1. Agent calls `search_knowledge` MCP tool
2. Tool writes IPC task file with `type: 'search_knowledge'`
3. Host IPC handler picks it up, calls qmd HTTP endpoint at `POST /query`
4. Results written back to IPC response file
5. Agent receives search results as structured JSON

**File:** `src/ipc.ts` — add handler:

```typescript
case 'search_knowledge': {
  const { searches, intent, limit = 10 } = data;
  try {
    const qmdUrl = process.env.QMD_HTTP_URL || 'http://127.0.0.1:8181';
    const body: Record<string, unknown> = {
      searches,
      collections: ['knowledge'],
      limit,
    };
    if (intent) body.intent = intent;
    const response = await fetch(`${qmdUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const results = await response.json();
    return { success: true, results };
  } catch (err) {
    return { success: false, error: 'Knowledge search unavailable — is qmd running?' };
  }
}
```

### 7. `reindex_knowledge` IPC Handler

**File:** `src/ipc.ts`

Triggered after the Brain Router writes a new knowledge file. Runs as fire-and-forget — the agent doesn't wait for completion.

```typescript
case 'reindex_knowledge': {
  // Main-only: only the Brain Router should trigger reindexing
  if (!sourceGroup?.isMain) {
    return { success: false, error: 'Only main group can trigger reindex' };
  }
  // Fire-and-forget: spawn background process, don't await
  const { spawn } = await import('child_process');
  const child = spawn('qmd', ['embed'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { success: true, message: 'Reindex started in background' };
}
```

**MCP tool** (in `ipc-mcp-stdio.ts`):
```typescript
{
  name: 'reindex_knowledge',
  description: 'Trigger re-indexing of the knowledge repository after adding or updating files. Runs in background (fire-and-forget). Main group only.',
  inputSchema: { type: 'object', properties: {} },
}
```

### 8. Brain Router Prompt Update

**File:** `groups/main/CLAUDE.md`

Add KNOWLEDGE intent and search capabilities to the existing Brain Router prompt.

**Changes to "On Every Message" section:**
```markdown
## On Every Message

1. Read `/workspace/group/projects.yaml` to get the current project list
2. Classify the message to the best-matching project using name, aliases, and brief
3. Determine intent: CATALOG (default), EXECUTE, or KNOWLEDGE
```

**New "Intent Detection" entry:**
```markdown
- **KNOWLEDGE**: User wants to store or retrieve from the knowledge repository.
  - Store signals: "save to knowledge", "add to knowledge base", "store this",
    "remember this for reference", "knowledge:"
  - Search signals: "search knowledge", "pull from knowledge", "check knowledge base",
    "what do I know about"
```

**New "Knowledge Mode" section:**
```markdown
## Knowledge Mode

### Storing Knowledge

When the user wants to save information to the knowledge vault:

1. **Determine note type and placement:**
   - External entity (company, person, product, tool)? → `References/`
   - Someone else's content (article, report, doc)? → `Clippings/`
   - Your own synthesis, analysis, or decision? → vault root

2. **Resolve entity (mandatory — never skip):**
   - Extract the entity/topic name from the message
   - List files in the target directory for filename matches
   - Search qmd with a lex query for the entity name (catches notes where
     the entity is mentioned but the filename differs)
   - Match with tolerance: case-insensitive, ignore corporate suffixes
     (Corp, Inc, Ltd), treat partial names as potential matches
   - **Clear match** → read the existing file, append or update
   - **Ambiguous** (multiple candidates) → ask the user which note to update
   - **No match** → create a new note, add name variants as aliases in frontmatter

3. **Write the note following vault conventions:**
   - YAML frontmatter with type, category, tags, related
   - Wikilinks to related notes (even if they don't exist yet)
   - Pluralize categories and tags
   - YYYY-MM-DD format for all dates
   - Follow obsidian-markdown conventions for formatting
4. Call `mcp__nanoclaw__reindex_knowledge` to update the search index
5. Confirm: "Saved to knowledge → {note name} ({folder})"

### Searching Knowledge

When the user asks to search the knowledge base (standalone query):

1. Call `mcp__nanoclaw__search_knowledge` with appropriate search types:
   - Use `lex` for exact terms, names, identifiers
   - Use `vec` for natural language questions
   - Combine `lex` + `vec` for best recall
   - Add `intent` if the query is ambiguous
2. Summarize the results concisely
3. Include note names as reference

### Injecting Knowledge into Execute

When the user asks to execute AND pull from knowledge:

1. Call `mcp__nanoclaw__search_knowledge` with relevant terms
2. Format the results as context
3. Prepend to the execute prompt:
   ```
   [Knowledge context from repository:]
   {search results}

   [Task:]
   {original execute prompt}
   ```
4. Dispatch via `mcp__nanoclaw__execute_in_group` as usual
```

**New "Rules" entries:**
```markdown
- When storing knowledge, always check for existing notes before creating new ones.
- Link profusely — even unresolved [[wikilinks]] are valuable breadcrumbs.
- Default note placement: References/ for entities, Clippings/ for external content, root for synthesis.
```

### 9. `/add-knowledge` Setup Skill

**File:** `.claude/skills/add-knowledge/SKILL.md`

A NanoClaw setup skill (consistent with `/add-whatsapp`, `/add-discord`, `/add-telegram`) that handles:

1. **Vault initialization**
   - Clone [kepano-obsidian](https://github.com/kepano/kepano-obsidian) to `~/knowledge` (or `NANOCLAW_KNOWLEDGE_DIR`)
   - Open the vault in Obsidian to verify it works
   - User can customize settings/plugins in Obsidian as desired

2. **qmd installation & indexing**
   - `npm install -g @tobilu/qmd`
   - `qmd collection add ~/knowledge --name knowledge`
   - `qmd embed` (initial embedding generation)
   - Verify: `qmd status`

3. **NanoClaw integration**
   - Add `KNOWLEDGE_DIR` to `src/config.ts`
   - Add `QMD_HTTP_URL` to `.env`
   - Add knowledge vault mounts in `src/container-runner.ts`
   - Create `container/skills/knowledge/SKILL.md`
   - Add `search_knowledge` and `reindex_knowledge` IPC handlers + MCP tools
   - Update Brain Router prompt in `groups/main/CLAUDE.md`

4. **Background service**
   - Create `~/Library/LaunchAgents/com.nanoclaw.qmd.plist`
   - `launchctl load ~/Library/LaunchAgents/com.nanoclaw.qmd.plist`
   - Verify: `curl http://127.0.0.1:8181/status` (or equivalent health check)

5. **Build & verify**
   - `npm run build`
   - Rebuild container: `./container/build.sh`
   - Restart NanoClaw

---

## Implementation Order

### Phase 1: Foundation
1. Create `/add-knowledge` setup skill
2. Run the skill to initialize vault (clone kepano-obsidian to `~/knowledge`)
3. Add `KNOWLEDGE_DIR` to `src/config.ts`
4. Add knowledge vault mounts to `src/container-runner.ts` (read-write for main, read-only for others)
5. Create `container/skills/knowledge/SKILL.md` with vault conventions
6. Build and verify mounts work

### Phase 2: Ingestion
7. Add KNOWLEDGE intent to `groups/main/CLAUDE.md` (Brain Router prompt)
8. Test: send "save to knowledge: Competitor X raised $50M" → verify file written correctly to vault with proper frontmatter and wikilinks

### Phase 3: Search
9. Install qmd, add knowledge collection, build embeddings
10. Add `search_knowledge` IPC handler in `src/ipc.ts`
11. Add `search_knowledge` MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts`
12. Add `reindex_knowledge` IPC handler + MCP tool (fire-and-forget)
13. Update Brain Router prompt with search/inject sections
14. Set up qmd as launchd background service
15. Test: send "search knowledge for competitor pricing" → verify results returned
16. Test: send "for my-project: build pricing page, pull from knowledge" → verify knowledge context injected into execute prompt

### Phase 4: Polish
17. Verify project agents can call `search_knowledge` when explicitly asked
18. Rebuild container image with updated agent-runner
19. End-to-end test: ingest → reindex → search → inject into execute

---

## Use Case Walkthroughs

These scenarios illustrate how the knowledge repository works in practice through the Brain Router. The primary interface is Discord (Brain Router's main channel for WhatsApp/Telegram, project channels for execution).

### UC1: Store new knowledge (new entity)

**You (Brain Router channel):**
> save to knowledge: Acme Corp just announced they're sunsetting their free tier effective Q3 2026. Moving to a $29/seat minimum. Their CEO posted about it on LinkedIn today.

**Brain Router detects** KNOWLEDGE intent (signal: "save to knowledge").

**Entity resolution:**
- Entity: "Acme Corp" — external company → `References/`
- Lists `References/` directory — no `Acme Corp.md`
- Searches qmd: `{ "searches": [{ "type": "lex", "query": "\"Acme Corp\"" }] }` — no results
- No match → create new note

**Brain Router writes** `/workspace/knowledge/References/Acme Corp.md`:
```markdown
---
created: 2026-03-13
type: reference
category:
  - companies
tags:
  - pricing
  - competitors
aliases:
  - Acme
related:
  - "[[Pricing strategy]]"
---

# Acme Corp

## Notes

### 2026-03-13

Announced sunsetting of free tier effective Q3 2026. Moving to $29/seat minimum. CEO posted about it on LinkedIn.
```

**Brain Router calls** `reindex_knowledge` (fire-and-forget).

**You receive:**
> Saved to knowledge → Acme Corp (References)

---

### UC2: Update existing knowledge (entity resolution across sessions)

**You (Brain Router channel), two weeks later:**
> knowledge: Acme Q1 earnings are out. Revenue up 34% YoY, 12k paying customers. They're investing heavily in AI features.

**Brain Router detects** KNOWLEDGE intent. Note the user said "Acme", not "Acme Corp".

**Entity resolution:**
- Entity: "Acme" — external company → `References/`
- Lists `References/` — sees `Acme Corp.md` (fuzzy match: "Acme" ⊂ "Acme Corp")
- Searches qmd: `{ "searches": [{ "type": "lex", "query": "\"Acme\"" }] }` — returns `Acme Corp.md`
- Clear match → read existing file, append

**Brain Router appends** to `/workspace/knowledge/References/Acme Corp.md`:
```markdown
### 2026-03-27

Q1 earnings: revenue up 34% YoY, 12k paying customers. Investing heavily in AI features.
```

Also adds `earnings` to tags and `[[AI features]]` to related (unresolved wikilink — breadcrumb for future).

**Brain Router calls** `reindex_knowledge`.

**You receive:**
> Updated knowledge → Acme Corp (References)

---

### UC3: Store a clipping (URL/article)

**You (Brain Router channel):**
> save to knowledge: https://example.com/blog/state-of-saas-pricing-2026

**Brain Router detects** KNOWLEDGE intent. Sees a URL. Uses defuddle (from obsidian-skills) to extract clean markdown from the page. This is someone else's content → `Clippings/`.

**Brain Router writes** `/workspace/knowledge/Clippings/State of SaaS Pricing 2026.md`:
```markdown
---
created: 2026-03-13
type: clipping
source: https://example.com/blog/state-of-saas-pricing-2026
author: Jane Smith
category:
  - articles
tags:
  - pricing
  - saas
  - market-research
related:
  - "[[Acme Corp]]"
  - "[[Pricing strategy]]"
---

# State of SaaS Pricing 2026

[extracted article content, cleaned up by defuddle]
```

**You receive:**
> Saved to knowledge → State of SaaS Pricing 2026 (Clippings)

---

### UC4: Store your own synthesis

**You (Brain Router channel):**
> save to knowledge: After looking at Acme, Globex, and Initech pricing, I think the market is converging on $25-35/seat for mid-market. Free tiers are disappearing. Our positioning should emphasize the free tier as a differentiator while it still exists.

**Brain Router detects** KNOWLEDGE intent. This isn't about an external entity — it's your own analysis → vault root.

**Brain Router writes** `/workspace/knowledge/Mid-market pricing convergence.md`:
```markdown
---
created: 2026-03-13
type: note
category:
  - analysis
tags:
  - pricing
  - market-research
  - positioning
related:
  - "[[Acme Corp]]"
  - "[[Globex]]"
  - "[[Initech]]"
  - "[[Pricing strategy]]"
---

# Mid-market pricing convergence

Market is converging on $25-35/seat for mid-market SaaS. Free tiers are disappearing (Acme sunsetted theirs Q3 2026).

Our positioning should emphasize the free tier as a differentiator while it still exists.
```

Note the wikilinks to `[[Globex]]` and `[[Initech]]` — these don't exist yet as notes. They're breadcrumbs. When you later save knowledge about those companies, the links resolve automatically in Obsidian.

**You receive:**
> Saved to knowledge → Mid-market pricing convergence (root)

---

### UC5: Search knowledge from Brain Router

**You (Brain Router channel):**
> what do I know about competitor pricing?

**Brain Router detects** KNOWLEDGE search intent (signal: "what do I know about").

**Brain Router calls** `search_knowledge`:
```json
{
  "searches": [
    { "type": "lex", "query": "competitor pricing" },
    { "type": "vec", "query": "what pricing strategies are competitors using" }
  ],
  "limit": 5
}
```

**qmd returns** matching documents ranked by relevance: Acme Corp.md, Mid-market pricing convergence.md, State of SaaS Pricing 2026.md.

**You receive:**
> **Knowledge search: competitor pricing**
>
> - **Acme Corp** (References) — Sunsetted free tier Q3 2026, moving to $29/seat. Revenue up 34% YoY.
> - **Mid-market pricing convergence** (root) — Market converging on $25-35/seat. Free tiers disappearing. Our free tier is a differentiator.
> - **State of SaaS Pricing 2026** (Clippings) — Industry analysis by Jane Smith on SaaS pricing trends.

---

### UC6: Execute with knowledge injection

**You (Brain Router channel):**
> for saas-mvp: build the pricing page, pull from knowledge about competitor pricing and our positioning

**Brain Router detects** EXECUTE intent + knowledge search signal ("pull from knowledge").

**Step 1 — Search knowledge:**
```json
{
  "searches": [
    { "type": "lex", "query": "competitor pricing positioning" },
    { "type": "vec", "query": "pricing strategy and market positioning for our product" }
  ],
  "limit": 5
}
```

**Step 2 — Dispatch to project** via `execute_in_group`:
```
target_group_folder: project:saas-mvp
prompt: |
  [Knowledge context from repository:]

  ## Acme Corp (References/Acme Corp.md)
  Sunsetted free tier Q3 2026. Moving to $29/seat minimum.
  Q1 earnings: revenue up 34% YoY, 12k paying customers.

  ## Mid-market pricing convergence (root)
  Market converging on $25-35/seat for mid-market SaaS.
  Free tiers disappearing. Our free tier is a differentiator.

  ## State of SaaS Pricing 2026 (Clippings)
  [relevant excerpts]

  [Task:]
  Build the pricing page. Use the competitor context above to
  position our pricing effectively.
```

**You receive (in Brain Router channel):**
> Executing in **saas-mvp** → <#1234567890>

The saas-mvp project agent picks up the task in its Discord channel with full knowledge context already in the prompt. It builds the pricing page with competitive awareness baked in.

---

### UC7: Project agent searches knowledge directly

**You (in Discord #saas-mvp channel):**
> @Andy what do my competitors charge for API access? check the knowledge repo

The saas-mvp project agent receives this. It sees "check the knowledge repo" — the explicit signal to search.

**Agent calls** `search_knowledge`:
```json
{
  "searches": [
    { "type": "lex", "query": "API access pricing" },
    { "type": "vec", "query": "how much do competitors charge for API access" }
  ],
  "intent": "competitor pricing for API features",
  "limit": 5
}
```

The IPC flow: agent writes task file → host picks up → host calls qmd HTTP API → results returned to agent.

The agent also has the vault mounted read-only at `/workspace/knowledge`, so if the search results reference specific files, it can read `/workspace/knowledge/References/Acme Corp.md` for full context.

**Agent responds (in Discord #saas-mvp):**
> Based on the knowledge repo:
> - **Acme Corp** charges $29/seat base, API access is an add-on at $99/mo
> - No API pricing info on file for Globex or Initech yet
>
> Want me to research their API pricing and save it to knowledge?

Note: the project agent can *read* the vault and *search* it, but cannot *write* to it (read-only mount). Storing new knowledge goes through the Brain Router.

---

### UC8: Template evolution kicks in

**You (Brain Router channel)**, after several weeks of adding company notes:
> save to knowledge: Initech just launched a new enterprise plan at $89/seat. They dropped their starter tier entirely. 2,400 customers, mostly mid-market.

**Brain Router creates** `References/Initech.md`. This is the 4th company reference note (after Acme Corp, Globex, Initech). It scans the others and notices they all share a similar structure: Overview section, Notes section with dated entries, frontmatter with `category: companies`, pricing-related tags, and `related` links.

**After saving, Brain Router prompts:**
> Saved to knowledge → Initech (References)
>
> I've now created 4 company reference notes with a recurring structure — Overview, dated Notes entries, `category: companies` frontmatter, and cross-links to related companies. Want me to create a **Company** template so future company notes start from a consistent base?

**You respond:**
> yes, and add a Pricing section and a Key Metrics section too

**Brain Router writes** `/workspace/knowledge/Templates/Company.md`:
```markdown
---
created: {{date}}
type: reference
category:
  - companies
tags: []
aliases: []
related: []
---

# {{title}}

## Overview


## Pricing


## Key Metrics


## Notes

### {{date}}

```

**You receive:**
> Created template → Company (Templates)

Future company notes start from this template.

---

### UC9: Template refinement

**You (Brain Router channel)**, months later:
> save to knowledge: NovaTech is a new competitor. Based in Berlin. Series B, $40M raised. Their product focuses on developer tools with a CLI-first approach. Pricing starts at €19/seat.

**Brain Router uses the Company template** to create `References/NovaTech.md`. But the message includes funding info that doesn't fit neatly into the existing sections. The Brain Router adds funding detail under Overview.

After saving, it notices the last 3 company notes have all included funding information with no natural home in the template.

**Brain Router suggests:**
> Updated knowledge → NovaTech (References)
>
> Your recent company notes keep including funding details (NovaTech $40M Series B, Globex $85M Series C, etc.) that I'm fitting into Overview. Want me to add a **Funding** section to the Company template?

**You respond:**
> yes

**Brain Router updates** `Templates/Company.md` to add `## Funding` between Overview and Pricing.

---

### UC10: Mixed intent (knowledge + execute)

**You (Brain Router channel):**
> for saas-mvp: the design team shared new mockups for the dashboard. Also save to knowledge that our design system uses 8px grid spacing and Inter font.

**Brain Router detects two intents** in one message:
- EXECUTE: dashboard mockups task → route to saas-mvp
- KNOWLEDGE: design system details → save to vault

**Brain Router does both:**
1. Writes to knowledge — creates or updates `Design system.md` in the vault root
2. Dispatches the dashboard mockup task to saas-mvp via `execute_in_group`

**You receive:**
> Saved to knowledge → Design system (root)
> Executing in **saas-mvp** → <#1234567890>

---

### UC11: Bulk knowledge dump

**You (Brain Router channel):**
> save to knowledge: Here's everything from the competitor analysis meeting today:
> - Acme is losing enterprise deals to us because of our free tier
> - Globex is pivoting to vertical SaaS (healthcare focus)
> - Initech's new CTO came from AWS, expect infrastructure play
> - Market consensus is PLG is dead for enterprise, sales-led is back
> - Our win rate against Acme is 67%, against Globex 45%

**Brain Router detects** KNOWLEDGE intent. This is a multi-entity dump spanning multiple entities plus your own analysis.

**Entity resolution (for each entity mentioned):**
- "Acme" → matches `References/Acme Corp.md` → append
- "Globex" → matches `References/Globex.md` → append
- "Initech" → matches `References/Initech.md` → append
- Market consensus + win rates → your own synthesis → root note

**Brain Router:**
1. Appends to `References/Acme Corp.md` — free tier competitive insight, 67% win rate
2. Appends to `References/Globex.md` — healthcare pivot
3. Appends to `References/Initech.md` — new CTO from AWS
4. Creates `Competitive landscape Q1 2026.md` in root — market consensus, win rates
5. Calls `reindex_knowledge` once at the end

**You receive:**
> Updated knowledge:
> - Acme Corp (References) — free tier advantage, 67% win rate
> - Globex (References) — healthcare pivot
> - Initech (References) — new CTO from AWS
> - Competitive landscape Q1 2026 (root) — market trends, win rates
>
> Reindex started.

---

## Decisions

1. **qmd HTTP API (not MCP mode)** — qmd supports both HTTP and MCP server modes. We use HTTP because NanoClaw containers communicate with the host via IPC files, not MCP transport. The host process proxies search requests from containers to qmd's HTTP API at `POST /query`. This keeps everything within NanoClaw's existing IPC framework.

2. **Fire-and-forget reindexing** — After the Brain Router writes a knowledge file, `reindex_knowledge` spawns `qmd embed` as a detached background process. The agent doesn't wait. For a personal vault this is fast enough that the index is current by the next search.

3. **Setup skill (`/add-knowledge`)** — Consistent with NanoClaw's pattern of `/add-whatsapp`, `/add-discord`, etc. Handles vault creation, qmd installation, NanoClaw wiring, and background service setup.

4. **Emergent templates** — Start with whatever ships in the kepano-obsidian vault. The knowledge skill teaches conventions (frontmatter schema, folder placement, linking rules) and includes a template evolution process: after 3+ notes of the same type share a recurring structure, the Brain Router proposes creating a template. Templates are never created silently — always proposed and confirmed. Existing templates can also be refined when usage patterns drift.

5. **Obsidian CLI is out of scope** — qmd is the primary and sole search path. Obsidian's built-in search is too rudimentary. If an advanced search community plugin is later installed in Obsidian, the CLI could serve as a manual backup, but that's a future consideration outside this plan.
