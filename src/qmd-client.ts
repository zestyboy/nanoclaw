/**
 * QMD MCP HTTP client with three-tier search and CLI fallback.
 *
 * Tier 1: BM25 (lex-only query via MCP or CLI) — instant, no models
 * Tier 2: Vector (vec-only query via MCP) — <1s with warm embedding model
 * Tier 3: Hybrid (lex+vec query via MCP or CLI) — full pipeline
 *
 * Falls back to CLI execFileSync if the MCP HTTP server is unreachable.
 */

import { execFileSync } from 'child_process';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// --- Configuration ---

const QMD_HTTP_PORT = process.env.QMD_HTTP_PORT || '7862';
const QMD_HTTP_BASE = `http://localhost:${QMD_HTTP_PORT}/mcp`;
const QMD_BM25_TIMEOUT_MS = 10_000;
const QMD_VEC_TIMEOUT_MS = 15_000;
const QMD_HYBRID_TIMEOUT_MS = 60_000;
const QMD_CLI_TIMEOUT_MS = 120_000;
const QMD_CANDIDATE_LIMIT = Number.parseInt(
  process.env.QMD_QUERY_CANDIDATE_LIMIT || '20',
  10,
);

// --- MCP Session State ---

let mcpSessionId: string | null = null;
let mcpAvailable: boolean | null = null; // null = unknown, true/false = cached
let mcpAvailableCheckedAt = 0;
const MCP_AVAILABILITY_CACHE_MS = 30_000; // re-check every 30s after failure

// --- Types ---

export interface QmdSearchResult {
  results: unknown[];
  tier: 'bm25' | 'vsearch' | 'hybrid' | 'bm25-cli' | 'hybrid-cli';
}

interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: {
    content?: Array<{ type: string; text: string }>;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

// --- MCP HTTP Client ---

async function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  id: number,
  timeoutMs: number,
): Promise<McpJsonRpcResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (mcpSessionId) {
    headers['Mcp-Session-Id'] = mcpSessionId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(QMD_HTTP_BASE, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal,
    });

    // Capture session ID from response headers
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) {
      mcpSessionId = sessionId;
    }

    const text = await response.text();
    return JSON.parse(text) as McpJsonRpcResponse;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureMcpSession(): Promise<boolean> {
  if (mcpSessionId) return true;

  try {
    const resp = await mcpRequest(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'nanoclaw-host', version: '1.0' },
      },
      0,
      5_000,
    );

    if (resp.error) {
      logger.warn({ error: resp.error }, 'QMD MCP initialize failed');
      return false;
    }

    // Send initialized notification (no id = notification)
    await fetch(QMD_HTTP_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    }).catch(() => {});

    logger.info('QMD MCP session established');
    return true;
  } catch (err) {
    logger.warn({ err }, 'QMD MCP server unreachable');
    return false;
  }
}

async function isMcpAvailable(): Promise<boolean> {
  // Use cached result if recent
  if (
    mcpAvailable !== null &&
    Date.now() - mcpAvailableCheckedAt < MCP_AVAILABILITY_CACHE_MS
  ) {
    return mcpAvailable;
  }

  mcpAvailable = await ensureMcpSession();
  mcpAvailableCheckedAt = Date.now();
  return mcpAvailable;
}

async function mcpQuery(
  searches: Array<{ type: string; query: string }>,
  collections: string[],
  intent: string | undefined,
  limit: number,
  timeoutMs: number,
  requestId: number,
): Promise<unknown[] | null> {
  const args: Record<string, unknown> = {
    searches,
    collections,
    limit,
  };
  if (intent) args.intent = intent;

  const resp = await mcpRequest(
    'tools/call',
    { name: 'query', arguments: args },
    requestId,
    timeoutMs,
  );

  if (resp.error) {
    logger.warn({ error: resp.error }, 'QMD MCP query error');
    return null;
  }

  const text = resp.result?.content?.[0]?.text;
  if (!text) return null;

  // Check for "no results" messages
  if (text.startsWith('No results found')) return [];

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Non-JSON response (e.g. formatted text) — return as single result
    return [{ text }];
  }
}

// --- CLI Fallback ---

function cliBm25Search(
  query: string,
  collection: string,
  limit: number,
): unknown[] {
  const output = execFileSync(
    'qmd',
    ['search', query, '--json', '-c', collection, '-n', String(limit)],
    { cwd: DATA_DIR, encoding: 'utf-8', timeout: QMD_BM25_TIMEOUT_MS },
  );
  return JSON.parse(output) as unknown[];
}

