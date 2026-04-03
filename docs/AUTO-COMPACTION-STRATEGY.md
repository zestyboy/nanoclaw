# Auto-Compaction Strategy

## Problem

NanoClaw sessions grow unbounded. The Agent SDK handles the hard context limit by auto-summarizing when full, but by that point:
- Token cost per turn is high
- Older context quality degrades from summarization under pressure
- No proactive management of session size

Currently, compaction is manual via `/compact` from Discord.

## Options

### 1. Threshold-based (recommended starting point)
Compact when context usage exceeds a threshold (e.g. 70%).
- `session-health.ts` already tracks context % per group
- Add a check after each turn in the message loop
- If context % > threshold, auto-trigger `/compact`
- Simple, predictable, directly tied to the resource constraint

### 2. Turn-count based
Compact every N turns (e.g. every 20 messages).
- Simpler but less adaptive — short messages waste compaction, long messages may hit limits before N turns

### 3. Cost-based
Compact when token cost per turn exceeds a threshold.
- `sessionCosts` already tracked in `src/index.ts`
- Good proxy for context size but less direct

## Key Files
- `src/session-health.ts` — context % estimation
- `src/session-commands.ts` — existing `/compact` handling
- `src/index.ts` — message loop, session cost tracking

## Considerations
- Should compaction be per-group or global?
- Should the user be notified when auto-compaction runs?
- Should there be a cooldown to avoid compacting on consecutive turns?
- Different thresholds for main (PA) vs project groups?
