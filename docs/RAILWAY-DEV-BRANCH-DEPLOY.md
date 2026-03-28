# Railway Dev Branch Auto-Deploy — Not Working

## Problem

The dev environment does not auto-deploy when pushing to the `dev` branch. Production auto-deploys from `main` correctly.

## What We Observed (2026-03-27)

1. **Git push to `dev` produced no Railway build** — `git push origin dev` succeeded but no deployment appeared in Railway
2. **Dev deployments show no git metadata** — `railway deployment list --environment dev` shows `branch=?` and `commit=?`, meaning all dev builds were CLI deploys (`railway up`), never git-triggered
3. **Production works fine** — deployments show `branch=main` with proper commit hashes
4. **CLI workaround** — `railway up --service nanoclaw --environment dev --detach` works but deploys from local files, not the git branch

## What We Tried

- `railway redeploy --environment dev` — failed, `--environment` is not a valid flag for `redeploy`
- `railway restart --environment dev` — same issue
- The CLI uses linked context, not explicit environment flags for redeploy/restart
- Fell back to `railway up` which worked but isn't git-triggered

## Root Cause (Suspected)

The dev environment likely doesn't have a source branch configured. Railway needs per-environment branch configuration to know which branch triggers a deploy for each environment. This is probably set in:

- **Railway Dashboard** → Service Settings → Source → Branch (per environment)
- **Railway GraphQL API** — a mutation to set the source branch on the service instance for the dev environment

## TODO

- [ ] Check Railway dashboard: Project → dev environment → nanoclaw service → Settings → look for "Source" or "Branch" configuration
- [ ] If no branch is set, configure it to watch the `dev` branch
- [ ] If the dashboard doesn't expose this, use the Railway GraphQL API to set the branch per environment (see `configure.md` in the Railway skill references)
- [ ] Verify by pushing a test commit to `dev` and confirming a build triggers
- [ ] Update CLAUDE.md deployment workflow section once fixed

## Current Workaround

```bash
# Manual deploy to dev from local files
railway up --service nanoclaw --environment dev --detach -m "description"
```

This works but doesn't track git commits in the deployment metadata.
