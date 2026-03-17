import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  IS_RAILWAY,
  PROJECTS_DIR,
  PUBLIC_KNOWLEDGE_DIR,
  QMD_CACHE_DIR,
  SECOND_BRAIN_DIR,
  STATE_DIR,
  STATE_MANIFEST_PATH,
  STATE_VERIFY_ENFORCE,
} from './config.js';
import { ensureDatabaseFile, getDatabasePath } from './db.js';
import { logger } from './logger.js';
import { ensureQmdCacheLayout, verifyQmdCollections } from './qmd-state.js';
import {
  loadStateManifest,
  writeStateManifest,
  StateManifest,
} from './state-manifest.js';
import {
  restoreCanonicalStateIfNeeded,
  scheduleCanonicalSnapshot,
} from './state-backup.js';

export interface RailwayStateCheck {
  name: string;
  status: 'ok' | 'repairable' | 'fatal';
  detail: string;
}

export interface RailwayStateCheckResult {
  status: 'ok' | 'repairable' | 'fatal';
  checks: RailwayStateCheck[];
  repairsApplied: string[];
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function getArgValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function ensureBaseDirs(): string[] {
  const repairs: string[] = [];
  const required = [
    path.join(DATA_DIR, 'store'),
    GROUPS_DIR,
    PROJECTS_DIR,
    path.join(DATA_DIR, 'sessions'),
    path.join(DATA_DIR, 'ipc'),
    STATE_DIR,
    path.join(DATA_DIR, 'state', 'locks'),
  ];
  for (const dir of required) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      repairs.push(`created ${dir}`);
    }
  }
  return repairs;
}

function baseManifestCheck(manifest: StateManifest): RailwayStateCheck[] {
  return [
    {
      name: 'state-manifest',
      status: fs.existsSync(STATE_MANIFEST_PATH) ? 'ok' : 'repairable',
      detail: fs.existsSync(STATE_MANIFEST_PATH)
        ? 'state manifest present'
        : 'state manifest will be synthesized',
    },
    {
      name: 'database',
      status: fs.existsSync(getDatabasePath()) ? 'ok' : 'repairable',
      detail: fs.existsSync(getDatabasePath())
        ? 'database file present'
        : 'database file missing',
    },
    {
      name: 'public-knowledge',
      status:
        PUBLIC_KNOWLEDGE_DIR && fs.existsSync(PUBLIC_KNOWLEDGE_DIR)
          ? 'ok'
          : 'repairable',
      detail:
        PUBLIC_KNOWLEDGE_DIR && fs.existsSync(PUBLIC_KNOWLEDGE_DIR)
          ? 'vault directory present'
          : 'vault directory missing',
    },
    {
      name: 'second-brain',
      status:
        SECOND_BRAIN_DIR && fs.existsSync(SECOND_BRAIN_DIR)
          ? 'ok'
          : 'repairable',
      detail:
        SECOND_BRAIN_DIR && fs.existsSync(SECOND_BRAIN_DIR)
          ? 'vault directory present'
          : 'vault directory missing',
    },
    {
      name: 'qmd-cache',
      status: fs.existsSync(QMD_CACHE_DIR) ? 'ok' : 'repairable',
      detail: fs.existsSync(QMD_CACHE_DIR)
        ? 'qmd cache directory present'
        : 'qmd cache directory missing',
    },
    {
      name: 'qmd-collections',
      status: Object.values(manifest.qmd.collections).some(
        (c) => c.status === 'failed',
      )
        ? 'fatal'
        : Object.values(manifest.qmd.collections).some(
              (c) => c.status !== 'valid',
            )
          ? 'repairable'
          : 'ok',
      detail: `verified ${Object.keys(manifest.qmd.collections).length} collections`,
    },
  ];
}

export async function verifyRailwayState(options?: {
  mode?: 'boot' | 'manual';
  repair?: boolean;
}): Promise<RailwayStateCheckResult> {
  const mode = options?.mode || 'manual';
  const repair = options?.repair === true;
  const hadManifestAtStart = fs.existsSync(STATE_MANIFEST_PATH);
  const repairsApplied: string[] = [];

  if (mode === 'boot' && IS_RAILWAY) {
    const restored = await restoreCanonicalStateIfNeeded();
    if (restored) repairsApplied.push('restored canonical state from R2');
  }
  repairsApplied.push(...ensureBaseDirs());

  try {
    ensureDatabaseFile();
    repairsApplied.push('verified database schema');
  } catch (err) {
    return {
      status: 'fatal',
      checks: [
        {
          name: 'database',
          status: 'fatal',
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      repairsApplied,
    };
  }

  repairsApplied.push(...ensureQmdCacheLayout());

  const qmdResult = await verifyQmdCollections({ repair });
  repairsApplied.push(...qmdResult.repairsApplied);

  const manifest = loadStateManifest();
  manifest.database = {
    path: getDatabasePath(),
    status: 'valid',
    checkedAt: new Date().toISOString(),
    detail: 'database schema verified',
  };
  manifest.vaults['public-knowledge'] = {
    path: PUBLIC_KNOWLEDGE_DIR,
    status:
      PUBLIC_KNOWLEDGE_DIR && fs.existsSync(PUBLIC_KNOWLEDGE_DIR)
        ? 'valid'
        : 'missing',
    checkedAt: new Date().toISOString(),
  };
  manifest.vaults['second-brain'] = {
    path: SECOND_BRAIN_DIR,
    status:
      SECOND_BRAIN_DIR && fs.existsSync(SECOND_BRAIN_DIR) ? 'valid' : 'missing',
    checkedAt: new Date().toISOString(),
  };
  manifest.lastVerifiedAt = new Date().toISOString();
  manifest.lastVerifiedMode = mode;
  writeStateManifest(manifest);

  const checks = baseManifestCheck(loadStateManifest());
  let status: RailwayStateCheckResult['status'] = 'ok';
  if (checks.some((check) => check.status === 'fatal')) {
    status = 'fatal';
  } else if (
    !repair &&
    (!hadManifestAtStart ||
      checks.some((check) => check.status === 'repairable'))
  ) {
    status = repair ? 'ok' : 'repairable';
  }

  if (repair && repairsApplied.length > 0) {
    scheduleCanonicalSnapshot('boot-repair');
  }

  return { status, checks, repairsApplied };
}

async function main(): Promise<void> {
  const modeArg = getArgValue('--mode');
  const mode = modeArg === 'boot' ? 'boot' : 'manual';
  const repair =
    hasArg('--repair') || (mode === 'boot' && STATE_VERIFY_ENFORCE);
  const result = await verifyRailwayState({ mode, repair });
  const logPayload = {
    mode,
    status: result.status,
    repairsApplied: result.repairsApplied,
    checks: result.checks,
  };
  if (result.status === 'fatal') {
    logger.error(logPayload, 'Railway state verification completed');
  } else if (result.status === 'repairable') {
    logger.warn(logPayload, 'Railway state verification completed');
  } else {
    logger.info(logPayload, 'Railway state verification completed');
  }
  if (result.status === 'fatal') process.exit(1);
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Railway state verification failed');
    process.exit(1);
  });
}
