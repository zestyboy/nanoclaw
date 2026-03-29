/**
 * QMD SDK client with three-tier search. Models stay warm in process memory.
 *
 * Tier 1: BM25 (searchLex) — instant, no models
 * Tier 2: Vector (search with vec-only, rerank:false) — fast with warm embedding model
 * Tier 3: Hybrid (search with lex+vec, rerank:false) — full retrieval, no reranking
 *
 * Falls back to CLI execFileSync if the SDK store fails to initialize.
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
  searchLex(
    query: string,
    options?: { limit?: number; collection?: string },
  ): Promise<Array<Record<string, unknown>>>;
}

async function getStore(): Promise<QmdStore | null> {
  if (!storePromise) {
    storePromise = initStore();
  }
  return storePromise;
}

async function initStore(): Promise<QmdStore | null> {
  try {
    // Dynamic import — QMD may not be installed as a project dep in all environments
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
    storePromise = null; // Allow retry on next call
    return null;
  }
}

// --- Types ---

export interface QmdSearchResult {
  results: unknown[];
  tier: 'bm25' | 'vsearch' | 'hybrid' | 'bm25-cli' | 'hybrid-cli';
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
    { cwd: DATA_DIR, encoding: 'utf-8', timeout: 10_000 },
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
  const store = await getStore();
  const bm25Query = searches.map((s) => s.query).join(' ');

  // Tier 1: BM25 (searchLex) — instant, no models
  try {
    let bm25Results: unknown[];
    if (store) {
      bm25Results = await store.searchLex(bm25Query, { limit, collection });
    } else {
      bm25Results = cliBm25Search(bm25Query, collection, limit);
    }

    if (bm25Results.length > 0) {
      logger.info(
        { collection, resultCount: bm25Results.length, tier: 'bm25' },
        'QMD BM25 returned results',
      );
      return { results: bm25Results, tier: store ? 'bm25' : 'bm25-cli' };
    }
    logger.info({ collection }, 'QMD BM25 returned no results');
  } catch (err) {
    logger.warn({ err, collection }, 'QMD BM25 search failed');
  }

  // Tier 2: Vector search (rerank:false) — warm embedding model, no reranker
  if (store) {
    try {
      const vecQuery = searches.map((s) => s.query).join('. ');
      const vecResults = await store.search({
        queries: [{ type: 'vec', query: vecQuery }],
        collections: [collection],
        intent,
        limit,
        rerank: false,
      });

      if (vecResults.length > 0) {
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

  // Tier 3: Hybrid (lex+vec, rerank:false via SDK, or full CLI fallback)
  try {
    if (store) {
      const hybridResults = await store.search({
        queries: searches,
        collections: [collection],
        intent,
        limit,
        rerank: false,
      });
      logger.info(
        { collection, resultCount: hybridResults.length, tier: 'hybrid' },
        'QMD hybrid (no rerank) returned results',
      );
      return { results: hybridResults, tier: 'hybrid' };
    }

    // CLI fallback — runs full pipeline including reranking (slow but works)
    const cliResults = cliHybridSearch(searches, intent, collection, limit);
    logger.info(
      { collection, resultCount: cliResults.length, tier: 'hybrid-cli' },
      'QMD hybrid (CLI fallback) returned results',
    );
    return { results: cliResults, tier: 'hybrid-cli' };
  } catch (err) {
    logger.warn({ err, collection }, 'QMD hybrid search failed');
    return { results: [], tier: store ? 'hybrid' : 'hybrid-cli' };
  }
}
