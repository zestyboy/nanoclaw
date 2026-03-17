import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  IS_RAILWAY,
  PUBLIC_KNOWLEDGE_DIR,
  QMD_CACHE_DIR,
  SECOND_BRAIN_DIR,
  STATE_LOCKS_DIR,
} from './config.js';
import { logger } from './logger.js';
import {
  loadStateManifest,
  QmdCollectionState,
  setManifestLock,
  STATE_MANIFEST_SCHEMA_VERSION,
  StateManifest,
  writeStateManifest,
} from './state-manifest.js';

export interface QmdCollectionSpec {
  name: 'public-knowledge' | 'second-brain';
  sourcePath: string;
}

export interface QmdVerificationResult {
  manifest: StateManifest;
  repairsApplied: string[];
  issues: string[];
}

const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export const QMD_COLLECTIONS: QmdCollectionSpec[] = [
  { name: 'public-knowledge', sourcePath: PUBLIC_KNOWLEDGE_DIR },
  { name: 'second-brain', sourcePath: SECOND_BRAIN_DIR },
];

function lockPath(collection: string): string {
  return path.join(STATE_LOCKS_DIR, `${collection}.json`);
}

function runQmdCommand(args: string[]): string {
  return execFileSync('qmd', args, {
    cwd: DATA_DIR,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function getQmdVersion(): string {
  return runQmdCommand(['--version']).split('\n')[0] || 'unknown';
}

export function ensureQmdCacheLayout(): string[] {
  const repairs: string[] = [];
  const requiredDirs = [
    QMD_CACHE_DIR,
    path.join(QMD_CACHE_DIR, 'qmd'),
    path.join(QMD_CACHE_DIR, 'qmd', 'models'),
  ];
  for (const dir of requiredDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      repairs.push(`created ${dir}`);
    }
  }
  return repairs;
}

export function computeDerivedStateKey(
  collection: string,
  sourcePath: string,
  qmdVersion: string,
): string {
  return [
    collection,
    sourcePath,
    qmdVersion,
    `manifest-v${STATE_MANIFEST_SCHEMA_VERSION}`,
  ].join('|');
}

function ensureCollectionRegistered(spec: QmdCollectionSpec): void {
  try {
    runQmdCommand(['collection', 'remove', spec.name]);
  } catch {
    /* not registered yet */
  }
  runQmdCommand(['collection', 'add', spec.name, spec.sourcePath]);
}

function hasModels(): boolean {
  const modelsDir = path.join(QMD_CACHE_DIR, 'qmd', 'models');
  return (
    fs.existsSync(modelsDir) &&
    fs.readdirSync(modelsDir).some((entry) => !entry.startsWith('.'))
  );
}

function collectionBucket(collection: string): string {
  if (collection === 'public-knowledge') {
    return process.env.R2_PUBLIC_KNOWLEDGE_BUCKET || '';
  }
  if (collection === 'second-brain') {
    return process.env.R2_SECOND_BRAIN_BUCKET || '';
  }
  return '';
}

function syncCollectionToR2(spec: QmdCollectionSpec): void {
  const bucket = collectionBucket(spec.name);
  if (!IS_RAILWAY || !bucket) return;
  execFileSync(
    'rclone',
    [
      'sync',
      spec.sourcePath,
      `r2:${bucket}`,
      '--exclude',
      '.remotely-save/**',
      '--exclude',
      '.qmd/**',
      '--exclude',
      '.obsidian/**',
      '--exclude',
      '.silverbullet/**',
    ],
    {
      cwd: DATA_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function acquireLock(collection: string): {
  acquired: boolean;
  stale: boolean;
} {
  fs.mkdirSync(STATE_LOCKS_DIR, { recursive: true });
  const file = lockPath(collection);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        updatedAt?: string;
      };
      const updatedAt = data.updatedAt ? Date.parse(data.updatedAt) : 0;
      if (updatedAt && Date.now() - updatedAt < LOCK_STALE_MS) {
        return { acquired: false, stale: false };
      }
    } catch {
      // Stale or corrupt lock, overwrite it below.
    }
  }

  const updatedAt = new Date().toISOString();
  fs.writeFileSync(
    file,
    JSON.stringify({ collection, updatedAt, pid: process.pid }, null, 2),
  );
  setManifestLock(collection, {
    type: 'qmd-reindex',
    status: 'running',
    updatedAt,
  });
  return { acquired: true, stale: false };
}

function releaseLock(collection: string): void {
  try {
    fs.unlinkSync(lockPath(collection));
  } catch {
    /* already gone */
  }
  setManifestLock(collection, null);
}

function collectionState(
  manifest: StateManifest,
  spec: QmdCollectionSpec,
): QmdCollectionState {
  return (
    manifest.qmd.collections[spec.name] || {
      collection: spec.name,
      sourcePath: spec.sourcePath,
      path: path.join(QMD_CACHE_DIR, spec.name),
      status: 'missing',
    }
  );
}

export async function runQmdReindex(
  collection: QmdCollectionSpec['name'],
  reason: string,
): Promise<void> {
  const spec = QMD_COLLECTIONS.find((entry) => entry.name === collection);
  if (!spec) {
    throw new Error(`Unknown qmd collection: ${collection}`);
  }
  if (!spec.sourcePath || !fs.existsSync(spec.sourcePath)) {
    throw new Error(`Collection source path not available: ${spec.sourcePath}`);
  }

  const lock = acquireLock(collection);
  if (!lock.acquired) {
    logger.info({ collection }, 'QMD reindex already in progress, skipping');
    return;
  }

  try {
    const manifest = loadStateManifest();
    const qmdVersion = getQmdVersion();
    const derivedStateKey = computeDerivedStateKey(
      collection,
      spec.sourcePath,
      qmdVersion,
    );

    manifest.qmd.toolVersion = qmdVersion;
    manifest.qmd.collections[collection] = {
      ...collectionState(manifest, spec),
      collection,
      sourcePath: spec.sourcePath,
      status: 'rebuilding',
      checkedAt: new Date().toISOString(),
      detail: reason,
      toolVersion: qmdVersion,
      derivedStateKey,
    };
    writeStateManifest(manifest);

    ensureCollectionRegistered(spec);
    runQmdCommand(['update', '-c', collection]);
    runQmdCommand(['embed', '-c', collection]);
    syncCollectionToR2(spec);

    const nextManifest = loadStateManifest();
    nextManifest.qmd.toolVersion = qmdVersion;
    nextManifest.qmd.collections[collection] = {
      ...collectionState(nextManifest, spec),
      collection,
      sourcePath: spec.sourcePath,
      status: 'valid',
      checkedAt: new Date().toISOString(),
      detail: reason,
      toolVersion: qmdVersion,
      derivedStateKey,
      lastUpdateAt: new Date().toISOString(),
      lastEmbedAt: new Date().toISOString(),
    };
    writeStateManifest(nextManifest);
  } finally {
    releaseLock(collection);
  }
}

export async function verifyQmdCollections(options?: {
  repair?: boolean;
}): Promise<QmdVerificationResult> {
  const repair = options?.repair === true;
  const manifest = loadStateManifest();
  const repairsApplied = ensureQmdCacheLayout();
  const issues: string[] = [];

  let qmdVersion = 'unknown';
  try {
    qmdVersion = getQmdVersion();
    manifest.qmd.toolVersion = qmdVersion;
  } catch (err) {
    issues.push(
      `qmd unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    for (const spec of QMD_COLLECTIONS) {
      manifest.qmd.collections[spec.name] = {
        ...collectionState(manifest, spec),
        collection: spec.name,
        sourcePath: spec.sourcePath,
        status: 'failed',
        checkedAt: new Date().toISOString(),
        detail: 'qmd executable is not available',
      };
    }
    writeStateManifest(manifest);
    return { manifest, repairsApplied, issues };
  }

  for (const spec of QMD_COLLECTIONS) {
    const sourceExists = !!spec.sourcePath && fs.existsSync(spec.sourcePath);
    const expectedKey = computeDerivedStateKey(
      spec.name,
      spec.sourcePath,
      qmdVersion,
    );
    const current = collectionState(manifest, spec);

    if (!sourceExists) {
      manifest.qmd.collections[spec.name] = {
        ...current,
        collection: spec.name,
        sourcePath: spec.sourcePath,
        status: 'missing',
        checkedAt: new Date().toISOString(),
        detail: `source path unavailable: ${spec.sourcePath}`,
        toolVersion: qmdVersion,
        derivedStateKey: expectedKey,
      };
      issues.push(`${spec.name} source path unavailable`);
      continue;
    }

    ensureCollectionRegistered(spec);

    const missingDerivedState =
      !hasModels() ||
      !current.lastUpdateAt ||
      !current.lastEmbedAt ||
      current.derivedStateKey !== expectedKey;

    if (missingDerivedState) {
      manifest.qmd.collections[spec.name] = {
        ...current,
        collection: spec.name,
        sourcePath: spec.sourcePath,
        status: 'stale',
        checkedAt: new Date().toISOString(),
        detail: 'derived state missing or outdated',
        toolVersion: qmdVersion,
        derivedStateKey: expectedKey,
      };
      issues.push(`${spec.name} derived state is stale`);
      if (repair) {
        await runQmdReindex(spec.name, 'boot verification');
        repairsApplied.push(`reindexed ${spec.name}`);
        manifest.qmd.collections[spec.name] =
          loadStateManifest().qmd.collections[spec.name];
      }
      continue;
    }

    manifest.qmd.collections[spec.name] = {
      ...current,
      collection: spec.name,
      sourcePath: spec.sourcePath,
      status: 'valid',
      checkedAt: new Date().toISOString(),
      detail: 'qmd collection verified',
      toolVersion: qmdVersion,
      derivedStateKey: expectedKey,
    };
  }

  writeStateManifest(manifest);
  return { manifest: loadStateManifest(), repairsApplied, issues };
}

export function scheduleQmdReindex(
  collection: QmdCollectionSpec['name'],
  reason: string,
): void {
  void runQmdReindex(collection, reason).catch((err) => {
    logger.error(
      { err, collection, reason },
      'QMD reindex failed in background task',
    );
  });
}
