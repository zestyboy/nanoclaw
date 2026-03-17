import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;
const execFileSync = vi.fn((cmd: string, args: string[]) => {
  if (cmd === 'qmd' && args[0] === '--version') return 'qmd 1.0.0';
  return '';
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-state-'));
  fs.mkdirSync(path.join(tempDir, 'public-knowledge'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'second-brain'), { recursive: true });
  vi.resetModules();
  vi.doMock('./config.js', () => ({
    DATA_DIR: tempDir,
    IS_RAILWAY: false,
    PUBLIC_KNOWLEDGE_DIR: path.join(tempDir, 'public-knowledge'),
    QMD_CACHE_DIR: path.join(tempDir, 'qmd-cache'),
    SECOND_BRAIN_DIR: path.join(tempDir, 'second-brain'),
    STATE_DIR: path.join(tempDir, 'state'),
    STATE_LOCKS_DIR: path.join(tempDir, 'state', 'locks'),
    STATE_MANIFEST_PATH: path.join(tempDir, 'state', 'state-manifest.json'),
    STORE_DIR: path.join(tempDir, 'store'),
  }));
  vi.doMock('./logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));
  vi.doMock('child_process', () => ({
    execFileSync,
  }));
});

afterEach(() => {
  vi.doUnmock('./config.js');
  vi.doUnmock('./logger.js');
  vi.doUnmock('child_process');
  fs.rmSync(tempDir, { recursive: true, force: true });
  execFileSync.mockClear();
});

describe('qmd-state', () => {
  it('marks collections stale when derived state is missing', async () => {
    const { verifyQmdCollections } = await import('./qmd-state.js');

    const result = await verifyQmdCollections({ repair: false });

    expect(result.manifest.qmd.collections['public-knowledge'].status).toBe(
      'stale',
    );
    expect(result.manifest.qmd.collections['second-brain'].status).toBe(
      'stale',
    );
  });

  it('reindexes stale collections when repair is enabled', async () => {
    const { verifyQmdCollections } = await import('./qmd-state.js');

    const result = await verifyQmdCollections({ repair: true });

    expect(result.repairsApplied).toContain('reindexed public-knowledge');
    expect(result.repairsApplied).toContain('reindexed second-brain');
    expect(result.manifest.qmd.collections['public-knowledge'].status).toBe(
      'valid',
    );
    expect(result.manifest.qmd.collections['second-brain'].status).toBe(
      'valid',
    );
  });
});
