import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  clearActiveSession,
  resetGroupSessionFilesystem,
} from './session-clear.js';

describe('clearActiveSession', () => {
  it('closes the active agent before clearing persisted session state', () => {
    const deps = {
      closeStdin: vi.fn(),
      clearSessionState: vi.fn(),
      resetSessionFilesystem: vi.fn(),
      saveState: vi.fn(),
      setLastAgentTimestamp: vi.fn(),
    };

    clearActiveSession(
      {
        chatJid: 'dc:123',
        groupFolder: 'main',
      },
      deps,
    );

    expect(deps.closeStdin).toHaveBeenCalledWith('dc:123');
    expect(deps.clearSessionState).toHaveBeenCalledWith('main');
    expect(deps.resetSessionFilesystem).toHaveBeenCalledWith('main');
    expect(deps.saveState).toHaveBeenCalled();
    expect(deps.setLastAgentTimestamp).not.toHaveBeenCalled();
  });

  it('updates the last-agent cursor when a clear command consumed a message', () => {
    const deps = {
      closeStdin: vi.fn(),
      clearSessionState: vi.fn(),
      resetSessionFilesystem: vi.fn(),
      saveState: vi.fn(),
      setLastAgentTimestamp: vi.fn(),
    };

    clearActiveSession(
      {
        chatJid: 'dc:123',
        groupFolder: 'main',
        timestamp: '2026-03-21T07:04:30.545Z',
      },
      deps,
    );

    expect(deps.setLastAgentTimestamp).toHaveBeenCalledWith(
      'dc:123',
      '2026-03-21T07:04:30.545Z',
    );
  });

  it('removes persisted Claude session files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-clear-'));
    const sessionDir = path.join(root, 'main');
    fs.mkdirSync(path.join(sessionDir, '.claude', 'projects'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(sessionDir, '.claude', 'projects', 'session.jsonl'),
      '{}\n',
    );

    resetGroupSessionFilesystem('main', () => sessionDir);

    expect(fs.existsSync(sessionDir)).toBe(false);
  });
});
