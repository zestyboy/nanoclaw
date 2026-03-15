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
 *   npx tsx scripts/notion-to-obsidian.ts --list-databases <input-dir>
 *   npx tsx scripts/notion-to-obsidian.ts --database <logical-path> <input-dir> <output-dir>
 *
 * The input-dir should be the unzipped Notion HTML export folder.
 * The output-dir will be populated with the Obsidian vault structure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
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

export function stripNotionUuid(name: string): string {
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
  attachments: AttachmentPlan[];
  /** Attachment rewrite stats for this page */
  attachmentStats: PageAttachmentStats;
}

type RawPath = Buffer;

type AttachmentReferenceKind = 'image' | 'file';

interface SourceEntry {
  rawPath: RawPath;
  logicalPath: string;
  displayName: string;
  isDirectory: boolean;
}

interface HtmlFile extends SourceEntry {
  isDirectory: false;
}

interface DatabaseFolder {
  folder: SourceEntry;
  kind: string;
  targetFolder: string;
}

interface ListedDatabase {
  logicalPath: string;
  displayName: string;
  kind: string;
  targetFolder: string;
}

interface SourceIndex {
  byLogicalPath: Map<string, SourceEntry>;
  byBasename: Map<string, SourceEntry[]>;
}

interface ConvertOptions {
  databaseLogicalPath?: string;
  copyInfrastructure?: boolean;
}

interface AttachmentPlan {
  source: SourceEntry;
  targetPath: string;
  kind: AttachmentReferenceKind;
}

interface AttachmentRegistry {
  bySourceLogicalPath: Map<string, string>;
  byTargetPath: Map<string, string>;
  copiedTargets: Set<string>;
  collisionRenamedCount: number;
  outputDir: string;
}

interface PageAttachmentStats {
  imageRefsRewritten: number;
  fileRefsRewritten: number;
  unresolvedAttachmentRefs: number;
}

interface ConvertStats extends PageAttachmentStats {
  converted: number;
  skipped: number;
  errors: number;
  attachmentsCopied: number;
  collisionRenamedAttachments: number;
}

class AttachmentCopyError extends Error {}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const WINDOWS_1252_MAP: Record<number, string> = {
  0x80: '\u20ac',
  0x82: '\u201a',
  0x83: '\u0192',
  0x84: '\u201e',
  0x85: '\u2026',
  0x86: '\u2020',
  0x87: '\u2021',
  0x88: '\u02c6',
  0x89: '\u2030',
  0x8a: '\u0160',
  0x8b: '\u2039',
  0x8c: '\u0152',
  0x8e: '\u017d',
  0x91: '\u2018',
  0x92: '\u2019',
  0x93: '\u201c',
  0x94: '\u201d',
  0x95: '\u2022',
  0x96: '\u2013',
  0x97: '\u2014',
  0x98: '\u02dc',
  0x99: '\u2122',
  0x9a: '\u0161',
  0x9b: '\u203a',
  0x9c: '\u0153',
  0x9e: '\u017e',
  0x9f: '\u0178',
};

function toRawPath(pathValue: string): RawPath {
  return Buffer.from(pathValue);
}

function joinRawPath(parent: RawPath, child: Buffer | string): RawPath {
  const childBuffer = typeof child === 'string' ? Buffer.from(child) : child;
  if (parent[parent.length - 1] === 0x2f) {
    return Buffer.concat([parent, childBuffer]);
  }
  return Buffer.concat([parent, Buffer.from('/'), childBuffer]);
}

function decodeWindows1252(input: Buffer): string {
  let decoded = '';
  for (const byte of input) {
    decoded += WINDOWS_1252_MAP[byte] || String.fromCharCode(byte);
  }
  return decoded;
}

export function decodeFilesystemName(input: Buffer): string {
  try {
    const decoded = UTF8_DECODER.decode(input);
    if (!decoded.includes('\uFFFD')) {
      return decoded.normalize('NFC');
    }
  } catch {
    // Fall back to Windows-1252 decoding below.
  }
  return decodeWindows1252(input).normalize('NFC');
}

function normalizeLookupPath(input: string): string {
  const normalized = path.posix
    .normalize(input.replace(/\\/g, '/'))
    .replace(/^\/+/, '');
  return normalized === '.'
    ? ''
    : normalized.normalize('NFC').toLowerCase();
}

function stripQueryAndHash(input: string): string {
  return input.split('#')[0]?.split('?')[0] || '';
}

