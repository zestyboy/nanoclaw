/**
 * Notion HTML Export → Obsidian Vault Converter
 *
 * Converts a Notion HTML export into an Obsidian vault with:
 * - Normalized frontmatter (kind, snake_case properties, wikilinks)
 * - Folder structure matching the Second Brain layout
 * - Internal links converted to [[wikilinks]]
 * - Attachments preserved
 *
 * Usage:
 *   npx tsx scripts/notion-to-obsidian.ts <input-dir> <output-dir>
 *
 * The input-dir should be the unzipped Notion HTML export folder.
 * The output-dir will be populated with the Obsidian vault structure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config: maps Notion database folder names to our vault structure
// ---------------------------------------------------------------------------

/** Notion database name → kind + target folder */
const DATABASE_MAP: Record<
  string,
  { kind: string; folder: string }
> = {
  // Primary matches (exact or substring)
  tasks: { kind: 'task', folder: '01 Tasks' },
  notes: { kind: 'note', folder: '02 Notes' },
  projects: { kind: 'project', folder: '03 Projects' },
  tags: { kind: 'tag', folder: '04 Tags' },
  goals: { kind: 'goal', folder: '05 Goals' },
  milestones: { kind: 'milestone', folder: '06 Milestones' },
  people: { kind: 'person', folder: '07 People' },
  'work sessions': { kind: 'work-session', folder: '08 Work Sessions' },
  books: { kind: 'book', folder: '09 Books' },
  recipes: { kind: 'recipe', folder: '10 Recipes' },
};

/** Maps Notion property names → our snake_case names */
const PROPERTY_NAME_MAP: Record<string, string> = {
  // Tasks
  name: '_skip', // title comes from filename
  title: '_skip',
  status: 'status',
  priority: 'priority',
  due: 'due',
  'due date': 'due',
  'start date': 'start_date',
  snooze: 'snooze',
  'wait date': 'wait_date',
  'smart list': 'smart_list',
  'my day': 'my_day',
  project: 'project',
  tag: 'tag',
  tags: 'tag',
  'parent tag': 'parent_tag',
  goal: 'goal',
  people: 'people',
  archived: 'archived',
  favorite: 'favorite',
  type: '_ambiguous', // resolved per-kind
  'target deadline': 'target_deadline',
  completed: 'completed',
  'recur interval': 'recur_interval',
  'recur unit': 'recur_unit',
  'enforce schedule': 'enforce_schedule',
  url: 'url',
  image: 'cover',
  cover: 'cover',
  'parent task': 'parent_task',
  'sub-projects': 'sub_projects',
  'parent project': 'parent_project',
  contexts: 'contexts',
  energy: 'energy',
  labels: 'labels',
  'project type': 'project_type',
  // People
  surname: 'surname',
  company: 'company',
  'title/role': 'title_role',
  email: 'email',
  phone: 'phone',
  birthday: 'birthday',
  location: 'location',
  relationship: 'relationship',
  interests: 'interests',
  'check in': 'check_in',
  'check-in': 'check_in',
  'last check in': 'last_check_in',
  'last check-in': 'last_check_in',
  linkedin: 'linkedin',
  // Books
  author: 'author',
  rating: 'rating',
  pages: 'pages',
  isbn: 'isbn',
  'publish year': 'publish_year',
  genres: 'genres',
  // Goals
  'goal set': 'goal_set',
  achieved: 'achieved',
  // Milestones
  'date completed': 'date_completed',
  // Notes
  'note type': 'note_type',
  // Tags
  'tag type': 'tag_type',
  // Recipes
  'recipe tags': 'recipe_tags',
  servings: 'servings',
  'prep time': 'prep_time',
  'cook time': 'cook_time',
};

/** Ambiguous "Type" property → correct name based on kind */
const TYPE_PROPERTY_BY_KIND: Record<string, string> = {
  note: 'note_type',
  tag: 'tag_type',
  project: 'project_type',
};

// ---------------------------------------------------------------------------
// Notion UUID pattern: 32-hex-char ID appended to filenames
// e.g., "My Task abc1234567890abcdef1234567890ab.html"
// or "My Task abc1234567890abcdef1234567890ab" (folder)
// ---------------------------------------------------------------------------
const UUID_PATTERN = /\s+[0-9a-f]{20,32}$/;
const UUID_PATTERN_WITH_EXT = /\s+[0-9a-f]{20,32}(\.\w+)$/;

