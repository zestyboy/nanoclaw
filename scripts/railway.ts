#!/usr/bin/env tsx
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  formatRailwayTarget,
  getCurrentGitBranch,
  getExpectedRailwaySourceBranch,
  getRailwaySourceConfigForService,
  getRailwayTargetConfig,
  getServiceIdFromRailwayStatus,
  RailwayEnvironmentConfigJson,
  RailwaySourceConfig,
  RailwayStatusJson,
  RailwayTargetConfig,
  RailwayTargetName,
} from './railway-common.js';

type RailwayAction = 'deploy' | 'status' | 'logs' | 'verify';

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
    actionArg !== 'logs' &&
    actionArg !== 'verify'
  ) {
    throw new Error(
      'Action must be one of: deploy, status, logs, verify.',
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

export interface RailwaySourceVerificationResult {
  serviceId: string;
  source: RailwaySourceConfig;
  expectedBranch: string;
  ok: boolean;
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

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function verifyRailwaySourceBranch(
  status: RailwayStatusJson,
  config: RailwayEnvironmentConfigJson,
  target: RailwayTargetConfig,
): RailwaySourceVerificationResult {
  const serviceId = getServiceIdFromRailwayStatus(status, target.service);
  const source = getRailwaySourceConfigForService(config, serviceId);
  const expectedBranch = getExpectedRailwaySourceBranch(target.name);

  return {
    serviceId,
    source,
    expectedBranch,
    ok: source.branch === expectedBranch,
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

function runRailwayVerify(parsed: ParsedRailwayArgs): void {
  const cwd = process.cwd();
  const target = getRailwayTargetConfig(parsed.target, { cwd });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-railway-'));
  const jsonOutput = parsed.passthroughArgs.includes('--json');

  if (!jsonOutput) {
    console.log(`[railway] target ${formatRailwayTarget(target)}`);
  }

  try {
    execFileSync(
      'railway',
      [
        'link',
        '--project',
        target.projectId,
        '--environment',
        target.environment,
        '--service',
        target.service,
      ],
      {
        cwd: tempDir,
        stdio: 'pipe',
      },
    );

    const status = parseJson<RailwayStatusJson>(
      execFileSync('railway', ['status', '--json'], {
        cwd: tempDir,
        encoding: 'utf-8',
      }),
      'Railway status',
    );
    const config = parseJson<RailwayEnvironmentConfigJson>(
      execFileSync(
        'railway',
        ['environment', 'config', '--environment', target.environment, '--json'],
        {
          cwd: tempDir,
          encoding: 'utf-8',
        },
      ),
      'Railway environment config',
    );
    const result = verifyRailwaySourceBranch(status, config, target);

    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            environment: target.environment,
            expectedBranch: result.expectedBranch,
            ok: result.ok,
            projectId: target.projectId,
            service: target.service,
            serviceId: result.serviceId,
            source: result.source,
          },
          null,
          2,
        ),
      );
      if (!result.ok) process.exitCode = 1;
    } else {
      console.log(
        `[railway] source repo=${result.source.repo || '?'} branch=${result.source.branch || '?'} rootDirectory=${result.source.rootDirectory || '(root)'}`,
      );
      if (result.ok) {
        console.log(
          `[railway] verified ${target.service} watches ${result.expectedBranch} in ${target.environment}`,
        );
      } else {
        console.error(
          `[railway] expected branch=${result.expectedBranch} but ${target.service} watches ${result.source.branch || 'unset'} in ${target.environment}`,
        );
        process.exitCode = 1;
      }
    }
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
  if (parsed.action === 'verify') {
    runRailwayVerify(parsed);
    return;
  }

  runLinkedRailwayAction(parsed);
}

const entryPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
const thisPath = fileURLToPath(import.meta.url);

if (entryPath === thisPath) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}
