# Discord Skill Discovery Design Spec

## Summary

Add skill discovery to NanoClaw's Discord channel using a hybrid model:

1. A native Discord slash command for skill discovery and single-skill invocation
2. A lightweight inline message syntax for referencing one or more skills inside normal chat messages
3. Server-side skill detection and confirmation, rather than true Discord composer highlighting

This is intentionally not a literal clone of Claude Code's terminal UX. Discord's composer and slash-command model are structurally different. The goal is to achieve the same functional outcome: users can discover skills they do not remember, invoke one skill quickly, and reference multiple skills in a single message when needed.

## Context

NanoClaw already has two relevant input paths:

- Native Discord slash commands, registered globally and handled immediately
- Ordinary Discord messages, which flow through the standard message loop and agent routing

This split is documented in [SYSTEM-OVERVIEW.md](./SYSTEM-OVERVIEW.md), especially the slash-command architecture and routing paths.

The existing architecture strongly favors a dual-surface solution:

- Use native Discord interactions where Discord provides good UX
- Use normal messages where freeform composition is required

## Problem

Users want a Discord experience similar to Claude Code terminal skill invocation:

- Type `/` and discover available skills if they do not remember the exact name
- Reference a skill inside the body of a normal message
- Sometimes reference two skills in the same message
- Ideally get feedback that the skill name was recognized

Discord does not support this natively in the same way as a terminal or editor:

- Slash commands are application commands, not inline body tokens
- A slash command must begin the interaction
- Discord only supports one slash command invocation at a time
- Slash commands cannot be mixed into arbitrary message body text as executable units
- Discord does not provide custom inline token highlighting in the composer

## Goals

- Let users discover skills from Discord without remembering exact names
- Let users invoke a single skill through a Discord-native autocomplete flow
- Let users reference multiple skills in one ordinary message
- Preserve NanoClaw's existing routing model and Brain Router behavior
- Keep the mental model simple and explicit

## Non-Goals

- Reproduce Claude Code terminal highlighting exactly inside Discord
- Register every skill as its own Discord application command
- Build a full custom Discord UI beyond what interactions, autocomplete, and normal messages allow
- Replace natural-language skill triggering entirely

## Recommendation

Use a hybrid UX:

- `/skills run` for discovery and single-skill invocation
- `+skill-name` inline references for one or more skills inside ordinary messages
- Bot-generated confirmation of detected skills in place of true inline highlighting

This gives discovery, explicit invocation, and multi-skill composition without fighting Discord's platform limits.

## Use Cases at a Glance

The intended split is:

- Use `/skills run` when the user does not remember the exact skill name, or wants a guided, tappable flow.
- Use `/skills search` when the user vaguely remembers the topic or capability, but not the exact skill name.
- Use `+skill-name` when the user already knows the skill and wants to reference one or two skills inside a normal sentence.

This is the core mental model for the Discord adaptation:

- `/skills run` is guided invocation
- `/skills search` is discovery
- `+skill-name` is shorthand inside regular chat

## Proposed UX

### 1. Native Skill Discovery

Introduce a top-level Discord slash command:

`/skills`

Initial subcommands:

- `run`
- `search`
- `list`

Examples:

- `/skills run name:use-railway`
- `/skills search query:rail`
- `/skills list`

### `/skills run`

Purpose:

- Fast path for a single explicit skill invocation
- Primary discovery surface via Discord autocomplete

Behavior:

- User chooses a skill from autocomplete on the `name` option
- Optional freeform `task` or `args` text may be included
- NanoClaw turns that interaction into a normal agent-bound instruction with explicit skill loading

Why this exists:

- It maps well to Discord's native capabilities
- It solves the "I forgot the exact skill name" problem
- It does not require the user to know inline syntax first

### `/skills search`

Purpose:

- Fuzzy discovery when the user only remembers part of a name or topic

Behavior:

- Returns an ephemeral list of matching skills with short descriptions
- May include suggested inline tokens users can paste into normal messages

