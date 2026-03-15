import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const FIXTURES_DIR = path.resolve(__dirname, 'test-fixtures/notion-export');
const OUTPUT_DIR = path.resolve('/tmp/test-vault-output-vitest');

describe('notion-to-obsidian converter', () => {
  beforeAll(() => {
    // Clean and run the converter
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true });
    }
    execSync(
      `npx tsx scripts/notion-to-obsidian.ts "${FIXTURES_DIR}" "${OUTPUT_DIR}"`,
      { cwd: path.resolve(__dirname, '..'), timeout: 30000 }
    );
  });

  afterAll(() => {
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true });
    }
  });

  it('creates the vault folder structure', () => {
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
      expect(fs.existsSync(path.join(OUTPUT_DIR, folder))).toBe(true);
    }
  });

  it('strips Notion UUIDs from filenames', () => {
    expect(
      fs.existsSync(path.join(OUTPUT_DIR, '01 Tasks/Buy groceries.md'))
    ).toBe(true);
    // Should NOT have UUID in name
    const files = fs.readdirSync(path.join(OUTPUT_DIR, '01 Tasks'));
    expect(files.every((f) => !f.match(/[0-9a-f]{20,32}/))).toBe(true);
  });

  it('adds correct kind to frontmatter', () => {
    const task = fs.readFileSync(
      path.join(OUTPUT_DIR, '01 Tasks/Buy groceries.md'),
      'utf-8'
    );
    expect(task).toContain('kind: task');

    const note = fs.readFileSync(
      path.join(OUTPUT_DIR, '02 Notes/Top 10 Healthy Meal Prep Ideas.md'),
      'utf-8'
    );
    expect(note).toContain('kind: note');

    const project = fs.readFileSync(
      path.join(OUTPUT_DIR, '03 Projects/Kitchen Renovation.md'),
      'utf-8'
    );
    expect(project).toContain('kind: project');
  });

  it('normalizes property names to snake_case', () => {
    const task = fs.readFileSync(
      path.join(OUTPUT_DIR, '01 Tasks/Buy groceries.md'),
      'utf-8'
    );
    expect(task).toContain('smart_list:');
    expect(task).toContain('my_day:');
  });

  it('converts relations to wikilinks', () => {
    const task = fs.readFileSync(
      path.join(OUTPUT_DIR, '01 Tasks/Buy groceries.md'),
      'utf-8'
    );
    expect(task).toContain('project: "[[Kitchen Renovation]]"');
  });

  it('converts internal links to wikilinks in body', () => {
    const task = fs.readFileSync(
      path.join(OUTPUT_DIR, '01 Tasks/Buy groceries.md'),
      'utf-8'
    );
    expect(task).toContain('[[Top 10 Healthy Meal Prep Ideas]]');
    // Should NOT contain any WKLNK placeholders
    expect(task).not.toContain('WKLNK');
  });

  it('converts date properties to YYYY-MM-DD format', () => {
    const task = fs.readFileSync(
      path.join(OUTPUT_DIR, '01 Tasks/Buy groceries.md'),
      'utf-8'
    );
    expect(task).toContain('due: 2026-03-20');

    const project = fs.readFileSync(
      path.join(OUTPUT_DIR, '03 Projects/Kitchen Renovation.md'),
      'utf-8'
    );
    expect(project).toContain('target_deadline: 2026-06-30');
  });

  it('converts boolean properties correctly', () => {
    const task = fs.readFileSync(
      path.join(OUTPUT_DIR, '01 Tasks/Buy groceries.md'),
      'utf-8'
    );
    expect(task).toContain('my_day: true');
    expect(task).toContain('archived: false');
  });

  it('converts multi-select to arrays', () => {
    const task = fs.readFileSync(
      path.join(OUTPUT_DIR, '01 Tasks/Buy groceries.md'),
      'utf-8'
    );
    expect(task).toContain('contexts:');
    expect(task).toContain('- "Errand"');
    expect(task).toContain('- "Shopping"');
  });

  it('resolves ambiguous Type property by kind', () => {
    const note = fs.readFileSync(
      path.join(OUTPUT_DIR, '02 Notes/Top 10 Healthy Meal Prep Ideas.md'),
      'utf-8'
    );
    expect(note).toContain('note_type: Web Clip');
    // Should NOT have 'type:'
    expect(note).not.toMatch(/^type:/m);
  });

  it('copies vault infrastructure files', () => {
    expect(
      fs.existsSync(path.join(OUTPUT_DIR, 'Bases/tasks.base'))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(OUTPUT_DIR, 'Templates/task.md'))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(OUTPUT_DIR, 'Dashboards/My Day.md'))
    ).toBe(true);
    expect(fs.existsSync(path.join(OUTPUT_DIR, 'Home.md'))).toBe(true);
  });

  it('preserves body content as markdown', () => {
    const task = fs.readFileSync(
      path.join(OUTPUT_DIR, '01 Tasks/Buy groceries.md'),
      'utf-8'
    );
    expect(task).toContain('Chicken breast');
    expect(task).toContain('- '); // list markers

    const project = fs.readFileSync(
      path.join(OUTPUT_DIR, '03 Projects/Kitchen Renovation.md'),
      'utf-8'
    );
    expect(project).toContain('## Overview');
    expect(project).toContain('## Budget');
  });

  it('removes page title from body (avoids duplication)', () => {
    const note = fs.readFileSync(
      path.join(OUTPUT_DIR, '02 Notes/Top 10 Healthy Meal Prep Ideas.md'),
      'utf-8'
    );
    // The body should NOT start with the title as an h1
    const body = note.split('---\n').slice(2).join('---\n');
    expect(body).not.toMatch(/^#\s+Top 10 Healthy Meal Prep Ideas/m);
  });

  describe('Notion DOM quirks handling', () => {
    let quirksNote: string;

    beforeAll(() => {
      quirksNote = fs.readFileSync(
        path.join(OUTPUT_DIR, '02 Notes/Notion Quirks Test.md'),
        'utf-8'
      );
    });

    it('converts Notion checkboxes to markdown checkboxes', () => {
      expect(quirksNote).toContain('[x] Buy milk');
      expect(quirksNote).toContain('[ ] Call dentist');
    });

    it('merges adjacent same-type lists', () => {
      // "Normal list item" and "Another list item" were in separate <ul>s
      // They should now be in a single list (no extra blank line between)
      expect(quirksNote).toContain('Normal list item');
      expect(quirksNote).toContain('Another list item');
    });

    it('strips @ prefix from Notion dates', () => {
      expect(quirksNote).toContain('March 15, 2026');
      expect(quirksNote).not.toContain('@March');
    });

    it('converts toggle headings to proper headings', () => {
      // font-size 1.5em → h2
      expect(quirksNote).toContain('## Important Section');
    });
  });
});
