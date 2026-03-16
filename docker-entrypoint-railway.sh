#!/bin/bash
set -e

# Fix volume permissions
chown -R node:node /data 2>/dev/null || true

# Seed database on first run
if [ ! -f "/data/store/messages.db" ] && [ -d "/app/seed-data" ]; then
  mkdir -p /data/store
  cp /app/seed-data/* /data/store/
  chown -R node:node /data/store
fi

# Sync group system prompts from image to persistent volume on every deploy.
# CLAUDE.md and templates/ are code artifacts — always overwrite with latest.
# Other files (logs, conversations, notes) are agent data — never touched.
if [ -d "/app/groups" ]; then
  for group_dir in /app/groups/*/; do
    group_name=$(basename "$group_dir")
    mkdir -p "/data/groups/$group_name"
    [ -f "$group_dir/CLAUDE.md" ] && cp "$group_dir/CLAUDE.md" "/data/groups/$group_name/CLAUDE.md"
    [ -d "$group_dir/templates" ] && cp -r "$group_dir/templates" "/data/groups/$group_name/"
  done
  chown -R node:node /data/groups
fi

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
    gosu node qmd collection add "$vault_name" "/data/$vault_name" 2>/dev/null || true
    gosu node sh -c "qmd update -c $vault_name && qmd embed -c $vault_name" 2>/dev/null || true
  done

  # Background: backup both vaults to R2 and reindex every 12 hours
  (while true; do
    sleep 43200
    for vault_name in public-knowledge second-brain; do
      case "$vault_name" in
        public-knowledge) BUCKET="$R2_PUBLIC_KNOWLEDGE_BUCKET" ;;
        second-brain)     BUCKET="$R2_SECOND_BRAIN_BUCKET" ;;
      esac
      if [ -z "$BUCKET" ]; then continue; fi
      rclone sync "/data/$vault_name" "r2:${BUCKET}" --exclude ".remotely-save/**" --exclude ".obsidian/**" --exclude ".silverbullet/**" --exclude "*.zip" 2>/dev/null
      qmd update -c "$vault_name" && qmd embed -c "$vault_name" 2>/dev/null || true
    done
  done) &
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
  SB_SPACE="/data/second-brain"
  echo "Silver Bullet space: $SB_SPACE"
  echo "  files: $(find "$SB_SPACE" -name '*.md' 2>/dev/null | wc -l) markdown files"
  echo "  dirs: $(ls -d "$SB_SPACE"/*/ 2>/dev/null | head -5)"
  gosu node silverbullet "$SB_SPACE" &
  echo "Silver Bullet started on $SB_HOSTNAME:$SB_PORT"

  # Expose Silver Bullet via Tailscale (HTTPS on the tailnet)
  tailscale --socket=/var/run/tailscale/tailscaled.sock serve \
    --bg "http://127.0.0.1:$SB_PORT"
  echo "Silver Bullet available at https://$TS_HOSTNAME via Tailscale"
fi

# Drop to non-root user and run NanoClaw
# (claude-code refuses --dangerously-skip-permissions when running as root)
exec gosu node "$@"
