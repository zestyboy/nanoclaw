# Two-Project Railway Plan for NanoClaw

## Goal

Operate NanoClaw with two separate Railway projects:

- `nanoclaw-prod`: production only, deployed from GitHub `main`
- `nanoclaw-dev`: development only, used for local and feature-branch iteration

This separates state, secrets, volumes, bot identities, and deployment triggers so development work cannot accidentally affect production.

## Why This Pattern

NanoClaw is stateful and operationally sensitive:

- persistent `/data` volume
- live messaging bot tokens
- scheduled tasks
- background services
- Syncthing peer state
- production-facing integrations

Because of that, separate Railway projects are preferable to a single project with multiple environments.

## Desired End State

### Production project
- Railway project: `nanoclaw-prod`
- Source linked to GitHub repo
- Auto-deploy enabled from `main` only
- Production bot tokens only
- Production volume only
- Production Syncthing config only
- No routine `railway up` from local machine

### Development project
- Railway project: `nanoclaw-dev`
- Separate Railway project and separate volume
- Used for `railway up` from local machine
- May or may not be linked to GitHub, but should not auto-deploy from `main`
- Development bot tokens only
- Development Syncthing pairing only
- Safe place for branch testing and config iteration

## High-Level Workflow

### Development workflow
1. Create or switch to a local feature branch.
2. Make code changes locally.
3. Deploy to `nanoclaw-dev` using `railway up`.
4. Validate behavior on the dev Railway service.
5. Iterate until ready.
6. Open PR and merge to `main`.

### Production workflow
1. Merge approved changes to `main`.
2. Railway production project auto-deploys from GitHub `main`.
3. Validate production rollout.
4. Avoid manual local deploys to prod except for emergencies.

## Project Topology

### Project 1: Production
- Railway project name: `nanoclaw-prod`
- Service name: `nanoclaw`
- Volume mount: `/data`
- Connected repo: current GitHub repo
- Auto-deploy branch: `main`
- Restart policy and runtime config mirrored from current working production setup

### Project 2: Development
- Railway project name: `nanoclaw-dev`
- Service name: `nanoclaw`
- Volume mount: `/data`
- Can use same Dockerfile and runtime shape as prod
- Should not share volume, tokens, or Syncthing identity with prod

## Secrets and Environment Separation

## Production-only secrets
- production Discord bot token
- production Telegram bot token
- production Tailscale auth key if used
- production Syncthing peer configuration
- production OAuth and API credentials
- production R2 credentials if these should point at prod buckets only

## Development-only secrets
- development Discord bot token
- development Telegram bot token
- development Tailscale auth key if needed
- development Syncthing peer configuration
- development OAuth/API credentials where possible
- separate R2 buckets or prefixes if dev should not write into prod data

## Rule
Never reuse production messaging bot tokens in the dev project unless there is no alternative and the behavior is explicitly acceptable.

## Storage and State Isolation

### Production
- Keep current production Railway volume as-is.
- Keep current production `/data` state isolated.
- Keep production Syncthing pairing tied only to the production project.

### Development
- Provision a new Railway volume.
- Start with a clean `/data` unless a deliberate seed/import step is needed.
- Pair Syncthing separately if dev file mirroring is desired.
- Do not point dev at production Syncthing peers.

## Syncthing Plan

### Production
- Current Syncthing setup remains on production only.
- Continues syncing `/data/projects` to your laptop if desired.

### Development options
Choose one:

#### Option A: No Syncthing on dev initially
- Simplest
- Use local code + `railway up` only
- Best if Syncthing is mainly needed for prod project continuity

#### Option B: Separate Syncthing peer for dev
- Add a second local Syncthing folder, for example:
  - `~/development/nanoclaw-projects-dev`
- Pair dev Railway project to that folder only
- Separate device/folder identity from prod
- Recommended if you want to test file-sync behavior in dev too

## Recommended initial choice
Use Option A first. Add Syncthing to dev later only if needed.

## GitHub and Deploy Trigger Policy

### Production
- GitHub linked
- Auto-deploy enabled
- Trigger branch: `main`
- Production changes arrive only through merge to `main`

### Development
Recommended configuration:
- either no GitHub auto-deploy
- or GitHub linked but auto-deploy disabled / pointed away from `main`

The key is:
- `railway up` should be the normal deployment path for dev
- GitHub `main` should not overwrite the dev service unexpectedly

## Local CLI Workflow

Create explicit commands so deploy target selection is mechanical.

