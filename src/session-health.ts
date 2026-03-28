import fs from 'fs';
import path from 'path';

import {
  NANOCLAW_EMBEDDED_DOC_WARN_BYTES,
  NANOCLAW_SESSION_LARGEST_ENTRY_WARN_BYTES,
  NANOCLAW_SESSION_WARN_BYTES,
} from './config.js';
import { resolveGroupSessionPath } from './group-folder.js';
import {
  AgentModelUsage,
  AgentUsageSnapshot,
  SessionEmbeddedFile,
  SessionMetrics,
} from './types.js';

export interface TranscriptInspection {
  transcriptPath: string | null;
  transcriptBytes: number;
  embeddedDocumentBytes: number;
  largestEntryBytes: number;
  topEmbeddedFiles: SessionEmbeddedFile[];
}

export interface SessionWarning {
  key: string;
  message: string;
  /** Additional threshold keys to mark as warned (avoids re-firing lower thresholds). */
  extraKeys?: string[];
}

const CONTEXT_THRESHOLDS = [70, 85, 95] as const;

function walkForTranscript(dir: string, sessionId: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = walkForTranscript(fullPath, sessionId);
      if (nested) return nested;
      continue;
    }
    if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
      return fullPath;
    }
  }
  return null;
}

function basenameHint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const name = path.posix.basename(trimmed);
  return name.toLowerCase().endsWith('.pdf') ? name : null;
}

function getPdfLabel(node: Record<string, unknown>): string {
  return (
    basenameHint(node.file_name) ||
    basenameHint(node.filename) ||
    basenameHint(node.name) ||
    basenameHint(node.path) ||
    basenameHint(node.url) ||
    'embedded.pdf'
  );
}

function isPdfNode(node: Record<string, unknown>): boolean {
  const mime = [node.mimeType, node.mime_type, node.media_type, node.type]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return mime.includes('pdf') || getPdfLabel(node) !== 'embedded.pdf';
}

function collectEmbeddedPdfStats(
  value: unknown,
  files: Map<string, SessionEmbeddedFile>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEmbeddedPdfStats(item, files);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  if (typeof node.base64 === 'string' && isPdfNode(node)) {
    const label = getPdfLabel(node);
    const bytes = Buffer.byteLength(node.base64, 'utf8');
    const existing = files.get(label);
    if (existing) {
      existing.bytes += bytes;
      existing.occurrences += 1;
    } else {
      files.set(label, { label, bytes, occurrences: 1 });
    }
  }

  for (const child of Object.values(node)) {
    collectEmbeddedPdfStats(child, files);
  }
}

export function inspectSessionTranscript(
  groupFolder: string,
  sessionId: string,
): TranscriptInspection | null {
  const claudeProjectsDir = path.join(
    resolveGroupSessionPath(groupFolder),
    '.claude',
    'projects',
  );
  const transcriptPath = walkForTranscript(claudeProjectsDir, sessionId);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null;
  }

  const content = fs.readFileSync(transcriptPath, 'utf8');
  let largestEntryBytes = 0;
  const embeddedFiles = new Map<string, SessionEmbeddedFile>();

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    largestEntryBytes = Math.max(largestEntryBytes, lineBytes);
    try {
      collectEmbeddedPdfStats(JSON.parse(line), embeddedFiles);
    } catch {
      continue;
    }
  }

  const allEmbeddedFiles = [...embeddedFiles.values()].sort(
    (a, b) => b.bytes - a.bytes,
  );
  const topEmbeddedFiles = allEmbeddedFiles.slice(0, 5);

  return {
    transcriptPath,
    transcriptBytes: Buffer.byteLength(content, 'utf8'),
    embeddedDocumentBytes: allEmbeddedFiles.reduce(
      (sum, item) => sum + item.bytes,
      0,
    ),
    largestEntryBytes,
    topEmbeddedFiles,
  };
}

