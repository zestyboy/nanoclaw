import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
export const RAILWAY_DATA_DIR = '/data';

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = IS_RAILWAY
  ? path.resolve(RAILWAY_DATA_DIR, 'store')
  : path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = IS_RAILWAY
  ? path.resolve(RAILWAY_DATA_DIR, 'groups')
  : path.resolve(PROJECT_ROOT, 'groups');
// On Railway, ipc/ and sessions/ live directly under /data (the persistent volume).
// Locally, they live under ./data/ in the project root.
export const DATA_DIR = IS_RAILWAY
  ? RAILWAY_DATA_DIR
  : path.resolve(PROJECT_ROOT, 'data');
export const STATE_DIR = path.resolve(DATA_DIR, 'state');
export const STATE_LOCKS_DIR = path.resolve(STATE_DIR, 'locks');
export const STATE_MANIFEST_PATH = path.resolve(
  STATE_DIR,
  'state-manifest.json',
);
export const PROJECTS_DIR = IS_RAILWAY
  ? path.resolve(RAILWAY_DATA_DIR, 'projects')
  : process.env.NANOCLAW_PROJECTS_DIR ||
    path.join(HOME_DIR, 'development', 'nanoclaw-projects');
export const PUBLIC_KNOWLEDGE_DIR =
  process.env.NANOCLAW_PUBLIC_KNOWLEDGE_DIR ||
  (IS_RAILWAY
    ? '/data/public-knowledge'
    : path.join(HOME_DIR, 'development', 'nanoclaw-knowledge'));
export const SECOND_BRAIN_DIR =
  process.env.NANOCLAW_SECOND_BRAIN_DIR ||
  (IS_RAILWAY ? '/data/second-brain' : '');
export const QMD_CACHE_DIR = path.resolve(DATA_DIR, 'qmd-cache');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const STATE_VERIFY_ENFORCE =
  (process.env.STATE_VERIFY_ENFORCE || 'false') === 'true';
export const FORCE_STATE_RESTORE =
  (process.env.FORCE_STATE_RESTORE || 'false') === 'true';
export const R2_STATE_BUCKET = process.env.R2_STATE_BUCKET || '';
export type PushChangesDirectMode = 'allow' | 'pr-only';
export const PUSH_CHANGES_DEFAULT_BRANCH =
  process.env.PUSH_CHANGES_DEFAULT_BRANCH || 'main';
export const PUSH_CHANGES_DIRECT_MODE: PushChangesDirectMode =
  process.env.PUSH_CHANGES_DIRECT_MODE === 'pr-only' ? 'pr-only' : 'allow';
export const STATE_SNAPSHOT_INTERVAL_MS = parseInt(
  process.env.STATE_SNAPSHOT_INTERVAL_MS || '21600000',
  10,
);
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const NANOCLAW_PDF_EXTRACT_MAX_CHARS = parseInt(
  process.env.NANOCLAW_PDF_EXTRACT_MAX_CHARS || '4000',
  10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
