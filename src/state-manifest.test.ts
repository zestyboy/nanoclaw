import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-state-manifest-'));
  vi.resetModules();
  vi.doMock('./config.js', () => ({
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
});

afterEach(() => {
  vi.doUnmock('./config.js');
  vi.doUnmock('./logger.js');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('state-manifest', () => {
  it('synthesizes a manifest when none exists yet', async () => {
    fs.mkdirSync(path.join(tempDir, 'public-knowledge'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'second-brain'), { recursive: true });

    const mod = await import('./state-manifest.js');
    const manifest = mod.loadStateManifest();

    expect(manifest.schemaVersion).toBe(mod.STATE_MANIFEST_SCHEMA_VERSION);
    expect(manifest.database.status).toBe('missing');
    expect(manifest.vaults['public-knowledge'].status).toBe('valid');
    expect(manifest.vaults['second-brain'].status).toBe('valid');
  });

  it('writes and normalizes persisted manifests', async () => {
    const mod = await import('./state-manifest.js');
    const manifest = mod.createStateManifest();
    manifest.database.status = 'valid';
    manifest.qmd.collections['public-knowledge'] = {
      collection: 'public-knowledge',
      sourcePath: path.join(tempDir, 'public-knowledge'),
      path: path.join(tempDir, 'qmd-cache', 'public-knowledge'),
      status: 'valid',
      derivedStateKey: 'abc',
    };

    mod.writeStateManifest(manifest);
    const persisted = mod.readStateManifest();

    expect(persisted).toBeDefined();
    expect(persisted?.database.status).toBe('valid');
    expect(persisted?.qmd.collections['public-knowledge'].derivedStateKey).toBe(
      'abc',
    );
  });
});
