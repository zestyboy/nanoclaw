import fs from 'fs';
import path from 'path';

export interface RecentNoteMatch {
  file: string;
  title: string;
  note_date: string | null;
  modified_at: string;
  score: number;
  matched_terms: string[];
  snippet: string;
}

export interface RecentNoteSearchResult {
  results: RecentNoteMatch[];
  stats: {
    files_scanned: number;
    files_in_range: number;
    files_matched: number;
    start_date: string;
    end_date: string;
  };
}

export interface RecentNoteSearchOptions {
  rootDir: string;
  startDate: string;
  endDate: string;
  query?: string;
  terms?: string[];
  limit?: number;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'around',
  'for',
  'from',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'past',
  'tell',
  'that',
  'the',
  'their',
  'them',
  'these',
  'this',
  'thoughts',
  'to',
  'week',
  'were',
  'what',
  'within',
]);

const NATURAL_DATE_PATTERN =
  /@?\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i;

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDateString(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return toIsoDate(parsed);
}

function extractFrontmatter(content: string): string | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  return content.slice(4, end);
}

export function parseDateFromFrontmatter(content: string): string | null {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return null;

  const match = frontmatter.match(
    /^(created|date|day|journal_date|publish_date):\s*(.+)$/m,
  );
  if (!match) return null;

  return parseDateString(match[2]);
}

export function parseDateFromFilename(filePath: string): string | null {
  const base = path.basename(filePath, path.extname(filePath));

  const isoMatch = base.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const naturalMatch = base.match(NATURAL_DATE_PATTERN);
  if (!naturalMatch) return null;

  return parseDateString(naturalMatch[0].replace(/^@/, ''));
}

export function deriveNoteDate(
  filePath: string,
  content: string,
  stat: fs.Stats,
): string {
  return (
    parseDateFromFrontmatter(content) ||
    parseDateFromFilename(filePath) ||
    toIsoDate(stat.mtime)
  );
}

export function tokenizeSearchTerms(
  query: string,
  explicitTerms: string[] = [],
): string[] {
  const fromQuery = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));

  const combined = [...explicitTerms, ...fromQuery]
    .map((term) => term.toLowerCase().trim())
    .filter((term) => term.length > 0);

  return [...new Set(combined)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countTermMatches(text: string, term: string): number {
  const matches = text.match(new RegExp(escapeRegExp(term), 'gi'));
  return matches ? matches.length : 0;
}

function buildSnippet(content: string, terms: string[]): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return '';

  const lower = normalized.toLowerCase();
  const firstIndex = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (firstIndex === undefined) {
    return normalized.slice(0, 220);
  }

  const start = Math.max(0, firstIndex - 90);
  const end = Math.min(normalized.length, firstIndex + 180);
  return normalized.slice(start, end);
}

function deriveTitle(content: string, filePath: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(filePath, path.extname(filePath));
}

function walkMarkdownFiles(rootDir: string): string[] {
  const files: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function searchRecentNotes(
  options: RecentNoteSearchOptions,
): RecentNoteSearchResult {
  const limit = options.limit ?? 10;
  const searchTerms = tokenizeSearchTerms(options.query ?? '', options.terms);
  const files = walkMarkdownFiles(options.rootDir);
  const results: RecentNoteMatch[] = [];
  let filesInRange = 0;

  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const noteDate = deriveNoteDate(filePath, content, stat);

    if (noteDate < options.startDate || noteDate > options.endDate) continue;
    filesInRange += 1;

    const title = deriveTitle(content, filePath);
    const haystack = `${title}\n${content}`.toLowerCase();
    const matchedTerms = searchTerms.filter((term) => haystack.includes(term));
    if (matchedTerms.length === 0) continue;

    let score = 0;
    for (const term of matchedTerms) {
      score += countTermMatches(title, term) * 4;
      score += countTermMatches(content, term);
    }

    results.push({
      file: path.relative(options.rootDir, filePath),
      title,
      note_date: noteDate,
      modified_at: stat.mtime.toISOString(),
      score,
      matched_terms: matchedTerms,
      snippet: buildSnippet(content, matchedTerms),
    });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.note_date || '').localeCompare(a.note_date || '');
  });

  return {
    results: results.slice(0, limit),
    stats: {
      files_scanned: files.length,
      files_in_range: filesInRange,
      files_matched: results.length,
      start_date: options.startDate,
      end_date: options.endDate,
    },
  };
}