function stripNotionUuid(name: string): string {
  // Strip UUID from name, preserving extension if present
  return name.replace(UUID_PATTERN_WITH_EXT, '$1').replace(UUID_PATTERN, '');
}

// ---------------------------------------------------------------------------
// Turndown setup (HTML → Markdown)
// ---------------------------------------------------------------------------

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });

  // Notion uses <details> for toggle blocks
  td.addRule('details', {
    filter: 'details',
    replacement(_content, node) {
      const el = node as HTMLDetailsElement;
      const summary = el.querySelector('summary');
      const summaryText = summary ? summary.textContent?.trim() || '' : '';
      // Get content after summary
      const children = Array.from(el.childNodes).filter(
        (n) => n !== summary
      );
      const tempDiv = el.ownerDocument.createElement('div');
      children.forEach((c) => tempDiv.appendChild(c.cloneNode(true)));
      const innerMd = td.turndown(tempDiv.innerHTML);
      return `\n> [!info]- ${summaryText}\n> ${innerMd.replace(/\n/g, '\n> ')}\n\n`;
    },
  });

  // Notion bookmark blocks
  td.addRule('bookmark', {
    filter(node) {
      return (
        node.nodeName === 'A' &&
        (node as HTMLElement).classList.contains('bookmark')
      );
    },
    replacement(_content, node) {
      const el = node as HTMLAnchorElement;
      const href = el.getAttribute('href') || '';
      const title =
        el.querySelector('.bookmark-title')?.textContent?.trim() ||
        el.textContent?.trim() ||
        href;
      return `[${title}](${href})`;
    },
  });

  // Notion callout blocks
  td.addRule('callout', {
    filter(node) {
      return (
        node.nodeName === 'FIGURE' &&
        (node as HTMLElement).classList.contains('callout')
      );
    },
    replacement(_content, node) {
      const el = node as HTMLElement;
      const text = el.textContent?.trim() || '';
      return `\n> [!note]\n> ${text.replace(/\n/g, '\n> ')}\n\n`;
    },
  });

  // Notion equation blocks
  td.addRule('equation', {
    filter(node) {
      return (
        node.nodeName === 'FIGURE' &&
        (node as HTMLElement).classList.contains('equation')
      );
    },
    replacement(_content, node) {
      const el = node as HTMLElement;
      const math = el.querySelector('.katex-mathml annotation')?.textContent || el.textContent?.trim() || '';
      return `$$${math}$$`;
    },
  });

  return td;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotionPage {
  /** Original file path relative to export root */
  sourcePath: string;
  /** Clean title (UUID stripped) */
  title: string;
  /** Detected kind (task, note, project, etc.) */
  kind: string;
  /** Target folder in vault */
  targetFolder: string;
  /** Parsed frontmatter properties */
  properties: Record<string, unknown>;
  /** Markdown body content */
  body: string;
  /** Attachment files to copy (source → target relative path) */
  attachments: Array<{ source: string; targetPath: string }>;
}

// Global filename mapping: clean name → all matching files
// Used to resolve internal links
const fileNameMap = new Map<string, string>();

// ---------------------------------------------------------------------------
// Parse a Notion HTML file
// ---------------------------------------------------------------------------

