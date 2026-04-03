# Codex CLI Capability Model And Workflow Safety Plan

## Recommendation

Do not implement `~/.claude/plans/snug-shimmying-kazoo.md` as written.

That plan is primarily a local workaround, not a fix for the Codex CLI and session-policy problems described in [docs/CODEX-CLI-SESSION-PROBLEMS.md](/Users/niven/development/nanoclaw/docs/CODEX-CLI-SESSION-PROBLEMS.md). It disables sandboxing entirely, assumes the user wants maximum permissiveness, and moves core capability detection into repo-level instructions. That would reduce safety without fixing the root problems:

- ambiguous capability reporting
- inconsistent permissions within a session
- unclear distinction between policy denial and real network failures
- workflow drift when the canonical Git path is blocked
- poor recovery planning before mutating Git state

## Why The Existing Plan Should Not Be Implemented

### 1. It treats a product bug as a user-config workaround

Changing `~/.codex/config.toml` to `danger-full-access` does not fix the Codex CLI capability model. It only bypasses it for one machine. The reported issue is that the environment was unreliable and opaque, not merely too restrictive.

### 2. It weakens security more than necessary

The desired outcome in the problem report is stable and explicit permissions, not unrestricted access. A good fix should preserve sandboxing where possible and make restrictions understandable and durable.

### 3. It makes unsupported assumptions about root cause

The proposal states that the macOS sandbox caused all 10 issues. The evidence does not support that conclusion. At least some failures could have been:

- transient DNS failure
- host-specific network policy
- path-class restrictions
- `.git` special-case handling
- session-mode drift
- command guardrails unrelated to filesystem policy

The plan jumps to a solution before isolating the failure domains.

### 4. It misplaces the fix into `AGENTS.md`

Adding startup probes to `AGENTS.md` is the wrong layer. Repo instructions can document workflow expectations, but they should not be responsible for discovering Codex CLI platform capabilities or compensating for unstable session policy.

### 5. It does not solve the key operational problem

The main operational failure was that the agent could mutate Git state and later lose the ability to clean it up. The proposal does not add preflight checks, session-stability guarantees, mutation guards, or fallback behavior for partially available sessions.

### 6. It ignores several documented requirements

The original session report explicitly asks for:

- stable permissions for the lifetime of a session
- explicit capability reporting at session start
- separation between network, hidden-path, `.git`, and normal workspace restrictions
- safer Git workflow behavior when cleanup may be impossible

The existing plan does not provide a design for any of those.

## Replacement Plan

## Objective

Fix Codex CLI so that a session exposes a clear, stable capability matrix and uses that matrix to prevent workflow drift, especially for Git-based repos with explicit promotion flows.

## Non-Goals

- Do not default to `danger-full-access`
- Do not move platform capability discovery into repo-local instructions
- Do not silently substitute alternate release flows when the canonical one is blocked

## Design Principles

- Capabilities must be explicit before risky operations begin.
- Capability classes must be reported separately, not inferred from generic errors.
- Permissions must remain stable for the lifetime of a session, or the session must explicitly report that stability is not guaranteed.
- The agent must check whether it can perform likely cleanup before mutating repo state.
- Repo workflow rules should shape agent behavior once capabilities are known.

## Workstream 1: Session Capability Matrix

Add a session-start capability report and a queryable capability command.

### Capability classes

- normal workspace writes
- hidden path writes
- `.git` metadata writes
- worktree creation
- network egress by destination class:
  - GitHub
  - Railway
  - arbitrary HTTPS
- destructive command policy

### Requirements

- Report each capability as `available`, `blocked_by_policy`, `failed_runtime_check`, or `unknown`.
- Include whether the result is guaranteed stable for the session.
- Make the matrix visible at session start and queryable on demand.

### Example output

```text
Session capabilities
- workspace writes: available, stable
- hidden paths: blocked_by_policy, stable
- .git writes: blocked_by_policy, stable
- git worktrees: blocked_by_policy, stable
- github network: failed_runtime_check (dns_resolution), unstable
- railway network: available, stable
- destructive temp cleanup under /tmp: available, stable
```

## Workstream 2: Error Taxonomy And Diagnostics

Upgrade tool errors so they distinguish platform policy from environmental failure.

### Network errors

Differentiate:

- blocked by policy
- DNS resolution failure
- TCP connect failure
- TLS failure
- auth failure
- application-level rejection

### Filesystem errors

Differentiate:

- blocked hidden path
- blocked VCS metadata path
- blocked outside writable root
- runtime OS error

### Command guardrail errors

Differentiate:

- blocked because destructive pattern is forbidden
- blocked because path risk classification is high
- blocked because approval would be required

## Workstream 3: Session Stability Guarantee

Codex CLI should not silently change write permissions mid-session.

