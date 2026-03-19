import {
  IS_RAILWAY,
  PUSH_CHANGES_DEFAULT_BRANCH,
  PUSH_CHANGES_DIRECT_MODE,
  PushChangesDirectMode,
} from './config.js';

export interface PushChangesPolicy {
  isRailway: boolean;
  defaultBranch: string;
  directMode: PushChangesDirectMode;
}

export interface PushChangesPolicyOverride {
  isRailway?: boolean;
  defaultBranch?: string;
  directMode?: PushChangesDirectMode;
}

export function resolvePushChangesPolicy(
  override: PushChangesPolicyOverride = {},
): PushChangesPolicy {
  return {
    isRailway: override.isRailway ?? IS_RAILWAY,
    defaultBranch: override.defaultBranch ?? PUSH_CHANGES_DEFAULT_BRANCH,
    directMode: override.directMode ?? PUSH_CHANGES_DIRECT_MODE,
  };
}

export function resolvePushChangesBranch(
  requestedBranch?: string,
  override: PushChangesPolicyOverride = {},
): string {
  const policy = resolvePushChangesPolicy(override);
  return requestedBranch || policy.defaultBranch;
}

export function assertPushChangesAllowed(
  createPr: boolean | undefined,
  override: PushChangesPolicyOverride = {},
): void {
  const policy = resolvePushChangesPolicy(override);

  if (policy.isRailway && policy.directMode === 'pr-only' && !createPr) {
    throw new Error(
      'Direct push_changes is disabled in this Railway environment; use create_pr=true.',
    );
  }
}
