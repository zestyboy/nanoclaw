import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';

export interface SkillSummary {
  name: string;
  description: string;
  skillPath: string;
  rootPath: string;
  /** Parent package name if this is a sub-skill (e.g. "gstack" for gstack/browse). */
  package?: string;
  source:
    | 'repo-agent'
    | 'repo-codex'
    | 'user-agent'
    | 'user-codex'
    | 'user-library'
    | 'container';
}

export interface InlineSkillReference {
  raw: string;
  name: string;
  index: number;
}

export interface UnresolvedInlineSkillReference {
  reference: InlineSkillReference;
  suggestion: SkillSummary | null;
}

export interface ParsedSkillRefs {
  references: InlineSkillReference[];
  resolved: SkillSummary[];
  unresolved: UnresolvedInlineSkillReference[];
}

export interface SkillCatalogOptions {
  roots?: string[];
}

export interface RuntimeSkillRootResolution {
  roots: string[];
  source: 'default' | 'env';
}

export interface RuntimeSkillSyncResult {
  copied: SkillSummary[];
  removed: string[];
  warnings: string[];
  roots: string[];
}

const INLINE_SKILL_RE = /(^|[^\w/])\+([a-z][a-z0-9-_]*)\b/gi;
const RUNTIME_SKILL_ROOTS_ENV = 'NANOCLAW_RUNTIME_SKILL_ROOTS';

type SkillSource = SkillSummary['source'];

/** Canonical personal skill library path. */
export function getPersonalSkillLibraryPath(): string {
  return process.env.AI_SKILLS_HOME || path.join(os.homedir(), '.ai', 'skills');
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    deduped.push(resolved);
  }

  return deduped;
}

function classifySkillRoot(rootPath: string): SkillSource {
  const normalized = rootPath.split(path.sep).join('/');
  const cwd = process.cwd().split(path.sep).join('/');
  const home = os.homedir().split(path.sep).join('/');
  const aiSkillsHome = (process.env.AI_SKILLS_HOME || `${home}/.ai/skills`)
    .split(path.sep)
    .join('/');

  if (normalized === `${cwd}/.agents/skills`) return 'repo-agent';
  if (normalized === `${cwd}/.codex/skills`) return 'repo-codex';
  if (normalized === `${cwd}/container/skills`) return 'container';
  if (normalized === aiSkillsHome) return 'user-library';
  if (normalized === `${home}/.agents/skills`) return 'user-agent';
  if (normalized === `${home}/.codex/skills`) return 'user-codex';
  if (normalized.includes('/container/skills')) return 'container';
  if (normalized.includes('/.codex/skills')) return 'user-codex';
  return 'user-agent';
}

function getDefaultSkillRoots(): string[] {
  const cwd = process.cwd();
  const home = os.homedir();
  const codeHome = process.env.CODEX_HOME;
  const aiHome = process.env.AI_SKILLS_HOME || path.join(home, '.ai', 'skills');

  return dedupePaths(
    [
      path.join(cwd, '.agents', 'skills'),
      path.join(cwd, '.codex', 'skills'),
      aiHome,
      path.join(home, '.agents', 'skills'),
      path.join(home, '.codex', 'skills'),
      codeHome ? path.join(codeHome, 'skills') : null,
      path.join(cwd, 'container', 'skills'),
    ].filter((value): value is string => Boolean(value)),
  );
}