function isRemoteReference(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

function isLocalHtmlReference(input: string): boolean {
  if (isRemoteReference(input)) {
    return false;
  }

  const cleaned = stripQueryAndHash(input).trim().toLowerCase();
  return cleaned.endsWith('.html') || cleaned.endsWith('.md');
}

function isLocalAttachmentReference(input: string): boolean {
  if (isRemoteReference(input)) {
    return false;
  }

  const cleaned = stripQueryAndHash(input).trim().toLowerCase();
  const extension = path.posix.extname(cleaned);
  return Boolean(
    extension &&
      extension !== '.html' &&
      extension !== '.md' &&
      extension !== '.csv'
  );
}

function decodeReference(input: string): string | null {
  try {
    return decodeURIComponent(input);
  } catch {
    return null;
  }
}

function sanitizePathSegment(segment: string): string {
  return sanitizeFilename(segment);
}

function stripNotionUuidFromPathSegments(input: string): string {
  const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
  const cleanedSegments = normalized
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .map((segment) => sanitizePathSegment(stripNotionUuid(segment)))
    .filter(Boolean);

  return cleanedSegments.join('/');
}

function createPageLinkPlaceholder(linkedName: string): string {
  return `WKLNK8START8${linkedName}8END8WKLNK`;
}

function createImageAttachmentPlaceholder(targetPath: string): string {
  return `ATTIMG8START8${encodeURIComponent(targetPath)}8END8ATTIMG`;
}

function createFileAttachmentPlaceholder(
  targetPath: string,
  label: string
): string {
  return `ATTFILE8START8${encodeURIComponent(targetPath)}8MID8${encodeURIComponent(
    label
  )}8END8ATTFILE`;
}

function decodePlaceholderValue(input: string): string {
  return decodeURIComponent(input);
}

function hasMeaningfulAttachmentLabel(targetPath: string, label: string): boolean {
  if (!label) {
    return false;
  }

  const basename = path.posix.basename(targetPath);
  return label !== basename && label !== stripNotionUuid(basename);
}

function formatAttachmentLink(targetPath: string, label: string): string {
  return hasMeaningfulAttachmentLabel(targetPath, label)
    ? `[[${targetPath}|${label}]]`
    : `[[${targetPath}]]`;
}

function appendHashSuffix(
  targetPath: string,
  sourceLogicalPath: string,
  hashLength: number
): string {
  const dir = path.posix.dirname(targetPath);
  const ext = path.posix.extname(targetPath);
  const base = path.posix.basename(targetPath, ext);
  const suffix = createHash('sha1')
    .update(normalizeLookupPath(sourceLogicalPath))
    .digest('hex')
    .slice(0, hashLength);
  const fileName = `${base}-${suffix}${ext}`;

  return dir === '.'
    ? fileName
    : path.posix.join(dir, fileName);
}

function filesMatch(sourceRawPath: RawPath, targetPath: string): boolean {
  if (!fs.existsSync(targetPath)) {
    return false;
  }

  const sourceStat = fs.statSync(sourceRawPath);
  const targetStat = fs.statSync(targetPath);
  if (sourceStat.size !== targetStat.size) {
    return false;
  }

  return fs.readFileSync(sourceRawPath).equals(fs.readFileSync(targetPath));
}

function createAttachmentRegistry(outputDir: string): AttachmentRegistry {
  return {
    bySourceLogicalPath: new Map<string, string>(),
    byTargetPath: new Map<string, string>(),
    copiedTargets: new Set<string>(),
    collisionRenamedCount: 0,
    outputDir,
  };
}

function readdirRaw(dir: RawPath): fs.Dirent<Buffer>[] {
  return fs.readdirSync(dir, {
    encoding: 'buffer',
    withFileTypes: true,
  }) as fs.Dirent<Buffer>[];
}

function makeSourceEntry(
  parentRawPath: RawPath,
  parentLogicalPath: string,
  entry: fs.Dirent<Buffer>
): SourceEntry {
  const displayName = decodeFilesystemName(entry.name);
  return {
    rawPath: joinRawPath(parentRawPath, entry.name),
    logicalPath: parentLogicalPath
      ? path.posix.join(parentLogicalPath, displayName)
      : displayName,
    displayName,
    isDirectory: entry.isDirectory(),
  };
}

function buildSourceIndex(exportRoot: string): SourceIndex {
  const byLogicalPath = new Map<string, SourceEntry>();
  const byBasename = new Map<string, SourceEntry[]>();

  function walk(rawDir: RawPath, logicalDir: string): void {
    for (const entry of readdirRaw(rawDir)) {
      const node = makeSourceEntry(rawDir, logicalDir, entry);
      const logicalKey = normalizeLookupPath(node.logicalPath);
      byLogicalPath.set(logicalKey, node);

      const basenameKey = normalizeLookupPath(node.displayName);
      const basenameEntries = byBasename.get(basenameKey) || [];
      basenameEntries.push(node);
      byBasename.set(basenameKey, basenameEntries);

      if (node.isDirectory) {
        walk(node.rawPath, node.logicalPath);
      }
    }
  }

  walk(toRawPath(exportRoot), '');
  return { byLogicalPath, byBasename };
}

function resolveSourceEntry(
  sourceIndex: SourceIndex,
  currentLogicalDir: string,
  rawReference: string
): SourceEntry | null {
  const cleanReference = stripQueryAndHash(rawReference).trim();
  if (!cleanReference) {
    return null;
  }

  const normalizedReference = normalizeLookupPath(cleanReference);
  const relativeKey = normalizeLookupPath(
    path.posix.join(currentLogicalDir, cleanReference)
  );

  const directMatch =
    sourceIndex.byLogicalPath.get(relativeKey) ||
    sourceIndex.byLogicalPath.get(normalizedReference);
  if (directMatch) {
    return directMatch;
  }

  const basename = path.posix.basename(cleanReference);
  const basenameMatches = (sourceIndex.byBasename.get(
    normalizeLookupPath(basename)
  ) || []).filter((entry) => !entry.isDirectory);

  if (basenameMatches.length === 1) {
    return basenameMatches[0];
  }

  return null;
}

function buildAttachmentRelativePath(
  sourceLogicalPath: string,
  databaseLogicalPath: string
): string {
  const databaseParent = path.posix.dirname(databaseLogicalPath);
  const relativeToDatabaseParent = path.posix.relative(
    databaseParent === '.' ? '' : databaseParent,
    sourceLogicalPath
  );

  const candidatePath =
    relativeToDatabaseParent &&
    !relativeToDatabaseParent.startsWith('../') &&
    !relativeToDatabaseParent.startsWith('/')
      ? relativeToDatabaseParent
      : sourceLogicalPath;

  const cleaned = stripNotionUuidFromPathSegments(candidatePath);
  return cleaned || sanitizeFilename(stripNotionUuid(path.posix.basename(sourceLogicalPath)));
}

function planAttachmentTarget(
  source: SourceEntry,
  databaseLogicalPath: string,
  registry: AttachmentRegistry
): { targetPath: string; collisionRenamed: boolean } {
  const sourceKey = normalizeLookupPath(source.logicalPath);
  const cachedTarget = registry.bySourceLogicalPath.get(sourceKey);
  if (cachedTarget) {
    return { targetPath: cachedTarget, collisionRenamed: false };
  }

  const relativePath = buildAttachmentRelativePath(
    source.logicalPath,
    databaseLogicalPath
  );
  const preferredTarget = path.posix.join('Attachments', relativePath);

  let candidate = preferredTarget;
  let collisionRenamed = false;
  let hashLength = 8;

  while (true) {
    const targetKey = normalizeLookupPath(candidate);
    const targetOwner = registry.byTargetPath.get(targetKey);
    if (targetOwner && targetOwner !== sourceKey) {
      collisionRenamed = true;
      candidate = appendHashSuffix(preferredTarget, source.logicalPath, hashLength);
      hashLength += 4;
      continue;
    }

    const candidatePath = path.join(registry.outputDir, candidate);
    if (fs.existsSync(candidatePath) && !filesMatch(source.rawPath, candidatePath)) {
      collisionRenamed = true;
      candidate = appendHashSuffix(preferredTarget, source.logicalPath, hashLength);
      hashLength += 4;
      continue;
    }

    registry.bySourceLogicalPath.set(sourceKey, candidate);
    registry.byTargetPath.set(targetKey, sourceKey);
    if (collisionRenamed) {
      registry.collisionRenamedCount++;
    }
    return { targetPath: candidate, collisionRenamed };
  }
}

function resolveAttachmentPlan(
  sourceIndex: SourceIndex,
  htmlFile: HtmlFile,
  databaseLogicalPath: string,
  registry: AttachmentRegistry,
  rawReference: string,
  kind: AttachmentReferenceKind
): AttachmentPlan | null {
  const decodedReference = decodeReference(rawReference);
  if (!decodedReference) {
    console.warn(
      `    [!] Malformed attachment reference in ${htmlFile.logicalPath}: ${rawReference}`
    );
    return null;
  }

  const resolvedEntry = resolveSourceEntry(
    sourceIndex,
    path.posix.dirname(htmlFile.logicalPath),
    decodedReference
  );
  if (!resolvedEntry || resolvedEntry.isDirectory) {
    console.warn(
      `    [!] Unresolved attachment reference in ${htmlFile.logicalPath}: ${rawReference}`
    );
    return null;
  }

  const { targetPath } = planAttachmentTarget(
    resolvedEntry,
    databaseLogicalPath,
    registry
  );
  return {
    source: resolvedEntry,
    targetPath,
    kind,
  };
}

// ---------------------------------------------------------------------------
// Notion DOM fixes (patterns from the Obsidian Importer plugin)
// ---------------------------------------------------------------------------

/** Notion wraps each <li> in its own <ul>/<ol>. Merge adjacent same-type lists. */
function fixNotionLists(root: Element): void {
  const lists = root.querySelectorAll('ul, ol');
  for (const list of lists) {
    const next = list.nextElementSibling;
    if (next && next.tagName === list.tagName) {
      // Move all children from next list into current
      while (next.firstChild) {
        list.appendChild(next.firstChild);
      }
      next.parentElement?.removeChild(next);
    }
  }
}

/** Convert Notion checkbox divs to markdown-style checkboxes. */
function fixNotionCheckboxes(root: Element): void {
  const checkboxes = root.querySelectorAll('.checkbox');
  for (const cb of checkboxes) {
    const isChecked = cb.classList.contains('checkbox-on');
    const marker = isChecked ? '[x] ' : '[ ] ';
    const textNode = cb.ownerDocument.createTextNode(marker);
    cb.parentElement?.replaceChild(textNode, cb);
  }
}

/** Notion prepends @ to dates in the body. Strip it. */
function fixNotionDates(root: Element): void {
  const times = root.querySelectorAll('time');
  for (const time of times) {
    const text = time.textContent || '';
    if (text.startsWith('@')) {
      time.textContent = text.slice(1).trim();
    }
  }
}

/** Convert Notion toggle headings (<summary> with font-size) to proper headings. */
function fixToggleHeadings(root: Element): void {
  const summaries = root.querySelectorAll('summary');
  for (const summary of summaries) {
    const style = summary.getAttribute('style') || '';
    let tag = '';
    if (style.includes('1.875em')) tag = 'h1';
    else if (style.includes('1.5em')) tag = 'h2';
    else if (style.includes('1.25em')) tag = 'h3';
    if (tag) {
      const heading = summary.ownerDocument.createElement(tag);
      heading.innerHTML = summary.innerHTML;
      summary.parentElement?.replaceChild(heading, summary);
    }
  }
}

// ---------------------------------------------------------------------------
// Parse a Notion HTML file
// ---------------------------------------------------------------------------

function parseNotionHtml(
  htmlFile: HtmlFile,
  kind: string,
  targetFolder: string,
  sourceIndex: SourceIndex,
  databaseLogicalPath: string,
  attachmentRegistry: AttachmentRegistry
): NotionPage {
  const html = fs.readFileSync(htmlFile.rawPath, 'utf-8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Extract title: prefer <title> element (full title), fall back to filename
  const basename = htmlFile.displayName.replace(/\.html$/i, '');
  const titleEl = doc.querySelector('title');
  const title = titleEl?.textContent?.trim() || stripNotionUuid(basename);

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

  // --- Notion-specific DOM fixes (from Obsidian Importer patterns) ---

  // Fix Notion's list structure: each <li> is wrapped in its own <ul>/<ol>
  // Merge adjacent same-type lists into a single list
  fixNotionLists(bodyElement);

  // Convert Notion checkboxes in body to markdown checkboxes
  fixNotionCheckboxes(bodyElement);

  // Strip @ prefix from Notion date elements
  fixNotionDates(bodyElement);

  // Convert toggle headings: <summary> with font-size → proper headings
  fixToggleHeadings(bodyElement);

  const attachmentStats: PageAttachmentStats = {
    imageRefsRewritten: 0,
    fileRefsRewritten: 0,
    unresolvedAttachmentRefs: 0,
  };
  const attachments: AttachmentPlan[] = [];

  for (const img of bodyElement.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (!src || isRemoteReference(src)) {
      continue;
    }
    if (!isLocalAttachmentReference(src)) {
      continue;
    }

    const attachment = resolveAttachmentPlan(
      sourceIndex,
      htmlFile,
      databaseLogicalPath,
      attachmentRegistry,
      src,
      'image'
    );
    if (!attachment) {
      attachmentStats.unresolvedAttachmentRefs++;
      continue;
    }

    attachments.push(attachment);
    img.replaceWith(
      doc.createTextNode(createImageAttachmentPlaceholder(attachment.targetPath))
    );
    attachmentStats.imageRefsRewritten++;
  }

  // Rewrite links before Turndown so page links and local attachments can
  // follow different output formats.
  const links = bodyElement.querySelectorAll('a');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href || isRemoteReference(href)) {
      continue;
    }

    if (isLocalHtmlReference(href)) {
      const decodedHref = decodeReference(href);
      if (!decodedHref) {
        continue;
      }

      const linkedBasename = path.basename(decodedHref, '.html');
      const linkedName = stripNotionUuid(path.basename(linkedBasename, '.md'));
      if (linkedName) {
        link.textContent = createPageLinkPlaceholder(linkedName);
        link.setAttribute('href', '#');
      }
      continue;
    }

    if (!isLocalAttachmentReference(href)) {
      continue;
    }

    const attachment = resolveAttachmentPlan(
      sourceIndex,
      htmlFile,
      databaseLogicalPath,
      attachmentRegistry,
      href,
      'file'
    );
    if (!attachment) {
      attachmentStats.unresolvedAttachmentRefs++;
      continue;
    }

    const label = link.textContent?.trim() || '';
    attachments.push(attachment);
    link.textContent = createFileAttachmentPlaceholder(attachment.targetPath, label);
    link.setAttribute('href', '#');
    attachmentStats.fileRefsRewritten++;
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
  body = body.replace(
    /\[ATTFILE8START8(.+?)8MID8(.+?)8END8ATTFILE\]\([^)]*\)/g,
    (_match, encodedTargetPath, encodedLabel) =>
      formatAttachmentLink(
        decodePlaceholderValue(encodedTargetPath),
        decodePlaceholderValue(encodedLabel)
      )
  );
  body = body.replace(
    /ATTFILE8START8(.+?)8MID8(.+?)8END8ATTFILE/g,
    (_match, encodedTargetPath, encodedLabel) =>
      formatAttachmentLink(
        decodePlaceholderValue(encodedTargetPath),
        decodePlaceholderValue(encodedLabel)
      )
  );
  body = body.replace(
    /ATTIMG8START8(.+?)8END8ATTIMG/g,
    (_match, encodedTargetPath) =>
      `![[${decodePlaceholderValue(encodedTargetPath)}]]`
  );

  // Fix Turndown-escaped checkboxes: \[x\] → [x], \[ \] → [ ]
  body = body.replace(/\\\[(x| )\\\]/g, '[$1]');

  // Clean up excessive blank lines
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  const page: NotionPage = {
    sourcePath: htmlFile.logicalPath,
    title,
    kind,
    targetFolder,
    properties,
    body,
    attachments,
    attachmentStats,
  };
  dom.window.close();
  return page;
}

