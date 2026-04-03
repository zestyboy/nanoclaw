#!/bin/bash
set -e

# Ensure base directories exist on the persistent volume.
mkdir -p /data/store /data/groups /data/projects /data/sessions /data/ipc /data/state
mkdir -p /data/state/locks
mkdir -p /data/syncthing

# Fix volume permissions after any root-owned directories are created.
chown -R node:node /data 2>/dev/null || true

# Ensure qmd cache directory exists on the persistent volume.
# XDG_CACHE_HOME is set in Dockerfile.railway so it survives gosu.
mkdir -p /data/qmd-cache
mkdir -p /data/qmd-cache/qmd/models
mkdir -p /home/node/.cache/qmd
if [ -e /home/node/.cache/qmd/models ] && [ ! -L /home/node/.cache/qmd/models ]; then
  rm -rf /home/node/.cache/qmd/models
fi
ln -sfn /data/qmd-cache/qmd/models /home/node/.cache/qmd/models
chown -h node:node /home/node/.cache/qmd/models 2>/dev/null || true
chown -R node:node /home/node/.cache
chown -R node:node /data/qmd-cache

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

  # Knowledge vaults: Railway volume is the working copy, R2 is the backup.
  # On startup: restore from R2 only if the local volume is empty (fresh deploy).
  # Every 12h: backup Railway → R2.
  # Agents trigger qmd reindex on-demand after writes; 12h periodic reindex as fallback.

  for vault_name in public-knowledge second-brain; do
    case "$vault_name" in
      public-knowledge) BUCKET="$R2_PUBLIC_KNOWLEDGE_BUCKET" ;;
      second-brain)     BUCKET="$R2_SECOND_BRAIN_BUCKET" ;;
    esac

    if [ -z "$BUCKET" ]; then continue; fi

    mkdir -p "/data/$vault_name"
    LOCAL_FILES=$(find "/data/$vault_name" -name "*.md" 2>/dev/null | head -1)
    if [ -z "$LOCAL_FILES" ] || [ "$FORCE_R2_RESTORE" = "true" ]; then
      echo "$vault_name: restoring from R2 backup..."
      gosu node rclone sync "r2:${BUCKET}" "/data/$vault_name" --exclude ".remotely-save/**" --exclude "*.zip" || true
      echo "$vault_name: restored $(find "/data/$vault_name" -name '*.md' | wc -l) markdown files"
    else
      echo "$vault_name: volume has data ($(find "/data/$vault_name" -name '*.md' | wc -l) files) — skipping R2 restore."
    fi
  done

  # Background: backup both vaults to R2 every 12 hours.
  (while true; do
    sleep 43200
    for vault_name in public-knowledge second-brain; do
      case "$vault_name" in
        public-knowledge) BUCKET="$R2_PUBLIC_KNOWLEDGE_BUCKET" ;;
        second-brain)     BUCKET="$R2_SECOND_BRAIN_BUCKET" ;;
      esac
      if [ -z "$BUCKET" ]; then continue; fi
      rclone sync "/data/$vault_name" "r2:${BUCKET}" --exclude ".remotely-save/**" --exclude ".obsidian/**" --exclude ".silverbullet/**" --exclude "*.zip" 2>/dev/null
    done
  done) &
fi

# Verify Railway state before starting the host process.
VERIFY_ARGS="--mode boot"
if [ "$STATE_VERIFY_ENFORCE" = "true" ]; then
  VERIFY_ARGS="$VERIFY_ARGS --repair"
fi
gosu node sh -lc "node dist/verify-railway-state.js $VERIFY_ARGS"

# Sync group system prompts from image to persistent volume on every deploy.
# CLAUDE.md and templates/ are code artifacts — always overwrite with latest.
# Other files (logs, conversations, notes) are agent data — never touched.
if [ -d "/app/groups" ]; then
  for group_dir in /app/groups/*/; do
    group_name=$(basename "$group_dir")
    mkdir -p "/data/groups/$group_name"
    [ -f "$group_dir/CLAUDE.md" ] && cp "$group_dir/CLAUDE.md" "/data/groups/$group_name/CLAUDE.md"
    [ -d "$group_dir/templates" ] && cp -r "$group_dir/templates" "/data/groups/$group_name/"
    [ -f "$group_dir/projects.yaml" ] && [ ! -f "/data/groups/$group_name/projects.yaml" ] && \
      cp "$group_dir/projects.yaml" "/data/groups/$group_name/projects.yaml"
  done
  chown -R node:node /data/groups
fi

# Create personal skill library directory on persistent volume
SKILLS_PATH="${SYNCTHING_SKILLS_FOLDER_PATH:-/data/ai-skills}"
mkdir -p "$SKILLS_PATH"
chown node:node "$SKILLS_PATH"
export AI_SKILLS_HOME="$SKILLS_PATH"

# Start Syncthing for project-only sync (if configured)
if [ "${SYNCTHING_ENABLED:-false}" = "true" ]; then
  if [ ! -f /data/syncthing/config.xml ] || [ ! -f /data/syncthing/cert.pem ] || [ ! -f /data/syncthing/key.pem ]; then
    echo "Syncthing: generating initial config..."
    if ! gosu node syncthing generate --home=/data/syncthing --no-default-folder >/dev/null 2>&1; then
      echo "Syncthing: failed to generate initial config, continuing without project sync."
    fi
  fi

  if [ -f /data/syncthing/config.xml ]; then
    echo "Syncthing: starting daemon..."
    gosu node syncthing \
      --home=/data/syncthing \
      --gui-address=127.0.0.1:8384 \
      --no-browser &

    if gosu node node dist/syncthing-config.js; then
      SYNCTHING_DEVICE_ID="$(gosu node syncthing --home=/data/syncthing --device-id 2>/dev/null || true)"
      if [ -n "$SYNCTHING_DEVICE_ID" ]; then
        echo "Syncthing device ID: $SYNCTHING_DEVICE_ID"
      fi
    else
      echo "Syncthing: failed to configure managed settings, continuing with existing daemon state."
    fi
  else
    echo "Syncthing: config.xml is missing, continuing without project sync."
  fi
fi

# Start Tailscale + Silver Bullet (if configured)
if [ -n "$TAILSCALE_AUTHKEY" ]; then
  mkdir -p /data/tailscale /var/run/tailscale

  # Start tailscaled in userspace mode (no TUN device on Railway)
  tailscaled \
    --tun=userspace-networking \
    --state=/data/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock &

  # Wait for tailscaled socket to become available
  for i in $(seq 1 30); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
  done

  # Authenticate (reuses existing state across deploys)
  TS_HOSTNAME="${TAILSCALE_HOSTNAME:-nanoclaw-sb}"
  tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    --authkey="$TAILSCALE_AUTHKEY" \
    --hostname="$TS_HOSTNAME"

  # Start Silver Bullet on a local-only port (all config via env vars)
  export SB_PORT="${SB_PORT:-3333}"
  export SB_HOSTNAME="127.0.0.1"
  gosu node silverbullet /data/second-brain &
  echo "Silver Bullet started on $SB_HOSTNAME:$SB_PORT"

  # Expose Silver Bullet via Tailscale (HTTPS on the tailnet)
  tailscale --socket=/var/run/tailscale/tailscaled.sock serve \
    --bg "http://127.0.0.1:$SB_PORT"
  echo "Silver Bullet available at https://$TS_HOSTNAME via Tailscale"
fi

# Drop to non-root user and run NanoClaw
# (claude-code refuses --dangerously-skip-permissions when running as root)
# Drop to non-root user and run NanoClaw
exec gosu node "$@"