### Requirements

- Capability policy is frozen when the session starts.
- If policy must change, the session emits an explicit state-change event and reprints the matrix.
- Agents can branch behavior on a `stable_session_capabilities` flag.

### Acceptance criteria

- If `.git` writes are available at start, they remain available unless the session explicitly transitions and reports the change.
- If hidden paths are blocked, they stay blocked consistently.

## Workstream 4: Preflight For Git-Mutating Workflows

Before any Git mutation, Codex should preflight both the target action and its likely cleanup path.

### Actions that require preflight

- branch creation or switching
- commit creation
- merges
- rebases
- worktree creation
- commands that create `.git/index.lock` or refs

### Required checks

- `.git` write capability
- worktree capability if worktree recovery is proposed
- remote-network capability if push is part of the intended flow
- cleanup feasibility for the proposed sequence

### Agent behavior

- If the canonical path requires `git push` and GitHub is unavailable, stop and surface that as a workflow blocker.
- Do not merge into `dev` locally if the session cannot also perform the expected push or rollback.
- If a workaround exists but changes the release process, require explicit user confirmation.

## Workstream 5: Workflow Drift Prevention

Use repo instructions as policy inputs, not as a substitute for platform capability detection.

### Behavior for repos with explicit promotion flow

If repo instructions indicate:

- feature branch -> `dev` -> test -> `main`

then the agent should:

- preserve that flow by default
- refuse ad hoc deploy substitutions unless the user explicitly authorizes the deviation
- label any deviation as `non-canonical workflow`

### Railway-specific behavior

If Railway deploy commands are available but GitHub push is not:

- do not silently use `railway up` as a substitute for branch promotion
- explain that deployment is possible but would bypass the documented Git flow
- require explicit approval to proceed with a non-canonical deploy

## Workstream 6: Path-Class Policy Transparency

Expose write policy by path class.

### Minimum path classes

- normal files in writable roots
- hidden files and directories
- VCS metadata like `.git`
- temp directories
- user home outside writable roots

### Requirements

- Both `apply_patch` and shell writes should use the same path policy model.
- If `.agents/...` is blocked because it is a hidden path, state that directly.
- If `/tmp/...` cleanup is allowed, destructive-command heuristics should respect the low-risk classification.

## Workstream 7: Temp Cleanup And Snapshot Safety

### Temp cleanup

Adjust guardrails so low-risk temp cleanup is allowed when the target is clearly disposable.

Examples:

- allow deleting agent-created temp dirs under `/tmp`
- keep blocking broad deletes under repo roots, `$HOME`, or ambiguous paths

### Snapshot export safety

When Codex assembles deployment snapshots:

- exclude common runtime-state directories by default
- show the excluded paths
- allow explicit opt-in if the user wants a stateful export

Suggested default exclusions:

- `data/`
- session logs
- local caches
- temporary deployment bundles

## Implementation Sequence

1. Add session capability probes and a machine-readable capability object.
2. Add error taxonomy mapping for network, filesystem, and guardrail failures.
3. Freeze capability policy for the session and emit change events if transitions are unavoidable.
4. Add Git preflight checks before mutation and before proposing recovery paths.
5. Add workflow-drift prevention logic that consults repo instructions.
6. Update temp cleanup heuristics and snapshot-export defaults.
7. Add regression tests for all documented failure classes.

## Test Plan

### Capability matrix tests

- hidden paths blocked, normal paths writable
- `.git` blocked separately from workspace writes
- GitHub unavailable while Railway remains available
- policy-stable session does not change mid-run

### Workflow tests

- repo with branch promotion flow blocks ad hoc deploy substitution by default
- agent refuses Git mutation when rollback path is unavailable
- worktree recovery is not proposed when worktree creation is blocked

### Error-message tests

- DNS failure is reported differently from policy denial
- hidden-path block is reported differently from outside-root block
- temp cleanup block includes path-risk explanation

## Acceptance Criteria

- At session start, the user can see whether workspace writes, hidden paths, `.git`, worktrees, GitHub, and Railway are available.
- If a capability is blocked, the user can tell whether the reason is policy or runtime failure.
- Capability behavior is stable for the session or explicitly reported when it changes.
- Codex does not enter non-canonical deploy flows without saying so and getting explicit confirmation.
- Codex does not mutate Git state when it lacks the ability to perform the expected cleanup path.

## Open Questions

- Which network destinations should be probed by default versus lazily on first use?
- Should repo instructions be machine-readable so workflow policy can be enforced more reliably?
- Should the capability matrix be attached to every tool error, or only shown on demand after the first failure?

## Proposed Outcome

The right fix is not “remove the sandbox.” The right fix is a stable and inspectable capability model, plus agent workflow rules that use that model to avoid creating states they cannot recover from.
