import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-verify-state-'));
  fs.mkdirSync(path.join(tempDir, 'public-knowledge'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'second-brain'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'qmd-cache'), { recursive: true });
  vi.resetModules();
  vi.doMock('./config.js', () => ({
    DATA_DIR: tempDir,
    GROUPS_DIR: path.join(tempDir, 'groups'),
    IS_RAILWAY: false,
    PROJECTS_DIR: path.join(tempDir, 'projects'),
    PUBLIC_KNOWLEDGE_DIR: path.join(tempDir, 'public-knowledge'),
    QMD_CACHE_DIR: path.join(tempDir, 'qmd-cache'),
    SECOND_BRAIN_DIR: path.join(tempDir, 'second-brain'),
    STATE_DIR: path.join(tempDir, 'state'),
    STATE_LOCKS_DIR: path.join(tempDir, 'state', 'locks'),
    STATE_MANIFEST_PATH: path.join(tempDir, 'state', 'state-manifest.json'),
    STATE_VERIFY_ENFORCE: false,
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
  vi.doMock('./db.js', () => ({
    ensureDatabaseFile: vi.fn(() => {
      const dbPath = path.join(tempDir, 'store', 'messages.db');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, '');
    }),
    getDatabasePath: vi.fn(() => path.join(tempDir, 'store', 'messages.db')),
  }));
  vi.doMock('./qmd-state.js', () => ({
    ensureQmdCacheLayout: vi.fn(() => []),
    verifyQmdCollections: vi.fn(async () => {
      const { loadStateManifest } = await import('./state-manifest.js');
      const manifest = loadStateManifest();
      manifest.qmd.collections['public-knowledge'] = {
        collection: 'public-knowledge',
        sourcePath: path.join(tempDir, 'public-knowledge'),
        path: path.join(tempDir, 'qmd-cache', 'public-knowledge'),
        status: 'valid',
      };
      manifest.qmd.collections['second-brain'] = {
        collection: 'second-brain',
        sourcePath: path.join(tempDir, 'second-brain'),
        path: path.join(tempDir, 'qmd-cache', 'second-brain'),
        status: 'valid',
      };
      return { manifest, repairsApplied: [], issues: [] };
    }),
  }));
  vi.doMock('./state-backup.js', () => ({
    restoreCanonicalStateIfNeeded: vi.fn(async () => false),
    scheduleCanonicalSnapshot: vi.fn(),
  }));
});

afterEach(() => {
  vi.doUnmock('./config.js');
  vi.doUnmock('./logger.js');
  vi.doUnmock('./db.js');
  vi.doUnmock('./qmd-state.js');
  vi.doUnmock('./state-backup.js');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('verify-railway-state', () => {
  it('reports a missing manifest as repairable in report-only mode', async () => {
    const { verifyRailwayState } = await import('./verify-railway-state.js');

    const result = await verifyRailwayState({
      mode: 'manual',
      repair: false,
    });

    expect(result.status).toBe('repairable');
    expect(result.checks.some((check) => check.name === 'state-manifest')).toBe(
      true,
    );
  });
});
