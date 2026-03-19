import { describe, expect, it } from 'vitest';

import {
  buildDeployArgs,
  buildLinkedActionArgs,
  parseRailwayScriptArgs,
} from './railway.js';

describe('railway wrapper', () => {
  it('parses deploy arguments and main override', () => {
    expect(
      parseRailwayScriptArgs([
        'dev',
        'deploy',
        '--allow-main',
        '--message',
        'ship it',
        '--verbose',
      ]),
    ).toEqual({
      action: 'deploy',
      allowMain: true,
      message: 'ship it',
      passthroughArgs: ['--verbose'],
      target: 'dev',
    });
  });

  it('rejects wrapped production deploys', () => {
    expect(() => parseRailwayScriptArgs(['prod', 'deploy'])).toThrow(
      /not wrapped/,
    );
  });

  it('builds explicit dev deploy arguments', () => {
    expect(
      buildDeployArgs(
        {
          environment: 'dev',
          name: 'dev',
          projectId: 'prj_shared',
          service: 'nanoclaw',
        },
        { branch: 'feature/test' },
      ),
    ).toEqual([
      'up',
      '--project',
      'prj_shared',
      '--environment',
      'dev',
      '--service',
      'nanoclaw',
      '--detach',
      '-m',
      'dev deploy from feature/test',
    ]);
  });

  it('builds linked status commands without repo context', () => {
    expect(
      buildLinkedActionArgs(
        'status',
        {
          environment: 'production',
          name: 'prod',
          projectId: 'prj_shared',
          service: 'nanoclaw',
        },
        ['--json'],
      ),
    ).toEqual({
      commandArgs: [
        'service',
        'status',
        '--service',
        'nanoclaw',
        '--environment',
        'production',
        '--json',
      ],
      linkArgs: [
        'link',
        '--project',
        'prj_shared',
        '--environment',
        'production',
        '--service',
        'nanoclaw',
      ],
    });
  });
});
