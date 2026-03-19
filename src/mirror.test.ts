import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  activateMirror,
  deactivateMirror,
  getMirrorsForSource,
  recordOutbound,
  recordInbound,
  formatRetroactiveMessages,
  cleanupExpiredMirrors,
  _clearAllMirrors,
  _getActiveMirrorCount,
} from './mirror.js';

beforeEach(() => {
  _clearAllMirrors();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('activateMirror', () => {
  it('creates a mirror and returns no retroactive records when buffer is empty', () => {
    const result = activateMirror('dc:111', 'dc:222', 'Test Project');
    expect(result.activated).toBe(true);
    expect(result.retroactive).toHaveLength(0);
    expect(_getActiveMirrorCount()).toBe(1);
  });

  it('refreshes expiry when activated again for the same pair', () => {
    activateMirror('dc:111', 'dc:222', 'Test Project', 10);
    const result = activateMirror('dc:111', 'dc:222', 'Test Project', 60);
    expect(_getActiveMirrorCount()).toBe(1);
    expect(result.retroactive).toHaveLength(0);
  });

  it('allows multiple mirrors from the same source', () => {
    activateMirror('dc:111', 'dc:222', 'Project A');
    activateMirror('dc:111', 'dc:333', 'Project B');
    expect(_getActiveMirrorCount()).toBe(2);
    expect(getMirrorsForSource('dc:111')).toHaveLength(2);
  });

  it('evicts oldest mirror when max per source is exceeded', () => {
    activateMirror('dc:111', 'dc:222', 'Project A');
    activateMirror('dc:111', 'dc:333', 'Project B');
    activateMirror('dc:111', 'dc:444', 'Project C');
    // 3 mirrors — at the limit
    expect(getMirrorsForSource('dc:111')).toHaveLength(3);

    // 4th should evict the oldest
    activateMirror('dc:111', 'dc:555', 'Project D');
    const mirrors = getMirrorsForSource('dc:111');
    expect(mirrors).toHaveLength(3);
    expect(mirrors.find((m) => m.targetJid === 'dc:222')).toBeUndefined();
    expect(mirrors.find((m) => m.targetJid === 'dc:555')).toBeDefined();
  });

  it('rejects a mirror that would create a loop', () => {
    activateMirror('dc:111', 'dc:222', 'Forward');
    const result = activateMirror('dc:222', 'dc:111', 'Backward');
    expect(result.activated).toBe(false);
    expect(_getActiveMirrorCount()).toBe(1);
  });

  it('returns retroactive records from the buffer', () => {
    recordOutbound('dc:111', 'Hello from bot');
    recordInbound('dc:111', 'Hello from user', 'Alice');
    recordOutbound('dc:111', 'Bot reply');

    const result = activateMirror('dc:111', 'dc:222', 'Test Project');
    expect(result.retroactive).toHaveLength(3);
    expect(result.retroactive[0].text).toBe('Hello from bot');
    expect(result.retroactive[1].text).toBe('Hello from user');
    expect(result.retroactive[1].isUserMessage).toBe(true);
    expect(result.retroactive[1].senderName).toBe('Alice');
    expect(result.retroactive[2].text).toBe('Bot reply');
  });

  it('only returns retroactive records for the correct source JID', () => {
    recordOutbound('dc:111', 'From source');
    recordOutbound('dc:999', 'From other');

    const result = activateMirror('dc:111', 'dc:222', 'Test Project');
    expect(result.retroactive).toHaveLength(1);
    expect(result.retroactive[0].text).toBe('From source');
  });

  it('treats an expired mirror as a new activation and returns catch-up', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    activateMirror('dc:111', 'dc:222', 'Test Project', 1);

    vi.spyOn(Date, 'now').mockReturnValue(70_000);
    recordOutbound('dc:111', 'Recent bot update');

    const result = activateMirror('dc:111', 'dc:222', 'Test Project', 30);
    expect(result.retroactive).toHaveLength(1);
    expect(result.retroactive[0].text).toBe('Recent bot update');
  });
});

describe('deactivateMirror', () => {
  it('removes a specific mirror', () => {
    activateMirror('dc:111', 'dc:222', 'A');
    activateMirror('dc:111', 'dc:333', 'B');
    expect(deactivateMirror('dc:111', 'dc:222')).toBe(true);
    expect(getMirrorsForSource('dc:111')).toHaveLength(1);
    expect(getMirrorsForSource('dc:111')[0].targetJid).toBe('dc:333');
  });

  it('removes all mirrors for a source when no target specified', () => {
    activateMirror('dc:111', 'dc:222', 'A');
    activateMirror('dc:111', 'dc:333', 'B');
    expect(deactivateMirror('dc:111')).toBe(true);
    expect(getMirrorsForSource('dc:111')).toHaveLength(0);
  });

  it('returns false when no mirror exists', () => {
    expect(deactivateMirror('dc:999')).toBe(false);
    expect(deactivateMirror('dc:111', 'dc:222')).toBe(false);
  });
});

describe('getMirrorsForSource', () => {
  it('returns empty array for unknown source', () => {
    expect(getMirrorsForSource('dc:unknown')).toHaveLength(0);
  });

  it('filters out expired mirrors', () => {
    // Activate with 0 duration (expires immediately)
    activateMirror('dc:111', 'dc:222', 'Test', 0);
    // Wait a tiny bit to ensure expiry
    expect(getMirrorsForSource('dc:111')).toHaveLength(0);
  });
});

describe('formatRetroactiveMessages', () => {
  it('returns empty string for empty records', () => {
    expect(formatRetroactiveMessages([])).toBe('');
  });

  it('formats user messages with sender name', () => {
    const result = formatRetroactiveMessages([
      {
        jid: 'dc:111',
        text: 'Hello!',
        timestamp: Date.now(),
        senderName: 'Alice',
        isUserMessage: true,
      },
    ]);
    expect(result).toContain('**Alice**: Hello!');
  });

  it('formats bot messages without prefix', () => {
    const result = formatRetroactiveMessages([
      {
        jid: 'dc:111',
        text: 'Bot says hi',
        timestamp: Date.now(),
        isUserMessage: false,
      },
    ]);
    expect(result).toContain('Bot says hi');
    expect(result).not.toContain('**');
  });

  it('formats mixed messages in order', () => {
    const result = formatRetroactiveMessages([
      {
        jid: 'dc:111',
        text: 'User question',
        timestamp: 1,
        senderName: 'Bob',
        isUserMessage: true,
      },
      {
        jid: 'dc:111',
        text: 'Bot answer',
        timestamp: 2,
        isUserMessage: false,
      },
    ]);
    expect(result).toContain('**Bob**: User question');
    expect(result).toContain('Bot answer');
    expect(result.indexOf('User question')).toBeLessThan(
      result.indexOf('Bot answer'),
    );
  });
});

describe('cleanupExpiredMirrors', () => {
  it('removes expired mirrors', () => {
    activateMirror('dc:111', 'dc:222', 'Test', 0);
    expect(_getActiveMirrorCount()).toBe(1);
    const cleaned = cleanupExpiredMirrors();
    expect(cleaned).toBe(1);
    expect(_getActiveMirrorCount()).toBe(0);
  });

  it('preserves active mirrors', () => {
    activateMirror('dc:111', 'dc:222', 'Test', 60);
    const cleaned = cleanupExpiredMirrors();
    expect(cleaned).toBe(0);
    expect(_getActiveMirrorCount()).toBe(1);
  });
});
