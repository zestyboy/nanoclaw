#!/usr/bin/env bash
# =============================================================================
# Entrypoint for the Notion Import Railway service.
# Configures rclone from env vars, runs the import, then exits.
# =============================================================================
set -euo pipefail

echo "=== Notion Import Service ==="
echo ""

# --- Configure rclone from Railway env vars ---
echo "Configuring rclone for R2..."
mkdir -p /root/.config/rclone
cat > /root/.config/rclone/rclone.conf <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY}
secret_access_key = ${R2_SECRET_KEY}
endpoint = ${R2_ENDPOINT}
EOF
echo "  rclone configured."
echo ""

# --- Verify R2 access ---
echo "Verifying R2 access..."
# Use the same bucket for import and output — the R2 API token is scoped to this bucket
OUTPUT_BUCKET="${R2_SECOND_BRAIN_BUCKET:-second-brain}"
IMPORT_BUCKET="$OUTPUT_BUCKET"

rclone lsf "r2:${IMPORT_BUCKET}/" > /dev/null || {
  echo "ERROR: Cannot access r2:${IMPORT_BUCKET}/"
  echo "Check R2_ACCESS_KEY, R2_SECRET_KEY, R2_ENDPOINT env vars."
  exit 1
}
echo "  R2 access OK."
echo ""

# --- Find the zip file ---
ZIP_NAME="${1:-}"
if [ -z "$ZIP_NAME" ]; then
  echo "Looking for Notion export zip in r2:${IMPORT_BUCKET}/..."
  ZIP_NAME=$(rclone lsf "r2:${IMPORT_BUCKET}/" --include "*.zip" | head -1)
  if [ -z "$ZIP_NAME" ]; then
    echo "ERROR: No .zip file found in r2:${IMPORT_BUCKET}/"
    echo ""
    echo "Upload your Notion export zip to the '${IMPORT_BUCKET}' R2 bucket first."
    echo "You can use the Cloudflare dashboard or wrangler CLI."
    exit 1
  fi
fi
echo "  Found: ${ZIP_NAME}"
echo ""

# --- Download and extract ---
WORK_DIR="/tmp/notion-import"
mkdir -p "$WORK_DIR"

echo "Downloading ${ZIP_NAME} from R2..."
rclone copy "r2:${IMPORT_BUCKET}/${ZIP_NAME}" "$WORK_DIR/"
echo "  Downloaded."

EXTRACT_DIR="${WORK_DIR}/notion-export"
mkdir -p "$EXTRACT_DIR"
echo "Extracting..."
unzip -q "${WORK_DIR}/${ZIP_NAME}" -d "$EXTRACT_DIR"

# Find the actual export root (might be nested one level)
EXPORT_ROOT="$EXTRACT_DIR"
SUBDIRS=$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)
if [ "$SUBDIRS" -eq 1 ]; then
  EXPORT_ROOT="$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d)"
  echo "  Export root: ${EXPORT_ROOT}"
fi
echo ""

# --- Download vault infrastructure from R2 ---
# Bases, Templates, Dashboards, and Home.md are already on R2
# We download them to use as the infrastructure source
INFRA_DIR="${WORK_DIR}/vault-infra"
mkdir -p "$INFRA_DIR"
echo "Downloading vault infrastructure from R2..."
rclone copy "r2:${OUTPUT_BUCKET}/Bases" "${INFRA_DIR}/Bases/" 2>/dev/null || true
rclone copy "r2:${OUTPUT_BUCKET}/Templates" "${INFRA_DIR}/Templates/" 2>/dev/null || true
rclone copy "r2:${OUTPUT_BUCKET}/Dashboards" "${INFRA_DIR}/Dashboards/" 2>/dev/null || true
rclone copy "r2:${OUTPUT_BUCKET}/Home.md" "${INFRA_DIR}/" 2>/dev/null || true
echo "  Infrastructure downloaded."
echo ""

# --- Run the conversion ---
OUTPUT_DIR="${WORK_DIR}/vault"
export VAULT_INFRA_DIR="$INFRA_DIR"

echo "Running Notion → Obsidian conversion..."
echo ""
cd /app
npx tsx scripts/notion-to-obsidian.ts "$EXPORT_ROOT" "$OUTPUT_DIR"
echo ""

# --- Upload converted vault to R2 ---
echo "Uploading converted vault to R2..."
# Use copy (not sync) to avoid deleting the zip or other existing files
rclone copy "$OUTPUT_DIR" "r2:${OUTPUT_BUCKET}/" \
  --exclude ".obsidian/**" \
  --progress
echo ""

# --- Cleanup ---
echo "Cleaning up..."
rm -rf "$WORK_DIR"
echo ""

echo "=== Import Complete ==="
echo ""
echo "The vault is now on r2:${OUTPUT_BUCKET}/"
echo "The NanoClaw service will pick it up on the next rclone sync cycle."
echo ""
echo "This service will now exit."
