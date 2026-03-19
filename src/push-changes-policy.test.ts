import { describe, expect, it } from 'vitest';

import {
  assertPushChangesAllowed,
  resolvePushChangesBranch,
  resolvePushChangesPolicy,
} from './push-changes-policy.js';

describe('push-changes-policy', () => {
  it('defaults to main when no branch is provided', () => {
    expect(
      resolvePushChangesBranch(undefined, {
        defaultBranch: 'main',
        directMode: 'allow',
        isRailway: true,
      }),
    ).toBe('main');
  });

  it('prefers an explicit branch when provided', () => {
    expect(
      resolvePushChangesBranch('release/hotfix', {
        defaultBranch: 'main',
        directMode: 'allow',
        isRailway: true,
      }),
    ).toBe('release/hotfix');
  });

  it('rejects direct pushes in pr-only railway mode', () => {
    expect(() =>
      assertPushChangesAllowed(false, {
        defaultBranch: 'main',
        directMode: 'pr-only',
        isRailway: true,
      }),
    ).toThrow(/create_pr=true/);
  });

  it('allows PR creation in pr-only railway mode', () => {
    expect(() =>
      assertPushChangesAllowed(true, {
        defaultBranch: 'main',
        directMode: 'pr-only',
        isRailway: true,
      }),
    ).not.toThrow();
  });

  it('allows direct pushes outside pr-only railway mode', () => {
    expect(() =>
      assertPushChangesAllowed(false, {
        defaultBranch: 'main',
        directMode: 'allow',
        isRailway: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertPushChangesAllowed(false, {
        defaultBranch: 'main',
        directMode: 'pr-only',
        isRailway: false,
      }),
    ).not.toThrow();
  });

  it('resolves policy overrides without mutating defaults', () => {
    expect(
      resolvePushChangesPolicy({
        defaultBranch: 'stable',
        directMode: 'pr-only',
        isRailway: true,
      }),
    ).toEqual({
      defaultBranch: 'stable',
      directMode: 'pr-only',
      isRailway: true,
    });
  });
});
