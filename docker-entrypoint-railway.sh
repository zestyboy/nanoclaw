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

  # Sync public knowledge repo from R2
  if [ -n "$R2_PUBLIC_KNOWLEDGE_BUCKET" ]; then
    mkdir -p /data/public-knowledge
    gosu node rclone sync r2:${R2_PUBLIC_KNOWLEDGE_BUCKET} /data/public-knowledge --exclude ".remotely-save/**"
    if [ ! -f "/data/public-knowledge/.qmd/config.toml" ]; then
      cd /data/public-knowledge && gosu node qmd init -c public-knowledge
    fi
    cd /data/public-knowledge && gosu node sh -c 'qmd update -c public-knowledge && qmd embed' 2>/dev/null || true
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
    if [ -n "$R2_PUBLIC_KNOWLEDGE_BUCKET" ]; then
      rclone sync r2:${R2_PUBLIC_KNOWLEDGE_BUCKET} /data/public-knowledge --exclude ".remotely-save/**" 2>/dev/null
      cd /data/public-knowledge && qmd update -c public-knowledge && qmd embed 2>/dev/null || true
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
