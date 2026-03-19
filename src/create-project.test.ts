import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from './types.js';

describe('create_project registry ownership', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-create-project-'));
    originalCwd = process.cwd();
    originalEnv = { ...process.env };

    process.chdir(tempDir);
    process.env.NANOCLAW_PROJECTS_DIR = path.join(tempDir, 'projects');
    process.env.DISCORD_GUILD_ID = 'guild-123';
    process.env.DISCORD_PROJECT_CATEGORY_ID = 'category-123';

    fs.mkdirSync(path.join(tempDir, 'groups', 'main'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'groups', 'brain-router', 'templates'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tempDir, 'projects'), { recursive: true });

    fs.writeFileSync(
      path.join(
        tempDir,
        'groups',
        'brain-router',
        'templates',
        'general-project-claude.md',
      ),
      '# {PROJECT_NAME}\n\n{BRIEF}\n',
    );

    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes new projects to the brain-router registry even when main invokes create_project', async () => {
    const { _initTestDatabase, setRegisteredGroup } = await import('./db.js');
    const { processTaskIpc } = await import('./ipc.js');

    _initTestDatabase();

    const mainGroup: RegisteredGroup = {
      name: 'Personal Assistant',
      folder: 'main',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    };
    const brainRouterGroup: RegisteredGroup = {
      name: 'Brain Router',
      folder: 'brain-router',
      trigger: '@Router',
      added_at: '2024-01-01T00:00:00.000Z',
      trusted: true,
    };

    const groups: Record<string, RegisteredGroup> = {
      'dc:main': mainGroup,
      'dc:brain': brainRouterGroup,
    };
    setRegisteredGroup('dc:main', mainGroup);
    setRegisteredGroup('dc:brain', brainRouterGroup);

    await processTaskIpc(
      {
        type: 'create_project',
        name: 'Test Mirroring',
        slug: 'test-mirroring',
        projectType: 'general',
        brief: 'Verify mirrored project conversations',
      },
      'main',
      true,
      false,
      {
        sendMessage: async () => {},
        registeredGroups: () => groups,
        registerGroup: (jid, group) => {
          groups[jid] = group;
          setRegisteredGroup(jid, group);
        },
        syncGroups: async () => {},
        getAvailableGroups: () => [],
        writeGroupsSnapshot: () => {},
        enqueueMessageCheck: () => {},
        createDiscordChannel: async () => '1234567890',
      },
    );

    const brainRouterProjectsYaml = fs.readFileSync(
      path.join(tempDir, 'groups', 'brain-router', 'projects.yaml'),
      'utf-8',
    );
    expect(brainRouterProjectsYaml).toContain('test-mirroring');
    expect(brainRouterProjectsYaml).toContain('1234567890');

    const mainProjectsYamlPath = path.join(tempDir, 'groups', 'main', 'projects.yaml');
    expect(fs.existsSync(mainProjectsYamlPath)).toBe(false);

    const claudeFile = fs.readFileSync(
      path.join(tempDir, 'projects', 'test-mirroring', 'CLAUDE.md'),
      'utf-8',
    );
    expect(claudeFile).toContain('# Test Mirroring');
    expect(claudeFile).toContain('Verify mirrored project conversations');
  });
});
