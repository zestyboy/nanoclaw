import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const sessionRootRef = vi.hoisted(() => ({ current: '' }));

vi.mock('./group-folder.js', () => ({
  resolveGroupSessionPath: vi.fn(() => sessionRootRef.current),
}));

vi.mock('./config.js', () => ({
  NANOCLAW_SESSION_WARN_BYTES: 1024,
  NANOCLAW_EMBEDDED_DOC_WARN_BYTES: 512,
  NANOCLAW_SESSION_LARGEST_ENTRY_WARN_BYTES: 256,
}));

import {
  collectSessionWarnings,
  formatContextReport,
  inspectSessionTranscript,
} from './session-health.js';

function writeTranscript(sessionId: string, lines: string[]): void {
  const transcriptDir = path.join(
    sessionRootRef.current,
    '.claude',
    'projects',
    'test-project',
  );
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(transcriptDir, `${sessionId}.jsonl`),
    lines.join('\n'),
  );
}

describe('session-health', () => {
  afterEach(() => {
    if (sessionRootRef.current) {
      fs.rmSync(sessionRootRef.current, { recursive: true, force: true });
      sessionRootRef.current = '';
    }
  });

  it('inspects transcript size and embedded pdf payloads', () => {
    sessionRootRef.current = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-session-health-'),
    );

    writeTranscript('session-1', [
      JSON.stringify({
        type: 'user',
        message: { content: 'hello' },
      }),
      JSON.stringify({
        type: 'user',
        toolUseResult: {
          file: {
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            base64: 'abcd'.repeat(100),
          },
        },
      }),
      JSON.stringify({
        type: 'user',
        toolUseResult: {
          file: {
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            base64: 'efgh'.repeat(50),
          },
        },
      }),
    ]);

    const inspection = inspectSessionTranscript('project:test', 'session-1');
    expect(inspection).toEqual(
      expect.objectContaining({
        transcriptPath: expect.stringContaining('session-1.jsonl'),
        embeddedDocumentBytes: 600,
        topEmbeddedFiles: [
          expect.objectContaining({
            label: 'report.pdf',
            bytes: 600,
            occurrences: 2,
          }),
        ],
      }),
    );
    expect(inspection?.largestEntryBytes).toBeGreaterThan(256);
  });

  it('formats warnings and context report', () => {
    const metrics = {
      group_folder: 'project:test',
      session_id: 'session-1',
      transcript_bytes: 2048,
      embedded_document_bytes: 1024,
      largest_entry_bytes: 512,
      top_embedded_files: [
        { label: 'report.pdf', bytes: 1024, occurrences: 1 },
      ],
      last_input_tokens: 1200,
      last_output_tokens: 300,
      last_total_cost_usd: 0.01,
      last_model_usage: null,
      last_context_percent: 86,
      last_rate_limit_utilization: 0.74,
      rate_limit_status: 'allowed_warning',
      rate_limit_type: 'five_hour',
      rate_limit_resets_at: null,
      warned_thresholds: [],
      updated_at: new Date().toISOString(),
    };

    const warnings = collectSessionWarnings(metrics);
    expect(warnings.map((warning) => warning.key)).toEqual([
      'context:70',
      'context:85',
      'transcript_size',
      'embedded_docs',
      'largest_entry',
    ]);

    const report = formatContextReport(metrics);
    expect(report).toContain('Context [█████████░] 86%');
    expect(report).toContain('Rate Limit [███████░░░] 74%');
    expect(report).toContain('Top Embedded Files: report.pdf');
  });
});
