---
name: add-knowledge
description: Add Public Knowledge Repository to NanoClaw. Sets up an Obsidian vault, qmd search, container mounts, IPC handlers, and Brain Router integration.
user_invocable: true
---

# Add Public Knowledge Repository

This skill sets up the public knowledge repository system. The code changes (config, mounts, IPC handlers, MCP tools, Brain Router prompt, container skill) are already applied. This skill handles the external setup: vault initialization and qmd installation.

## Phase 1: Vault Initialization

### Clone the template vault

```bash
KNOWLEDGE_DIR="${NANOCLAW_PUBLIC_KNOWLEDGE_DIR:-$HOME/knowledge}"

if [ -d "$KNOWLEDGE_DIR" ]; then
  echo "Public knowledge vault already exists at $KNOWLEDGE_DIR"
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
KNOWLEDGE_DIR="${NANOCLAW_PUBLIC_KNOWLEDGE_DIR:-$HOME/knowledge}"
qmd collection add "$KNOWLEDGE_DIR" --name public-knowledge
qmd embed
```

### Verify

```bash
qmd status
qmd query "test" --json -c public-knowledge -n 1
```

## Phase 3: Build & Verify

```bash
npm run build
./container/build.sh
```

Restart NanoClaw:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Test

Send a test message to the Brain Router:

> save to knowledge: Test entry for verifying the public knowledge repository setup.

Verify:
1. File created in `~/knowledge/` with proper frontmatter
2. qmd reindex triggered (`qmd status` shows updated counts)
3. Search works: send "what do I know about test entry?"