function parseConfiguredRootList(value: string | undefined): string[] {
  if (!value) return [];

  return dedupePaths(
    value
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function resolveRuntimeSkillRoots(): RuntimeSkillRootResolution {
  const configured = parseConfiguredRootList(
    process.env[RUNTIME_SKILL_ROOTS_ENV],
  );
  if (configured.length > 0) {
    return {
      roots: configured,
      source: 'env',
    };
  }

  return {
    roots: getDefaultSkillRoots(),
    source: 'default',
  };
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return {};

  try {
    const parsed = YAML.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function fallbackDescription(content: string): string {
  const body = content
    .replace(/^---\s*\n[\s\S]*?\n---\s*/m, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));

  return body || '';
}

function normalizeDescription(description: unknown, content: string): string {
  if (typeof description === 'string' && description.trim()) {
    return description.replace(/\s+/g, ' ').trim();
  }

  return fallbackDescription(content).replace(/\s+/g, ' ').trim();
}

function readSkillSummary(
  rootPath: string,
  skillDirName: string,
): SkillSummary | null {
  const skillPath = path.join(rootPath, skillDirName);
  const skillFile = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;

  let content: string;
  try {
    content = fs.readFileSync(skillFile, 'utf8');
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(content);
  const rawName = frontmatter.name;
  const name =
    typeof rawName === 'string' && rawName.trim()
      ? rawName.trim()
      : skillDirName;

  return {
    name,
    description: normalizeDescription(frontmatter.description, content),
    skillPath,
    rootPath,
    source: classifySkillRoot(rootPath),
  };
}

function scanSkills(roots: string[]): SkillSummary[] {
  const byName = new Map<string, SkillSummary>();

  for (const rootPath of roots) {
    if (!fs.existsSync(rootPath)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const summary = readSkillSummary(rootPath, entry.name);
      if (summary) {
        const key = summary.name.toLowerCase();
        if (!byName.has(key)) {
          byName.set(key, summary);
        }
      }

      // Scan sub-skills inside parent directories (e.g. gstack/browse)
      const parentDir = path.join(rootPath, entry.name);
      let subEntries: fs.Dirent[];
      try {
        subEntries = fs.readdirSync(parentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        const subSummary = readSkillSummary(parentDir, sub.name);
        if (!subSummary) continue;
        subSummary.package = entry.name;
        const subKey = subSummary.name.toLowerCase();
        if (!byName.has(subKey)) {
          byName.set(subKey, subSummary);
        }
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scoreSkillMatch(skill: SkillSummary, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;

  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();

  if (name === needle) return 120;
  if (name.startsWith(needle)) return 100 - (name.length - needle.length);
  if (name.includes(needle)) return 80;
  if (description.includes(needle)) return 40;

  const compactNeedle = needle.replace(/[\s_-]+/g, '');
  const compactName = name.replace(/[\s_-]+/g, '');
  if (compactName.includes(compactNeedle)) return 30;

  return 0;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const temp = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }

  return previous[b.length];
}

export function listSkills(options: SkillCatalogOptions = {}): SkillSummary[] {
  const roots = options.roots
    ? dedupePaths(options.roots)
    : resolveRuntimeSkillRoots().roots;

  return scanSkills(roots);
}

export function syncRuntimeSkills(
  destinationRoot: string,
  options: SkillCatalogOptions = {},
): RuntimeSkillSyncResult {
  const resolution = options.roots
    ? {
        roots: dedupePaths(options.roots),
        source: 'env' as const,
      }
    : resolveRuntimeSkillRoots();
  const warnings: string[] = [];

  if (resolution.source === 'env') {
    for (const rootPath of resolution.roots) {
      if (!fs.existsSync(rootPath)) {
        warnings.push(`Runtime skill root not found: ${rootPath}`);
        continue;
      }

      try {
        fs.readdirSync(rootPath, { withFileTypes: true });
      } catch (error) {
        warnings.push(
          `Runtime skill root unreadable: ${rootPath} (${String(error)})`,
        );
      }
    }
  }

  const skills = scanSkills(resolution.roots);
  fs.mkdirSync(destinationRoot, { recursive: true });

  const desiredDirs = new Set<string>();
  for (const skill of skills) {
    const destination = path.join(destinationRoot, skill.name);
    desiredDirs.add(skill.name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(skill.skillPath, destination, { recursive: true });
  }

  const removed: string[] = [];
  let existingEntries: fs.Dirent[] = [];
  try {
    existingEntries = fs.readdirSync(destinationRoot, { withFileTypes: true });
  } catch {
    existingEntries = [];
  }

  for (const entry of existingEntries) {
    if (!entry.isDirectory()) continue;
    if (desiredDirs.has(entry.name)) continue;
    removed.push(entry.name);
    fs.rmSync(path.join(destinationRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }

  return {
    copied: skills,
    removed: removed.sort((a, b) => a.localeCompare(b)),
    warnings,
    roots: resolution.roots,
  };
}

export function findSkillByName(
  name: string,
  options: SkillCatalogOptions = {},
): SkillSummary | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;

  return (
    listSkills(options).find((skill) => skill.name.toLowerCase() === needle) ||
    null
  );
}

export function searchSkills(
  query: string,
  options: SkillCatalogOptions = {},
): SkillSummary[] {
  const skills = listSkills(options);
  const scored = skills
    .map((skill) => ({
      skill,
      score: scoreSkillMatch(skill, query),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
    );

  return scored.map((entry) => entry.skill);
}

export function suggestSkill(
  input: string,
  options: SkillCatalogOptions = {},
): SkillSummary | null {
  const needle = input.trim().toLowerCase();
  if (!needle) return null;

  const skills = listSkills(options);
  let best: { skill: SkillSummary; distance: number } | null = null;

  for (const skill of skills) {
    const distance = levenshtein(needle, skill.name.toLowerCase());
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance &&
        skill.name.localeCompare(best.skill.name) < 0)
    ) {
      best = { skill, distance };
    }
  }

  if (!best) return null;

  const threshold = Math.max(2, Math.ceil(needle.length * 0.25));
  return best.distance <= threshold ? best.skill : null;
}

export function formatSkillInlineToken(name: string): string {
  return `+${name}`;
}

export function parseInlineSkillRefs(
  text: string,
  options: SkillCatalogOptions = {},
): ParsedSkillRefs {
  const references: InlineSkillReference[] = [];
  const seenByName = new Set<string>();

  for (const match of text.matchAll(INLINE_SKILL_RE)) {
    const raw = `+${match[2]}`;
    const name = match[2];
    const index = (match.index || 0) + match[1].length;
    const key = name.toLowerCase();
    if (seenByName.has(key)) continue;
    seenByName.add(key);
    references.push({ raw, name, index });
  }

  const resolved: SkillSummary[] = [];
  const unresolved: UnresolvedInlineSkillReference[] = [];

  for (const reference of references) {
    const skill = findSkillByName(reference.name, options);
    if (skill) {
      resolved.push(skill);
      continue;
    }

    const suggestion = suggestSkill(reference.name, options);
    if (!suggestion) {
      continue;
    }

    unresolved.push({
      reference,
      suggestion,
    });
  }

  return { references, resolved, unresolved };
}