Example response:

```text
Matching skills:
- use-railway: Operate Railway infrastructure and deployments
- add-railway-monitoring: Add Railway monitoring and checks

Inline token:
+use-railway
```

### `/skills list`

Purpose:

- Browse all available skills or the first page of them

Behavior:

- Returns an ephemeral categorized list
- If the skill set is large, return only a bounded set plus guidance to use `/skills search`

## Inline Skill References

### Syntax

Use this message-body syntax:

`+skill-name`

Examples:

- `Use +use-railway to diagnose the deploy failure.`
- `Apply +use-railway and +document-release after the deploy is fixed.`

### Why this syntax

- It is short and mobile-friendly
- It is visually distinct from natural language
- It does not conflict with Discord's slash command parsing
- It supports multiple references in one message
- It is easy to detect server-side with deterministic parsing
- It minimizes punctuation burden and typo rate on the Discord mobile app

### Alternative syntax considered

- `[[skill:use-railway]]`
- `/use-railway` inside message bodies
- `@skill(use-railway)`
- `skill:use-railway`

These are weaker because:

- `[[skill:...]]` is reliable for parsing but awkward for frequent mobile typing
- `/use-railway` suggests Discord-native command semantics that do not actually exist in message bodies
- `@...` risks confusion with mentions
- `skill:...` is workable but longer and more cumbersome on mobile than a `+` prefix

## Recognition and Feedback

Discord cannot provide real inline highlighting for custom message-body tokens. NanoClaw should instead provide recognition feedback after receipt.

When inline skills are detected:

- Parse them before message formatting to the agent
- Resolve each referenced skill against the discovered skill catalog
- If all resolve, include a lightweight confirmation in NanoClaw's response path

Example:

```text
Skills detected: use-railway, document-release
```

If some are unknown:

```text
Unknown skill: use-raiway
Did you mean: use-railway
```

This gives users the "highlighted/recognized" feeling after send, which is the closest practical equivalent in Discord.

## Skill Resolution Model

NanoClaw should maintain a skill catalog for Discord-facing discovery. The catalog is a read model over the existing skill directories and metadata.

Each entry should contain:

- `name`
- `description`
- `path`
- `source`
- optional `tags`
- optional `argument_hint`
- optional `hidden_from_discovery`

The catalog should support:

- Exact name lookup
- Prefix matching for autocomplete
- Fuzzy search for `/skills search`
- Stable rendering order

## Execution Semantics

### `/skills run`

`/skills run` should not bypass the existing agent model. It should produce an explicit instruction that flows through the same message-processing path as other user work.

Conceptually:

1. User invokes `/skills run`
2. Discord handler resolves the selected skill
3. NanoClaw synthesizes a message or instruction envelope
4. The target agent receives the task with an explicit instruction that the named skill must be loaded

This should remain compatible with:

- Main-group direct work
- Brain Router passthrough patterns
- Group-specific agent execution

### Inline references

For ordinary messages:

1. User sends a normal Discord message
2. Discord message intake parses `+skill-name` references
3. NanoClaw resolves referenced skills
4. The outbound prompt to the container includes an explicit "load these skills" instruction
5. Original user text remains intact, minus or alongside structured skill metadata

This keeps multi-skill composition inside the existing chat flow.

## Interaction with Current Routing

This feature should preserve current routing semantics:

- Slash commands remain a channel-level interaction surface
- Ordinary messages remain the main conversational surface
- Brain Router intent overrides like `/catalog` and `/execute` remain unchanged

The new skill feature should be orthogonal to Brain Router routing.

Examples:

- `/skills run name:use-railway task:Check why the deploy failed`
  Result: direct explicit skill invocation

- `+use-railway investigate the failed deploy and summarize next steps`
  Result: normal message with explicit skill loading metadata

- `/execute +use-railway check the deployment logs`
  Result: Brain Router still sees `/execute` as the intent override, and the skill metadata is carried into the dispatched task

## Why Not One Slash Command Per Skill