function writePageToVault(
  outputDir: string,
  page: NotionPage,
  writtenFiles: Set<string>,
  attachmentRegistry: AttachmentRegistry,
  stats: ConvertStats
): void {
  const targetDir = path.join(outputDir, page.targetFolder);
  const baseName = sanitizeFilename(page.title);

  let attempt = 0;
  let targetPath = '';
  while (true) {
    const suffix = attempt === 0 ? '' : ` (${attempt + 1})`;
    const fileName = `${baseName}${suffix}.md`;
    const candidate = path.join(targetDir, fileName);
    const key = candidate.toLowerCase();
    if (!writtenFiles.has(key) && !fs.existsSync(candidate)) {
      targetPath = candidate;
      writtenFiles.add(key);
      break;
    }
    attempt++;
  }

  const frontmatter = buildFrontmatter(page.kind, page.properties);
  const content = `${frontmatter}\n\n${page.body}\n`;
  fs.writeFileSync(targetPath, content, 'utf-8');

  for (const attachment of page.attachments) {
    const attachmentKey = normalizeLookupPath(attachment.targetPath);
    if (attachmentRegistry.copiedTargets.has(attachmentKey)) {
      continue;
    }

    const attachmentTarget = path.join(outputDir, attachment.targetPath);
    try {
      fs.mkdirSync(path.dirname(attachmentTarget), { recursive: true });
      if (fs.existsSync(attachmentTarget)) {
        if (!filesMatch(attachment.source.rawPath, attachmentTarget)) {
          throw new AttachmentCopyError(
            `Attachment target conflict for ${attachment.targetPath} from ${attachment.source.logicalPath}`
          );
        }
      } else {
        fs.copyFileSync(attachment.source.rawPath, attachmentTarget);
        stats.attachmentsCopied++;
      }
      attachmentRegistry.copiedTargets.add(attachmentKey);
    } catch (err) {
      throw new AttachmentCopyError(
        `Error copying attachment ${attachment.source.logicalPath} → ${attachment.targetPath}: ${err}`
      );
    }
  }
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

function discoverDatabases(
  exportRoot: string,
  options: { quiet?: boolean } = {}
): DatabaseFolder[] {
  const exportRootRaw = toRawPath(exportRoot);
  const dbComponentsDir = findDatabasesFolder(exportRootRaw, options);
  const searchRoot = dbComponentsDir || {
    rawPath: exportRootRaw,
    logicalPath: '',
    displayName: path.basename(exportRoot),
    isDirectory: true,
  };

  if (!options.quiet) {
    console.log(`  Search root: ${searchRoot.logicalPath || exportRoot}`);
  }

  const results: DatabaseFolder[] = [];
  const entries = readdirRaw(searchRoot.rawPath);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const folder = makeSourceEntry(
      searchRoot.rawPath,
      searchRoot.logicalPath,
      entry
    );
    const folderName = stripNotionUuid(folder.displayName).toLowerCase();

    let matched = false;
    for (const [dbName, config] of Object.entries(DATABASE_MAP)) {
      if (
        folderName === dbName ||
        folderName.includes(dbName) ||
        dbName.includes(folderName)
      ) {
        results.push({
          folder,
          kind: config.kind,
          targetFolder: config.folder,
        });
        matched = true;
        break;
      }
    }

    if (!matched) {
      try {
        const hasHtml = readdirRaw(folder.rawPath).some(
          (child) => !child.isDirectory() && decodeFilesystemName(child.name).endsWith('.html')
        );
        if (hasHtml) {
          if (!options.quiet) {
            console.log(
              `  [?] Unrecognized folder: "${folder.displayName}" → will be treated as notes`
            );
          }
          results.push({
            folder,
            kind: 'note',
            targetFolder: '02 Notes',
          });
        }
      } catch {
        if (!options.quiet) {
          console.log(
            `  [!] Cannot read folder: "${folder.displayName}" — skipping (likely encoding issue)`
          );
        }
      }
    }
  }

  return results;
}

