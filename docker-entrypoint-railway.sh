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

  # Sync Second Brain from R2
  if [ -n "$R2_SECOND_BRAIN_BUCKET" ]; then
    mkdir -p /data/second-brain
    gosu node rclone sync r2:${R2_SECOND_BRAIN_BUCKET} /data/second-brain --exclude ".remotely-save/**" || true
    gosu node qmd collection add second-brain /data/second-brain 2>/dev/null || true
    gosu node sh -c 'qmd update -c second-brain && qmd embed -c second-brain' 2>/dev/null || true
  fi

  # Background sync loop (every 5 min: pull from R2, reindex both vaults)
  (while true; do
    sleep 300
    if [ -n "$R2_PUBLIC_KNOWLEDGE_BUCKET" ]; then
      rclone sync r2:${R2_PUBLIC_KNOWLEDGE_BUCKET} /data/public-knowledge --exclude ".remotely-save/**" 2>/dev/null
      qmd update -c public-knowledge && qmd embed -c public-knowledge 2>/dev/null || true
    fi
    if [ -n "$R2_SECOND_BRAIN_BUCKET" ]; then
      rclone sync r2:${R2_SECOND_BRAIN_BUCKET} /data/second-brain --exclude ".remotely-save/**" 2>/dev/null
      qmd update -c second-brain && qmd embed -c second-brain 2>/dev/null || true
    fi
  done) &
fi

# Drop to non-root user and run NanoClaw
# (claude-code refuses --dangerously-skip-permissions when running as root)
exec gosu node "$@"