// Approximate bytes-per-token for JSONL transcripts (JSON is verbose).
const BYTES_PER_TOKEN = 4;
// Estimated tokens consumed by system prompt, tool definitions, and CLAUDE.md.
const SYSTEM_OVERHEAD_TOKENS = 50_000;

export function estimateContextPercent(
  usage: Pick<
    AgentUsageSnapshot,
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadInputTokens'
    | 'cacheCreationInputTokens'
    | 'modelUsage'
  >,
  transcriptBytes?: number,
): number | null {
  const modelUsage = usage.modelUsage;
  if (!modelUsage) return null;

  const contextWindow = Math.max(
    0,
    ...Object.values(modelUsage).map((item) => item.contextWindow || 0),
  );
  if (!contextWindow) return null;

  // Prefer transcript-based estimate: the SDK's usage fields are cumulative
  // across all API calls in a query(), so summing them overstates actual
  // context window utilisation (e.g. 5 tool-call roundtrips each reading
  // 200K from cache reports 1M cumulative cache_read_input_tokens).
  if (transcriptBytes != null && transcriptBytes > 0) {
    const estimatedTokens =
      Math.round(transcriptBytes / BYTES_PER_TOKEN) + SYSTEM_OVERHEAD_TOKENS;
    return Math.min(100, Math.round((estimatedTokens / contextWindow) * 100));
  }

  // Fallback: use cumulative token counts (known to overestimate).
  const totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens;

  if (totalTokens <= 0) return 0;
  return Math.min(100, Math.round((totalTokens / contextWindow) * 100));
}

