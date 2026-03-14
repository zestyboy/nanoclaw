# Switching from Apple Container to Docker

This documents how to switch NanoClaw's container runtime from Apple Container back to Docker. This is essentially the reverse of `/convert-to-apple-container` — undoing the Apple Container adaptations and reverting to upstream's defaults (which assume Docker).

Written based on the issues encountered during the 2026-03-14 session where an upstream merge silently broke Apple Container support. The same categories of difference apply when switching in either direction.

## Why Switch

- **Linux deployment**: Apple Container is macOS-only. Docker runs everywhere.
- **CI/CD**: Most CI environments have Docker, not Apple Container.
- **Team use**: Other contributors are more likely to have Docker installed.

## What's Different Between the Two Runtimes

There are five areas where Apple Container and Docker diverge. All are isolated to a small number of files.

### 1. Container-to-Host Networking

| | Apple Container | Docker Desktop (macOS) | Docker (Linux) |
|---|---|---|---|
| **Host address** | `192.168.64.1` (vnet gateway) | `host.docker.internal` (built-in DNS) | `host.docker.internal` (via `--add-host`) |
| **Proxy bind** | `192.168.64.1` | `127.0.0.1` | docker0 bridge IP |

Apple Container VMs sit on a `192.168.64.0/24` virtual network. Docker Desktop routes `host.docker.internal` to loopback automatically.

**Files**: `src/container-runtime.ts` (`CONTAINER_HOST_GATEWAY`, `PROXY_BIND_HOST`, `hostGatewayArgs()`)

### 2. `.env` Shadowing

The `.env` file contains API keys that must be hidden from containers. The two runtimes handle this differently:

| | Apple Container | Docker |
|---|---|---|
| **Method** | In-container `mount --bind /dev/null .env` in entrypoint (requires starting as root, then dropping privileges) | Host-side bind mount: `--mount type=bind,source=/dev/null,target=/workspace/project/.env,readonly` |
| **Why** | VirtioFS cannot mount character devices (`/dev/null`) from the host | Docker supports file-level bind mounts of any type |

**Files**: `src/container-runner.ts` (mount construction), `container/Dockerfile` (entrypoint script)

### 3. Privilege Model

| | Apple Container | Docker |
|---|---|---|
| **Main containers** | Start as root → `mount --bind` → `setpriv --reuid` to drop privileges | Start with `--user uid:gid` directly; `.env` shadowed by host mount |
| **Non-main containers** | `--user uid:gid` | `--user uid:gid` |

With Docker, main containers don't need root because the host handles `.env` shadowing.

**Files**: `src/container-runner.ts` (privilege drop logic), `container/Dockerfile` (entrypoint)

### 4. Runtime Binary & CLI

| | Apple Container | Docker |
|---|---|---|
| **Binary** | `container` | `docker` |
| **Status check** | `container system status` | `docker info` |
| **List containers** | `container ls --format json` | `docker ps --format json` |
| **Build** | `container build` | `docker build` |

**Files**: `src/container-runtime.ts` (`CONTAINER_RUNTIME_BIN`), `container/build.sh`

### 5. Orphan Container Cleanup

Apple Container's `container ls --format json` returns:
```json
[{"status": "running", "configuration": {"id": "nanoclaw-main-..."}}]
```

Docker's `docker ps --format json` returns one JSON object per line:
```json
{"ID": "abc123", "Names": "nanoclaw-main-...", "State": "running"}
```

The parsing logic in `cleanupOrphans()` currently uses Apple Container's format.

**File**: `src/container-runtime.ts` (`cleanupOrphans()`)

## Step-by-Step: Switch to Docker

### Prerequisites

```bash
docker --version  # Verify Docker is installed
docker info       # Verify daemon is running
```

### 1. `src/container-runtime.ts`

Change `CONTAINER_RUNTIME_BIN`:
```typescript
// Before (Apple Container)
export const CONTAINER_RUNTIME_BIN = 'container';

// After (Docker)
export const CONTAINER_RUNTIME_BIN = 'docker';
```

The `detectHostGateway()` and `detectProxyBindHost()` functions already have Docker fallback logic — they check `CONTAINER_RUNTIME_BIN` and will return the correct values automatically.

Update `ensureContainerRuntimeRunning()` error message to reference Docker instead of Apple Container.

Update `cleanupOrphans()` to parse Docker's JSON format:
```typescript
// Docker outputs one JSON object per line, not an array
const lines = output.trim().split('\n').filter(Boolean);
const containers = lines.map(l => JSON.parse(l));
const orphans = containers
  .filter(c => c.State === 'running' && c.Names.startsWith('nanoclaw-'))
  .map(c => c.Names);
```

### 2. `src/container-runner.ts`

Re-add the host-side `/dev/null` mount for `.env` shadowing:
```typescript
const envFile = path.join(projectRoot, '.env');
if (fs.existsSync(envFile)) {
  mounts.push({
    hostPath: '/dev/null',
    containerPath: '/workspace/project/.env',
    readonly: true,
  });
}
```

Simplify the privilege model — main containers no longer need root:
```typescript
// Remove the isMain branch that passes RUN_UID/RUN_GID
// Use --user for all containers
if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
  args.push('--user', `${hostUid}:${hostGid}`);
  args.push('-e', 'HOME=/home/node');
}
```

### 3. `container/Dockerfile`

The entrypoint can be simplified since Docker handles `.env` shadowing:
```bash
#!/bin/bash
set -e
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
exec node /tmp/dist/index.js < /tmp/input.json
```

The `mount --bind`, `setpriv`, and `RUN_UID`/`RUN_GID` logic can be removed (but leaving it in won't break anything — it's guarded by `if [ "$(id -u)" = "0" ]`).

### 4. `container/build.sh`

```bash
# Change default runtime
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
```

### 5. Build and Test

```bash
npm run build
./container/build.sh
npm test

# Restart service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
systemctl --user restart nanoclaw                    # Linux
```

### 6. Update `CLAUDE.md`

Replace the "Apple Container Runtime" section with a Docker equivalent, or remove it if Docker is the upstream default.

## Rollback

If something breaks, revert to Apple Container:
```bash
git checkout HEAD -- src/container-runtime.ts src/container-runner.ts container/Dockerfile container/build.sh
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Lessons Learned (from the 2026-03-14 incident)

1. **The networking layer is the main divergence.** Both runtimes run the same Linux image — the difference is how the container reaches the host. Get this wrong and every API call fails with ENOTFOUND silently.

2. **`.env` shadowing is the second divergence.** Docker can bind-mount `/dev/null` over a file. Apple Container (VirtioFS) cannot. This causes immediate container startup failure.

3. **Both issues fail silently from the user's perspective.** No error appears in Discord — messages just get no response. Check `logs/nanoclaw.log` for `ENOTFOUND` or `/dev/null` errors.

4. **`src/container-runtime.ts` is the single file that controls runtime behavior.** The comment on line 1 says it: "All runtime-specific logic lives here so swapping runtimes means changing one file." That's mostly true — the `.env` mount in `container-runner.ts` and the Dockerfile entrypoint are the exceptions.