### Suggested commands
- `npm run railway:dev:status`
- `npm run railway:dev:deploy`
- `npm run railway:prod:status`
- `npm run railway:prod:logs`

### Suggested implementation approach
Add small scripts or package.json commands that always pass:
- project
- environment
- service

This avoids relying on whichever Railway project is currently linked in the shell.

## Example command pattern
These are examples only; exact IDs/names should be filled in during implementation.

```bash
railway status --project nanoclaw-dev --service nanoclaw
railway up --project nanoclaw-dev --service nanoclaw --detach -m "dev deploy"
railway status --project nanoclaw-prod --service nanoclaw
railway logs --project nanoclaw-prod --service nanoclaw
Repo Changes To Make During Implementation
1. Add Railway target scripts
Add package.json scripts or shell scripts for:

dev deploy
dev status
dev logs
prod status
prod logs
2. Add documentation
Update README with:

two-project deployment model
dev vs prod rules
which commands to use
warning not to run local deploys to prod
3. Add optional guardrails
Possible guardrails:

a script that refuses to deploy to prod unless an explicit override flag is passed
a deploy wrapper that checks current git branch before dev deploy
a script that prints current Railway target before deploying
4. Add environment inventory doc
Document:

which secrets belong to prod
which secrets belong to dev
which services/bots are shared vs isolated
which volumes and buckets map to which project
Railway Setup Steps For Later Implementation
Production project
Confirm current project is the production project.
Rename to nanoclaw-prod if needed.
Confirm GitHub link and main auto-deploy settings.
Confirm production env vars and volume are correct.
Confirm production Syncthing is working.
Development project
Create new Railway project nanoclaw-dev.
Add service nanoclaw.
Attach a fresh volume at /data.
Copy only the required non-prod env vars.
Add development-specific secrets and bot tokens.
Decide whether to link GitHub.
If linked, disable or constrain auto-deploy so main does not own dev.
Validate basic boot.
Optional Seed Strategy For Dev
If dev needs representative state, choose one:

Option A: Clean dev state
Start empty
Safest
Best default
Option B: Seed selected data
Copy minimal folders or configuration
Avoid importing production sessions or sensitive runtime state
Prefer seeding only what is needed for testing
Do not copy by default
/data/sessions
/data/ipc
/data/store
logs
production auth state that should remain isolated
Bot and Integration Strategy
Best practice
Use separate bot identities for dev and prod.

Discord
production bot in production server/category
dev bot in test server/category
Telegram
production bot for live usage
dev bot for testing only
Other integrations
Where possible:

use separate OAuth apps
use separate callback URLs
use separate buckets/prefixes
use separate rate-limited external resources
Operational Rules
Production rules
only deploy through merge to main
no experimental feature testing
no ad hoc env var changes without intent
no local railway up except emergency cases
Development rules
all feature branch deploys go here
safe place for env var experiments
safe place for Syncthing experiments if enabled
safe place for container/runtime validation
Risks and Mitigations
Risk: production and development use the same bot tokens
Mitigation:

provision separate bot identities before switching workflows
Risk: railway up accidentally targets prod
Mitigation:

use explicit --project and --service
add wrapper scripts
avoid relying on linked context
Risk: dev writes to prod buckets or external systems
Mitigation:

separate credentials, buckets, prefixes, and webhook endpoints
Risk: confusion over which Railway project is active
Mitigation:

use explicit commands only
document project names clearly
add helper scripts
Validation Checklist For Later Implementation
Production validation
prod Railway project points to GitHub main
auto-deploy from main works
production bots connect
volume mounts correctly
production Syncthing still works
no dev-only env vars present
Development validation
railway up deploys to dev project only
dev boots cleanly
dev has separate volume
dev bots/integrations are isolated
GitHub main does not overwrite dev unexpectedly
Recommended Implementation Order
Audit the current production Railway project and label it as prod.
Create a new dev Railway project.
Provision a fresh dev volume.
Populate dev env vars and dev bot credentials.
Add repo-level deploy scripts for explicit targeting.
Test local railway up to dev.
Confirm prod remains GitHub main driven.
Update README and ops docs.
Optionally add dev Syncthing later.
Recommendation Summary
For NanoClaw, use:

separate Railway projects
prod driven by GitHub main
dev driven by local railway up
separate state, secrets, and bots
explicit CLI wrappers to prevent target mistakes
This is the safest and least confusing long-term pattern for a stateful assistant like this one.