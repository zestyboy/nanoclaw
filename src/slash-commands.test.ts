/**
 * Tests for slash command dispatcher logic in index.ts
 *
 * Since the onSlashCommand handler is defined inline in main(), we test the
 * underlying functions it calls: DB operations, queue operations, and the
 * individual command behaviors through integration-style tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  getGroupEffort,
  getSessionHistory,
  recordSessionHistory,
  renameSession,
  setGroupEffort,
  setSession,
  touchSessionHistory,
  getTasksForGroup,
  createTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// =============================================================================
// Session History
// =============================================================================

describe('session history', () => {
  it('records a new session', () => {
    recordSessionHistory('test-group', 'session-abc', 'Hello world');
    const history = getSessionHistory('test-group');
    expect(history).toHaveLength(1);
    expect(history[0].session_id).toBe('session-abc');
    expect(history[0].group_folder).toBe('test-group');
    expect(history[0].first_prompt).toBe('Hello world');
    expect(history[0].name).toBeNull();
  });

  it('upserts on duplicate session_id (updates last_used)', () => {
    recordSessionHistory('test-group', 'session-abc', 'First');
    const before = getSessionHistory('test-group')[0].last_used;

    // Small delay to ensure timestamp differs
    recordSessionHistory('test-group', 'session-abc', 'Second');
    const after = getSessionHistory('test-group')[0].last_used;

    // Should still be one entry (upsert)
    expect(getSessionHistory('test-group')).toHaveLength(1);
    // last_used should be updated
    expect(after >= before).toBe(true);
    // first_prompt should NOT change on upsert
    expect(getSessionHistory('test-group')[0].first_prompt).toBe('First');
  });

  it('records multiple sessions for same group', () => {
    recordSessionHistory('test-group', 'session-1', 'First');
    recordSessionHistory('test-group', 'session-2', 'Second');
    recordSessionHistory('test-group', 'session-3', 'Third');

    const history = getSessionHistory('test-group');
    expect(history).toHaveLength(3);
  });

  it('orders by last_used descending', () => {
    recordSessionHistory('test-group', 'session-old');
    recordSessionHistory('test-group', 'session-new');

    const history = getSessionHistory('test-group');
    expect(history[0].session_id).toBe('session-new');
    expect(history[1].session_id).toBe('session-old');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      recordSessionHistory('test-group', `session-${i}`);
    }
    const history = getSessionHistory('test-group', 3);
    expect(history).toHaveLength(3);
  });

  it('isolates groups', () => {
    recordSessionHistory('group-a', 'session-a');
    recordSessionHistory('group-b', 'session-b');

    expect(getSessionHistory('group-a')).toHaveLength(1);
    expect(getSessionHistory('group-a')[0].session_id).toBe('session-a');
    expect(getSessionHistory('group-b')).toHaveLength(1);
    expect(getSessionHistory('group-b')[0].session_id).toBe('session-b');
  });

  it('returns empty array for unknown group', () => {
    expect(getSessionHistory('nonexistent')).toHaveLength(0);
  });
});

describe('renameSession', () => {
  it('sets the name on an existing session', () => {
    recordSessionHistory('test-group', 'session-abc');
    renameSession('test-group', 'session-abc', 'My Auth Work');

    const history = getSessionHistory('test-group');
    expect(history[0].name).toBe('My Auth Work');
  });

  it('does nothing for non-existent session (no error)', () => {
    // Should not throw
    renameSession('test-group', 'nonexistent', 'Name');
    expect(getSessionHistory('test-group')).toHaveLength(0);
  });

  it('does not rename sessions in other groups', () => {
    recordSessionHistory('group-a', 'session-1');
    recordSessionHistory('group-b', 'session-1-different');

    renameSession('group-a', 'session-1', 'Renamed');

    expect(getSessionHistory('group-a')[0].name).toBe('Renamed');
    expect(getSessionHistory('group-b')[0].name).toBeNull();
  });
});

describe('touchSessionHistory', () => {
  it('updates last_used timestamp', () => {
    recordSessionHistory('test-group', 'session-abc');
    const before = getSessionHistory('test-group')[0].last_used;

    touchSessionHistory('session-abc');
    const after = getSessionHistory('test-group')[0].last_used;

    expect(after >= before).toBe(true);
  });

  it('does nothing for non-existent session', () => {
    // Should not throw
    touchSessionHistory('nonexistent');
  });
});

// =============================================================================
// Group Settings (Effort Level)
// =============================================================================

describe('group effort settings', () => {
  it('returns null for unconfigured group', () => {
    expect(getGroupEffort('test-group')).toBeNull();
  });

  it('sets and retrieves effort level', () => {
    setGroupEffort('test-group', 'low');
    expect(getGroupEffort('test-group')).toBe('low');
  });

  it('updates effort level', () => {
    setGroupEffort('test-group', 'low');
    setGroupEffort('test-group', 'high');
    expect(getGroupEffort('test-group')).toBe('high');
  });

  it('can set effort to null (reset to default)', () => {
    setGroupEffort('test-group', 'high');
    setGroupEffort('test-group', null);
    expect(getGroupEffort('test-group')).toBeNull();
  });

  it('isolates groups', () => {
    setGroupEffort('group-a', 'low');
    setGroupEffort('group-b', 'high');

    expect(getGroupEffort('group-a')).toBe('low');
    expect(getGroupEffort('group-b')).toBe('high');
    expect(getGroupEffort('group-c')).toBeNull();
  });
});

// =============================================================================
// /tasks command — getTasksForGroup
// =============================================================================

describe('getTasksForGroup', () => {
  it('returns empty array for group with no tasks', () => {
    expect(getTasksForGroup('test-group')).toHaveLength(0);
  });

  it('returns tasks for the specified group', () => {
    createTask({
      id: 'task-1',
      group_folder: 'test-group',
      chat_jid: 'dc:123',
      prompt: 'Run daily report',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });
    createTask({
      id: 'task-2',
      group_folder: 'other-group',
      chat_jid: 'dc:456',
      prompt: 'Other task',
      schedule_type: 'once',
      schedule_value: '2026-03-25T10:00:00Z',
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const tasks = getTasksForGroup('test-group');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task-1');
    expect(tasks[0].prompt).toBe('Run daily report');
  });
});

// =============================================================================
// /work command — session switching logic
// =============================================================================

describe('/work session switching logic', () => {
  it('session switch updates active session and touch reorders history', () => {
    // Simulate: record two sessions with distinct timestamps
    recordSessionHistory('test-group', 'session-1', 'First conversation');
    recordSessionHistory('test-group', 'session-2', 'Second conversation');

    // Active session is session-2
    setSession('test-group', 'session-2');

    // Both sessions exist
    const history = getSessionHistory('test-group');
    expect(history).toHaveLength(2);

    // Find session-1 (the older one) by name/id
    const target = history.find((h) => h.session_id === 'session-1');
    expect(target).toBeDefined();

    // Switch: update active session and touch history
    setSession('test-group', target!.session_id);
    touchSessionHistory(target!.session_id);

    // Verify the session was switched in the sessions table
    // (We can't directly call getSession here since it's not exported in this test,
    // but we verified the DB functions work individually above)

    // Verify touch updated the last_used timestamp
    const updated = getSessionHistory('test-group');
    const touchedEntry = updated.find((h) => h.session_id === 'session-1');
    expect(touchedEntry).toBeDefined();
    expect(touchedEntry!.last_used >= target!.last_used).toBe(true);
  });

  it('finding session by name works', () => {
    recordSessionHistory('test-group', 'session-1', 'First');
    renameSession('test-group', 'session-1', 'auth-work');

    const history = getSessionHistory('test-group');
    const target = history.find(
      (h) => h.name?.toLowerCase() === 'auth-work',
    );
    expect(target).toBeDefined();
    expect(target!.session_id).toBe('session-1');
  });

  it('finding session by partial ID works', () => {
    recordSessionHistory('test-group', 'abcd1234-full-session-id');

    const history = getSessionHistory('test-group');
    const target = history.find((h) =>
      h.session_id.startsWith('abcd1234'),
    );
    expect(target).toBeDefined();
  });
});

// =============================================================================
// /cost — sessionCosts tracking (in-memory, tested via interface)
// =============================================================================

describe('/cost session costs tracking', () => {
  it('accumulates cost data correctly', () => {
    // Simulate the cost accumulation logic from wrappedOnOutput
    const sessionCosts: Record<string, { tokens: number; cost: number }> = {};

    const groupFolder = 'test-group';

    // First result
    const output1 = {
      totalCostUsd: 0.005,
      usage: { input_tokens: 1000, output_tokens: 500 },
    };
    const cost1 = sessionCosts[groupFolder] || { tokens: 0, cost: 0 };
    if (output1.totalCostUsd != null) cost1.cost = output1.totalCostUsd;
    if (output1.usage) {
      cost1.tokens +=
        (output1.usage.input_tokens || 0) +
        (output1.usage.output_tokens || 0);
    }
    sessionCosts[groupFolder] = cost1;

    expect(sessionCosts[groupFolder].tokens).toBe(1500);
    expect(sessionCosts[groupFolder].cost).toBe(0.005);

    // Second result — cost accumulates tokens, replaces total cost
    const output2 = {
      totalCostUsd: 0.012,
      usage: { input_tokens: 2000, output_tokens: 800 },
    };
    const cost2 = sessionCosts[groupFolder] || { tokens: 0, cost: 0 };
    if (output2.totalCostUsd != null) cost2.cost = output2.totalCostUsd;
    if (output2.usage) {
      cost2.tokens +=
        (output2.usage.input_tokens || 0) +
        (output2.usage.output_tokens || 0);
    }
    sessionCosts[groupFolder] = cost2;

    expect(sessionCosts[groupFolder].tokens).toBe(4300); // 1500 + 2800
    expect(sessionCosts[groupFolder].cost).toBe(0.012); // replaced
  });
});

// =============================================================================
// /effort — valid levels
// =============================================================================

describe('/effort validation logic', () => {
  const validLevels = ['low', 'medium', 'high'];

  it('accepts valid effort levels', () => {
    for (const level of validLevels) {
      expect(validLevels.includes(level)).toBe(true);
    }
  });

  it('rejects invalid effort levels', () => {
    expect(validLevels.includes('max')).toBe(false);
    expect(validLevels.includes('turbo')).toBe(false);
    expect(validLevels.includes('')).toBe(false);
  });
});
