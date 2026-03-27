# QMD HTTP MCP Migration Plan

Migrate QMD from per-search CLI invocation (`execFileSync`) to a persistent HTTP MCP server with a three-tier search strategy optimized for Railway CPU.

## Problem

Every search cold-loads ~2.1GB of neural models via `execFileSync('qmd', ['query', ...])`. On Railway (CPU-only, no GPU), this means:
- 60-120s per hybrid search (embedding + reranking on CPU)
- Models loaded and unloaded on every single search
- Even vsearch (vector-only) takes 10-29s via CLI due to cold model loading

## Railway Benchmarks (2026-03-27)

Tested on Railway Hobby plan (8 vCPU / 8 GB RAM), second-brain collection (1056 files):

| Mode | Cold | Warm | What it does |
|------|------|------|-------------|
| **BM25** (`qmd search`) | ~480ms | ~400ms | Pure FTS5 keyword, no models |
| **vsearch** (`qmd vsearch`) | ~29s | ~10-13s | 300MB embedding model on CPU |
| **hybrid** (`qmd query`) | 60-120s | ~30-60s | All three models (2.1GB) |

**Key finding:** vsearch is NOT sub-second via CLI because the embedding model cold-loads every invocation. A persistent HTTP MCP server is needed to keep models warm and achieve sub-second semantic search.

## Target State

- QMD runs as a persistent HTTP MCP server (`qmd mcp --http`) inside the Railway container
- Embedding model stays warm in RAM (~300MB resident for vsearch, fits easily in 8GB)
- Three-tier search strategy: BM25 (instant) → vsearch (warm, <1s) → hybrid-no-rerank (fallback)
- CLI fallback if HTTP server is down (current two-tier BM25→hybrid behavior)

## Architecture Change

```
BEFORE:
  Agent → IPC file → Host → execFileSync('qmd search/query') → cold load models → result
  (BM25: 400ms, vsearch: 10-29s, hybrid: 60-120s)

AFTER:
  Agent → IPC file → Host → HTTP request to localhost:QMD_PORT → warm models → result
  (BM25: ~400ms via CLI, vsearch: <1s via HTTP, hybrid: 5-15s via HTTP)
```

The QMD HTTP server is a background process in the same Railway container, started by the entrypoint script before the Node.js host process. It listens on localhost only.

## Rollback

If the HTTP MCP server has issues at any point, the system falls back to CLI `execFileSync` automatically — the two-tier BM25→hybrid search shipped on main continues to work. If we can't get HTTP MCP working properly, we merge nothing and stay on BM25-only (which is already fast at 400ms).

---

## Phase 0: Discover QMD MCP HTTP API

Before writing any code, we need to understand the QMD MCP HTTP protocol.

**Tasks:**
1. Run `qmd mcp --http` locally and inspect the API
2. Determine: what port does it listen on? What endpoints does it expose?
3. Send test requests to understand the JSON-RPC/MCP request format
4. Confirm which tools are available (search, vsearch, query) and their parameter schemas
5. Check if there's a health/ready endpoint
6. Check if `--no-rerank` or equivalent is available via MCP

**Deliverable:** Documented API format we can code against.

---

## Phase 1: Start QMD HTTP MCP Server in Entrypoint

**Files:** `docker-entrypoint-railway.sh`

Add a section after the QMD cache setup (after line 23) that starts `qmd mcp --http` as a background process:

```bash
# Start QMD MCP HTTP server (models stay loaded between searches)
QMD_HTTP_PORT="${QMD_HTTP_PORT:-7862}"
echo "Starting QMD MCP HTTP server on port $QMD_HTTP_PORT..."
gosu node qmd mcp --http --port "$QMD_HTTP_PORT" &
QMD_PID=$!

# Wait for QMD HTTP server to be ready
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$QMD_HTTP_PORT/health" >/dev/null 2>&1; then
    echo "QMD MCP HTTP server ready (pid $QMD_PID)"
    break
  fi
  sleep 1
done
```

Health check endpoint TBD (depends on Phase 0 findings). May need TCP connect check instead.

**Verification:** Deploy to Railway, check logs for "QMD MCP HTTP server ready".

---

## Phase 2: Create QMD HTTP Client Module

**New file:** `src/qmd-client.ts`

A thin client that talks to the QMD MCP HTTP server with CLI fallback.

```typescript
interface QmdSearchResult {
  results: unknown[];
  tier: 'bm25' | 'vsearch' | 'hybrid';
}

async function qmdSearch(
  collection: string,
  searches: Array<{ type: string; query: string }>,
  intent: string | undefined,
  limit: number,
): Promise<QmdSearchResult>
```

**Tier logic:**

1. **Tier 1 — BM25** (always via CLI, ~400ms): Pure keyword, no models needed. No benefit from HTTP server.
2. **Tier 2 — vsearch** (via HTTP MCP, <1s warm): Semantic vector search with warm embedding model. This is the whole point of the HTTP server.
3. **Tier 3 — hybrid** (via HTTP MCP, 5-15s warm): Full query pipeline. Only if tiers 1+2 both return nothing.

**CLI fallback:** If HTTP server is unreachable, skip tier 2 and fall back to tier 1 (BM25) → tier 3 (hybrid via CLI). This is the current behavior on main.

---

## Phase 3: Replace IPC Search Handlers

**File:** `src/ipc.ts`

Replace `qmdTwoTierSearch()` with a call to the new `qmdSearch()` from `src/qmd-client.ts`.

IPC file-based communication between agent and host is unchanged. Only the host-side search execution changes.

---

## Phase 4: Ensure Embeddings Are Pre-Built

**File:** `docker-entrypoint-railway.sh`

Collections must be registered and embeddings built before the HTTP server can serve vsearch queries. The existing `verifyQmdCollections({ repair: true })` in `verify-railway-state.ts` handles this on the Node.js side. Confirm it runs before the HTTP server starts serving, or add explicit `qmd embed` in the entrypoint.

---

## Phase 5: Test on Railway

Deploy the feature branch to Railway and verify:
1. QMD HTTP server starts and stays running
2. BM25 search still works (~400ms)
3. vsearch via HTTP is sub-second (warm model)
4. Hybrid fallback works when BM25+vsearch return nothing
5. CLI fallback works if HTTP server is killed
6. No memory pressure (models + Node.js fit in 8GB)

---

## Implementation Order

| Step | Effort | Risk | Description |
|------|--------|------|-------------|
| 0 | Small | None | Discover QMD MCP HTTP API format |
| 1 | Small | Low | Start QMD HTTP server in entrypoint |
| 2 | Medium | Low | Create `qmd-client.ts` with three-tier search + CLI fallback |
| 3 | Small | Medium | Replace IPC handlers to use new client |
| 4 | Small | Low | Ensure embeddings pre-built |
| 5 | Medium | Low | Deploy and test on Railway |

## Open Questions

1. **QMD MCP HTTP API format** — Phase 0 will resolve this
2. **`--no-rerank` flag** — Does it exist in QMD 2.0.1? Alternative: structured query with only `lex:` + `vec:` lines
3. **Memory footprint** — Will keeping the embedding model warm (~300MB) cause memory pressure alongside Node.js + agent child processes?
4. **Model idle disposal** — QMD docs say "embedding/reranking contexts are disposed after 5 min idle but transparently recreated". Need to verify this doesn't defeat the purpose of warm models.
