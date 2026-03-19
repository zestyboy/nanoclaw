#!/usr/bin/env tsx
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  formatRailwayTarget,
  getCurrentGitBranch,
  getRailwayTargetConfig,
  RailwayTargetConfig,
  RailwayTargetName,
} from './railway-common.js';

type RailwayAction = 'deploy' | 'status' | 'logs';

export interface ParsedRailwayArgs {
  target: RailwayTargetName;
  action: RailwayAction;
  allowMain: boolean;
  message?: string;
  passthroughArgs: string[];
}

export function parseRailwayScriptArgs(args: string[]): ParsedRailwayArgs {
  const [targetArg, actionArg, ...rest] = args;

  if (targetArg !== 'dev' && targetArg !== 'prod') {
    throw new Error('Usage: tsx scripts/railway.ts <dev|prod> <action> [...]');
  }
  if (
    actionArg !== 'deploy' &&
    actionArg !== 'status' &&
    actionArg !== 'logs'
  ) {
    throw new Error(
      'Action must be one of: deploy, status, logs.',
    );
  }
  if (targetArg === 'prod' && actionArg === 'deploy') {
    throw new Error(
      'Production deploys are intentionally not wrapped; merge to main instead.',
    );
  }

  let allowMain = false;
  let message: string | undefined;
  const passthroughArgs: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--allow-main') {
      allowMain = true;
      continue;
    }
    if (arg === '--message' || arg === '-m') {
      i += 1;
      if (!rest[i]) {
        throw new Error(`${arg} requires a value.`);
      }
      message = rest[i];
      continue;
    }
    passthroughArgs.push(arg);
  }

  return {
    target: targetArg,
    action: actionArg,
    allowMain,
    message,
    passthroughArgs,
  };
}

export function buildDeployArgs(
  target: RailwayTargetConfig,
  options: {
    branch: string;
    message?: string;
    passthroughArgs?: string[];
  },
): string[] {
  return [
    'up',
    '--project',
    target.projectId,
    '--environment',
    target.environment,
    '--service',
    target.service,
    '--detach',
    '-m',
    options.message || `dev deploy from ${options.branch}`,
    ...(options.passthroughArgs || []),
  ];
}

export function buildLinkedActionArgs(
  action: Exclude<RailwayAction, 'deploy'>,
  target: RailwayTargetConfig,
  passthroughArgs: string[] = [],
): { linkArgs: string[]; commandArgs: string[] } {
  return {
    linkArgs: [
      'link',
      '--project',
      target.projectId,
      '--environment',
      target.environment,
      '--service',
      target.service,
    ],
    commandArgs:
      action === 'status'
        ? [
            'service',
            'status',
            '--service',
            target.service,
            '--environment',
            target.environment,
            ...passthroughArgs,
          ]
        : [
            'logs',
            '--service',
            target.service,
            '--environment',
            target.environment,
            ...passthroughArgs,
          ],
  };
}

function runRailwayDeploy(parsed: ParsedRailwayArgs): void {
  const cwd = process.cwd();
  const branch = getCurrentGitBranch(cwd);
  const target = getRailwayTargetConfig(parsed.target, { cwd });

  if (target.name !== 'dev') {
    throw new Error('Deploy is only supported for the dev target.');
  }
  if (branch === 'main' && !parsed.allowMain) {
    throw new Error(
      'Refusing to deploy dev from main. Re-run with --allow-main to override.',
    );
  }

  console.log(`[railway] target ${formatRailwayTarget(target)}`);
  console.log(`[railway] git branch=${branch}`);

  execFileSync(
    'railway',
    buildDeployArgs(target, {
      branch,
      message: parsed.message,
      passthroughArgs: parsed.passthroughArgs,
    }),
    { cwd, stdio: 'inherit' },
  );
}

function runLinkedRailwayAction(parsed: ParsedRailwayArgs): void {
  const cwd = process.cwd();
  const target = getRailwayTargetConfig(parsed.target, { cwd });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-railway-'));
  const { linkArgs, commandArgs } = buildLinkedActionArgs(
    parsed.action,
    target,
    parsed.passthroughArgs,
  );

  console.log(`[railway] target ${formatRailwayTarget(target)}`);

  try {
    execFileSync('railway', linkArgs, {
      cwd: tempDir,
      stdio: 'pipe',
    });
    execFileSync('railway', commandArgs, {
      cwd: tempDir,
      stdio: 'inherit',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function main(args: string[]): void {
  const parsed = parseRailwayScriptArgs(args);

  if (parsed.action === 'deploy') {
    runRailwayDeploy(parsed);
    return;
  }

  runLinkedRailwayAction(parsed);
}

const entryPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
const thisPath = fileURLToPath(import.meta.url);

if (entryPath === thisPath) {
  main(process.argv.slice(2));
}
