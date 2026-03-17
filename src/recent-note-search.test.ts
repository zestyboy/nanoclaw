import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseDateFromFilename,
  parseDateFromFrontmatter,
  searchRecentNotes,
  tokenizeSearchTerms,
} from './recent-note-search.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-recent-search-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('recent note date parsing', () => {
  it('parses natural-language journal filenames', () => {
    expect(
      parseDateFromFilename('/vault/02 Notes/Journal- @March 12, 2025.md'),
    ).toBe('2025-03-12');
  });

  it('parses ISO dates from frontmatter', () => {
    expect(
      parseDateFromFrontmatter('---\ncreated: 2026-03-12\n---\nhello'),
    ).toBe('2026-03-12');
  });

  it('tokenizes query terms and removes stop words', () => {
    expect(
      tokenizeSearchTerms(
        'What were my thoughts around hiring within the past week?',
        ['staffing'],
      ),
    ).toEqual(['staffing', 'hiring']);
  });
});

describe('searchRecentNotes', () => {
  it('returns only notes inside the requested date range', () => {
    const rootDir = makeTempDir();
    const notesDir = path.join(rootDir, '02 Notes');
    fs.mkdirSync(notesDir, { recursive: true });

    fs.writeFileSync(
      path.join(notesDir, 'Journal- @March 12, 2025.md'),
      '# What to do with Paul\n\nStaffing discussion with Aengus and hiring questions.',
    );
    fs.writeFileSync(
      path.join(notesDir, 'Journal- @January 8, 2026.md'),
      '# Marketing Hiring 2026\n\nWe should hire a GTM engineer and designer.',
    );

    const result = searchRecentNotes({
      rootDir,
      startDate: '2025-03-09',
      endDate: '2025-03-16',
      query: 'hiring thoughts',
      terms: ['staffing'],
      limit: 5,
    });

    expect(result.stats.files_scanned).toBe(2);
    expect(result.stats.files_in_range).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toContain('What to do with Paul');
    expect(result.results[0].note_date).toBe('2025-03-12');
    expect(result.results[0].matched_terms).toContain('staffing');
  });

  it('ignores undated notes even if they were modified recently', () => {
    const rootDir = makeTempDir();
    const notesDir = path.join(rootDir, '02 Notes');
    fs.mkdirSync(notesDir, { recursive: true });

    fs.writeFileSync(
      path.join(notesDir, 'Core Data Transfer Tool.md'),
      '# Core Data Transfer Tool\n\nHiring and recruiting appear here but this note is undated.',
    );
    fs.writeFileSync(
      path.join(notesDir, 'Journal- @March 12, 2026.md'),
      '# Staffing\n\nDiscuss with Aengus about hiring.',
    );

    const result = searchRecentNotes({
      rootDir,
      startDate: '2026-03-09',
      endDate: '2026-03-16',
      query: 'hiring',
      terms: ['staffing'],
      limit: 5,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Staffing');
    expect(result.results[0].note_date).toBe('2026-03-12');
  });
});
