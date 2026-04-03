# Discord Skill Discovery Implementation Plan

## Purpose

This plan maps [DISCORD-SKILL-DISCOVERY-SPEC.md](./DISCORD-SKILL-DISCOVERY-SPEC.md) onto NanoClaw's current codebase.

It is intentionally implementation-oriented, but still stops short of code changes. The goal is to identify:

- which files need to change
- what responsibilities each file should own
- the order of work
- the main risks and test cases

## Design Recap

The approved UX is:

- `/skills run` for Discord-native skill discovery and single-skill invocation
- `/skills search` and `/skills list` for browsing
- `+skill-name` inline references for one or more skills inside ordinary messages
- server-side recognition feedback instead of composer highlighting

This fits NanoClaw's existing split between:

- native Discord slash-command interactions
- ordinary inbound Discord messages handled through the message loop

## Current Relevant Architecture

### Discord interaction path

- [src/channels/discord.ts](/Users/niven/development/nanoclaw/src/channels/discord.ts)
  Registers Discord slash commands and forwards interactions to `onSlashCommand`.
- [src/channels/registry.ts](/Users/niven/development/nanoclaw/src/channels/registry.ts)
  Defines the cross-channel `OnSlashCommand` callback shape.
- [src/index.ts](/Users/niven/development/nanoclaw/src/index.ts)
  Dispatches slash commands inside the inline `onSlashCommand` handler.

### Ordinary message path

- [src/channels/discord.ts](/Users/niven/development/nanoclaw/src/channels/discord.ts)
  Converts Discord messages into NanoClaw inbound messages.
- [src/index.ts](/Users/niven/development/nanoclaw/src/index.ts)
  Stores messages, performs routing, and invokes the agent/container path.

### Existing skill visibility

- [src/index.ts](/Users/niven/development/nanoclaw/src/index.ts)
  Already has a `/skills` slash command that reads `container/skills/*/SKILL.md` and renders a list.

This is useful because the codebase already has a basic skill discovery path. The new work is to turn that into:

- a reusable skill catalog
- Discord autocomplete-backed invocation
- inline skill reference parsing

## High-Level Implementation Strategy

Implement in three layers:

1. Build a reusable skill catalog module
2. Add Discord slash command support for `/skills run|search|list`
3. Add inline `+skill-name` parsing to ordinary Discord messages before prompt construction

Do not embed skill parsing logic directly into `src/channels/discord.ts` or duplicate `SKILL.md` parsing inside multiple branches of `src/index.ts`.

The main structural improvement should be extraction of skill discovery into a dedicated module under `src/`.

## Proposed File Changes

### 1. New module: `src/skills.ts`

Create a new module that owns all Discord-facing skill discovery logic.

Responsibilities:

- discover skill roots
- enumerate available skills
- parse `SKILL.md` metadata
- expose exact-match, prefix-match, and fuzzy search APIs
- return presentation-safe skill summaries
- parse inline `+skill-name` references from message text

Suggested exports:

- `listSkills(): SkillSummary[]`
- `searchSkills(query: string): SkillSummary[]`
- `findSkillByName(name: string): SkillSummary | null`
- `parseInlineSkillRefs(text: string): ParsedSkillRefs`
- `formatSkillInlineToken(name: string): string`

Suggested types:

- `SkillSummary`
- `ParsedSkillRefs`
- `InlineSkillReference`

Why this module should exist:

- it removes duplicated filesystem parsing
- it gives both slash commands and normal messages one shared source of truth
- it keeps `src/index.ts` from getting even more procedural

### 2. Update `src/channels/registry.ts`

The current `OnSlashCommand` signature is:

```ts
(chatJid, command, args, respond) => void
```

That is too narrow for Discord autocomplete and structured slash-command options.

Revise the abstraction so Discord can pass richer command payloads while other channels can keep the simple path.

Recommended direction:

- keep backward compatibility if possible
- add an optional structured argument object for slash-command options

Conceptually:

- `command`: top-level command name, e.g. `skills`
- `args`: legacy raw string
- `meta`: optional structured data, e.g. subcommand and named options

Example shape:

```ts
type SlashCommandMeta = {
  subcommand?: string;
  options?: Record<string, string>;
};
```

This change matters because `/skills run name:use-railway task:...` is much cleaner to handle as structured data than as a flat string.

### 3. Update `src/channels/discord.ts`

This file should own Discord-specific interaction UX, but not business logic.

Changes needed:

- register the new `/skills` command in `registerSlashCommands()`
- define subcommands:
  - `run`
  - `search`
  - `list`
- add a string option for `name` on `/skills run`
- add a string option for `task` on `/skills run`
- add a string option for `query` on `/skills search`
- wire Discord autocomplete handling for the `name` option

Important detail:

Discord autocomplete is a different interaction flow from regular slash-command execution. This file likely needs:

- an additional interaction branch for autocomplete events
- a call into `src/skills.ts` to fetch prefix matches

The autocomplete response should return a small bounded set, for example top 25 matches.

This file should also continue to:

- acknowledge command invocations quickly
- avoid owning parsing of `SKILL.md` directly

### 4. Update `src/index.ts`

This is the central dispatcher and will need two kinds of changes.

#### A. Slash-command dispatch

Add handling for the new `/skills` top-level command in the inline `onSlashCommand` handler.

Subcommand behaviors:

- `/skills run`
  - resolve the selected skill through `src/skills.ts`
  - synthesize an agent-bound instruction that explicitly loads that skill
  - enqueue it into the normal processing path instead of inventing a separate execution path

- `/skills search`
  - call `searchSkills(query)`
  - respond ephemerally with short descriptions and a copyable `+skill-name` token

- `/skills list`
  - call `listSkills()`
  - render a bounded list, likely categorized later if needed

This same area should probably retire or internally reuse the existing `/skills` implementation, which currently reparses `container/skills` inline. Avoid maintaining two separate discovery implementations.

Recommended outcome:

- keep the current `/skills` list behavior available, either as `/skills list` or as a compatibility path
- have all `/skills` discovery flows use the same `src/skills.ts` functions

#### B. Ordinary message inline-skill handling

Before the agent prompt is constructed for a normal message, parse for `+skill-name` references.

Responsibilities in `src/index.ts`:

- call `parseInlineSkillRefs(message.content)` for inbound messages
- resolve references against the skill catalog
- de-duplicate matches
- attach explicit skill-loading instructions to the agent prompt
- emit user-facing confirmation when skills are detected
- emit correction suggestions for unknown explicit references

Important constraint:

The original user message should still be preserved in storage and routing. Parsing should add structure, not destroy the original text.

### 5. Optional new helper: `src/skill-invocation.ts`

If `src/index.ts` starts to accumulate too much logic, extract the prompt-shaping part into a second module.

Responsibilities:

- convert resolved skills plus message text into a normalized execution envelope
- generate the explicit "load these skills" instruction block
- centralize de-duplication and error formatting

This is optional, but likely worthwhile if both slash invocation and inline references need to build the same prompt metadata.

### 6. Tests

Relevant existing test files:

- [src/channels/discord.test.ts](/Users/niven/development/nanoclaw/src/channels/discord.test.ts)
- [src/slash-commands.test.ts](/Users/niven/development/nanoclaw/src/slash-commands.test.ts)

New recommended test files:

- `src/skills.test.ts`
- optionally `src/skill-invocation.test.ts`

## Detailed Work Plan

## Phase 1: Reusable Skill Catalog

### Goal

Create a single reusable source of truth for skill discovery.

### Files

- new: `src/skills.ts`
- new: `src/skills.test.ts`

### Tasks

1. Define `SkillSummary` and parsing helpers.
2. Read skill definitions from the current source of truth.
3. Extract `name` and `description` safely from `SKILL.md`.
4. Add exact lookup, prefix match, and fuzzy search.
5. Add inline `+skill-name` token parsing.
6. Add unit tests for:
   - skill discovery
   - malformed `SKILL.md`
   - duplicate names
   - inline token parsing
   - typo suggestions or fuzzy results