function parseNotionHtml(
  htmlPath: string,
  exportRoot: string,
  kind: string,
  targetFolder: string
): NotionPage {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Extract title from filename
  const basename = path.basename(htmlPath, '.html');
  const title = stripNotionUuid(basename);

  // Extract properties from the Notion property table
  const properties: Record<string, unknown> = {};
  const propertyTable = doc.querySelector('table.properties');

  if (propertyTable) {
    const rows = propertyTable.querySelectorAll('tr');
    for (const row of rows) {
      const header = row.querySelector('th')?.textContent?.trim().toLowerCase();
      const cell = row.querySelector('td');
      if (!header || !cell) continue;

      // Look up the normalized property name
      let propName = PROPERTY_NAME_MAP[header];
      if (!propName) {
        // Try kebab-to-snake
        propName = header.replace(/[\s-]+/g, '_');
      }
      if (propName === '_skip') continue;
      if (propName === '_ambiguous') {
        propName = TYPE_PROPERTY_BY_KIND[kind] || header.replace(/[\s-]+/g, '_');
      }

      const value = extractPropertyValue(cell, propName);
      if (value !== undefined && value !== null && value !== '') {
        properties[propName] = value;
      }
    }
  }

  // Remove the property table from the DOM before converting body
  propertyTable?.parentElement?.removeChild(propertyTable);

  // Also remove the title header (Notion puts it as the first <h1> or page-title)
  const pageTitle =
    doc.querySelector('.page-title') ||
    doc.querySelector('header') ||
    doc.querySelector('h1');
  if (pageTitle) {
    // Only remove if it matches our title
    const titleText = pageTitle.textContent?.trim() || '';
    if (titleText === title || stripNotionUuid(titleText) === title) {
      pageTitle.parentElement?.removeChild(pageTitle);
    }
  }

  // Convert remaining HTML body to Markdown
  const bodyElement = doc.querySelector('.page-body') || doc.body;
  const turndown = createTurndown();

  // Before converting, fix internal links to use clean names
  const links = bodyElement.querySelectorAll('a');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;

    // Internal Notion links are relative paths like "My%20Page%20uuid.html"
    if (href.startsWith('http://') || href.startsWith('https://')) continue;

    try {
      const decodedHref = decodeURIComponent(href);
      const linkedBasename = path.basename(decodedHref, '.html');
      // Also handle .md extension and folder references
      const linkedName = stripNotionUuid(
        path.basename(linkedBasename, '.md')
      );
      if (linkedName) {
        // Replace with wikilink placeholder that turndown won't mangle
        const placeholder = `WKLNK8START8${linkedName}8END8WKLNK`;
        link.textContent = placeholder;
        link.setAttribute('href', '#');
      }
    } catch {
      // Skip malformed URLs
    }
  }

  let body = turndown.turndown(bodyElement.innerHTML);

  // Convert wikilink placeholders to actual wikilinks
  // Turndown wraps them in markdown link syntax: [WKLNK8START8Name8END8WKLNK](#)
  // or sometimes just the raw placeholder
  body = body.replace(
    /\[WKLNK8START8(.+?)8END8WKLNK\]\([^)]*\)/g,
    (_match, name) => `[[${name}]]`
  );
  body = body.replace(
    /WKLNK8START8(.+?)8END8WKLNK/g,
    (_match, name) => `[[${name}]]`
  );

  // Clean up excessive blank lines
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  // Collect attachments
  const attachments: Array<{ source: string; targetPath: string }> = [];
  const htmlDir = path.dirname(htmlPath);

  // Look for attachment references in the HTML (images, files)
  const images = doc.querySelectorAll('img');
  for (const img of images) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('http://') || src.startsWith('https://')) continue;
    try {
      const decodedSrc = decodeURIComponent(src);
      const absPath = path.resolve(htmlDir, decodedSrc);
      if (fs.existsSync(absPath)) {
        const attachName = stripNotionUuid(path.basename(decodedSrc));
        attachments.push({
          source: absPath,
          targetPath: `Attachments/${attachName}`,
        });
        // Update body to reference new attachment path
        body = body.replace(
          new RegExp(escapeRegex(src), 'g'),
          `Attachments/${attachName}`
        );
      }
    } catch {
      // Skip
    }
  }

  return {
    sourcePath: path.relative(exportRoot, htmlPath),
    title,
    kind,
    targetFolder,
    properties,
    body,
    attachments,
  };
}

// ---------------------------------------------------------------------------
// Extract a typed value from a Notion property table cell
// ---------------------------------------------------------------------------

function extractPropertyValue(
  cell: Element,
  propName: string
): unknown {
  // Check for checkbox
  const checkbox = cell.querySelector('.checkbox');
  if (checkbox) {
    return checkbox.classList.contains('checkbox-on');
  }

  // Check for multiple select (tags/multi-select)
  const selects = cell.querySelectorAll('.selected-value');
  if (selects.length > 0) {
    const values = Array.from(selects).map(
      (s) => s.textContent?.trim() || ''
    );
    // Determine if this is a relation (links) or plain multi-select
    if (isRelationProperty(propName)) {
      return values.map((v) => `"[[${v}]]"`);
    }
    return values.length === 1 ? values[0] : values;
  }

  // Check for relation links
  const relationLinks = cell.querySelectorAll('a');
  if (relationLinks.length > 0 && isRelationProperty(propName)) {
    const names = Array.from(relationLinks).map((a) => {
      const text = a.textContent?.trim() || '';
      return stripNotionUuid(text);
    });
    if (names.length === 1) {
      return `"[[${names[0]}]]"`;
    }
    return names.map((n) => `"[[${n}]]"`);
  }

  // Check for date
  const dateValue = cell.querySelector('.date');
  if (dateValue) {
    const text = dateValue.textContent?.trim() || '';
    return normalizeDate(text);
  }

  // Plain text value
  const text = cell.textContent?.trim() || '';
  if (!text) return undefined;

  // Boolean strings
  if (text.toLowerCase() === 'yes' || text.toLowerCase() === 'true') return true;
  if (text.toLowerCase() === 'no' || text.toLowerCase() === 'false') return false;

  // Numeric values for known numeric properties
  if (isNumericProperty(propName)) {
    const num = parseFloat(text);
    if (!isNaN(num)) return num;
  }

  // Date strings
  if (isDateProperty(propName)) {
    return normalizeDate(text);
  }

  // Relation properties should become wikilinks
  if (isRelationProperty(propName)) {
    return `"[[${stripNotionUuid(text)}]]"`;
  }

  return text;
}