/** Recursively find the "Databases & Components" folder, preferring v3 paths */
function findDatabasesFolder(
  root: RawPath,
  options: { quiet?: boolean } = {}
): SourceEntry | null {
  const candidates: SourceEntry[] = [];

  function walk(rawDir: RawPath, logicalDir: string, depth: number): void {
    if (depth > 5) return;
    try {
      for (const entry of readdirRaw(rawDir)) {
        if (!entry.isDirectory()) continue;
        const node = makeSourceEntry(rawDir, logicalDir, entry);
        if (node.displayName === 'Databases & Components') {
          candidates.push(node);
        } else {
          walk(node.rawPath, node.logicalPath, depth + 1);
        }
      }
    } catch {
      // Skip unreadable dirs.
    }
  }

  walk(root, '', 0);

  if (candidates.length === 0) {
    return null;
  }

  const rankedCandidates = [...candidates].sort((a, b) => {
    return scoreDatabasesCandidate(b.logicalPath) - scoreDatabasesCandidate(a.logicalPath);
  });
  const v3Candidate = rankedCandidates.find((candidate) => {
    const key = normalizeLookupPath(candidate.logicalPath);
    return key.includes('[v3]') || key.includes('v3');
  });

  if (v3Candidate) {
    if (!options.quiet) {
      console.log(
        `  Found v3 Databases & Components: ${v3Candidate.logicalPath}`
      );
    }
    return v3Candidate;
  }

  if (!options.quiet) {
    console.log(`  Found Databases & Components: ${candidates[0].logicalPath}`);
  }
  return candidates[0];
}