### Notes

This phase should be completed before touching Discord interactions. Otherwise the command layer will end up coupled to filesystem parsing.

## Phase 2: Discord Slash Command Surface

### Goal

Add `/skills run`, `/skills search`, and `/skills list` with autocomplete-backed discovery.

### Files

- `src/channels/registry.ts`
- `src/channels/discord.ts`
- `src/channels/discord.test.ts`

### Tasks

1. Extend the slash-command callback abstraction to support structured options.
2. Register `/skills` and its subcommands in Discord.
3. Add autocomplete support for the `/skills run name` option.
4. Forward structured interaction data to `onSlashCommand`.
5. Add Discord tests for:
   - command registration
   - subcommand routing
   - autocomplete interaction handling
   - bounded result count

### Risks

- Discord interaction timing is strict; autocomplete must stay fast.
- The shared callback abstraction should not become Discord-specific enough to hurt future channels.

## Phase 3: Dispatcher Support in `src/index.ts`

### Goal

Teach the central command handler how to execute the new skill flows.

### Files

- `src/index.ts`
- `src/slash-commands.test.ts`

### Tasks

1. Add `/skills` handler branches for `run`, `search`, and `list`.
2. Replace the inline `/skills` filesystem parsing with the shared skill catalog module.
3. For `/skills run`, synthesize a message that enters the normal work queue with explicit skill-loading metadata.
4. Ensure responses remain ephemeral and short enough for Discord limits.
5. Add tests covering:
   - `/skills list`
   - `/skills search`
   - `/skills run` with a valid skill
   - `/skills run` with an unknown skill

### Important design choice

Do not create a one-off execution path that bypasses normal group/session handling.

`/skills run` should still enter the existing agent work path so that:

- session behavior remains consistent
- message history remains coherent
- Brain Router and group context still work the same way

## Phase 4: Inline `+skill-name` References

### Goal

Support one or more explicit skill references in normal Discord messages.

### Files

- `src/index.ts`
- maybe new: `src/skill-invocation.ts`
- tests in `src/skills.test.ts` and/or a new integration-style test file

### Tasks

1. Parse `+skill-name` references from inbound message content.
2. Resolve them against the shared catalog.
3. De-duplicate resolved skills.
4. Attach explicit skill-loading instructions to the agent input.
5. Respond with:
   - success confirmation for recognized skills
   - suggestions for mistyped skills
6. Enforce a soft cap on number of explicit inline skill references.

### Parsing guidance

Keep the parser conservative.

Reasonable initial rule:

- detect `+name` where `name` matches the allowed skill-name character set
- avoid matching things like arithmetic, email aliases, or unrelated plus-prefixed tokens where possible

This parser should be strict enough to avoid accidental triggers in ordinary chat.

## Phase 5: Prompt Construction and Agent Semantics

### Goal

Make skill invocation explicit and consistent for both slash-command and inline-reference paths.

### Files

- `src/index.ts`
- optionally new: `src/skill-invocation.ts`

### Tasks

1. Define the exact internal representation of "requested skills".
2. Ensure both `/skills run` and `+skill-name` references produce the same internal shape.
3. Decide whether resolved skills are:
   - injected into prompt text
   - passed as structured metadata
   - both
4. Make the instruction explicit enough that the downstream agent reliably loads the intended skill(s).

### Recommendation

Start simple:

- generate an explicit instruction block in prompt text
- keep the original user message below it

That is easier to inspect and debug than inventing hidden metadata too early.

## Backward Compatibility

### Existing `/skills`

The current `/skills` command should not be silently broken.

Recommended options:

- keep `/skills` as the canonical command surface, with `run`, `search`, and `list` subcommands
- preserve the current top-level list behavior if users already rely on bare `/skills`

