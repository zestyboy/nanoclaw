import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findSkillByName,
  formatSkillInlineToken,
  getPersonalSkillLibraryPath,
  listSkills,
  parseInlineSkillRefs,
  resolveRuntimeSkillRoots,
  searchSkills,
  suggestSkill,
  syncRuntimeSkills,
} from './skills.js';

function writeSkill(
  root: string,
  dirName: string,
  frontmatter: string,
  body = '# Skill\n\nBody text.\n',
) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `${frontmatter}\n${body}`);
}

describe('skills catalog', () => {
  const tempDirs: string[] = [];
  const originalRuntimeRoots = process.env.NANOCLAW_RUNTIME_SKILL_ROOTS;
  const originalAiSkillsHome = process.env.AI_SKILLS_HOME;

  afterEach(() => {
    if (originalRuntimeRoots === undefined) {
      delete process.env.NANOCLAW_RUNTIME_SKILL_ROOTS;
    } else {
      process.env.NANOCLAW_RUNTIME_SKILL_ROOTS = originalRuntimeRoots;
    }
    if (originalAiSkillsHome === undefined) {
      delete process.env.AI_SKILLS_HOME;
    } else {
      process.env.AI_SKILLS_HOME = originalAiSkillsHome;
    }
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
    tempDirs.push(dir);
    return dir;
  }

  it('lists skills from multiple roots and deduplicates by name', () => {
    const first = makeRoot();
    const second = makeRoot();

    writeSkill(
      first,
      'use-railway',
      `---
name: use-railway
description: Railway deploys and operations
---`,
    );
    writeSkill(
      second,
      'use-railway',
      `---
name: use-railway
description: Duplicate should be ignored
---`,
    );
    writeSkill(
      second,
      'document-release',
      `---
name: document-release
description: Release documentation updates
---`,
    );

    expect(listSkills({ roots: [first, second] })).toEqual([
      expect.objectContaining({
        name: 'document-release',
        description: 'Release documentation updates',
      }),
      expect.objectContaining({
        name: 'use-railway',
        description: 'Railway deploys and operations',
      }),
    ]);
  });

  it('parses folded YAML descriptions', () => {
    const root = makeRoot();
    writeSkill(
      root,
      'use-railway',
      `---
name: use-railway
description: >
  Operate Railway infrastructure and deployments across
  services and environments.
---`,
    );

    expect(findSkillByName('use-railway', { roots: [root] })).toEqual(
      expect.objectContaining({
        description:
          'Operate Railway infrastructure and deployments across services and environments.',
      }),
    );
  });

  it('searches by name prefix and description', () => {
    const root = makeRoot();
    writeSkill(
      root,
      'use-railway',
      `---
name: use-railway
description: Deploy and inspect Railway services
---`,
    );
    writeSkill(
      root,
      'document-release',
      `---
name: document-release
description: Update README and release docs
---`,
    );

    expect(
      searchSkills('rail', { roots: [root] }).map((skill) => skill.name),
    ).toEqual(['use-railway']);
    expect(
      searchSkills('README', { roots: [root] }).map((skill) => skill.name),
    ).toEqual(['document-release']);
  });

  it('parses inline skill references, resolves known skills, and suggests typos', () => {
    const root = makeRoot();
    writeSkill(
      root,
      'use-railway',
      `---
name: use-railway
description: Railway deploys
---`,
    );
    writeSkill(
      root,
      'document-release',
      `---
name: document-release
description: Release docs
---`,
    );

    const parsed = parseInlineSkillRefs(
      'Use +use-railway and +document-release, not +use-raiway.',
      { roots: [root] },
    );

    expect(parsed.references.map((ref) => ref.raw)).toEqual([
      '+use-railway',
      '+document-release',
      '+use-raiway',
    ]);
    expect(parsed.resolved.map((skill) => skill.name)).toEqual([
      'use-railway',
      'document-release',
    ]);
    expect(parsed.unresolved).toEqual([
      expect.objectContaining({
        reference: expect.objectContaining({ raw: '+use-raiway' }),
        suggestion: expect.objectContaining({ name: 'use-railway' }),
      }),
    ]);
  });

  it('deduplicates repeated inline references', () => {
    const root = makeRoot();
    writeSkill(
      root,
      'use-railway',
      `---
name: use-railway
description: Railway deploys
---`,
    );

    const parsed = parseInlineSkillRefs(
      '+use-railway then again +use-railway',
      { roots: [root] },
    );

    expect(parsed.references).toHaveLength(1);
    expect(parsed.resolved).toHaveLength(1);
  });

  it('ignores non-skill numeric plus tokens', () => {
    const root = makeRoot();
    writeSkill(
      root,
      'public-knowledge',
      `---
name: public-knowledge
description: Work vault
---`,
    );

    const parsed = parseInlineSkillRefs('Price is +5 today', { roots: [root] });

    expect(parsed.references).toHaveLength(0);
    expect(parsed.resolved).toHaveLength(0);
    expect(parsed.unresolved).toHaveLength(0);
  });

  it('suggests close slug typos but ignores unrelated unknown tokens', () => {
    const root = makeRoot();
    writeSkill(
      root,
      'public-knowledge',
      `---
name: public-knowledge
description: Work vault
---`,
    );

    const typoParsed = parseInlineSkillRefs('+public-knoledge', {
      roots: [root],
    });
    expect(typoParsed.unresolved).toEqual([
      expect.objectContaining({
        reference: expect.objectContaining({ raw: '+public-knoledge' }),
        suggestion: expect.objectContaining({ name: 'public-knowledge' }),
      }),
    ]);

    const unrelatedParsed = parseInlineSkillRefs('+totally-random-token', {
      roots: [root],
    });
    expect(unrelatedParsed.unresolved).toHaveLength(0);
  });

  it('formats inline skill tokens consistently', () => {
    expect(formatSkillInlineToken('use-railway')).toBe('+use-railway');
  });

  it('suggests the closest typo within a bounded distance', () => {
    const root = makeRoot();
    writeSkill(
      root,
      'use-railway',
      `---
name: use-railway
description: Railway deploys
---`,
    );
    writeSkill(
      root,
      'debug',
      `---
name: debug
description: Troubleshoot issues
---`,
    );

    expect(suggestSkill('use-raiway', { roots: [root] })?.name).toBe(
      'use-railway',
    );
    expect(suggestSkill('totally-different', { roots: [root] })).toBeNull();
  });

  it('syncs runtime skills using precedence and removes stale directories', () => {
    const highPriority = makeRoot();
    const fallback = makeRoot();
    const destination = makeRoot();

    writeSkill(
      fallback,
      'use-railway',
      `---
name: use-railway
description: Fallback description
---`,
      '# Skill\n\nFallback body.\n',
    );
    writeSkill(
      highPriority,
      'use-railway',
      `---
name: use-railway
description: Preferred description
---`,
      '# Skill\n\nPreferred body.\n',
    );
    writeSkill(
      fallback,
      'debug',
      `---
name: debug
description: Troubleshoot issues
---`,
    );

    fs.mkdirSync(path.join(destination, 'stale-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(destination, 'stale-skill', 'SKILL.md'),
      '# stale\n',
    );

    const result = syncRuntimeSkills(destination, {
      roots: [highPriority, fallback],
    });

    expect(result.copied.map((skill) => skill.name)).toEqual([
      'debug',
      'use-railway',
    ]);
    expect(result.removed).toEqual(['stale-skill']);
    expect(
      fs.readFileSync(
        path.join(destination, 'use-railway', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Preferred description');
    expect(fs.existsSync(path.join(destination, 'stale-skill'))).toBe(false);
  });

  it('classifies skills from AI_SKILLS_HOME as user-library', () => {
    const library = makeRoot();
    process.env.AI_SKILLS_HOME = library;

    writeSkill(
      library,
      'my-personal-skill',
      `---
name: my-personal-skill
description: A personal skill from the library
---`,
    );

    const skills = listSkills({ roots: [library] });
    expect(skills).toEqual([
      expect.objectContaining({
        name: 'my-personal-skill',
        source: 'user-library',
      }),
    ]);
  });

  it('getPersonalSkillLibraryPath respects AI_SKILLS_HOME env var', () => {
    process.env.AI_SKILLS_HOME = '/custom/skill/path';
    expect(getPersonalSkillLibraryPath()).toBe('/custom/skill/path');

    delete process.env.AI_SKILLS_HOME;
    expect(getPersonalSkillLibraryPath()).toBe(
      path.join(os.homedir(), '.ai', 'skills'),
    );
  });

  it('warns when configured runtime roots are missing', () => {
    const existing = makeRoot();
    const missing = path.join(existing, 'missing');

    writeSkill(
      existing,
      'debug',
      `---
name: debug
description: Troubleshoot issues
---`,
    );

    process.env.NANOCLAW_RUNTIME_SKILL_ROOTS = [existing, missing].join(
      path.delimiter,
    );

    expect(resolveRuntimeSkillRoots()).toEqual({
      roots: [existing, missing],
      source: 'env',
    });

    const destination = makeRoot();
    const result = syncRuntimeSkills(destination);

    expect(result.copied.map((skill) => skill.name)).toEqual(['debug']);
    expect(result.warnings).toEqual([
      `Runtime skill root not found: ${missing}`,
    ]);
  });
});