function isRelationProperty(name: string): boolean {
  return [
    'project',
    'tag',
    'parent_tag',
    'goal',
    'people',
    'parent_task',
    'sub_projects',
    'parent_project',
  ].includes(name);
}

function isDateProperty(name: string): boolean {
  return [
    'due',
    'start_date',
    'snooze',
    'wait_date',
    'target_deadline',
    'completed',
    'birthday',
    'check_in',
    'last_check_in',
    'achieved',
    'date_completed',
  ].includes(name);
}

function isNumericProperty(name: string): boolean {
  return [
    'rating',
    'pages',
    'publish_year',
    'recur_interval',
    'servings',
    'prep_time',
    'cook_time',
  ].includes(name);
}

function normalizeDate(text: string): string {
  // Try to parse various date formats from Notion
  // Notion typically exports as "Month Day, Year" or "@Month Day, Year"
  const cleaned = text.replace(/^@/, '').trim();
  try {
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0]; // YYYY-MM-DD
    }
  } catch {
    // Fall through
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Build frontmatter YAML
// ---------------------------------------------------------------------------

function buildFrontmatter(
  kind: string,
  properties: Record<string, unknown>
): string {
  const fm: Record<string, unknown> = { kind };

  // Merge properties
  for (const [key, value] of Object.entries(properties)) {
    fm[key] = value;
  }

  // Ensure essential properties exist with defaults
  if (kind === 'task') {
    fm.status ??= 'To Do';
    fm.my_day ??= false;
    fm.archived ??= false;
  } else if (kind === 'note') {
    fm.favorite ??= false;
    fm.archived ??= false;
  } else if (kind === 'project') {
    fm.status ??= 'Planned';
    fm.archived ??= false;
  } else if (kind === 'tag') {
    fm.archived ??= false;
  } else if (kind === 'goal') {
    fm.status ??= 'Dream';
    fm.archived ??= false;
  } else if (kind === 'person') {
    fm.archived ??= false;
  } else if (kind === 'book') {
    fm.status ??= 'Want to Read';
    fm.archived ??= false;
  }

  // Serialize to YAML
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    lines.push(serializeYamlProperty(key, value));
  }
  lines.push('---');
  return lines.join('\n');
}

function serializeYamlProperty(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    return `${key}:`;
  }
  if (typeof value === 'boolean') {
    return `${key}: ${value}`;
  }
  if (typeof value === 'number') {
    return `${key}: ${value}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    const items = value.map((v) => {
      if (typeof v === 'string' && v.startsWith('"[[')) {
        return `  - ${v}`;
      }
      return `  - "${String(v).replace(/"/g, '\\"')}"`;
    });
    return `${key}:\n${items.join('\n')}`;
  }
  if (typeof value === 'string') {
    // Wikilink values are already quoted: "[[Name]]"
    if (value.startsWith('"[[')) {
      return `${key}: ${value}`;
    }
    // Date values (YYYY-MM-DD) don't need quotes
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return `${key}: ${value}`;
    }
    // Quote strings that contain special YAML characters
    if (
      value.includes(':') ||
      value.includes('#') ||
      value.includes("'") ||
      value.includes('"') ||
      value.includes('\n') ||
      value.startsWith('[') ||
      value.startsWith('{')
    ) {
      return `${key}: "${value.replace(/"/g, '\\"')}"`;
    }
    return `${key}: ${value}`;
  }
  return `${key}: "${String(value)}"`;
}

// ---------------------------------------------------------------------------
// Discover and classify Notion export folders
// ---------------------------------------------------------------------------

interface DatabaseFolder {
  folderPath: string;
  folderName: string;
  kind: string;
  targetFolder: string;
}

