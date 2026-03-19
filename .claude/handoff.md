# Handoff: Project Message Mirroring

## Status

The feature is implemented, tested locally, validated end-to-end in Railway `dev`, and deployed successfully to the live dev service:

- Railway project: `fulfilling-adventure`
- Environment: `dev`
- Service: `nanoclaw`
- Latest validated dev deploy: `de2ef6ea-e764-4003-806a-ec0af2caafcb`

The separate `nanoclaw-dev` Railway project exists but was not the active dev bot used for testing.

## User-Facing Behavior

When a project-related conversation happens in `#personal-assistant-dev` or `#brain-router-dev`:

- the source channel still behaves normally
- Brain Router can activate mirroring to the project channel
- user messages and bot replies are mirrored into the project channel
- direct Brain Router conversations reply in `#brain-router-dev`
- delegated PA conversations reply back to `#personal-assistant-dev`, not `#brain-router-dev`
- Discord mirror messages to the project channel are sent silently to reduce duplicate notification noise

## What Was Fixed

### 1. Project registry ownership bug

Project creation from PA originally wrote `projects.yaml` into the calling group's folder instead of Brain Router's canonical project registry. That caused live failures where the Discord project channel was created, but later Brain Router said no matching project existed.

Fix:

- `src/ipc.ts`
- `create_project` now resolves the canonical project-owner folder and writes `projects.yaml` there
- regression test: `src/create-project.test.ts`

### 2. Missing synthetic chat metadata path

Synthetic `execute_in_group` dispatches could fail when the target chat metadata was missing in `chats`.

Fix:

- `src/ipc.ts`
- synthetic routed messages now ensure chat metadata exists before message insertion
- this removed the old requirement to “seed” `#brain-router-dev` manually before testing

### 3. Direct Brain Router mirroring support

Brain Router needed to support mirroring both delegated conversations and direct `#brain-router-dev` conversations.

Fixes:

- `container/agent-runner/src/ipc-mcp-stdio.ts`
- `groups/brain-router/CLAUDE.md`
- `activate_mirror` can omit `source_jid`; when omitted, the current Brain Router chat becomes the mirror source

### 4. Delegated reply over-broadcast

Delegated Brain Router replies were being posted into `#brain-router-dev` even when the conversation originated in `#personal-assistant-dev`.

Fix:

- `src/index.ts`
- reply targets are now selected per turn
- delegated replies go only to the original source channel
- direct Brain Router replies stay in `#brain-router-dev`
- regression test: `src/agent-reply-routing.test.ts`

### 5. Stale source-channel leakage across turns

After a delegated turn, a later direct Brain Router turn could still reply into the old source channel because the container reused stale reply-target context.

Fix:

- `src/index.ts`
- reply-source state is refreshed on each piped turn
- source extraction now only considers the newest message in the batch

### 6. Repeated catch-up spam

Refreshing an already-active mirror kept replaying retroactive “Catching up” summaries into the project channel.

Fix:

- `src/mirror.ts`
- retroactive catch-up now only sends on a genuinely new activation
- if a mirror has truly expired and is activated again, one fresh catch-up is still sent

### 7. Duplicate project-channel notification noise

The source channel would notify immediately for the user message, then the project channel would notify again for the mirrored user message and later again for the mirrored bot reply.

Fix:

- `src/types.ts`
- `src/channels/discord.ts`
- `src/channels/telegram.ts`
- `src/index.ts`
- mirror-target sends now support a `silent` option
- Discord mirror sends use `MessageFlags.SuppressNotifications`
- source-channel replies remain normal

### 8. Railway native build failure

The Railway Docker build failed on `better-sqlite3` because the image lacked Python/build tools.

Fix:

- `Dockerfile.railway`
- `host-builder` now installs `python3 make g++` before `npm ci`

## Validation Completed

### Local verification

- `npm test -- src/channels/discord.test.ts src/mirror.test.ts src/agent-reply-routing.test.ts src/create-project.test.ts src/ipc-auth.test.ts`
- `npm run typecheck`

### Dev Discord verification

Validated manually in:

- `#personal-assistant-dev`
- `#brain-router-dev`
- `#test-mirroring-2`

Verified behaviors:

- project creation succeeds
- PA-routed conversations mirror into the project channel
- direct Brain Router conversations mirror into the project channel
- delegated replies no longer appear in `#brain-router-dev`
- direct Brain Router replies no longer leak into `#personal-assistant-dev`
- repeated catch-up spam is reduced
- silent mirror messages appear in the project channel without the same visible notification noise

## Relevant Files

- `src/ipc.ts`
- `src/index.ts`
- `src/mirror.ts`
- `src/types.ts`
- `src/channels/discord.ts`
- `src/channels/telegram.ts`
- `container/agent-runner/src/ipc-mcp-stdio.ts`
- `groups/brain-router/CLAUDE.md`
- `Dockerfile.railway`
- `src/create-project.test.ts`
- `src/agent-reply-routing.test.ts`
- `src/mirror.test.ts`
- `src/channels/discord.test.ts`

## How To Promote To Production

Production is not deployed directly from Railway CLI. Promotion is through Git:

1. Review the handoff worktree changes.
2. Commit the branch.
3. Push the branch to GitHub.
4. Open a PR to `main`.
5. Merge the PR.
6. Railway `production` auto-deploys from GitHub `main`.
7. Verify with:
   - `npm run railway:prod:status -- --json`
   - `npm run railway:prod:logs -- --lines 200`
8. Smoke-test in production Discord with one low-risk project interaction.

Current production status at handoff time:

- Railway project: `fulfilling-adventure`
- Environment: `production`
- Service: `nanoclaw`
- Status: `SUCCESS`
- Current deployment before merge: `7240f79b-a22d-4e8b-959b-9a3ad23c03c6`

## Production Risks

Overall risk is moderate-low because:

- no SQLite schema changes were required
- the feature was validated against the actual dev Discord bot and service
- production and dev share the same app service shape

Main remaining risks:

- production has separate Discord tokens, channels, and persistent state; a prod-only configuration mismatch could still exist
- active mirrors are in-memory only and do not survive a deploy/restart; that is expected behavior, not a bug
- silent mirror suppression is Discord-specific; this optimization does not change Telegram behavior
- long-lived production sessions may carry old conversational context, so a `/clear` in the relevant prod channels before final smoke-testing is prudent

## Recommended Production Smoke Test

After merge:

1. Use a low-risk project or temporary test project in production.
2. In `#personal-assistant`, send one project-related note.
3. Confirm:
   - normal reply in the source channel
   - mirrored user message and bot reply in the project channel
   - no unexpected `#brain-router` reply for delegated turns
4. In `#brain-router`, send one direct project-related note.
5. Confirm:
   - reply stays in `#brain-router`
   - mirrored content appears in the project channel
   - no unexpected leak back to `#personal-assistant`
