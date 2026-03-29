/**
 * QMD SDK search client. Uses hybrid lex+vec with rerank:false for every search.
 *
 * Strategy: Every search runs both BM25 (keyword) and vector (semantic) retrieval
 * combined via RRF fusion, with LLM reranking disabled. This gives the best of
 * both worlds — exact keyword matches plus semantic understanding — in ~250ms.
 *
 * Models stay warm in Node.js process memory between searches. First vec query
 * after deploy takes ~5s to load the 300MB embedding model, then subsequent
 * queries are sub-second.
 *
 * Falls back to CLI execFileSync if the SDK store fails to initialize.
 *
 * ## Fallback strategies (if this approach needs changing)
 *
 * 1. BM25-only (fastest, no semantic):
 *    Use store.searchLex() — 240ms, no models needed.
 *    Trade-off: misses semantic matches ("editing" won't find "video editor").
 *
 * 2. Three-tier (BM25 → vec → hybrid):
 *    Try BM25 first, fall back to vec if empty, then hybrid.
 *    Trade-off: most queries only get keyword results.
 *
 * 3. Enable reranking (best quality, slowest):
 *    Set rerank: true — 60-120s on CPU. Only if result quality is poor.
 *    The 640MB reranker model re-reads full documents against the query.
 *
 * 4. CLI fallback (no SDK dependency):
 *    Use execFileSync('qmd', ['search', ...]) for BM25 (~400ms) and
 *    execFileSync('qmd', ['query', ...]) for hybrid (~60-120s, cold models).
 *    Already implemented below as automatic fallback if SDK init fails.
 *
 * ## Benchmarks (Railway Hobby, 8 vCPU, 1056 docs, query: "Harrison launch day video production")
 *
 * | Mode                          | CLI (before) | SDK rerank:false (current) |
 * |-------------------------------|-------------|---------------------------|
 * | BM25 (searchLex)              | 400ms       | 240ms                     |
 * | vec rerank:false (warm)       | 10-13s      | 24ms                      |
 * | hybrid lex+vec rerank:false   | 60-120s     | 255ms                     |
 */

import { execFileSync } from 'child_process';

import { DATA_DIR, IS_RAILWAY, QMD_CACHE_DIR } from './config.js';
import { logger } from './logger.js';

// --- Configuration ---

const QMD_CLI_TIMEOUT_MS = 120_000;
const QMD_CANDIDATE_LIMIT = Number.parseInt(
  process.env.QMD_QUERY_CANDIDATE_LIMIT || '20',
  10,
);

// --- Lazy SDK Store ---

let storePromise: Promise<QmdStore | null> | null = null;

interface QmdStore {
  search(options: {
    queries?: Array<{ type: string; query: string }>;
    intent?: string;
    rerank?: boolean;
    collection?: string;
    collections?: string[];
    limit?: number;
    minScore?: number;
  }): Promise<Array<Record<string, unknown>>>;
}

async function getStore(): Promise<QmdStore | null> {
  if (!storePromise) {
    storePromise = initStore();
  }
  return storePromise;
}

async function initStore(): Promise<QmdStore | null> {
  try {
    const qmd = await import('@tobilu/qmd');
    const dbPath = IS_RAILWAY
      ? '/data/qmd-cache/qmd/index.sqlite'
      : `${QMD_CACHE_DIR}/qmd/index.sqlite`;

    const store = await qmd.createStore({ dbPath });
    logger.info({ dbPath }, 'QMD SDK store initialized');
    return store as unknown as QmdStore;
  } catch (err) {
    logger.warn(
      { err },
      'QMD SDK store failed to initialize, will use CLI fallback',
    );
    storePromise = null;
    return null;
  }
}

// --- Types ---

export interface QmdSearchResult {
  results: unknown[];
  tier: 'hybrid' | 'hybrid-cli';
}

// --- CLI Fallback ---

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

// --- Search ---

export async function qmdSearch(
  collection: string,
  searches: Array<{ type: string; query: string }>,
  intent: string | undefined,
  limit: number,
): Promise<QmdSearchResult> {
  const store = await getStore();

  // Build lex+vec queries from the agent's search terms
  const combinedQuery = searches.map((s) => s.query).join(' ');
  const hybridSearches: Array<{ type: string; query: string }> = [
    { type: 'lex', query: combinedQuery },
    { type: 'vec', query: combinedQuery },
  ];

  // Primary: hybrid lex+vec via SDK with rerank:false (~255ms warm)
  if (store) {
    try {
      const results = await store.search({
        queries: hybridSearches,
        collections: [collection],
        intent,
        limit,
        rerank: false,
      });
      logger.info(
        { collection, resultCount: results.length, tier: 'hybrid' },
        'QMD hybrid search completed',
      );
      return { results, tier: 'hybrid' };
    } catch (err) {
      logger.warn({ err, collection }, 'QMD SDK search failed, trying CLI');
    }
  }

  // Fallback: CLI hybrid (slow — cold-loads all models, includes reranking)
  try {
    const results = cliHybridSearch(searches, intent, collection, limit);
    logger.info(
      { collection, resultCount: results.length, tier: 'hybrid-cli' },
      'QMD CLI fallback search completed',
    );
    return { results, tier: 'hybrid-cli' };
  } catch (err) {
    logger.error({ err, collection }, 'QMD search failed completely');
    return { results: [], tier: 'hybrid-cli' };
  }
}
