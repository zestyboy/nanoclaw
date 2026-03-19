import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export type RailwayTargetName = 'dev' | 'prod';

export interface RailwayTargetConfig {
  name: RailwayTargetName;
  projectId: string;
  environment: string;
  service: string;
}

const DEFAULT_SERVICE = 'nanoclaw';
const DEFAULT_ENVIRONMENTS: Record<RailwayTargetName, string> = {
  dev: 'dev',
  prod: 'production',
};

function parseEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};

  const values: Record<string, string> = {};
  const content = fs.readFileSync(envPath, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

function readRailwayEnv(cwd: string): Record<string, string> {
  return parseEnvFile(path.join(cwd, '.env'));
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0);
}

export function getRailwayTargetConfig(
  name: RailwayTargetName,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): RailwayTargetConfig {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const localEnv = readRailwayEnv(cwd);
  const environmentKey =
    name === 'dev' ? 'RAILWAY_DEV_ENVIRONMENT' : 'RAILWAY_PROD_ENVIRONMENT';
  const serviceKey =
    name === 'dev' ? 'RAILWAY_DEV_SERVICE' : 'RAILWAY_PROD_SERVICE';
  const projectId = firstDefined(
    env.RAILWAY_PROJECT_ID,
    localEnv.RAILWAY_PROJECT_ID,
  );

  if (!projectId) {
    throw new Error(
      'Missing RAILWAY_PROJECT_ID. Set it in your shell or project .env file.',
    );
  }

  return {
    name,
    projectId,
    environment:
      firstDefined(env[environmentKey], localEnv[environmentKey]) ||
      DEFAULT_ENVIRONMENTS[name],
    service:
      firstDefined(
        env[serviceKey],
        localEnv[serviceKey],
        env.RAILWAY_SERVICE_NAME,
        localEnv.RAILWAY_SERVICE_NAME,
      ) || DEFAULT_SERVICE,
  };
}

export function formatRailwayTarget(target: RailwayTargetConfig): string {
  return `project=${target.projectId} environment=${target.environment} service=${target.service}`;
}

export function getCurrentGitBranch(cwd: string = process.cwd()): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd,
    encoding: 'utf-8',
  }).trim();
}
