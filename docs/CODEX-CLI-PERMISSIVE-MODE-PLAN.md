# Codex CLI Low-Friction Usage Plan

## Recommendation

Do not modify Codex CLI source code.

Use Codex CLI in its already-supported high-permission configurations so the session behaves more predictably and does not get stuck on sandbox friction.

The correct fix for this use case is operational, not architectural:

- choose a less restrictive built-in sandbox mode
- use a non-interrupting approval policy
- make that configuration explicit in startup commands or config

## Scope

This plan assumes:

- you do not want to patch Codex CLI itself
- you want fewer permission failures
- you are willing to trade some safety for a smoother workflow in trusted repos

## What Codex CLI Supports Today

Codex CLI already exposes these relevant controls:

- `--sandbox read-only`
- `--sandbox workspace-write`
- `--sandbox danger-full-access`
- `--ask-for-approval untrusted|on-request|never`
- `--dangerously-bypass-approvals-and-sandbox`

This means there is no need to invent new modes in order to get a more permissive workflow.

## Recommended Operating Modes

### Option 1: Practical default for trusted repos

Use:

```bash
codex --sandbox danger-full-access -a never
```

This is the closest match to "stop making me fight permissions" while still using the normal CLI surface.

Use this when:

- the repo is trusted
- you want Git operations to work normally
- you want hidden paths and `.git` writes to stop failing due to sandboxing
- you do not want approval prompts

### Option 2: Maximum bypass mode

Use:

```bash
codex --dangerously-bypass-approvals-and-sandbox
```

Use this only when:

- the machine and repo are trusted
- you want the least amount of friction possible
- you accept that Codex is operating without sandbox protection

This is the most direct answer to your stated preference, but it should be reserved for sessions where you are comfortable with full trust.

## Suggested Persistent Config

If you want this behavior by default, update [~/.codex/config.toml](/Users/niven/.codex/config.toml) to:

```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

Your current config already has:

```toml
approval_policy = "never"
sandbox_mode = "workspace-write"
```

So the minimal change is just:

- switch `sandbox_mode` from `workspace-write` to `danger-full-access`

## Expected Impact On Your Reported Problems

This should materially reduce or eliminate the following classes of headaches:

- hidden repo paths like `.agents/...` being blocked by sandbox path policy
- `.git` write failures such as `index.lock` creation problems caused by sandbox restrictions
- worktree creation failing due to sandbox-denied writes under `.git/worktrees`
- shell commands that need broader write access than `workspace-write` permits

It may also reduce confusion around Git cleanup because Git metadata operations should no longer be sandbox-blocked.

## What This Does Not Guarantee

Even with `danger-full-access`, this does not guarantee:

- GitHub DNS is always reachable
- GitHub auth is valid
- Railway and GitHub behave identically at the network layer
- every failure is caused by Codex policy

So this approach removes one major class of friction, but not all possible environmental failures.

## Practical Guidance

For this repo, the most reasonable setup is:

1. Use `danger-full-access` for Codex sessions in NanoClaw.
2. Keep `approval_policy = "never"` if you do not want interruptions.
3. Avoid `workspace-write` when you know the task will involve:
   - `.git`
   - hidden repo paths
   - worktrees
   - deployment tooling
4. Only use `--dangerously-bypass-approvals-and-sandbox` when you explicitly want full trust and minimum friction.

## Bottom Line

If your goal is simply to stop fighting permissions, you do not need a new Codex CLI feature and you do not need to modify Codex CLI source.

Use the existing high-permission mode:

```bash
codex --sandbox danger-full-access -a never
```

and, if desired, make that the default in [~/.codex/config.toml](/Users/niven/.codex/config.toml).
