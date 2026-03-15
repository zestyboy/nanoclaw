#!/usr/bin/env bash
# =============================================================================
# Notion Import via R2 Pipeline
#
# Runs on Railway (or anywhere with rclone configured).
# Downloads a Notion export zip from R2, converts it, uploads the vault back.
#
# Prerequisites:
#   - rclone configured with r2: remote
#   - Node.js + tsx available
#   - The Notion export zip uploaded to r2:second-brain-import/
#
# Usage:
#   ./scripts/notion-import-r2.sh [zip-name]
#
# If zip-name is omitted, uses the first .zip file found in the import bucket.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WORK_DIR="/tmp/notion-import-$$"
IMPORT_BUCKET="${R2_NOTION_IMPORT_BUCKET:-second-brain-import}"
OUTPUT_BUCKET="${R2_SECOND_BRAIN_BUCKET:-second-brain}"

echo "=== Notion Import via R2 Pipeline ==="
echo ""

# --- Step 1: Find the zip file in R2 ---
ZIP_NAME="${1:-}"
if [ -z "$ZIP_NAME" ]; then
  echo "Step 1: Looking for Notion export zip in r2:${IMPORT_BUCKET}/..."
  ZIP_NAME=$(
    rclone lsf "r2:${IMPORT_BUCKET}/" \
      --files-only \
      --max-depth 1 \
      --include "*.zip" | head -1
  )
  if [ -z "$ZIP_NAME" ]; then
    echo "ERROR: No .zip file found in r2:${IMPORT_BUCKET}/"
    echo "Upload your Notion export zip first:"
    echo "  rclone copy ~/Downloads/export.zip r2:${IMPORT_BUCKET}/"
    exit 1
  fi
fi
echo "  Found: ${ZIP_NAME}"
echo ""

# --- Step 2: Download and extract ---
echo "Step 2: Downloading and extracting..."
mkdir -p "$WORK_DIR"
rclone copy "r2:${IMPORT_BUCKET}/${ZIP_NAME}" "$WORK_DIR/"
echo "  Downloaded to ${WORK_DIR}/${ZIP_NAME}"

# Unzip
EXTRACT_DIR="${WORK_DIR}/notion-export"
mkdir -p "$EXTRACT_DIR"
unzip -q "${WORK_DIR}/${ZIP_NAME}" -d "$EXTRACT_DIR"
echo "  Extracted to ${EXTRACT_DIR}"

# Find the actual export root (might be nested one level)
EXPORT_ROOT="$EXTRACT_DIR"
if [ "$(ls -d "$EXTRACT_DIR"/*/ 2>/dev/null | wc -l)" -eq 1 ]; then
  EXPORT_ROOT="$(ls -d "$EXTRACT_DIR"/*/)"
  echo "  Export root: ${EXPORT_ROOT}"
fi
echo ""

# --- Step 3: Run conversion ---
echo "Step 3: Running conversion..."
OUTPUT_DIR="${WORK_DIR}/vault"

# Point to vault infrastructure (Bases, Templates, etc.)
# On Railway, the dummy vault is in the repo. Locally, use env var.
export VAULT_INFRA_DIR="${VAULT_INFRA_DIR:-${PROJECT_ROOT}/../second-brain-dev}"

cd "$PROJECT_ROOT"
npx tsx scripts/notion-to-obsidian.ts "$EXPORT_ROOT" "$OUTPUT_DIR"
echo ""

# --- Step 4: Upload to R2 ---
echo "Step 4: Uploading vault to R2..."
rclone sync "$OUTPUT_DIR" "r2:${OUTPUT_BUCKET}/" \
  --exclude ".obsidian/**" \
  --progress
echo ""

# --- Step 5: Cleanup ---
echo "Step 5: Cleaning up..."
rm -rf "$WORK_DIR"
echo "  Cleaned up ${WORK_DIR}"
echo ""

echo "=== Import Complete ==="
echo ""
echo "The vault is now on r2:${OUTPUT_BUCKET}/"
echo "Railway will pick it up on the next rclone sync cycle (every 5 min)."
echo ""
echo "To force an immediate sync on Railway:"
echo "  railway run rclone sync r2:${OUTPUT_BUCKET} /data/second-brain"
