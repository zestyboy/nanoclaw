# Railway Deployment + R2-Synced Vaults

## Before You Start

Read this plan fully, then read the following source files before writing any code:
- `src/container-runner.ts` — the container-based agent runner you'll be mirroring for Railway
- `src/container-runtime.ts` — runtime abstraction (binary selection, host gateway, readonly mounts)
- `src/config.ts` — configuration and path defaults you'll be extending
- `src/index.ts` — orchestrator startup sequence where you'll add IS_RAILWAY conditionals
- `src/ipc.ts` — IPC handlers where you'll add Second Brain handlers and R2 write-back
- `groups/main/CLAUDE.md` — Brain Router prompt where you'll add the SECOND_BRAIN intent
- `container/skills/knowledge/SKILL.md` — knowledge skill you'll mirror for Second Brain

Follow the implementation order at the bottom of this plan.

**Safety first:** Before making any code changes, ensure the current working state is committed and tagged so the user can revert to a fully working local system if the Railway changes cause issues. See Implementation Order step 1.

---

## Context

Deploy NanoClaw on Railway so it runs 24/7 without a laptop. Three concerns:
1. **Railway deployment** — replace container-based agent execution with Node.js child processes (Railway can't run Docker-in-Docker)
2. **Knowledge repo on R2** — the existing work-related Obsidian vault (currently at `~/development/nanoclaw-knowledge`) needs to be accessible on Railway via Cloudflare R2
3. **Second Brain on R2** — a new personal Obsidian vault (converted from Notion), also on R2, separate from the knowledge repo. Never on work laptop.

**Two R2 buckets, two vaults:**

| Vault | Content | Managed from | R2 bucket | Railway path | Existing code |
|-------|---------|-------------|-----------|-------------|---------------|
| Knowledge repo | Work: products, company, competitors | Work laptop (Obsidian + remotely-save) | `knowledge` | `/data/knowledge` | Yes — `search_knowledge`, `reindex_knowledge` IPC handlers, Brain Router KNOWLEDGE intent, container mount logic |
| Second Brain | Personal: notes, ideas, life | Personal device (Obsidian + remotely-save) | `second-brain` | `/data/second-brain` | No — new IPC handlers, new Brain Router intent, new mount needed |

---

## Part 1: Railway Deployment

### Why child processes instead of containers

NanoClaw normally spawns a Docker/Apple Container per agent task. Railway runs your app inside a container but doesn't expose a Docker daemon — so you can't `docker run` from inside the Railway container. The solution: spawn agent-runner as a Node.js child process instead. The agent-runner code is identical; only the execution wrapper changes.

### Key architectural pattern: railway-runner.ts

`railway-runner.ts` replaces `container-runner.ts` on Railway. It must:

1. **Prepare workspace directories** on the Railway `/data` volume (not Docker mounts):
   - `/data/groups/{folder}` — group's writable workspace
   - `/data/groups/global` — shared global memory (read-only for non-main)
   - `/data/sessions/{folder}/.claude` — per-group Claude config, skills, agent-runner-src
   - `/data/ipc/{folder}/messages`, `tasks`, `input` — per-group IPC namespace
   - `/data/knowledge` — knowledge vault (from R2)
   - `/data/second-brain` — second brain vault (from R2)

2. **Sync templates before each run**: copy CLAUDE.md, skills, .mcp.json from the image to the session directory (same as container-runner copies them into container mounts)

3. **Spawn the agent as a child process**:
   ```typescript
   const child = spawn('node', [AGENT_RUNNER_PATH], {
     env: {
       ...process.env,
       NANOCLAW_WORKSPACE_GROUP: groupDir,
       NANOCLAW_WORKSPACE_GLOBAL: globalDir,
       NANOCLAW_IPC_DIR: ipcDir,
       HOME: sessionDir, // so claude-code reads per-group .claude/
     },
     stdio: ['pipe', 'pipe', 'pipe'],
   });
   ```

4. **Pass input via stdin** (same JSON format as container-runner)

5. **Parse OUTPUT markers on stdout**: `---NANOCLAW_OUTPUT_START---` + JSON + `---NANOCLAW_OUTPUT_END---` — identical streaming protocol to container-runner

6. **Handle timeouts**: soft timeout (resets on activity) + hard timeout (SIGTERM then SIGKILL after 15s)

7. **Write logs** to `/data/groups/{folder}/logs/railway-{timestamp}.log`

### Files to create

**`railway.json`** (new):
```json
{
  "build": { "dockerfile": "Dockerfile.railway" },
  "deploy": { "restartPolicyMaxRetries": 5, "restartPolicy": "ON_FAILURE" }
}
```

**`Dockerfile.railway`** (new) — 3-stage build:
```dockerfile
# Stage 1: Build agent-runner
FROM node:22-slim AS agent-builder
WORKDIR /build
COPY container/agent-runner/package*.json ./
RUN npm ci
COPY container/agent-runner/ ./
RUN npx tsc

# Stage 2: Build host orchestrator
FROM node:22-slim AS host-builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Stage 3: Final image
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium gosu rclone git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g agent-browser @anthropic-ai/claude-code
# Install qmd (check current install method — may be npm or cargo)
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY --from=host-builder /build/dist ./dist
COPY --from=agent-builder /build/dist /agent-runner-dist
COPY container/skills /app/container/skills
COPY groups /app/groups
COPY docker-entrypoint-railway.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint-railway.sh
ENV AGENT_RUNNER_PATH=/agent-runner-dist/index.js
ENV CHROMIUM_PATH=/usr/bin/chromium
ENTRYPOINT ["docker-entrypoint-railway.sh"]
CMD ["node", "dist/index.js"]
```

**`docker-entrypoint-railway.sh`** (new):
```bash
#!/bin/bash
set -e

# Fix volume permissions
chown -R node:node /data 2>/dev/null || true

# Configure rclone for R2 (if credentials provided)
if [ -n "$R2_ENDPOINT" ]; then
  mkdir -p /home/node/.config/rclone
  cat > /home/node/.config/rclone/rclone.conf <<RCLONE
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY}
secret_access_key = ${R2_SECRET_KEY}
endpoint = ${R2_ENDPOINT}
RCLONE
  chown -R node:node /home/node/.config

  # Sync knowledge repo from R2
  if [ -n "$R2_KNOWLEDGE_BUCKET" ]; then
    mkdir -p /data/knowledge
    gosu node rclone sync r2:${R2_KNOWLEDGE_BUCKET} /data/knowledge --exclude ".remotely-save/**"
    if [ ! -f "/data/knowledge/.qmd/config.toml" ]; then
      cd /data/knowledge && gosu node qmd init -c knowledge
    fi
    cd /data/knowledge && gosu node sh -c 'qmd update -c knowledge && qmd embed' 2>/dev/null || true
  fi

  # Sync Second Brain from R2
  if [ -n "$R2_SECOND_BRAIN_BUCKET" ]; then
    mkdir -p /data/second-brain
    gosu node rclone sync r2:${R2_SECOND_BRAIN_BUCKET} /data/second-brain --exclude ".remotely-save/**"
    if [ ! -f "/data/second-brain/.qmd/config.toml" ]; then
      cd /data/second-brain && gosu node qmd init -c second-brain
    fi
    cd /data/second-brain && gosu node sh -c 'qmd update -c second-brain && qmd embed' 2>/dev/null || true
  fi

  # Background sync loop (every 5 min: pull from R2, reindex both vaults)
  (while true; do
    sleep 300
    if [ -n "$R2_KNOWLEDGE_BUCKET" ]; then
      rclone sync r2:${R2_KNOWLEDGE_BUCKET} /data/knowledge --exclude ".remotely-save/**" 2>/dev/null
      cd /data/knowledge && qmd update -c knowledge && qmd embed 2>/dev/null || true
    fi
    if [ -n "$R2_SECOND_BRAIN_BUCKET" ]; then
      rclone sync r2:${R2_SECOND_BRAIN_BUCKET} /data/second-brain --exclude ".remotely-save/**" 2>/dev/null
      cd /data/second-brain && qmd update -c second-brain && qmd embed 2>/dev/null || true
    fi
  done) &
fi

# Drop to non-root user and run NanoClaw
# (claude-code refuses --dangerously-skip-permissions when running as root)
exec gosu node "$@"
```

**`src/railway-runner.ts`** (new): implement the child-process agent runner as described above. Study the existing `src/container-runner.ts` closely — mirror its interface (`runContainerAgent` signature, `ContainerOutput` return type, streaming callbacks) but replace Docker spawn with Node.js `child_process.spawn`. The key functions to replicate:
- `buildVolumeMounts` → becomes `prepareWorkspaceDirs` (create dirs on `/data` volume)
- `buildContainerArgs` → becomes building the env vars object for the child process
- The streaming output parser (OUTPUT_START/END markers) can be reused as-is
- Timeout logic (soft + hard) can be reused as-is

### Files to modify

**`src/config.ts`** — add:
```typescript
export const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
// On Railway, data lives on the persistent volume
export const RAILWAY_DATA_DIR = '/data';
```
Also update `KNOWLEDGE_DIR` default: when `IS_RAILWAY`, default to `/data/knowledge` instead of `~/development/nanoclaw-knowledge`.
Add: `export const SECOND_BRAIN_DIR = process.env.NANOCLAW_SECOND_BRAIN_DIR || (IS_RAILWAY ? '/data/second-brain' : '');`

**`src/container-runner.ts`** — add early dispatch at top of `runContainerAgent`:
```typescript
if (IS_RAILWAY) {
  return runRailwayAgent(group, input, options);
}
```

**`src/index.ts`** — skip container runtime checks when `IS_RAILWAY`:
- Skip `ensureContainerRuntimeRunning()` — no Docker daemon on Railway
- Skip `cleanupOrphans()` — no containers to clean up
- Skip container image build checks

**`src/container-runner.ts`** (mount logic) — when `IS_RAILWAY`, add Second Brain mount:
- Main group: `/data/second-brain` mounted read-write at `/workspace/second-brain`
- Non-main groups: `/data/second-brain` mounted read-only at `/workspace/second-brain`
(For railway-runner.ts, this translates to setting `NANOCLAW_WORKSPACE_SECOND_BRAIN` env var)

**`src/ipc.ts`** — add Second Brain IPC handlers mirroring the existing knowledge handlers:
- `search_second_brain` — same as `search_knowledge` but uses `-c second-brain` collection
- `reindex_second_brain` — same as `reindex_knowledge` but for second-brain collection
- Add write-back to R2 after reindex: `rclone sync /data/second-brain r2:${R2_SECOND_BRAIN_BUCKET} --exclude ".remotely-save/**" --exclude ".qmd/**"`
- Also add R2 write-back to existing `reindex_knowledge`: `rclone sync /data/knowledge r2:${R2_KNOWLEDGE_BUCKET} --exclude ".remotely-save/**" --exclude ".qmd/**"`

**`groups/main/CLAUDE.md`** (Brain Router) — add SECOND_BRAIN intent alongside existing KNOWLEDGE intent:
- Store signals: "save to second brain", "add to second brain", "personal note"
- Search signals: "search second brain", "check second brain", "what do I have about"
- Uses `search_second_brain` and `reindex_second_brain` MCP tools
- Same entity resolution pattern as KNOWLEDGE but against `/workspace/second-brain`

**`container/skills/`** — add `second-brain/SKILL.md` teaching agents the Second Brain vault conventions (can mirror `knowledge/SKILL.md` structure but with different vault paths and categories)

---

## Part 2: R2 Sync Setup (User's Manual Steps)

These are steps for the user, not code changes.

### Cloudflare R2 setup (one-time)

1. Cloudflare dashboard → R2 → Create two buckets: `knowledge` and `second-brain`
2. R2 → Manage R2 API Tokens → Create one token with read/write on both buckets
3. Note: Account ID, Access Key ID, Secret Access Key

### Obsidian remotely-save setup

**Work laptop (knowledge repo):**
1. Open the existing `nanoclaw-knowledge` vault in Obsidian
2. Install [remotely-save](https://github.com/remotely-save/remotely-save) plugin
3. Configure S3-compatible backend: endpoint `https://<account-id>.r2.cloudflarestorage.com`, bucket `knowledge`
4. Set sync interval (5 min), conflict resolution `keep_newer`
5. Do initial sync to populate R2

**Personal device (Second Brain):**
1. Convert Notion Second Brain to Obsidian format (separate effort)
2. Install remotely-save, configure same R2 endpoint, bucket `second-brain`
3. Set sync interval (5 min), conflict resolution `keep_newer`
4. Do initial sync to populate R2

### Railway setup (one-time, via dashboard)

- Create service pointing to your GitHub repo
- Attach volume mounted at `/data`
- Set environment variables:
  - `ANTHROPIC_API_KEY`
  - Channel tokens (Telegram, Discord, etc.)
  - `R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
  - `R2_ACCESS_KEY=<access-key-id>`
  - `R2_SECRET_KEY=<secret-access-key>`
  - `R2_KNOWLEDGE_BUCKET=knowledge`
  - `R2_SECOND_BRAIN_BUCKET=second-brain`
  - `NANOCLAW_KNOWLEDGE_DIR=/data/knowledge`
  - `NANOCLAW_SECOND_BRAIN_DIR=/data/second-brain`

### Conflict handling (both vaults)

- remotely-save metadata in `.remotely-save/` is excluded from rclone sync (both directions)
- qmd index in `.qmd/` is excluded when pushing back to R2
- `keep_newer` conflict resolution — single user, last-write-wins is safe
- Conflicts are rare: Obsidian writes from your device, Brain Router writes from Railway, unlikely to touch same file simultaneously

---

## Part 3: Development & Testing Workflow

### Local development (work laptop + Claude Code)

- Edit NanoClaw source code as usual
- For testing knowledge/second-brain integration locally, use a **dummy test vault** — a small folder with sample markdown files
- Optionally create test R2 buckets (`knowledge-test`, `second-brain-test`) with dummy content to test rclone sync plumbing
- The real vaults are never on the work laptop (knowledge repo can be, but doesn't have to be — it syncs via R2 either way)

### Deploying changes

```
Claude Code edits code → git commit → git push → Railway auto-deploys
```

For testing without pushing to GitHub: `railway up` deploys from your local working directory.

### End-to-end testing (from phone/messaging)

After deploying to Railway:
- `/knowledge search <topic>` → verify results from work knowledge vault
- `/second-brain search <topic>` → verify results from personal vault
- Store a note via Brain Router → check R2 bucket for the new file → verify it syncs back to Obsidian
- Your laptop is not involved — test through messaging channels

### Live debugging

- `railway logs` — stream logs
- `railway shell` — one-off shell into running container
- `railway run <command>` — execute with Railway env vars locally

---

## Implementation Order

1. **Backup current state:** Commit any uncommitted changes on `main`, then create a safety tag: `git tag pre-railway-backup`. This is the restore point if anything goes sideways (`git checkout pre-railway-backup`). Then create the feature branch `feat/railway-deployment`.
2. Add `railway.json`, `Dockerfile.railway`, `docker-entrypoint-railway.sh` (R2 sync for both vaults built into entrypoint)
3. Create `src/railway-runner.ts` — study `src/container-runner.ts` and mirror its interface using child process spawn
4. Modify `src/config.ts` — add `IS_RAILWAY`, `RAILWAY_DATA_DIR`, `SECOND_BRAIN_DIR`
5. Modify `src/container-runner.ts` — add `IS_RAILWAY` dispatch to railway-runner
6. Modify `src/index.ts` — skip container runtime checks when `IS_RAILWAY`
7. Add Second Brain IPC handlers to `src/ipc.ts` (mirror knowledge handlers)
8. Add R2 write-back (rclone push) to both `reindex_knowledge` and `reindex_second_brain` IPC handlers
9. Add Second Brain intent to `groups/main/CLAUDE.md` (Brain Router)
10. Add `container/skills/second-brain/SKILL.md`
11. Add Second Brain mount logic to container-runner (for Railway: env var; for local: optional mount if dir exists)

## Verification

**Railway deployment:**
- `railway up` → service starts, logs show R2 sync for both vaults
- Send message via channel → agent responds (proves railway-runner works)

**Knowledge repo:**
- `/knowledge search <topic>` via messaging → returns results (proves existing knowledge system works on Railway)
- Brain Router stores a note → rclone pushes to R2 → appears in Obsidian on work laptop

**Second Brain:**
- `/second-brain search <topic>` via messaging → returns results
- Brain Router stores a personal note → rclone pushes to R2 → appears in Obsidian on personal device

**Existing functionality:** all non-knowledge features should work unchanged (messaging, scheduling, project groups, etc.)

**Update workflow:**
- Push code change to GitHub → Railway auto-redeploys