Do not leave the old inline parser in place once the shared skill catalog exists.

### Existing natural-language behavior

This feature should augment, not replace, natural-language skill triggering.

Explicit `+skill-name` references should force or strongly bias skill loading.
Natural-language discovery can remain unchanged.

## Proposed Internal Data Flow

### `/skills run`

1. Discord autocomplete suggests skills from `src/skills.ts`
2. User submits `/skills run`
3. `src/channels/discord.ts` forwards structured command data
4. `src/index.ts` resolves the skill
5. `src/index.ts` synthesizes a normal work item with explicit skill-loading instruction
6. Existing queue/container/session flow continues unchanged

### `+skill-name`

1. User sends a normal Discord message
2. `src/channels/discord.ts` forwards the message as usual
3. `src/index.ts` parses `+skill-name`
4. `src/skills.ts` resolves the names
5. `src/index.ts` adds explicit skill-loading instructions
6. Agent executes with confirmation or suggestion feedback

## Risk Areas

### 1. Parsing ambiguity

`+skill-name` is mobile-friendly, but it is also terser and therefore easier to accidentally over-match.

Mitigation:

- conservative parser
- good tests
- correction flow for unknown explicit references

### 2. Prompt drift

If slash invocation and inline references construct prompts differently, behavior will diverge.

Mitigation:

- centralize prompt-shaping logic

### 3. Command abstraction creep

Discord autocomplete may tempt the channel abstraction to become overly Discord-specific.

Mitigation:

- keep structured slash-command metadata generic
- let only `src/channels/discord.ts` know Discord's exact interaction model

### 4. Duplicate discovery logic

There is already a `/skills` implementation in `src/index.ts`.

Mitigation:

- replace it with shared module calls early

## Testing Plan

### Unit tests

In `src/skills.test.ts`:

- discovers valid skills
- ignores invalid directories
- parses frontmatter or fallback names correctly
- supports exact lookup
- supports prefix match for autocomplete
- supports fuzzy search for `/skills search`
- parses `+skill-name` tokens
- de-duplicates repeated tokens
- handles malformed input safely

### Discord integration tests

In `src/channels/discord.test.ts`:

- registers `/skills`
- handles `/skills run`
- handles `/skills search`
- handles `/skills list`
- returns autocomplete suggestions for skill names
- does not exceed Discord result limits

### Dispatcher tests

In `src/slash-commands.test.ts`:

- `/skills list` returns rendered skills
- `/skills search` returns filtered results
- `/skills run` enqueues work
- `/skills run` with bad input returns suggestion/error

### Inline reference tests

In a new or existing integration-style test:

- ordinary message with one `+skill-name`
- ordinary message with two `+skill-name` references
- mistyped skill yields suggestion
- explicit token is not silently ignored

## Rollout Order

Recommended order:

1. `src/skills.ts`
2. migrate `/skills` to the shared catalog
3. Discord `/skills list` and `/skills search`
4. Discord autocomplete and `/skills run`
5. inline `+skill-name` parsing
6. prompt-shaping cleanup/refactor if needed

This order minimizes risk because:

- discovery comes before invocation
- the shared catalog is validated before Discord autocomplete depends on it
- inline multi-skill parsing lands after the simpler slash-command path is stable

## Definition of Done

The feature is complete when:

- `/skills run` works with Discord autocomplete
- `/skills search` and `/skills list` use the shared catalog
- `+skill-name` works in normal Discord messages
- two inline skill references can be resolved in one message
- recognition and typo-suggestion feedback works
- existing `/skills` behavior is either preserved or clearly superseded
- tests cover catalog parsing, Discord interaction routing, and inline references

## Recommended Next Action

Start by extracting the existing skill discovery logic out of [src/index.ts](/Users/niven/development/nanoclaw/src/index.ts) into a new [src/skills.ts](/Users/niven/development/nanoclaw/src/skills.ts) module. That is the key seam. Once that exists, the rest of the work becomes mostly interface wiring instead of duplicated feature logic.
