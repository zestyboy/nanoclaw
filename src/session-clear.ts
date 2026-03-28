import fs from 'fs';

import { resolveGroupSessionPath } from './group-folder.js';

export interface ClearActiveSessionOptions {
  chatJid: string;
  groupFolder: string;
  timestamp?: string;
}

export interface ClearActiveSessionDeps {
  closeStdin: (chatJid: string) => void;
  clearSessionState: (groupFolder: string) => void;
  resetSessionFilesystem: (groupFolder: string) => void;
  saveState: () => void;
  setLastAgentTimestamp?: (chatJid: string, timestamp: string) => void;
}

export function resetGroupSessionFilesystem(
  groupFolder: string,
  resolvePath: (groupFolder: string) => string = resolveGroupSessionPath,
): void {
  fs.rmSync(resolvePath(groupFolder), {
    recursive: true,
    force: true,
  });
}

export function clearActiveSession(
  options: ClearActiveSessionOptions,
  deps: ClearActiveSessionDeps,
): void {
  deps.closeStdin(options.chatJid);
  deps.clearSessionState(options.groupFolder);
  deps.resetSessionFilesystem(options.groupFolder);
  if (options.timestamp) {
    deps.setLastAgentTimestamp?.(options.chatJid, options.timestamp);
  }
  deps.saveState();
}
