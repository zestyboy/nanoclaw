import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DATA_DIR,
  FORCE_STATE_RESTORE,
  IS_RAILWAY,
  R2_STATE_BUCKET,
  STATE_LOCKS_DIR,
  STATE_MANIFEST_PATH,
  STATE_SNAPSHOT_INTERVAL_MS,
} from './config.js';
import { backupDatabaseFile } from './db.js';
import { logger } from './logger.js';
import {
  loadStateManifest,
  setManifestLock,
  StateSnapshotMetadata,
  updateStateManifest,
} from './state-manifest.js';

const SNAPSHOT_LOCK_NAME = 'canonical-snapshot';

let snapshotInFlight: Promise<void> | null = null;

function canUseSnapshots(): boolean {
  return IS_RAILWAY && !!R2_STATE_BUCKET;
}

function snapshotRemotePath(objectName: string): string {
  return `r2:${R2_STATE_BUCKET}/${objectName}`;
}

function ensureSnapshotLock(): boolean {
  fs.mkdirSync(STATE_LOCKS_DIR, { recursive: true });
  const updatedAt = new Date().toISOString();
  const lockPath = path.join(STATE_LOCKS_DIR, `${SNAPSHOT_LOCK_NAME}.json`);
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
        updatedAt?: string;
      };
      if (
        lock.updatedAt &&
        Date.now() - Date.parse(lock.updatedAt) < 6 * 60 * 60 * 1000
      ) {
        return false;
      }
    } catch {
      // overwrite stale lock
    }
  }
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ updatedAt, pid: process.pid }, null, 2),
  );
  setManifestLock(SNAPSHOT_LOCK_NAME, {
    type: 'snapshot',
    status: 'running',
    updatedAt,
  });
  return true;
}

function clearSnapshotLock(): void {
  try {
    fs.unlinkSync(path.join(STATE_LOCKS_DIR, `${SNAPSHOT_LOCK_NAME}.json`));
  } catch {
    /* ignore */
  }
  setManifestLock(SNAPSHOT_LOCK_NAME, null);
}

function rcloneCopyTo(source: string, destination: string): void {
  execFileSync('rclone', ['copyto', source, destination], {
    cwd: DATA_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function rcloneCat(source: string): string {
  return execFileSync('rclone', ['cat', source], {
    cwd: DATA_DIR,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function meaningfulEntries(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((entry) => !entry.startsWith('.'));
}

function volumeLooksEmpty(): boolean {
  if (fs.existsSync(STATE_MANIFEST_PATH)) return false;
  const dbExists = fs.existsSync(path.join(DATA_DIR, 'store', 'messages.db'));
  const hasGroups = meaningfulEntries(path.join(DATA_DIR, 'groups')).length > 0;
  const hasProjects =
    meaningfulEntries(path.join(DATA_DIR, 'projects')).length > 0;
  const hasState = meaningfulEntries(path.join(DATA_DIR, 'state')).length > 0;
  return !dbExists && !hasGroups && !hasProjects && !hasState;
}

export async function snapshotCanonicalState(reason: string): Promise<void> {
  if (!canUseSnapshots()) return;
  if (!ensureSnapshotLock()) {
    logger.info('Canonical state snapshot already in progress, skipping');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-state-'));
  try {
    const now = new Date();
    const id = now.toISOString().replace(/[:.]/g, '-');
    const dbFile = path.join(tempDir, `messages-${id}.db`);
    const archiveFile = path.join(tempDir, `canonical-${id}.tar.gz`);

    await backupDatabaseFile(dbFile);

    execFileSync(
      'tar',
      [
        '-czf',
        archiveFile,
        '--exclude=groups/*/logs',
        '--exclude=groups/*/logs/*',
        'groups',
        'projects',
        'state',
      ],
      {
        cwd: DATA_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const manifest = loadStateManifest();
    const metadata: StateSnapshotMetadata = {
      id,
      createdAt: now.toISOString(),
      reason,
      appVersion: manifest.appVersion,
      manifestSchemaVersion: manifest.schemaVersion,
      dbObject: `state-snapshots/messages-${id}.db`,
      archiveObject: `state-snapshots/canonical-${id}.tar.gz`,
    };

    const metadataFile = path.join(tempDir, 'latest.json');
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));

    rcloneCopyTo(dbFile, snapshotRemotePath(metadata.dbObject));
    rcloneCopyTo(archiveFile, snapshotRemotePath(metadata.archiveObject));
    rcloneCopyTo(
      metadataFile,
      snapshotRemotePath('state-snapshots/latest.json'),
    );

    updateStateManifest((current) => ({
      ...current,
      snapshots: {
        lastSuccessful: metadata,
      },
    }));
  } finally {
    clearSnapshotLock();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function restoreCanonicalStateIfNeeded(): Promise<boolean> {
  if (!canUseSnapshots()) return false;
  if (!FORCE_STATE_RESTORE && !volumeLooksEmpty()) return false;

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-state-restore-'),
  );
  try {
    const metadata = JSON.parse(
      rcloneCat(snapshotRemotePath('state-snapshots/latest.json')),
    ) as StateSnapshotMetadata;
    const dbFile = path.join(tempDir, 'messages.db');
    const archiveFile = path.join(tempDir, 'canonical.tar.gz');
    const extractDir = path.join(tempDir, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });

    rcloneCopyTo(snapshotRemotePath(metadata.dbObject), dbFile);
    rcloneCopyTo(snapshotRemotePath(metadata.archiveObject), archiveFile);

    execFileSync('tar', ['-xzf', archiveFile, '-C', extractDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    fs.rmSync(path.join(DATA_DIR, 'groups'), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'projects'), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(DATA_DIR, 'state'), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'store', 'messages.db'), {
      force: true,
    });

    fs.mkdirSync(path.join(DATA_DIR, 'store'), { recursive: true });
    fs.copyFileSync(dbFile, path.join(DATA_DIR, 'store', 'messages.db'));

    for (const entry of ['groups', 'projects', 'state']) {
      const source = path.join(extractDir, entry);
      if (fs.existsSync(source)) {
        fs.cpSync(source, path.join(DATA_DIR, entry), { recursive: true });
      }
    }

    logger.info(
      { snapshotId: metadata.id },
      'Canonical state restored from R2',
    );
    return true;
  } catch (err) {
    logger.warn({ err }, 'Canonical state restore skipped');
    return false;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function scheduleCanonicalSnapshot(reason: string): void {
  if (!canUseSnapshots()) return;
  if (snapshotInFlight) return;
  snapshotInFlight = snapshotCanonicalState(reason)
    .catch((err) => {
      logger.warn({ err, reason }, 'Canonical state snapshot failed');
    })
    .finally(() => {
      snapshotInFlight = null;
    });
}

export function startStateSnapshotLoop(): void {
  if (!canUseSnapshots()) return;
  setInterval(() => {
    scheduleCanonicalSnapshot('periodic');
  }, STATE_SNAPSHOT_INTERVAL_MS);
}
