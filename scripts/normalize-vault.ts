/**
 * Post-import normalization for the Second Brain vault.
 *
 * Cleans up Notion artifacts from the imported frontmatter:
 * - Strips formula/rollup/system properties
 * - Renames misnamed properties
 * - Normalizes dates to YYYY-MM-DD
 * - Strips Notion navigation blocks from body
 *
 * Usage:
 *   npx tsx scripts/normalize-vault.ts <vault-dir>
 */

import * as fs from 'fs';
import * as path from 'path';

// Properties to REMOVE (Notion formulas, rollups, system fields, junk)
const STRIP_PROPERTIES = new Set([
  // Notion formula outputs
  'smart_list_(formula)',
  'current_session',
  'due_stamp_(parent)',
  'due_timestamp',
  'edited_stamp_(parent)',
  'localization_key',
  'meta_labels',
  'my_day_label',
  'next_due',
  'project_active',
  'snooze_(parent)',
  'sub_task_sorter',
  'sub-task_sorter',
  'time_tracked',
  'time_tracked_(mins)',
  'time_tracking_status',
  'task_type_(ns)',
  'project_work_or_personal_(ns)',
  'wait_(parent)',
  // System/ref fields
  'created_by',
  'edited_by',
  'created',
  'edited',
  // Notion-specific ref/rollup fields
  'project_(ref)',
  'parent_task_(ref)',
  'parent_project',
  'parent_content',
  'parent_project_rollup_(ns)',
  'parent_smart_list',
  'related_project_task_type_(ns)',
  'project_area',
  // NS (not standard) fields
  'gtid_(ns)',
  'source_link_(ns)',
  'source_type_(ns)',
  'estimated_pomodoros_(ns)',
  'up_next_(ns)',
  'task_type_manual_(ns)',
  // Notion display metadata
  'updated_(short)',
  'updated',
  'latest_activity',
  'note_count',
  'tag_projects',
  'tag_notes',
  'sub_tags',
  'meta',
  'progress',
  'this_quarter',
  'this_year',
  // Project formula fields
  'sub_project_sorter_(ns)',
  'due_stamp_(parent)_(ns)',
  'due_timestamp_(ns)',
]);

// Properties to RENAME
const RENAME_PROPERTIES: Record<string, string> = {
  'shopping_list': '_delete', // Not useful in Obsidian
  'assigned_to': '_delete',   // Notion-specific
  'assignee': '_delete',      // Notion-specific
};

function normalizeVault(vaultDir: string): void {
  console.log(`Normalizing vault at: ${vaultDir}\n`);

  const folders = [
    '01 Tasks',
    '02 Notes',
    '03 Projects',
    '04 Tags',
    '05 Goals',
    '06 Milestones',
    '07 People',
    '08 Work Sessions',
    '09 Books',
    '10 Recipes',
  ];

  let totalProcessed = 0;
  let totalModified = 0;

  for (const folder of folders) {
    const folderPath = path.join(vaultDir, folder);
    if (!fs.existsSync(folderPath)) continue;

    const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.md'));
    let modified = 0;

    for (const file of files) {
      const filePath = path.join(folderPath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const normalized = normalizeFile(content);

      if (normalized !== content) {
        fs.writeFileSync(filePath, normalized, 'utf-8');
        modified++;
      }
      totalProcessed++;
    }

    console.log(`  ${folder}: ${files.length} files, ${modified} modified`);
    totalModified += modified;
  }

  console.log(`\nDone: ${totalProcessed} processed, ${totalModified} modified`);
}

function normalizeFile(content: string): string {
  // Split into frontmatter and body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, fmBlock, body] = fmMatch;
  const lines = fmBlock.split('\n');

  // Parse and filter frontmatter lines
  const cleanedLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Parse the property name from the line
    const propMatch = line.match(/^([a-z_()/-]+):\s*/);
    if (propMatch) {
      const propName = propMatch[1];

      // Check if this is a multi-line array
      const isArray = i + 1 < lines.length && lines[i + 1]?.startsWith('  - ');

      if (STRIP_PROPERTIES.has(propName) || RENAME_PROPERTIES[propName] === '_delete') {
        // Skip this property and any continuation lines
        i++;
        if (isArray) {
          while (i < lines.length && lines[i]?.startsWith('  ')) i++;
        }
        continue;
      }

      // Normalize date values
      const valueStr = line.slice(propMatch[0].length);
      const normalizedDate = tryNormalizeDate(valueStr, propName);
      if (normalizedDate !== null) {
        cleanedLines.push(`${propName}: ${normalizedDate}`);
        i++;
        continue;
      }
    }

    cleanedLines.push(line);
    i++;
  }

  // Clean body: strip Notion navigation toggle blocks
  let cleanBody = body;
  // Remove Notion nav callouts (the toggle blocks with Nav | [[Tasks]] etc.)
  cleanBody = cleanBody.replace(
    /-\s*>\s*\[!info\]-\s*Nav\s*\|[\s\S]*?(?=\n(?:#|\n|$))/g,
    ''
  );

  // Clean excessive blank lines
  cleanBody = cleanBody.replace(/\n{3,}/g, '\n\n');

  return `---\n${cleanedLines.join('\n')}\n---\n${cleanBody}`;
}

const DATE_PROPERTIES = new Set([
  'due', 'start_date', 'snooze', 'wait_date', 'completed',
  'target_deadline', 'birthday', 'check_in', 'last_check_in',
  'achieved', 'date_completed',
]);

function tryNormalizeDate(value: string, propName: string): string | null {
  if (!value) return null;

  // Strip quotes and @ prefix
  let cleaned = value.replace(/^["']|["']$/g, '').replace(/^@\s*/, '').trim();
  if (!cleaned) return null;

  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return null;

  // Only normalize known date properties
  if (!DATE_PROPERTIES.has(propName)) return null;

  // Try parsing date strings like "July 14, 2024" or "July 14, 2024 11:14 AM"
  try {
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  } catch {
    // Not a parseable date
  }

  return null;
}

// CLI
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.log('Usage: npx tsx scripts/normalize-vault.ts <vault-dir>');
  process.exit(1);
}

normalizeVault(path.resolve(args[0]));
