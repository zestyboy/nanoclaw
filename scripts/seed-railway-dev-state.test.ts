import { describe, expect, it } from 'vitest';

import {
  buildDevSeedPaths,
  buildRemoteArchiveScript,
  buildRemoteEmptyCheckScript,
  buildRemotePrepareScript,
  parseSeedArgs,
  validateDevSeedPaths,
} from './seed-railway-dev-state.js';

describe('seed-railway-dev-state', () => {
  it('uses the selective safe seed by default', () => {
    expect(
      buildDevSeedPaths({
        dryRun: false,
        force: false,
        includeState: false,
      }),
    ).toEqual([
      'groups',
      'projects',
      'public-knowledge',
      'second-brain',
    ]);
  });

  it('includes state only when explicitly requested', () => {
    expect(
      buildDevSeedPaths({
        dryRun: false,
        force: false,
        includeState: true,
      }),
    ).toEqual([
      'groups',
      'projects',
      'public-knowledge',
      'second-brain',
      'state',
    ]);
  });

  it('rejects disallowed seed paths', () => {
    expect(() => validateDevSeedPaths(['groups', 'sessions'])).toThrow(
      /disallowed path/,
    );
    expect(() => validateDevSeedPaths(['store/messages.db'])).toThrow(
      /disallowed path/,
    );
  });

  it('builds the remote scripts for checks and transfer', () => {
    expect(buildRemoteEmptyCheckScript(['groups'])).toContain(
      'ls -A /data/groups',
    );
    expect(buildRemotePrepareScript(['groups', 'projects'], { force: false })).toBe(
      'mkdir -p /data/groups /data/projects',
    );
    expect(buildRemotePrepareScript(['groups'], { force: true })).toBe(
      'rm -rf /data/groups && mkdir -p /data/groups',
    );
    expect(buildRemoteArchiveScript(['groups', 'projects'])).toBe(
      'cd /data && tar -czf - groups projects',
    );
  });

  it('parses CLI flags', () => {
    expect(parseSeedArgs(['--include-state', '--force', '--dry-run'])).toEqual(
      {
        dryRun: true,
        force: true,
        includeState: true,
      },
    );
  });
});
