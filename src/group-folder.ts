import path from 'path';

import { DATA_DIR, GROUPS_DIR, PROJECTS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);
const PROJECT_PREFIX = 'project:';

/** Check if a folder identifier refers to a project group */
export function isProjectFolder(folder: string): boolean {
  return folder.startsWith(PROJECT_PREFIX);
}

/** Extract slug from a project folder identifier (e.g., "project:home-renovation" -> "home-renovation") */
export function projectSlug(folder: string): string {
  return folder.slice(PROJECT_PREFIX.length);
}

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;

  // Project folders: "project:{slug}"
  if (isProjectFolder(folder)) {
    const slug = projectSlug(folder);
    return SLUG_PATTERN.test(slug) && !RESERVED_FOLDERS.has(slug);
  }

  // Regular group folders
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);

  if (isProjectFolder(folder)) {
    const slug = projectSlug(folder);
    const projectPath = path.resolve(PROJECTS_DIR, slug);
    ensureWithinBase(PROJECTS_DIR, projectPath);
    return projectPath;
  }

  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

/** Filesystem-safe version of folder name (replaces : with _) for session/IPC dirs */
function folderToFsName(folder: string): string {
  if (isProjectFolder(folder)) {
    return 'project_' + projectSlug(folder);
  }
  return folder;
}

/** Reverse of folderToFsName: convert filesystem directory name back to canonical folder name */
export function fsNameToFolder(fsName: string): string {
  if (fsName.startsWith('project_')) {
    return PROJECT_PREFIX + fsName.slice('project_'.length);
  }
  return fsName;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const fsName = folderToFsName(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, fsName);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

/** Resolve per-group session directory path (for .claude/, agent-runner-src, etc.) */
export function resolveGroupSessionPath(folder: string): string {
  assertValidGroupFolder(folder);
  const fsName = folderToFsName(folder);
  return path.resolve(DATA_DIR, 'sessions', fsName);
}