function discoverDatabases(exportRoot: string): DatabaseFolder[] {
  const results: DatabaseFolder[] = [];
  const entries = fs.readdirSync(exportRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const folderName = stripNotionUuid(entry.name).toLowerCase();

    // Try to match against known database names
    let matched = false;
    for (const [dbName, config] of Object.entries(DATABASE_MAP)) {
      if (
        folderName === dbName ||
        folderName.includes(dbName) ||
        dbName.includes(folderName)
      ) {
        results.push({
          folderPath: path.join(exportRoot, entry.name),
          folderName: entry.name,
          kind: config.kind,
          targetFolder: config.folder,
        });
        matched = true;
        break;
      }
    }

    if (!matched) {
      console.log(`  [?] Unrecognized folder: "${entry.name}" → will be treated as notes`);
      results.push({
        folderPath: path.join(exportRoot, entry.name),
        folderName: entry.name,
        kind: 'note',
        targetFolder: '02 Notes',
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Collect all HTML files recursively
// ---------------------------------------------------------------------------

function collectHtmlFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into subdirectories (Notion nests child pages)
      files.push(...collectHtmlFiles(fullPath));
    } else if (entry.name.endsWith('.html')) {
      files.push(fullPath);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Main conversion pipeline
// ---------------------------------------------------------------------------

async function convert(inputDir: string, outputDir: string): Promise<void> {
  console.log('=== Notion → Obsidian Converter ===\n');
  console.log(`Input:  ${inputDir}`);
  console.log(`Output: ${outputDir}\n`);

  // Validate input
  if (!fs.existsSync(inputDir)) {
    console.error(`ERROR: Input directory does not exist: ${inputDir}`);
    process.exit(1);
  }

  // Create output directory structure
  const folders = [
    '00 Inbox',
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
    'Attachments',
    'Bases',
    'Templates',
    'Dashboards',
  ];
  for (const folder of folders) {
    fs.mkdirSync(path.join(outputDir, folder), { recursive: true });
  }

  // Phase 1: Discover databases
  console.log('Phase 1: Discovering database folders...');
  const databases = discoverDatabases(inputDir);
  for (const db of databases) {
    console.log(`  [✓] ${db.folderName} → kind:${db.kind} → ${db.targetFolder}/`);
  }
  console.log();

  // Phase 2: Build filename mapping (for internal link resolution)
  console.log('Phase 2: Building filename index...');
  let totalFiles = 0;
  for (const db of databases) {
    const htmlFiles = collectHtmlFiles(db.folderPath);
    for (const file of htmlFiles) {
      const basename = path.basename(file, '.html');
      const cleanName = stripNotionUuid(basename);
      fileNameMap.set(basename, cleanName);
      fileNameMap.set(cleanName.toLowerCase(), cleanName);
      totalFiles++;
    }
  }
  console.log(`  Indexed ${totalFiles} files\n`);

  // Phase 3: Convert all pages
  console.log('Phase 3: Converting pages...');
  const pages: NotionPage[] = [];
  const stats = { converted: 0, skipped: 0, errors: 0 };

  for (const db of databases) {
    const htmlFiles = collectHtmlFiles(db.folderPath);
    console.log(`  Processing ${db.folderName} (${htmlFiles.length} files)...`);

    for (const htmlFile of htmlFiles) {
      try {
        const page = parseNotionHtml(
          htmlFile,
          inputDir,
          db.kind,
          db.targetFolder
        );

        // Skip empty/untitled pages
        if (!page.title || page.title.trim() === 'Untitled') {
          stats.skipped++;
          continue;
        }

        pages.push(page);
        stats.converted++;
      } catch (err) {
        console.error(`    [!] Error converting ${htmlFile}: ${err}`);
        stats.errors++;
      }
    }
  }
  console.log();

  // Phase 4: Write converted files
  console.log('Phase 4: Writing vault files...');
  const writtenFiles = new Set<string>();

  for (const page of pages) {
    // Build the target filename
    let fileName = sanitizeFilename(page.title) + '.md';
    const targetDir = path.join(outputDir, page.targetFolder);
    let targetPath = path.join(targetDir, fileName);

    // Handle duplicates
    if (writtenFiles.has(targetPath.toLowerCase())) {
      fileName = sanitizeFilename(page.title) + ' (2).md';
      targetPath = path.join(targetDir, fileName);
    }
    writtenFiles.add(targetPath.toLowerCase());

    // Build frontmatter + body
    const frontmatter = buildFrontmatter(page.kind, page.properties);
    const content = `${frontmatter}\n\n${page.body}\n`;

    fs.writeFileSync(targetPath, content, 'utf-8');

    // Copy attachments
    for (const att of page.attachments) {
      const attTarget = path.join(outputDir, att.targetPath);
      try {
        fs.mkdirSync(path.dirname(attTarget), { recursive: true });
        fs.copyFileSync(att.source, attTarget);
      } catch (err) {
        console.error(`    [!] Error copying attachment: ${err}`);
      }
    }
  }
  console.log(`  Written ${writtenFiles.size} files\n`);

  // Phase 5: Copy vault infrastructure (Bases, Templates, Dashboards, Home)
  console.log('Phase 5: Copying vault infrastructure...');
  copyVaultInfrastructure(outputDir);
  console.log();

  // Summary
  console.log('=== Conversion Complete ===');
  console.log(`  Converted: ${stats.converted}`);
  console.log(`  Skipped:   ${stats.skipped}`);
  console.log(`  Errors:    ${stats.errors}`);
  console.log(`  Output:    ${outputDir}`);
  console.log();
  console.log('Next steps:');
  console.log('  1. Review the output vault for correctness');
  console.log('  2. Upload to R2: rclone sync <output-dir> r2:second-brain');
  console.log('  3. Open in Obsidian to verify Bases render correctly');
}

// ---------------------------------------------------------------------------
// Copy vault infrastructure from the dummy vault
// ---------------------------------------------------------------------------

function copyVaultInfrastructure(outputDir: string): void {
  // These files come from our existing dummy vault structure.
  // On Railway, they'll be in the repo. When running locally, they'll be
  // at the path specified by the user.
  //
  // The script looks for infrastructure files in this order:
  // 1. VAULT_INFRA_DIR env var
  // 2. ../second-brain-dev (sibling directory)
  // 3. Fall back to just creating the folder structure

  const infraDir =
    process.env.VAULT_INFRA_DIR ||
    path.resolve(__dirname, '../../second-brain-dev');

  if (!fs.existsSync(infraDir)) {
    console.log(
      '  [!] No vault infrastructure directory found. Bases, Templates, and Dashboards will need to be added manually.'
    );
    console.log(
      `  Set VAULT_INFRA_DIR env var or place infra files at: ${infraDir}`
    );
    return;
  }

  // Copy Bases
  const basesDir = path.join(infraDir, 'Bases');
  if (fs.existsSync(basesDir)) {
    for (const file of fs.readdirSync(basesDir)) {
      if (file.endsWith('.base')) {
        fs.copyFileSync(
          path.join(basesDir, file),
          path.join(outputDir, 'Bases', file)
        );
        console.log(`  [✓] Bases/${file}`);
      }
    }
  }

  // Copy Templates
  const templatesDir = path.join(infraDir, 'Templates');
  if (fs.existsSync(templatesDir)) {
    for (const file of fs.readdirSync(templatesDir)) {
      if (file.endsWith('.md')) {
        fs.copyFileSync(
          path.join(templatesDir, file),
          path.join(outputDir, 'Templates', file)
        );
        console.log(`  [✓] Templates/${file}`);
      }
    }
  }

  // Copy Dashboards
  const dashboardsDir = path.join(infraDir, 'Dashboards');
  if (fs.existsSync(dashboardsDir)) {
    for (const file of fs.readdirSync(dashboardsDir)) {
      if (file.endsWith('.md')) {
        fs.copyFileSync(
          path.join(dashboardsDir, file),
          path.join(outputDir, 'Dashboards', file)
        );
        console.log(`  [✓] Dashboards/${file}`);
      }
    }
  }

  // Copy Home.md
  const homeMd = path.join(infraDir, 'Home.md');
  if (fs.existsSync(homeMd)) {
    fs.copyFileSync(homeMd, path.join(outputDir, 'Home.md'));
    console.log('  [✓] Home.md');
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function sanitizeFilename(name: string): string {
  // Remove/replace characters that are invalid in filenames
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: npx tsx scripts/notion-to-obsidian.ts <input-dir> <output-dir>');
  console.log();
  console.log('  input-dir   Path to unzipped Notion HTML export');
  console.log('  output-dir  Path where the Obsidian vault will be created');
  console.log();
  console.log('Options:');
  console.log('  VAULT_INFRA_DIR  Env var pointing to vault infrastructure (Bases, Templates)');
  process.exit(1);
}

const [inputDir, outputDir] = args;
convert(path.resolve(inputDir), path.resolve(outputDir)).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