function cliHybridSearch(
  searches: Array<{ type: string; query: string }>,
  intent: string | undefined,
  collection: string,
  limit: number,
): unknown[] {
  const queryLines: string[] = [];
  if (intent) queryLines.push(`intent: ${intent}`);
  for (const s of searches) {
    queryLines.push(`${s.type}: ${s.query}`);
  }
  const queryDoc = queryLines.join('\n');

  const output = execFileSync(
    'qmd',
    [
      'query',
      queryDoc,
      '--json',
      '-c',
      collection,
      '-n',
      String(limit),
      '-C',
      String(QMD_CANDIDATE_LIMIT),
    ],
    { cwd: DATA_DIR, encoding: 'utf-8', timeout: QMD_CLI_TIMEOUT_MS },
  );
  return JSON.parse(output) as unknown[];
}

// --- Three-Tier Search ---

export async function qmdSearch(
  collection: string,
  searches: Array<{ type: string; query: string }>,
  intent: string | undefined,
  limit: number,
): Promise<QmdSearchResult> {
  const bm25Query = searches.map((s) => s.query).join(' ');
  const httpAvailable = await isMcpAvailable();

  // Tier 1: BM25 (lex-only) — fast via CLI or MCP, no models needed
  try {
    let bm25Results: unknown[];
    if (httpAvailable) {
      const lexSearches = [{ type: 'lex' as const, query: bm25Query }];
      const results = await mcpQuery(
        lexSearches,
        [collection],
        intent,
        limit,
        QMD_BM25_TIMEOUT_MS,
        100,
      );
      bm25Results = results ?? [];
    } else {
      bm25Results = cliBm25Search(bm25Query, collection, limit);
    }

    if (bm25Results.length > 0) {
      logger.info(
        { collection, resultCount: bm25Results.length, tier: 'bm25' },
        'QMD BM25 returned results',
      );
      return { results: bm25Results, tier: httpAvailable ? 'bm25' : 'bm25-cli' };
    }
    logger.info({ collection }, 'QMD BM25 returned no results');
  } catch (err) {
    logger.warn({ err, collection }, 'QMD BM25 search failed');
  }

  // Tier 2: Vector search (vec-only via MCP) — needs warm embedding model
  if (httpAvailable) {
    try {
      const vecQuery = searches.map((s) => s.query).join('. ');
      const vecSearches = [{ type: 'vec' as const, query: vecQuery }];
      const vecResults = await mcpQuery(
        vecSearches,
        [collection],
        intent,
        limit,
        QMD_VEC_TIMEOUT_MS,
        200,
      );

      if (vecResults && vecResults.length > 0) {
        logger.info(
          { collection, resultCount: vecResults.length, tier: 'vsearch' },
          'QMD vsearch returned results',
        );
        return { results: vecResults, tier: 'vsearch' };
      }
      logger.info({ collection }, 'QMD vsearch returned no results');
    } catch (err) {
      logger.warn({ err, collection }, 'QMD vsearch failed');
    }
  }

  // Tier 3: Hybrid (full query via MCP or CLI fallback)
  try {
    if (httpAvailable) {
      const hybridResults = await mcpQuery(
        searches,
        [collection],
        intent,
        limit,
        QMD_HYBRID_TIMEOUT_MS,
        300,
      );
      if (hybridResults) {
        logger.info(
          { collection, resultCount: hybridResults.length, tier: 'hybrid' },
          'QMD hybrid returned results',
        );
        return { results: hybridResults, tier: 'hybrid' };
      }
    }

    // CLI fallback for hybrid
    const cliResults = cliHybridSearch(searches, intent, collection, limit);
    logger.info(
      { collection, resultCount: cliResults.length, tier: 'hybrid-cli' },
      'QMD hybrid (CLI fallback) returned results',
    );
    return { results: cliResults, tier: 'hybrid-cli' };
  } catch (err) {
    logger.warn({ err, collection }, 'QMD hybrid search failed');
    return { results: [], tier: 'hybrid-cli' };
  }
}

/**
 * Reset MCP session state (e.g. after QMD server restart).
 */
export function resetMcpSession(): void {
  mcpSessionId = null;
  mcpAvailable = null;
  mcpAvailableCheckedAt = 0;
}
