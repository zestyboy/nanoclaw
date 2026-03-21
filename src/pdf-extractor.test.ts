import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const groupDirRef = vi.hoisted(() => ({ current: '' }));

vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/groups',
  NANOCLAW_PDF_EXTRACT_MAX_CHARS: 80,
  PUBLIC_KNOWLEDGE_DIR: '',
  PROJECTS_DIR: '/tmp/projects',
  SECOND_BRAIN_DIR: '',
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => groupDirRef.current),
}));

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

import { extractPdfText } from './pdf-extractor.js';

describe('pdf-extractor', () => {
  beforeEach(() => {
    groupDirRef.current = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-pdf-extractor-'),
    );
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === 'pdftotext') {
        return 'Extracted text from pdf '.repeat(20);
      }
      if (command === 'pdfinfo') {
        return 'Pages:          7\n';
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  afterEach(() => {
    if (groupDirRef.current) {
      fs.rmSync(groupDirRef.current, { recursive: true, force: true });
      groupDirRef.current = '';
    }
  });

  it('extracts pdf text into a cached sidecar file', () => {
    const attachmentDir = path.join(groupDirRef.current, 'attachments', 'msg-1');
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentDir, 'report.pdf'), 'pdf-bytes');

    const first = extractPdfText({
      sourceGroup: 'project:test',
      sourcePath: '/workspace/group/attachments/msg-1/report.pdf',
      isElevated: false,
    });

    const second = extractPdfText({
      sourceGroup: 'project:test',
      sourcePath: '/workspace/group/attachments/msg-1/report.pdf',
      isElevated: false,
    });

    expect(first.pageCount).toBe(7);
    expect(first.characterCount).toBeGreaterThan(80);
    expect(first.extractedTextPath).toContain('/workspace/group/.nanoclaw/pdf-extract/');
    expect(first.excerpt.length).toBeLessThanOrEqual(80);
    expect(second.extractedTextPath).toBe(first.extractedTextPath);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'pdftotext',
      expect.any(Array),
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(
      execFileSyncMock.mock.calls.filter(([command]) => command === 'pdftotext'),
    ).toHaveLength(1);
  });

  it('marks sparse pdf extraction as scan candidate', () => {
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === 'pdftotext') return 'short';
      if (command === 'pdfinfo') return 'Pages:          1\n';
      throw new Error(`Unexpected command: ${command}`);
    });

    const attachmentDir = path.join(groupDirRef.current, 'attachments', 'msg-2');
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentDir, 'scan.pdf'), 'pdf-bytes');

    const result = extractPdfText({
      sourceGroup: 'project:test',
      sourcePath: '/workspace/group/attachments/msg-2/scan.pdf',
      isElevated: false,
    });

    expect(result.scanCandidate).toBe(true);
    expect(result.ocrAvailable).toBe(false);
  });

  it('accepts visible host paths for railway-style workspaces', () => {
    const attachmentDir = path.join(groupDirRef.current, 'attachments', 'msg-3');
    fs.mkdirSync(attachmentDir, { recursive: true });
    const hostPdfPath = path.join(attachmentDir, 'railway.pdf');
    fs.writeFileSync(hostPdfPath, 'pdf-bytes');

    const result = extractPdfText({
      sourceGroup: 'project:test',
      sourcePath: hostPdfPath,
      isElevated: false,
    });

    expect(result.sourcePath).toBe(hostPdfPath);
    expect(result.extractedTextPath).toMatch(/\.nanoclaw\/pdf-extract\/.*\.txt$/);
  });
});