function scoreDatabasesCandidate(logicalPath: string): number {
  const key = normalizeLookupPath(logicalPath);
  let score = 0;

  if (key.includes('[v3]')) score += 100;
  if (key.includes('v3')) score += 40;
  if (key.includes("ultimate brain + creator")) score += 20;
  if (key.includes('archive') || key.includes('archives')) score -= 120;
  if (key.includes('fresh')) score -= 40;
  if (key.includes('[v3 -')) score -= 30;

  return score;
}

// ---------------------------------------------------------------------------
// Collect all HTML files recursively
// ---------------------------------------------------------------------------

function collectHtmlFiles(dir: SourceEntry): HtmlFile[] {
  const files: HtmlFile[] = [];

  for (const entry of readdirRaw(dir.rawPath)) {
    const node = makeSourceEntry(dir.rawPath, dir.logicalPath, entry);
    if (node.isDirectory) {
      files.push(...collectHtmlFiles(node));
    } else if (node.displayName.endsWith('.html')) {
      files.push(node as HtmlFile);
    }
  }

  return files;
}

function ensureVaultFolders(outputDir: string): void {
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
}

function selectDatabases(
  databases: DatabaseFolder[],
  databaseLogicalPath?: string
): DatabaseFolder[] {
  if (!databaseLogicalPath) {
    return databases;
  }

  const normalizedTarget = normalizeLookupPath(databaseLogicalPath);
  const matched = databases.find(
    (db) => normalizeLookupPath(db.folder.logicalPath) === normalizedTarget
  );

  if (!matched) {
    throw new Error(`Database not found: ${databaseLogicalPath}`);
  }

  return [matched];
}

