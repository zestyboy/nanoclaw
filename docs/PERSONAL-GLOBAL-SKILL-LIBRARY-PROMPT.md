# Personal Global Skill Library Prompt

## Purpose

This document defines the broader feature:

- a user-owned personal skill library
- portable across AI surfaces and devices
- available in a consistent way across Claude Code, Codex, NanoClaw, and other user-facing assistant contexts

This is the higher-level product problem.

NanoClaw runtime alignment is only one downstream consumer of this system and is documented separately in:

- [SKILL-SYNC-FEATURE-PROMPT.md](/Users/niven/development/nanoclaw/docs/SKILL-SYNC-FEATURE-PROMPT.md)

---

## User Problem

As a user, I want to build up a personal set of important skills and have them available everywhere I work.

The mental model is closer to:

- Gmail contacts
- bookmarks
- password manager entries
- personal shortcuts

and not just:

- repo-local developer files
- one machine's configuration
- one tool's private plugin system

Desired experience:

- if I create or adopt a skill that is important to me, it should follow me
- it should be available from my laptop
- it should be available when I trigger NanoClaw from Discord or phone workflows
- it should be available in Codex and Claude Code contexts that support skills

In short:

- **personal skills are user data**
- not just project files

---

## Product Goal

Create a canonical personal/global skill layer that belongs to the user and can be consumed by multiple runtimes.

That layer should be:

- portable
- durable
- understandable
- syncable
- compatible with existing tool-specific built-in and project-local skill systems

---

## Prompt For Future Design / Implementation

```md
Design and implement a personal global skill library system for a user who wants the same important skills available across Claude Code, Codex, NanoClaw, laptop workflows, and phone-triggered assistant sessions.

Core problem:
- Skills today are often tied to one repo, one runtime, or one machine.
- The user wants a stable personal skill library that belongs to them and follows them everywhere.
- NanoClaw should be one consumer of this system, not the only target.

Goal:
- Define a canonical user-owned personal/global skill library.
- Support syncing or distributing that library across environments.
- Make it consumable by multiple runtimes, including NanoClaw.
- Preserve the distinction between:
  - built-in skills
  - project-local skills
  - personal/global skills

Key user model:
- Personal/global skills are like contacts: user-owned, portable, and shared across contexts.
- Project-local skills remain repo-specific.
- Built-in skills remain runtime/tool-provided.

Important design requirement:
- Do not frame this only as a NanoClaw feature.
- NanoClaw runtime sync is one integration target.
- The design should be broader than a single product's directory structure.

Questions to solve:
- What is the canonical storage model for personal/global skills?
- How should sync work across laptop, server, and other devices?
- Should the transport be Syncthing, git, cloud storage, or a pluggable abstraction?
- How do runtimes discover and consume the personal/global skill layer?
- How are conflicts handled between personal/global skills and project-local skills?
- How are deletions, versioning, and invalid skills handled?
- How is trust/security managed when synced skills are automatically consumed by multiple runtimes?

Syncthing:
- Evaluate Syncthing as one possible sync mechanism.
- Treat it as transport, not the full product design.
- The system should define canonical storage and consumer behavior even if the sync backend changes later.

Deliverables:
- a design for personal/global skill ownership and storage
- a precedence model among built-in, project-local, and personal/global skills
- a sync/distribution model
- one or more consumer integrations, including NanoClaw
- documentation for how a user adds, updates, deletes, and relies on personal/global skills

Quality bar:
- the design should match the user mental model of "my skills follow me everywhere"
- it should be explicit about boundaries between user-owned data and repo-local code
- it should be practical to operate
- it should not overfit to one runtime
```

---

## Recommended Model

Use a three-layer system:

1. **Built-in skills**
   - provided by a runtime or tool
   - examples: NanoClaw built-ins, tool-shipped defaults

2. **Project-local skills**
   - stored with a repo or environment
   - specific to one codebase or workflow

3. **Personal/global skills**
   - owned by the user
   - portable across runtimes and devices
   - the same conceptual layer everywhere

This separation is important. Without it, the system will blur user data and project implementation in a way that becomes hard to reason about.

---

## Syncthing Assessment

Syncthing is a good candidate for transport if:

- you want laptop-authored skills mirrored to a server or NanoClaw host
- you want near-real-time file sync
- you prefer peer-to-peer sync over a hosted registry

Syncthing is not sufficient by itself because it does not answer:

- what counts as canonical
- what each consumer should load
- precedence and conflicts
- validation and trust
- versioning and deletion behavior

So the right framing is:

- Syncthing may be a good implementation option for file distribution
- but the personal/global skill library feature is larger than Syncthing

---

## Suggested Architecture

### Canonical user-owned library

Define one stable personal/global skill root, conceptually something like:

- `~/AI/skills`
- or another explicit user-owned directory

That directory is the user's canonical personal skill library.

### Distribution

Then choose one transport:

- Syncthing
- git-backed repo
- cloud storage
- another sync mechanism

### Consumers

Each consumer should ingest the personal/global layer according to its own rules:

- NanoClaw
- Claude Code environments
- Codex environments
- future assistants

### Precedence

A reasonable general precedence model:

1. project-local skills
2. personal/global skills
3. built-in skills

This keeps project-specific overrides strong while still giving the user a portable personal layer.

---

## Security / Trust Notes

Because personal/global skills may be consumed automatically across multiple runtimes, the design should consider:

- whether all synced skills are auto-trusted
- whether some runtimes require validation before consumption
- whether signatures, approvals, or manifests are needed

At minimum, there should be:

- validation of readable skill structure
- clear logging when a skill is skipped
- explicit documentation of precedence and conflict behavior

---

## Manual Acceptance Tests

1. Create a new personal/global skill on the laptop.
2. Sync it to the server-side environment.
3. Confirm NanoClaw can discover it.
4. Confirm NanoClaw can execute with it.
5. Confirm the same skill is visible in the laptop-side tool environment.
6. Update the skill and confirm the update propagates.
7. Delete the skill and confirm the deletion propagates in a controlled way.
8. Create a project-local skill with the same name and confirm precedence works as intended.

---

## Summary

The real long-term product is not just "make NanoClaw sync skills into sessions."

It is:

- create a user-owned personal/global skill library
- make it portable across devices and runtimes
- let NanoClaw consume that system cleanly

That is the right framing for the broader feature.
