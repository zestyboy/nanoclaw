---
name: add-knowledge
description: Add Knowledge Repository to NanoClaw. Sets up an Obsidian vault, qmd search, container mounts, IPC handlers, and Brain Router integration.
user_invocable: true
---

# Add Knowledge Repository

This skill sets up the knowledge repository system. The code changes (config, mounts, IPC handlers, MCP tools, Brain Router prompt, container skill) are already applied. This skill handles the external setup: vault initialization, qmd installation, and background service.

## Phase 1: Vault Initialization

### Clone the template vault

```bash
KNOWLEDGE_DIR="${NANOCLAW_KNOWLEDGE_DIR:-$HOME/knowledge}"

if [ -d "$KNOWLEDGE_DIR" ]; then
  echo "Knowledge vault already exists at $KNOWLEDGE_DIR"
else
  git clone https://github.com/kepano/kepano-obsidian "$KNOWLEDGE_DIR"
fi
```

### Create folder structure

Ensure the Kepano vault structure folders exist:

```bash
mkdir -p "$KNOWLEDGE_DIR/Attachments"
mkdir -p "$KNOWLEDGE_DIR/Categories"
mkdir -p "$KNOWLEDGE_DIR/Clippings"
mkdir -p "$KNOWLEDGE_DIR/References"
mkdir -p "$KNOWLEDGE_DIR/Templates"
```

### Open in Obsidian

Tell the user to open the vault in Obsidian to verify it works:

```
Open ~/knowledge in Obsidian to verify the vault. You can customize settings and plugins as desired.
```

## Phase 2: qmd Installation & Indexing

### Install qmd

```bash
npm install -g @tobilu/qmd
```

### Add collection and build embeddings

```bash
KNOWLEDGE_DIR="${NANOCLAW_KNOWLEDGE_DIR:-$HOME/knowledge}"
qmd collection add "$KNOWLEDGE_DIR" --name knowledge
qmd embed
```

### Verify

```bash
qmd status
```

## Phase 3: Environment Variables

### Add to .env

Append to the project `.env` file if not already present:

```bash
# Check and add QMD_HTTP_URL
if ! grep -q 'QMD_HTTP_URL' .env 2>/dev/null; then
  echo -e '\n# Knowledge repository\nQMD_HTTP_URL=http://127.0.0.1:8181' >> .env
fi
```

## Phase 4: Background Service

### Create launchd plist (macOS)

Write `~/Library/LaunchAgents/com.nanoclaw.qmd.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nanoclaw.qmd</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/qmd</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/qmd.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/qmd.err</string>
</dict>
</plist>
```

**Important:** Find the actual qmd binary path with `which qmd` and use the full path in ProgramArguments.

### Load the service

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.qmd.plist
```

### Verify

```bash
curl -s http://127.0.0.1:8181/status || echo "qmd not responding — check /tmp/qmd.err"
```

## Phase 5: Build & Verify

```bash
npm run build
./container/build.sh
```

Restart NanoClaw:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 6: Test

Send a test message to the Brain Router:

> save to knowledge: Test entry for verifying the knowledge repository setup.

Verify:
1. File created in `~/knowledge/` with proper frontmatter
2. qmd reindex triggered (check `/tmp/qmd.log`)
3. Search works: send "what do I know about test entry?"
