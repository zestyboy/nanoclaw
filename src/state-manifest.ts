import fs from 'fs';
import path from 'path';

import {
  PUBLIC_KNOWLEDGE_DIR,
  QMD_CACHE_DIR,
  SECOND_BRAIN_DIR,
  STATE_DIR,
  STATE_LOCKS_DIR,
  STATE_MANIFEST_PATH,
  STORE_DIR,
} from './config.js';
import { logger } from './logger.js';

export const STATE_MANIFEST_SCHEMA_VERSION = 1;

export type StateStatus =
  | 'valid'
  | 'missing'
  | 'stale'
  | 'rebuilding'
  | 'failed';

export interface StatePathStatus {
  path: string;
  status: StateStatus;
  detail?: string;
  checkedAt?: string;
}

export interface QmdCollectionState extends StatePathStatus {
  collection: string;
  sourcePath: string;
  toolVersion?: string;
  derivedStateKey?: string;
  lastUpdateAt?: string;
  lastEmbedAt?: string;
}

export interface StateSnapshotMetadata {
  id: string;
  createdAt: string;
  reason: string;
  appVersion: string;
  manifestSchemaVersion: number;
  dbObject: string;
  archiveObject: string;
}

export interface StateLockState {
  type: 'qmd-reindex' | 'snapshot';
  status: 'running' | 'stale';
  updatedAt: string;
  detail?: string;
}

export interface StateManifest {
  schemaVersion: number;
  appVersion: string;
  lastVerifiedAt?: string;
  lastVerifiedMode?: 'boot' | 'manual';
  database: StatePathStatus;
  vaults: Record<string, StatePathStatus>;
  qmd: {
    cachePath: string;
    toolVersion?: string;
    collections: Record<string, QmdCollectionState>;
  };
  snapshots: {
    lastSuccessful?: StateSnapshotMetadata;
  };
  locks: Record<string, StateLockState>;
}

function readAppVersion(): string {
  const packagePath = path.resolve(process.cwd(), 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as {
      version?: string;
    };
    return pkg.version || 'dev';
  } catch (err) {
    logger.debug({ err, packagePath }, 'Unable to read package version');
    return 'dev';
  }
}

export function createStateManifest(): StateManifest {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  return {
    schemaVersion: STATE_MANIFEST_SCHEMA_VERSION,
    appVersion: readAppVersion(),
    database: {
      path: dbPath,
      status: fs.existsSync(dbPath) ? 'valid' : 'missing',
    },
    vaults: {
      'public-knowledge': {
        path: PUBLIC_KNOWLEDGE_DIR,
        status:
          PUBLIC_KNOWLEDGE_DIR && fs.existsSync(PUBLIC_KNOWLEDGE_DIR)
            ? 'valid'
            : 'missing',
      },
      'second-brain': {
        path: SECOND_BRAIN_DIR,
        status:
          SECOND_BRAIN_DIR && fs.existsSync(SECOND_BRAIN_DIR)
            ? 'valid'
            : 'missing',
      },
    },
    qmd: {
      cachePath: QMD_CACHE_DIR,
      collections: {},
    },
    snapshots: {},
    locks: {},
  };
}

function normalizePathStatus(
  fallbackPath: string,
  value: Partial<StatePathStatus> | undefined,
): StatePathStatus {
  return {
    path: value?.path || fallbackPath,
    status: value?.status || 'missing',
    detail: value?.detail,
    checkedAt: value?.checkedAt,
  };
}

function normalizeCollectionState(
  collection: string,
  sourcePath: string,
  value: Partial<QmdCollectionState> | undefined,
): QmdCollectionState {
  return {
    collection,
    sourcePath,
    path: value?.path || path.join(QMD_CACHE_DIR, collection),
    status: value?.status || 'missing',
    detail: value?.detail,
    checkedAt: value?.checkedAt,
    toolVersion: value?.toolVersion,
    derivedStateKey: value?.derivedStateKey,
    lastUpdateAt: value?.lastUpdateAt,
    lastEmbedAt: value?.lastEmbedAt,
  };
}

export function normalizeStateManifest(
  value: Partial<StateManifest> | undefined,
): StateManifest {
  const base = createStateManifest();
  const collections = value?.qmd?.collections || {};
  return {
    schemaVersion:
      value?.schemaVersion && value.schemaVersion > 0
        ? value.schemaVersion
        : STATE_MANIFEST_SCHEMA_VERSION,
    appVersion: value?.appVersion || base.appVersion,
    lastVerifiedAt: value?.lastVerifiedAt,
    lastVerifiedMode: value?.lastVerifiedMode,
    database: normalizePathStatus(base.database.path, value?.database),
    vaults: {
      'public-knowledge': normalizePathStatus(
        base.vaults['public-knowledge'].path,
        value?.vaults?.['public-knowledge'],
      ),
      'second-brain': normalizePathStatus(
        base.vaults['second-brain'].path,
        value?.vaults?.['second-brain'],
      ),
    },
    qmd: {
      cachePath: value?.qmd?.cachePath || base.qmd.cachePath,
      toolVersion: value?.qmd?.toolVersion,
      collections: Object.fromEntries(
        Object.entries(collections).map(([collection, state]) => [
          collection,
          normalizeCollectionState(
            collection,
            collection === 'public-knowledge'
              ? PUBLIC_KNOWLEDGE_DIR
              : SECOND_BRAIN_DIR,
            state,
          ),
        ]),
      ),
    },
    snapshots: {
      lastSuccessful: value?.snapshots?.lastSuccessful,
    },
    locks: value?.locks || {},
  };
}

export function ensureStateDirectories(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(STATE_LOCKS_DIR, { recursive: true });
}

export function readStateManifest(): StateManifest | undefined {
  try {
    if (!fs.existsSync(STATE_MANIFEST_PATH)) return undefined;
    const parsed = JSON.parse(
      fs.readFileSync(STATE_MANIFEST_PATH, 'utf-8'),
    ) as Partial<StateManifest>;
    return normalizeStateManifest(parsed);
  } catch (err) {
    logger.warn({ err }, 'Failed to read state manifest');
    return undefined;
  }
}

export function synthesizeStateManifest(): StateManifest {
  return normalizeStateManifest(createStateManifest());
}

export function loadStateManifest(): StateManifest {
  return readStateManifest() || synthesizeStateManifest();
}

export function writeStateManifest(manifest: StateManifest): void {
  ensureStateDirectories();
  const normalized = normalizeStateManifest({
    ...manifest,
    schemaVersion: STATE_MANIFEST_SCHEMA_VERSION,
    appVersion: readAppVersion(),
  });
  fs.writeFileSync(STATE_MANIFEST_PATH, JSON.stringify(normalized, null, 2));
}

export function updateStateManifest(
  updater: (manifest: StateManifest) => StateManifest,
): StateManifest {
  const next = updater(loadStateManifest());
  writeStateManifest(next);
  return next;
}

export function setManifestLock(
  name: string,
  lock: StateLockState | null,
): StateManifest {
  return updateStateManifest((manifest) => {
    const nextLocks = { ...manifest.locks };
    if (lock) {
      nextLocks[name] = lock;
    } else {
      delete nextLocks[name];
    }
    return {
      ...manifest,
      locks: nextLocks,
    };
  });
}
