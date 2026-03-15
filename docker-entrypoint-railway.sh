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

  # Sync public knowledge repo from R2
  if [ -n "$R2_PUBLIC_KNOWLEDGE_BUCKET" ]; then
    mkdir -p /data/public-knowledge
    gosu node rclone sync r2:${R2_PUBLIC_KNOWLEDGE_BUCKET} /data/public-knowledge --exclude ".remotely-save/**" || true
    gosu node qmd collection add public-knowledge /data/public-knowledge 2>/dev/null || true
    gosu node sh -c 'qmd update -c public-knowledge && qmd embed -c public-knowledge' 2>/dev/null || true
  fi

  # Second Brain: Railway volume is the working copy, R2 is the backup.
  # On startup: restore from R2 only if the local volume is empty (fresh deploy).
  # The periodic sync (below) pushes Railway → R2 as backup.
  if [ -n "$R2_SECOND_BRAIN_BUCKET" ]; then
    mkdir -p /data/second-brain
    LOCAL_COUNT=$(find /data/second-brain -name "*.md" 2>/dev/null | head -1)
    if [ -z "$LOCAL_COUNT" ]; then
      echo "Second Brain: volume empty — restoring from R2 backup..."
      gosu node rclone sync r2:${R2_SECOND_BRAIN_BUCKET} /data/second-brain --exclude ".remotely-save/**" --exclude "*.zip" || true
    else
      echo "Second Brain: volume has data — skipping R2 restore."
    fi
    gosu node qmd collection add second-brain /data/second-brain 2>/dev/null || true
    gosu node sh -c 'qmd update -c second-brain && qmd embed -c second-brain' 2>/dev/null || true
  fi

  # Background sync loops:
  #
  # Public knowledge: R2 → Railway every 5 min (R2 is source of truth, changes come from git/external edits)
  # Second Brain: Railway → R2 every 12 hours (Railway is working copy, R2 is just a backup)
  # qmd reindex: on-demand via reindex_second_brain IPC, plus a daily safety-net reindex
  #
  # Note: agents trigger qmd reindex after writing notes via the reindex_second_brain MCP tool.
  # The periodic reindex here is just a fallback in case the on-demand trigger is missed.

  # Public knowledge sync (every 5 min — R2 is source of truth)
  (while true; do
    sleep 300
    if [ -n "$R2_PUBLIC_KNOWLEDGE_BUCKET" ]; then
      rclone sync r2:${R2_PUBLIC_KNOWLEDGE_BUCKET} /data/public-knowledge --exclude ".remotely-save/**" 2>/dev/null
      qmd update -c public-knowledge && qmd embed -c public-knowledge 2>/dev/null || true
    fi
  done) &

  # Second Brain backup + reindex (every 12 hours)
  (while true; do
    sleep 43200
    if [ -n "$R2_SECOND_BRAIN_BUCKET" ]; then
      rclone sync /data/second-brain r2:${R2_SECOND_BRAIN_BUCKET} --exclude ".remotely-save/**" --exclude ".obsidian/**" --exclude "*.zip" 2>/dev/null
      qmd update -c second-brain && qmd embed -c second-brain 2>/dev/null || true
    fi
  done) &
fi

# Drop to non-root user and run NanoClaw
# (claude-code refuses --dangerously-skip-permissions when running as root)
exec gosu node "$@"
