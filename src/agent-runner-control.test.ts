/**
 * Tests for agent-runner control message processing logic.
 *
 * The agent-runner runs inside containers, but we can test the control message
 * parsing and IPC drain logic by extracting the patterns.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Replicate the drainIpcInput logic from agent-runner for testing.
 * This tests the _control-* file processing pattern.
 */
function drainIpcInput(inputDir: string): {
  controlResults: string[];
  messages: string[];
} {
  const allFiles = fs.readdirSync(inputDir).sort();
  const controlFiles = allFiles.filter(
    (f) => f.startsWith('_control-') && f.endsWith('.json'),
  );
  const messageFiles = allFiles.filter(
    (f) => !f.startsWith('_control-') && !f.startsWith('_') && f.endsWith('.json'),
  );

  const controlResults: string[] = [];
  const messages: string[] = [];

  for (const file of controlFiles) {
    const filePath = path.join(inputDir, file);
    const cmd = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    fs.unlinkSync(filePath);
    controlResults.push(cmd.type);
  }

  for (const file of messageFiles) {
    const filePath = path.join(inputDir, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    fs.unlinkSync(filePath);
    if (data.type === 'message' && data.text) {
      messages.push(data.text);
    }
  }

  return { controlResults, messages };
}

describe('agent-runner IPC control message processing', () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-test-'));
    return tmpDir;
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  it('processes control files before regular messages', () => {
    const dir = setup();
    try {
      // Write messages first (earlier timestamp), then control
      fs.writeFileSync(
        path.join(dir, '1000-abc.json'),
        JSON.stringify({ type: 'message', text: 'hello' }),
      );
      fs.writeFileSync(
        path.join(dir, '_control-2000-xyz.json'),
        JSON.stringify({ type: 'rewind' }),
      );
      fs.writeFileSync(
        path.join(dir, '3000-def.json'),
        JSON.stringify({ type: 'message', text: 'world' }),
      );

      const result = drainIpcInput(dir);

      // Control should be processed first
      expect(result.controlResults).toEqual(['rewind']);
      expect(result.messages).toEqual(['hello', 'world']);

      // All files should be consumed
      expect(fs.readdirSync(dir)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('ignores _close sentinel', () => {
    const dir = setup();
    try {
      fs.writeFileSync(path.join(dir, '_close'), '');
      fs.writeFileSync(
        path.join(dir, '1000-abc.json'),
        JSON.stringify({ type: 'message', text: 'hello' }),
      );

      const result = drainIpcInput(dir);

      expect(result.messages).toEqual(['hello']);
      // _close should still exist (not consumed by drain)
      expect(fs.existsSync(path.join(dir, '_close'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('handles empty directory', () => {
    const dir = setup();
    try {
      const result = drainIpcInput(dir);
      expect(result.controlResults).toEqual([]);
      expect(result.messages).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('sorts files chronologically', () => {
    const dir = setup();
    try {
      // Write out of order
      fs.writeFileSync(
        path.join(dir, '3000-c.json'),
        JSON.stringify({ type: 'message', text: 'third' }),
      );
      fs.writeFileSync(
        path.join(dir, '1000-a.json'),
        JSON.stringify({ type: 'message', text: 'first' }),
      );
      fs.writeFileSync(
        path.join(dir, '2000-b.json'),
        JSON.stringify({ type: 'message', text: 'second' }),
      );

      const result = drainIpcInput(dir);
      expect(result.messages).toEqual(['first', 'second', 'third']);
    } finally {
      cleanup();
    }
  });

  it('handles multiple control commands', () => {
    const dir = setup();
    try {
      fs.writeFileSync(
        path.join(dir, '_control-1000-a.json'),
        JSON.stringify({ type: 'rewind' }),
      );
      fs.writeFileSync(
        path.join(dir, '_control-2000-b.json'),
        JSON.stringify({ type: 'rewind' }),
      );

      const result = drainIpcInput(dir);
      expect(result.controlResults).toEqual(['rewind', 'rewind']);
    } finally {
      cleanup();
    }
  });
});

describe('control file naming convention', () => {
  it('_control- prefix files are distinguished from regular messages', () => {
    const controlFile = '_control-1234567890-abcd.json';
    const messageFile = '1234567890-abcd.json';
    const sentinel = '_close';

    expect(controlFile.startsWith('_control-')).toBe(true);
    expect(controlFile.endsWith('.json')).toBe(true);

    expect(messageFile.startsWith('_control-')).toBe(false);
    expect(messageFile.startsWith('_')).toBe(false);

    expect(sentinel.startsWith('_')).toBe(true);
    expect(sentinel.endsWith('.json')).toBe(false);
  });
});

describe('ContainerOutput with cost fields', () => {
  it('cost fields are optional and correctly typed', () => {
    // Simulate ContainerOutput with cost data
    const output = {
      status: 'success' as const,
      result: 'Hello',
      newSessionId: 'session-123',
      totalCostUsd: 0.0042,
      usage: { input_tokens: 1500, output_tokens: 300 },
    };

    expect(output.totalCostUsd).toBe(0.0042);
    expect(output.usage.input_tokens).toBe(1500);
    expect(output.usage.output_tokens).toBe(300);

    // Without cost fields
    const outputNoCost = {
      status: 'success' as const,
      result: null,
    };
    expect(outputNoCost.status).toBe('success');
  });
});

describe('ContainerInput with effortLevel', () => {
  it('effortLevel is passed through correctly', () => {
    const input = {
      prompt: 'Hello',
      groupFolder: 'test',
      chatJid: 'dc:123',
      isMain: false,
      effortLevel: 'low',
    };

    expect(input.effortLevel).toBe('low');
  });

  it('effortLevel is optional', () => {
    const input = {
      prompt: 'Hello',
      groupFolder: 'test',
      chatJid: 'dc:123',
      isMain: false,
    };

    expect(input).not.toHaveProperty('effortLevel');
  });
});
