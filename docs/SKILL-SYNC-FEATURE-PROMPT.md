# NanoClaw Runtime Skill Alignment Prompt

## Purpose

This document defines the narrower NanoClaw-specific feature:

- make NanoClaw discovery and runtime execution use the same skill set
- keep Personal Assistant and Brain Router sessions aligned with that set
- do this in a way that can later plug into a broader personal/global skill library

This is not the full cross-device personal skill system. That broader problem is captured separately in:

- [PERSONAL-GLOBAL-SKILL-LIBRARY-PROMPT.md](/Users/niven/development/nanoclaw/docs/PERSONAL-GLOBAL-SKILL-LIBRARY-PROMPT.md)

The key distinction is:

- **this feature**: NanoClaw runtime alignment
- **future broader feature**: user-owned personal skill library available everywhere

---

## Problem

Today, NanoClaw discovery and NanoClaw runtime are not fully aligned.

Current behavior:

- skill discovery can see multiple host-side roots
- `/skills list`, `/skills search`, Discord autocomplete, and inline `+skill-name` parsing all use that discovery catalog
- but the actual runtime session setup only copies `container/skills` into `.claude/skills`

So a skill may:

- appear discoverable in Discord
- be suggested by autocomplete
- be accepted in `/skills run`
- be recognized in inline `+skill-name` references

while still not being available to the agent runtime.

That mismatch must be removed.

---

## Relationship To The Broader Personal Skill Library

This feature should assume that, in the future, NanoClaw may consume a broader personal/global skill layer that belongs to the user and is portable across:

- Claude Code
- Codex
- NanoClaw
- laptop workflows
- phone-triggered assistant sessions

But this feature should not attempt to solve that entire system.

Instead, implement NanoClaw so it can consume a canonical runtime skill set now, and later point that canonical set at a shared personal/global skill library.

In other words:

- do not hardcode NanoClaw around `container/skills` forever
- do not assume repo-local skills are the only important source
- do build a clear runtime-alignment layer that can later ingest personal/global skills cleanly

---

## Product Goal

Within NanoClaw, if a skill is surfaced to the user for use, it should also be available to the runtime agent.

This applies especially to:

- Personal Assistant
- Brain Router

Those elevated assistants should have a stable shared runtime skill set across sessions and restarts.

---

## Prompt For Future Implementation

```md
Implement runtime skill alignment for NanoClaw so discovery and execution use the same source of truth.

Current problem:
- NanoClaw discovery reads multiple skill roots.
- But actual runtime session setup still only copies `container/skills` into `.claude/skills`.
- This creates a mismatch where a skill may appear in `/skills list`, `/skills search`, Discord autocomplete, or inline `+skill-name` recognition but not actually be available to the runtime agent.

Goal:
- Define a canonical runtime skill set for NanoClaw.
- Ensure the same set used for discovery is what gets copied into the actual runtime for agent sessions.
- Preserve existing NanoClaw routing, container/session behavior, and built-in skill support.
- Design the solution so it can later consume a broader personal/global skill library without major rework.

Important framing:
- This feature is NanoClaw-specific runtime alignment.
- It is not the entire personal-global skill library system.
- However, its interfaces and configuration should be future-compatible with that broader system.

Desired behavior:
- If NanoClaw discovery surfaces a skill by default, that skill should be runtime-available by default.
- Personal Assistant and Brain Router sessions should always receive the configured canonical runtime skill set.
- Repo-local, built-in, and optional future global/personal skill roots should be supportable through one shared model.
- Invalid or unreadable skill roots should fail gracefully with clear logs.

Implementation requirements:
- Create a shared runtime skill sync module instead of duplicating logic.
- Define canonical runtime roots separately from raw discovery roots if needed.
- Update discovery so default user-facing results reflect runtime-available skills.
- Update both local container execution and Railway child-process execution to use the same runtime sync logic.
- Preserve built-in `container/skills` behavior as a fallback or input root.
- Keep changes localized and testable.

Suggested files:
- `src/skills.ts`
- `src/container-runner.ts`
- `src/railway-runner.ts`
- `src/index.ts`

Questions to resolve:
- Which roots are canonical for runtime?
- What is the precedence when multiple roots provide the same skill name?
- Should all groups get the same canonical runtime set, or should this start with main/trusted groups only?
- Should discovery ever show non-runtime skills, or only runtime-available skills?
- How should deletions and invalid skills be handled?

Deliverables:
- shared runtime skill sync module
- canonical runtime skill root model
- runtime sync integration for local and Railway execution
- tests for discovery/runtime alignment and precedence behavior
- docs explaining how NanoClaw runtime skill availability works
```

---

## Recommended Design Notes

### Scope

Start with:

- Personal Assistant
- Brain Router

This is the highest-value slice and the least risky place to enforce a stable canonical runtime skill set.

### Root model

NanoClaw should support these categories conceptually:

- built-in runtime skills
- repo-local custom skills
- optional future personal/global skills

This feature does not need to implement the full personal/global system, but it should leave room for it.

### Suggested precedence

Reasonable starting precedence:

1. repo-local custom skills
2. optional future personal/global runtime root
3. built-in container skills

### Sync strategy

Create one shared function that:

- resolves canonical runtime roots
- validates skill directories
- de-duplicates by skill name
- copies the final set into session `.claude/skills`

Use that function in both:

- local container runner
- Railway runner

### Discovery policy

For default user-facing NanoClaw UX, prefer showing runtime-available skills.

This avoids confusing the user with skills that NanoClaw cannot actually execute yet.

---

## Manual Acceptance Tests

1. Add a skill to a canonical NanoClaw runtime root.
2. Confirm `/skills list` shows it.
3. Confirm `/skills search` finds it.
4. Confirm Discord autocomplete suggests it.
5. Confirm `/skills run` actually works with it at runtime.
6. Confirm inline `+skill-name` references both detect and execute correctly.
7. Remove the skill and confirm both discovery and runtime stop exposing it.
8. Add a duplicate skill with the same name in a higher-priority root and confirm precedence works correctly.

---

## Summary

This feature should solve NanoClaw runtime consistency, not the entire personal skill portability problem.

But it must be designed so that a future personal/global skill library can become one of NanoClaw's canonical runtime roots without another major redesign.