export function listDatabases(inputDir: string): ListedDatabase[] {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }

  return discoverDatabases(inputDir, { quiet: true }).map((db) => ({
    logicalPath: db.folder.logicalPath,
    displayName: db.folder.displayName,
    kind: db.kind,
    targetFolder: db.targetFolder,
  }));
}

// ---------------------------------------------------------------------------
// Main conversion pipeline
// ---------------------------------------------------------------------------

export async function convert(
  inputDir: string,
  outputDir: string,
  options: ConvertOptions = {}
): Promise<void> {
  console.log('=== Notion → Obsidian Converter ===\n');
  console.log(`Input:  ${inputDir}`);
  console.log(`Output: ${outputDir}\n`);
  if (options.databaseLogicalPath) {
    console.log(`Database: ${options.databaseLogicalPath}\n`);
  }

  // Validate input
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }

  // Create output directory structure
  ensureVaultFolders(outputDir);

  // Phase 1: Discover databases
  console.log('Phase 1: Discovering database folders...');
  const allDatabases = discoverDatabases(inputDir);
  const databases = selectDatabases(
    allDatabases,
    options.databaseLogicalPath
  );
  for (const db of databases) {
    console.log(
      `  [✓] ${db.folder.displayName} → kind:${db.kind} → ${db.targetFolder}/`
    );
  }
  console.log();

  // Phase 2: Build a source-path index for attachments and relative lookups.
  console.log('Phase 2: Building source path index...');
  const sourceIndex = buildSourceIndex(inputDir);
  console.log(`  Indexed ${sourceIndex.byLogicalPath.size} source paths\n`);

  // Phase 3: Convert and write pages incrementally to keep memory bounded.
  console.log('Phase 3: Converting pages...');
  const stats: ConvertStats = {
    converted: 0,
    skipped: 0,
    errors: 0,
    attachmentsCopied: 0,
    imageRefsRewritten: 0,
    fileRefsRewritten: 0,
    unresolvedAttachmentRefs: 0,
    collisionRenamedAttachments: 0,
  };
  const writtenFiles = new Set<string>();
  const attachmentRegistry = createAttachmentRegistry(outputDir);

  for (const db of databases) {
    const htmlFiles = collectHtmlFiles(db.folder);
    console.log(
      `  Processing ${db.folder.displayName} (${htmlFiles.length} files)...`
    );

    for (const htmlFile of htmlFiles) {
      try {
        const page = parseNotionHtml(
          htmlFile,
          db.kind,
          db.targetFolder,
          sourceIndex,
          db.folder.logicalPath,
          attachmentRegistry
        );

        // Skip empty/untitled pages
        if (!page.title || page.title.trim() === 'Untitled') {
          stats.skipped++;
          continue;
        }

        stats.imageRefsRewritten += page.attachmentStats.imageRefsRewritten;
        stats.fileRefsRewritten += page.attachmentStats.fileRefsRewritten;
        stats.unresolvedAttachmentRefs += page.attachmentStats.unresolvedAttachmentRefs;

        writePageToVault(
          outputDir,
          page,
          writtenFiles,
          attachmentRegistry,
          stats
        );
        stats.converted++;
      } catch (err) {
        if (err instanceof AttachmentCopyError) {
          throw err;
        }
        console.error(`    [!] Error converting ${htmlFile.logicalPath}: ${err}`);
        stats.errors++;
      }
    }
  }
  stats.collisionRenamedAttachments = attachmentRegistry.collisionRenamedCount;
  console.log();

  // Phase 4: Report written files
  console.log('Phase 4: Writing vault files...');
  console.log(`  Written ${writtenFiles.size} files\n`);

  // Phase 5: Copy vault infrastructure (Bases, Templates, Dashboards, Home)
  if (options.copyInfrastructure !== false) {
    console.log('Phase 5: Copying vault infrastructure...');
    copyVaultInfrastructure(outputDir);
    console.log();
  } else {
    console.log('Phase 5: Skipping vault infrastructure copy.\n');
  }

  // Summary
  console.log('=== Conversion Complete ===');
  console.log(`  Converted: ${stats.converted}`);
  console.log(`  Skipped:   ${stats.skipped}`);
  console.log(`  Errors:    ${stats.errors}`);
  console.log(`  Attachments copied:      ${stats.attachmentsCopied}`);
  console.log(`  Image refs rewritten:    ${stats.imageRefsRewritten}`);
  console.log(`  File refs rewritten:     ${stats.fileRefsRewritten}`);
  console.log(`  Unresolved local refs:   ${stats.unresolvedAttachmentRefs}`);
  console.log(
    `  Collision-renamed files: ${stats.collisionRenamedAttachments}`
  );
  console.log(`  Output:    ${outputDir}`);
  console.log();
  console.log('Next steps:');
  console.log('  1. Review the output vault for correctness');
  console.log('  2. Upload to R2: rclone sync <output-dir> r2:second-brain');
  console.log('  3. Open in Obsidian to verify Bases render correctly');

  if (stats.errors > 0) {
    throw new Error(`Conversion completed with ${stats.errors} page errors`);
  }
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

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isCliEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isCliEntryPoint) {
  const args = process.argv.slice(2);
  const shouldListDatabases = args[0] === '--list-databases';
  const shouldConvertSingleDatabase = args[0] === '--database';

  if (shouldListDatabases) {
    if (args.length !== 2) {
      console.log(
        'Usage: npx tsx scripts/notion-to-obsidian.ts --list-databases <input-dir>'
      );
      process.exit(1);
    }

    const inputDir = path.resolve(args[1]);
    try {
      for (const database of listDatabases(inputDir)) {
        console.log(database.logicalPath);
      }
    } catch (err) {
      console.error('Fatal error:', err);
      process.exit(1);
    }
    process.exit(0);
  }

  if (!shouldConvertSingleDatabase && args.length < 2) {
    console.log(
      'Usage: npx tsx scripts/notion-to-obsidian.ts <input-dir> <output-dir>'
    );
    console.log();
    console.log(
      '  --list-databases <input-dir>                 List discovered database folders'
    );
    console.log(
      '  --database <logical-path> <input-dir> <output-dir>  Convert one database folder'
    );
    console.log();
    console.log('  input-dir   Path to unzipped Notion HTML export');
    console.log('  output-dir  Path where the Obsidian vault will be created');
    console.log();
    console.log('Options:');
    console.log(
      '  VAULT_INFRA_DIR  Env var pointing to vault infrastructure (Bases, Templates)'
    );
    process.exit(1);
  }

  let inputDir: string;
  let outputDir: string;
  let options: ConvertOptions = {};

  if (shouldConvertSingleDatabase) {
    if (args.length < 4) {
      console.log(
        'Usage: npx tsx scripts/notion-to-obsidian.ts --database <logical-path> <input-dir> <output-dir>'
      );
      process.exit(1);
    }

    const [, databaseLogicalPath, rawInputDir, rawOutputDir, ...rest] = args;
    inputDir = path.resolve(rawInputDir);
    outputDir = path.resolve(rawOutputDir);
    options = {
      databaseLogicalPath,
      copyInfrastructure: !rest.includes('--skip-infra'),
    };
  } else {
    [inputDir, outputDir] = args;
    inputDir = path.resolve(inputDir);
    outputDir = path.resolve(outputDir);
  }

  convert(inputDir, outputDir, options).catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
