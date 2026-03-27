# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/add-slash-commands` | Add or extend native Discord slash commands |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Deployment Workflow

Railway auto-deploys from GitHub branches:

| Environment | Branch | Auto-deploys |
|-------------|--------|-------------|
| **dev** | `dev` | Yes — on push to `dev` |
| **production** | `main` | Yes — on push to `main` |

**Standard flow:**
1. Create a feature branch from `main` (e.g., `feat/my-feature`)
2. Do work, commit
3. Merge to `dev` → Railway dev auto-deploys → test on dev
4. Once verified, merge `dev` to `main` → Railway production auto-deploys

**Quick commands:**
```bash
git checkout dev && git merge feat/my-feature && git push origin dev  # deploy to dev
git checkout main && git merge dev && git push origin main            # promote to prod
```

Don't push directly to `main` without testing on dev first. Use `railway up --detach -s nanoclaw` for one-off CLI deploys if needed (e.g., hotfixes).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Apple Container Runtime

This install uses **Apple Container** (not Docker). After running `/update-nanoclaw`, verify the upstream merge hasn't reverted these Apple Container adaptations:

- **`src/container-runtime.ts`**: `CONTAINER_HOST_GATEWAY` must resolve to `192.168.64.1` (not `host.docker.internal`). `PROXY_BIND_HOST` must bind to `192.168.64.1` (not `127.0.0.1`). Apple Container VMs sit on a `192.168.64.0/24` vnet and cannot resolve `host.docker.internal`.
- **`src/container-runner.ts`**: Must NOT have a host-side `/dev/null` bind mount for `.env` shadowing. Apple Container's VirtioFS cannot mount character devices. The `.env` shadow is handled inside the container entrypoint via `mount --bind /dev/null`.

If these were overwritten, re-apply the fixes or run `/convert-to-apple-container`.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
