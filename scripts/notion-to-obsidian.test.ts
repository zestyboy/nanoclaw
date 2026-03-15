import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  convert,
  decodeFilesystemName,
  listDatabases,
  stripNotionUuid,
} from './notion-to-obsidian';

const FIXTURES_DIR = path.resolve(__dirname, 'test-fixtures/notion-export');
const OUTPUT_DIR = path.resolve('/tmp/test-vault-output-vitest');

function writeFile(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('notion-to-obsidian converter', () => {
  beforeAll(async () => {
    // Clean and run the converter
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true });
    }
    await convert(FIXTURES_DIR, OUTPUT_DIR);
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

describe('filename decoding', () => {
  it('preserves UTF-8 names', () => {
    expect(decodeFilesystemName(Buffer.from('Niven’s Notes', 'utf8'))).toBe(
      'Niven’s Notes'
    );
  });

  it('decodes Windows-1252 smart quotes', () => {
    const raw = Buffer.from([
      0x4e, 0x69, 0x76, 0x65, 0x6e, 0x92, 0x73, 0x20, 0x4e, 0x6f, 0x74, 0x65,
      0x73,
    ]);
    expect(decodeFilesystemName(raw)).toBe('Niven’s Notes');
  });

  it('still strips Notion UUIDs after decoding', () => {
    const raw = Buffer.from([
      0x4e, 0x69, 0x76, 0x65, 0x6e, 0x92, 0x73, 0x20, 0x4e, 0x6f, 0x74, 0x65,
      0x73, 0x20, 0x61, 0x62, 0x63, 0x31, 0x32, 0x33, 0x64, 0x65, 0x66, 0x34,
      0x35, 0x36, 0x37, 0x38, 0x39, 0x30, 0x31, 0x32, 0x33, 0x34,
    ]);
    expect(stripNotionUuid(decodeFilesystemName(raw))).toBe('Niven’s Notes');
  });
});

describe('source path resolution', () => {
  let tempRoot: string;

  afterAll(() => {
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves logical relative paths for attachments', async () => {
    tempRoot = makeTempDir('notion-export-');
    const exportDir = path.join(tempRoot, 'export');
    const outputDir = path.join(tempRoot, 'output');
    const notesDir = path.join(exportDir, 'Notes abc123def456789012345678901234');

    writeFile(
      path.join(notesDir, 'Photo Note abc123def456789012345678901235.html'),
      `<!doctype html><html><head><title>Photo Note</title></head><body class="page-body"><img src="assets/photo.png" /></body></html>`
    );
    writeFile(path.join(notesDir, 'assets/photo.png'), Buffer.from('png'));

    await convert(exportDir, outputDir);

    expect(
      fs.existsSync(path.join(outputDir, 'Attachments/Notes/assets/photo.png'))
    ).toBe(true);
    const note = fs.readFileSync(
      path.join(outputDir, '02 Notes/Photo Note.md'),
      'utf-8'
    );
    expect(note).toContain('![[Attachments/Notes/assets/photo.png]]');
  });

  it('rewrites URL-encoded image filenames to Obsidian embeds', async () => {
    tempRoot = makeTempDir('notion-export-');
    const exportDir = path.join(tempRoot, 'export');
    const outputDir = path.join(tempRoot, 'output');
    const notesDir = path.join(exportDir, 'Notes abc123def456789012345678901234');

    writeFile(
      path.join(notesDir, 'Encoded Image abc123def456789012345678901236.html'),
      `<!doctype html><html><head><title>Encoded Image</title></head><body class="page-body"><img src="assets/Photo%20One%20abc123def456789012345678901237.png" /></body></html>`
    );
    writeFile(
      path.join(
        notesDir,
        'assets/Photo One abc123def456789012345678901237.png'
      ),
      Buffer.from('png')
    );

    await convert(exportDir, outputDir);

    expect(
      fs.existsSync(
        path.join(outputDir, 'Attachments/Notes/assets/Photo One.png')
      )
    ).toBe(true);
    const note = fs.readFileSync(
      path.join(outputDir, '02 Notes/Encoded Image.md'),
      'utf-8'
    );
    expect(note).toContain('![[Attachments/Notes/assets/Photo One.png]]');
  });

  it('rewrites local file links to Obsidian wikilinks with labels', async () => {
    tempRoot = makeTempDir('notion-export-');
    const exportDir = path.join(tempRoot, 'export');
    const outputDir = path.join(tempRoot, 'output');
    const notesDir = path.join(exportDir, 'Notes abc123def456789012345678901234');

    writeFile(
      path.join(notesDir, 'Guide Link abc123def456789012345678901236.html'),
      `<!doctype html><html><head><title>Guide Link</title></head><body class="page-body"><p><a href="files/Guide%20abc123def456789012345678901237.pdf">Quarterly guide</a></p></body></html>`
    );
    writeFile(
      path.join(notesDir, 'files/Guide abc123def456789012345678901237.pdf'),
      Buffer.from('pdf')
    );

    await convert(exportDir, outputDir);

    expect(
      fs.existsSync(path.join(outputDir, 'Attachments/Notes/files/Guide.pdf'))
    ).toBe(true);
    const note = fs.readFileSync(
      path.join(outputDir, '02 Notes/Guide Link.md'),
      'utf-8'
    );
    expect(note).toContain(
      '[[Attachments/Notes/files/Guide.pdf|Quarterly guide]]'
    );
  });

  it('handles smart-quote attachment filenames', async () => {
    tempRoot = makeTempDir('notion-export-');
    const exportDir = path.join(tempRoot, 'export');
    const outputDir = path.join(tempRoot, 'output');
    const notesDir = path.join(exportDir, 'Notes abc123def456789012345678901234');

    writeFile(
      path.join(notesDir, 'Smart Quote abc123def456789012345678901236.html'),
      `<!doctype html><html><head><title>Smart Quote</title></head><body class="page-body"><img src="assets/Niven%E2%80%99s%20Photo%20abc123def456789012345678901234.png" /></body></html>`
    );
    writeFile(
      path.join(
        notesDir,
        'assets/Niven’s Photo abc123def456789012345678901234.png'
      ),
      Buffer.from('png')
    );

    await convert(exportDir, outputDir);

    expect(
      fs.existsSync(
        path.join(outputDir, 'Attachments/Notes/assets/Niven’s Photo.png')
      )
    ).toBe(true);
    const note = fs.readFileSync(
      path.join(outputDir, '02 Notes/Smart Quote.md'),
      'utf-8'
    );
    expect(note).toContain('![[Attachments/Notes/assets/Niven’s Photo.png]]');
  });

  it('preserves subpaths for duplicate cleaned basenames', async () => {
    tempRoot = makeTempDir('notion-export-');
    const exportDir = path.join(tempRoot, 'export');
    const outputDir = path.join(tempRoot, 'output');
    const notesDir = path.join(exportDir, 'Notes abc123def456789012345678901234');

    writeFile(
      path.join(notesDir, 'First Photo abc123def456789012345678901236.html'),
      `<!doctype html><html><head><title>First Photo</title></head><body class="page-body"><img src="assets/photo abc123def456789012345678901237.png" /></body></html>`
    );
    writeFile(
      path.join(notesDir, 'Second Photo abc123def456789012345678901238.html'),
      `<!doctype html><html><head><title>Second Photo</title></head><body class="page-body"><img src="other/photo deadbeefdeadbeefdeadbeefdeadbeef.png" /></body></html>`
    );
    writeFile(
      path.join(notesDir, 'assets/photo abc123def456789012345678901237.png'),
      Buffer.from('png-one')
    );
    writeFile(
      path.join(notesDir, 'other/photo deadbeefdeadbeefdeadbeefdeadbeef.png'),
      Buffer.from('png-two')
    );

    await convert(exportDir, outputDir);

    expect(
      fs.existsSync(path.join(outputDir, 'Attachments/Notes/assets/photo.png'))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(outputDir, 'Attachments/Notes/other/photo.png'))
    ).toBe(true);
  });

  it('adds a deterministic hash suffix when cleaned paths still collide', async () => {
    tempRoot = makeTempDir('notion-export-');
    const exportDir = path.join(tempRoot, 'export');
    const outputDir = path.join(tempRoot, 'output');
    const notesDir = path.join(exportDir, 'Notes abc123def456789012345678901234');

    writeFile(
      path.join(notesDir, 'Collision One abc123def456789012345678901236.html'),
      `<!doctype html><html><head><title>Collision One</title></head><body class="page-body"><img src="assets abc123def456789012345678901237/photo abc123def456789012345678901238.png" /></body></html>`
    );
    writeFile(
      path.join(notesDir, 'Collision Two abc123def456789012345678901239.html'),
      `<!doctype html><html><head><title>Collision Two</title></head><body class="page-body"><img src="assets/photo deadbeefdeadbeefdeadbeefdeadbeef.png" /></body></html>`
    );
    writeFile(
      path.join(
        notesDir,
        'assets abc123def456789012345678901237/photo abc123def456789012345678901238.png'
      ),
      Buffer.from('png-one')
    );
    writeFile(
      path.join(notesDir, 'assets/photo deadbeefdeadbeefdeadbeefdeadbeef.png'),
      Buffer.from('png-two')
    );

    await convert(exportDir, outputDir);

    const attachmentFiles = fs.readdirSync(
      path.join(outputDir, 'Attachments/Notes/assets')
    );
    expect(attachmentFiles).toContain('photo.png');
    expect(attachmentFiles.some((file) => /^photo-[0-9a-f]{8}\.png$/.test(file))).toBe(
      true
    );
  });

  it('only falls back to basename lookup when the basename is unique', async () => {
    tempRoot = makeTempDir('notion-export-');
    const exportDir = path.join(tempRoot, 'export');
    const outputDir = path.join(tempRoot, 'output');
    const notesDir = path.join(exportDir, 'Notes abc123def456789012345678901234');

    writeFile(
      path.join(notesDir, 'Ambiguous Photo abc123def456789012345678901236.html'),
      `<!doctype html><html><head><title>Ambiguous Photo</title></head><body class="page-body"><img src="photo.png" /></body></html>`
    );
    writeFile(path.join(notesDir, 'assets/photo.png'), Buffer.from('png-one'));
    writeFile(path.join(notesDir, 'other/photo.png'), Buffer.from('png-two'));

    await convert(exportDir, outputDir);

    expect(
      fs.existsSync(path.join(outputDir, 'Attachments/photo.png'))
    ).toBe(false);
    const note = fs.readFileSync(
      path.join(outputDir, '02 Notes/Ambiguous Photo.md'),
      'utf-8'
    );
    expect(note).not.toContain('Attachments/photo.png');
    expect(note).toContain('![](photo.png)');
  });
});

describe('single database mode', () => {
  let tempRoot: string;

  afterAll(() => {
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('appends duplicate titles safely across separate conversion runs', async () => {
    tempRoot = makeTempDir('notion-export-single-db-');
    const exportDir = path.join(tempRoot, 'export');
    const outputDir = path.join(tempRoot, 'output');
    const notesDirA = path.join(
      exportDir,
      'Reference Notes A abc123def456789012345678901234'
    );
    const notesDirB = path.join(
      exportDir,
      'Reference Notes B abc123def456789012345678901235'
    );

    writeFile(
      path.join(notesDirA, 'Shared Title abc123def456789012345678901236.html'),
      '<!doctype html><html><head><title>Shared Title</title></head><body class="page-body"><p>From notes</p></body></html>'
    );
    writeFile(
      path.join(notesDirB, 'Shared Title abc123def456789012345678901237.html'),
      '<!doctype html><html><head><title>Shared Title</title></head><body class="page-body"><p>From other notes</p></body></html>'
    );

    const databases = listDatabases(exportDir);
    expect(databases).toHaveLength(2);
    const firstPath = databases.find((db) =>
      db.logicalPath.includes('Reference Notes A')
    )?.logicalPath;
    const secondPath = databases.find((db) =>
      db.logicalPath.includes('Reference Notes B')
    )?.logicalPath;
    expect(firstPath).toBeTruthy();
    expect(secondPath).toBeTruthy();

    await convert(exportDir, outputDir, {
      databaseLogicalPath: firstPath!,
      copyInfrastructure: false,
    });
    await convert(exportDir, outputDir, {
      databaseLogicalPath: secondPath!,
      copyInfrastructure: false,
    });

    expect(
      fs.existsSync(path.join(outputDir, '02 Notes/Shared Title.md'))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(outputDir, '02 Notes/Shared Title (2).md'))
    ).toBe(true);
  });

  it('appends attachments safely across separate conversion runs', async () => {
    tempRoot = makeTempDir('notion-export-single-db-');
    const exportDir = path.join(tempRoot, 'export');
    const outputDir = path.join(tempRoot, 'output');
    const notesDirA = path.join(
      exportDir,
      'Reference Notes A abc123def456789012345678901234'
    );
    const notesDirB = path.join(
      exportDir,
      'Reference Notes B abc123def456789012345678901235'
    );

    writeFile(
      path.join(notesDirA, 'Alpha abc123def456789012345678901236.html'),
      '<!doctype html><html><head><title>Alpha</title></head><body class="page-body"><img src="assets/photo abc123def456789012345678901237.png" /></body></html>'
    );
    writeFile(
      path.join(notesDirB, 'Beta abc123def456789012345678901238.html'),
      '<!doctype html><html><head><title>Beta</title></head><body class="page-body"><img src="assets/photo abc123def456789012345678901239.png" /></body></html>'
    );
    writeFile(
      path.join(notesDirA, 'assets/photo abc123def456789012345678901237.png'),
      Buffer.from('png-one')
    );
    writeFile(
      path.join(notesDirB, 'assets/photo abc123def456789012345678901239.png'),
      Buffer.from('png-two')
    );

    const databases = listDatabases(exportDir);
    const firstPath = databases.find((db) =>
      db.logicalPath.includes('Reference Notes A')
    )?.logicalPath;
    const secondPath = databases.find((db) =>
      db.logicalPath.includes('Reference Notes B')
    )?.logicalPath;

    await convert(exportDir, outputDir, {
      databaseLogicalPath: firstPath!,
      copyInfrastructure: false,
    });
    await convert(exportDir, outputDir, {
      databaseLogicalPath: secondPath!,
      copyInfrastructure: false,
    });

    const attachmentRoot = path.join(outputDir, 'Attachments');
    expect(
      fs.existsSync(path.join(attachmentRoot, 'Reference Notes A/assets/photo.png'))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(attachmentRoot, 'Reference Notes B/assets/photo.png'))
    ).toBe(true);
  });
});
