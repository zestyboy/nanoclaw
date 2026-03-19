#!/usr/bin/env tsx
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  formatRailwayTarget,
  getRailwayTargetConfig,
  RailwayTargetConfig,
} from './railway-common.js';

const REQUIRED_DEV_SEED_PATHS = [
  'groups',
  'projects',
  'public-knowledge',
  'second-brain',
] as const;
const OPTIONAL_DEV_SEED_PATHS = ['state'] as const;
const DISALLOWED_DEV_SEED_PATHS = [
  'sessions',
  'ipc',
  'store',
  'store/messages.db',
  'logs',
  'syncthing',
] as const;

export interface SeedOptions {
  includeState: boolean;
  force: boolean;
  dryRun: boolean;
}

export function buildDevSeedPaths(options: SeedOptions): string[] {
  return options.includeState
    ? [...REQUIRED_DEV_SEED_PATHS, ...OPTIONAL_DEV_SEED_PATHS]
    : [...REQUIRED_DEV_SEED_PATHS];
}

export function validateDevSeedPaths(paths: string[]): void {
  const allowed = new Set([
    ...REQUIRED_DEV_SEED_PATHS,
    ...OPTIONAL_DEV_SEED_PATHS,
  ]);

  for (const seedPath of paths) {
    if (!allowed.has(seedPath as (typeof REQUIRED_DEV_SEED_PATHS)[number])) {
      throw new Error(
        `Refusing to seed disallowed path "${seedPath}". Allowed paths: ${[
          ...allowed,
        ].join(', ')}`,
      );
    }
    if (
      DISALLOWED_DEV_SEED_PATHS.some(
        (disallowed) =>
          seedPath === disallowed || seedPath.startsWith(`${disallowed}/`),
      )
    ) {
      throw new Error(`Refusing to seed protected path "${seedPath}".`);
    }
  }
}

export function buildRemoteEmptyCheckScript(paths: string[]): string {
  const checks = paths
    .map(
      (seedPath) =>
        `if [ -e /data/${seedPath} ] && [ "$(ls -A /data/${seedPath} 2>/dev/null)" ]; then echo /data/${seedPath}; fi`,
    )
    .join('; ');
  return `${checks}; true`;
}

export function buildRemotePrepareScript(
  paths: string[],
  options: { force: boolean },
): string {
  const mkdirs = paths.map((seedPath) => `/data/${seedPath}`).join(' ');
  if (!options.force) {
    return `mkdir -p ${mkdirs}`;
  }
  return `rm -rf ${mkdirs} && mkdir -p ${mkdirs}`;
}

export function buildRemoteArchiveScript(paths: string[]): string {
  return `cd /data && tar -czf - ${paths.join(' ')}`;
}

function railwayArgs(target: RailwayTargetConfig): string[] {
  return [
    '--project',
    target.projectId,
    '--environment',
    target.environment,
    '--service',
    target.service,
  ];
}

function runRailwayCommand(
  command: string,
  args: string[],
  options: {
    stdin?: NodeJS.ReadableStream;
    captureStdout?: boolean;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('railway', [command, ...args], {
      stdio: [
        options.stdin ? 'pipe' : 'inherit',
        options.captureStdout ? 'pipe' : 'inherit',
        'inherit',
      ],
    });
    let stdout = '';

    if (options.stdin && child.stdin) {
      options.stdin.pipe(child.stdin);
    }
    if (options.captureStdout && child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`railway ${command} exited with code ${code}`));
    });
  });
}

async function assertDevSeedSafe(
  devTarget: RailwayTargetConfig,
  paths: string[],
): Promise<void> {
  const output = await runRailwayCommand('ssh', [
    ...railwayArgs(devTarget),
    'sh',
    '-lc',
    buildRemoteEmptyCheckScript(paths),
  ], { captureStdout: true });
  const nonEmptyPaths = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (nonEmptyPaths.length > 0) {
    throw new Error(
      `Dev seed target is not empty for: ${nonEmptyPaths.join(', ')}. Re-run with --force to overwrite.`,
    );
  }
}

async function runDevSeed(options: SeedOptions): Promise<void> {
  const prodTarget = getRailwayTargetConfig('prod');
  const devTarget = getRailwayTargetConfig('dev');
  const paths = buildDevSeedPaths(options);
  validateDevSeedPaths(paths);

  console.log(`[seed] source ${formatRailwayTarget(prodTarget)}`);
  console.log(`[seed] target ${formatRailwayTarget(devTarget)}`);
  console.log(`[seed] paths ${paths.join(', ')}`);

  if (options.dryRun) {
    console.log('[seed] dry run only; no data copied');
    return;
  }

  if (!options.force) {
    await assertDevSeedSafe(devTarget, paths);
  }

  await runRailwayCommand('ssh', [
    ...railwayArgs(devTarget),
    'sh',
    '-lc',
    buildRemotePrepareScript(paths, { force: options.force }),
  ]);

  const source = spawn('railway', [
    'ssh',
    ...railwayArgs(prodTarget),
    'sh',
    '-lc',
    buildRemoteArchiveScript(paths),
  ], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  const dest = spawn('railway', [
    'ssh',
    ...railwayArgs(devTarget),
    'sh',
    '-lc',
    'cd /data && tar -xzf -',
  ], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (!source.stdout || !dest.stdin) {
    throw new Error('Failed to create tar stream for Railway seed.');
  }

  source.stdout.pipe(dest.stdin);

  const [sourceCode, destCode] = await Promise.all([
    new Promise<number | null>((resolve, reject) => {
      source.on('error', reject);
      source.on('close', resolve);
    }),
    new Promise<number | null>((resolve, reject) => {
      dest.on('error', reject);
      dest.on('close', resolve);
    }),
  ]);

  if (sourceCode !== 0 || destCode !== 0) {
    throw new Error(
      `Railway seed failed (source=${sourceCode ?? 'signal'}, dest=${destCode ?? 'signal'}).`,
    );
  }
}

export function parseSeedArgs(args: string[]): SeedOptions {
  let includeState = false;
  let force = false;
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--include-state') includeState = true;
    else if (arg === '--force') force = true;
    else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return { includeState, force, dryRun };
}

export async function main(args: string[]): Promise<void> {
  await runDevSeed(parseSeedArgs(args));
}

const entryPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
const thisPath = fileURLToPath(import.meta.url);

if (entryPath === thisPath) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