Do not register every skill as its own native Discord slash command.

Reasons:

- Discord application command namespace becomes noisy
- Registration churn increases as skills change
- Command propagation is operationally awkward
- It still does not solve multi-skill use inside one message
- It conflates discovery with command identity in a way Discord handles poorly at scale

Use one stable `/skills` command and keep skills as data, not command registrations.

## Why Not Inline `/skill-name`

Using `/use-railway` inside ordinary Discord messages is tempting because it resembles Claude Code terminal behavior. It is not recommended.

Reasons:

- It implies Discord-native executable command semantics that do not exist in message bodies
- It is ambiguous with existing slash-command mental models
- It creates future confusion if a native command of the same name is ever added
- It still cannot be highlighted inline by Discord

If a Claude Code-like syntax is desired, it should remain only a visual inspiration, not the actual Discord message-body format.

## Detailed UX Flows

### Flow A: User forgot the exact skill name

1. User types `/skills run`
2. Discord autocomplete shows matching skill names
3. User selects `use-railway`
4. User submits optional task text
5. NanoClaw acknowledges ephemerally and routes the work normally

### Flow B: User wants two skills in one task

1. User writes a normal message
2. Message includes `+use-railway` and `+document-release`
3. NanoClaw detects both references
4. NanoClaw confirms detection
5. Agent receives the task with both skills explicitly loaded

### Flow C: User mistypes a skill

1. User sends `+use-raiway`
2. NanoClaw fails exact resolution
3. NanoClaw responds with a correction suggestion
4. Message is not silently treated as plain text if the intent appears explicit

## Error Handling

### Unknown skill

Behavior:

- Respond with likely matches
- Do not silently ignore an explicit inline skill token

### Duplicate skill references

Behavior:

- De-duplicate before prompt construction
- Preserve order only if ordering later becomes semantically important

### Hidden or internal skills

Behavior:

- Exclude from Discord discovery by default
- If directly referenced and allowed, either resolve them or return an "not user-invocable" error

### Too many skills in one message

Behavior:

- Set a soft cap, for example 3
- If exceeded, ask the user to narrow the request

## Security and Trust Boundaries

Skill discovery should not expose unsafe internal metadata.

Discord-facing listings should avoid:

- Full filesystem paths
- Internal-only notes
- Hidden implementation details

The catalog exposed to Discord should be presentation-safe. If some skills are operational or admin-only, they should be discoverable only for authorized users or hidden entirely.

## Mobile UX Note

Mobile Discord is an explicit design constraint for this feature.

Implications:

- `/skills run` should be treated as the primary human-facing path
- Inline syntax should be brief enough for thumb typing
- Ephemeral responses from `/skills search` should include a copyable inline token
- The system should favor correction and suggestion over hard failure for small typos

This is the main reason the spec uses `+skill-name` rather than a bracketed token format.

## Open Questions

- Should all skills be discoverable in Discord, or only a curated subset?
- Should inline skill references work in every channel, or only registered NanoClaw channels?
- Should `/skills run` always target the current group, or allow optional target-group routing?
- Should a direct inline skill reference force explicit loading, even if the agent would not otherwise choose it?
- Should there be a visible "copy token" helper in `/skills search` responses?

## Success Criteria

- Users can discover a skill from Discord without remembering the exact name
- Users can invoke a single skill via Discord autocomplete
- Users can reference multiple skills in one ordinary message
- Skill references are recognized reliably and confirmed visibly
- The feature fits NanoClaw's current message loop and routing model without distorting Discord command architecture

## Recommended Next Step

Implement this in two phases:

### Phase 1

- Add `/skills run`, `/skills search`, `/skills list`
- Build a read-only skill catalog
- Add Discord autocomplete for the `name` option

### Phase 2

- Add inline `+skill-name` parsing for ordinary messages
- Add server-side recognition feedback
- Carry structured skill-loading metadata into prompt construction

This sequencing delivers immediate value while keeping the multi-skill inline path separate and easier to reason about.