export function renderUsageBar(percent: number | null): string {
  if (percent === null || Number.isNaN(percent)) return '[??????????]';
  const normalized = Math.max(0, Math.min(100, percent));
  const filled = Math.round(normalized / 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function buildThresholdKey(prefix: string, threshold: number): string {
  return `${prefix}:${threshold}`;
}

export function collectSessionWarnings(
  metrics: SessionMetrics,
): SessionWarning[] {
  const warnings: SessionWarning[] = [];
  const warned = new Set(metrics.warned_thresholds);

  // Only emit the highest applicable threshold to avoid spamming all three
  // warnings at once when context jumps past multiple thresholds.
  let highestNewThreshold: (typeof CONTEXT_THRESHOLDS)[number] | null = null;
  let highestNewKey: string | null = null;
  const newContextKeys: string[] = [];

  for (const threshold of CONTEXT_THRESHOLDS) {
    const key = buildThresholdKey('context', threshold);
    if (
      metrics.last_context_percent !== null &&
      metrics.last_context_percent >= threshold &&
      !warned.has(key)
    ) {
      newContextKeys.push(key);
      highestNewThreshold = threshold;
      highestNewKey = key;
    }
  }

  if (highestNewThreshold !== null && highestNewKey !== null) {
    const urgency =
      highestNewThreshold >= 95
        ? 'Session context is nearly exhausted.'
        : highestNewThreshold >= 85
          ? 'Session context is getting expensive.'
          : 'Session context is filling up.';
    warnings.push({
      key: highestNewKey,
      message: `${urgency} Context ${renderUsageBar(metrics.last_context_percent)} ${metrics.last_context_percent}%. Run \`/context\` to inspect usage and \`/clear\` when you want a fresh session.`,
      extraKeys: newContextKeys.filter((k) => k !== highestNewKey),
    });
  }

  if (
    metrics.transcript_bytes >= NANOCLAW_SESSION_WARN_BYTES &&
    !warned.has('transcript_size')
  ) {
    warnings.push({
      key: 'transcript_size',
      message: `Session transcript is ${formatBytes(metrics.transcript_bytes)}. Run \`/clear\` when you no longer need the current Claude session history.`,
    });
  }

  if (
    metrics.embedded_document_bytes >= NANOCLAW_EMBEDDED_DOC_WARN_BYTES &&
    !warned.has('embedded_docs')
  ) {
    warnings.push({
      key: 'embedded_docs',
      message: `Embedded PDF content in this session is ${formatBytes(metrics.embedded_document_bytes)}. Use extracted text files and clear the session once the attachment work is done.`,
    });
  }

  if (
    metrics.largest_entry_bytes >= NANOCLAW_SESSION_LARGEST_ENTRY_WARN_BYTES &&
    !warned.has('largest_entry')
  ) {
    warnings.push({
      key: 'largest_entry',
      message: `A single session entry is ${formatBytes(metrics.largest_entry_bytes)}. Large attachment payloads can make Claude sessions unreliable; consider \`/clear\`.`,
    });
  }

  return warnings;
}

export function mergeWarnedThresholds(
  metrics: SessionMetrics,
  warningKeys: string[],
): string[] {
  return [...new Set([...metrics.warned_thresholds, ...warningKeys])];
}

export function summarizeTopEmbeddedFiles(
  files: SessionEmbeddedFile[],
  limit = 3,
): string {
  if (files.length === 0) return 'none';
  return files
    .slice(0, limit)
    .map(
      (file) =>
        `${file.label} (${formatBytes(file.bytes)}, ${file.occurrences}x)`,
    )
    .join(', ');
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** Extract the API-confirmed model ID and context window from session metrics. */
export function getConfirmedModel(
  metrics: SessionMetrics | undefined,
): { model: string; contextWindow: number } | null {
  if (!metrics?.last_model_usage) return null;
  const entries = Object.entries(metrics.last_model_usage);
  if (entries.length === 0) return null;
  // Pick the entry with the largest context window (primary model)
  let best = entries[0];
  for (const entry of entries) {
    if ((entry[1].contextWindow || 0) > (best[1].contextWindow || 0)) {
      best = entry;
    }
  }
  return { model: best[0], contextWindow: best[1].contextWindow || 0 };
}

export function formatContextReport(metrics: SessionMetrics): string {
  const confirmed = getConfirmedModel(metrics);

  const lines = [
    `Session: ${metrics.session_id || 'none'}`,
    ...(confirmed
      ? [
          `Model: **${confirmed.model}**`,
          `Context Window: **${formatTokenCount(confirmed.contextWindow)}**`,
        ]
      : []),
    `Transcript: ${formatBytes(metrics.transcript_bytes)}`,
    `Embedded PDFs: ${formatBytes(metrics.embedded_document_bytes)}`,
    `Largest Entry: ${formatBytes(metrics.largest_entry_bytes)}`,
  ];

  if (
    metrics.last_input_tokens !== null ||
    metrics.last_output_tokens !== null
  ) {
    lines.push(
      `Last Turn Tokens: in ${metrics.last_input_tokens ?? 0}, out ${metrics.last_output_tokens ?? 0}`,
    );
  }

  if (metrics.last_context_percent !== null) {
    lines.push(
      `Context ${renderUsageBar(metrics.last_context_percent)} ${metrics.last_context_percent}%`,
    );
  } else {
    lines.push('Context: unavailable');
  }

  if (metrics.last_rate_limit_utilization !== null) {
    const percent =
      metrics.last_rate_limit_utilization <= 1
        ? Math.round(metrics.last_rate_limit_utilization * 100)
        : Math.round(metrics.last_rate_limit_utilization);
    lines.push(`Rate Limit ${renderUsageBar(percent)} ${percent}%`);
  }

  lines.push(
    `Top Embedded Files: ${summarizeTopEmbeddedFiles(metrics.top_embedded_files)}`,
  );
  return lines.join('\n');
}

export function cloneModelUsage(
  modelUsage: Record<string, AgentModelUsage> | undefined,
): Record<string, AgentModelUsage> | null {
  if (!modelUsage) return null;
  return JSON.parse(JSON.stringify(modelUsage)) as Record<
    string,
    AgentModelUsage
  >;
}
