# QMD Search Optimization — Final Strategy

## Problem

QMD on Railway (CPU-only, no GPU) took 60-120s per search because every CLI
invocation cold-loaded ~2.1GB of neural models (query expansion, embedding,
reranking). The reranker alone (640MB qwen3-reranker model) added 60s+ on CPU.

## Solution: SDK Direct Integration with rerank:false

Use the QMD SDK (`@tobilu/qmd`) directly from the Node.js host process instead
of spawning CLI subprocesses. Pass `rerank: false` to skip the expensive LLM
reranker. Models stay warm in process memory between searches.

### Search Strategy

**Single tier: hybrid lex+vec with `rerank: false`**

Every search runs both BM25 (keyword) and vector (semantic) retrieval combined
via Reciprocal Rank Fusion (RRF), with LLM reranking disabled. Falls back to
CLI `execFileSync` if the SDK store fails to initialize.

### Benchmarks (Railway Hobby, 8 vCPU, 1056 docs)

Query: `"Harrison launch day video production"`

| Mode | CLI (before) | SDK rerank:false (after) | Speedup |
|------|-------------|--------------------------|---------|
| BM25 only | 400ms | 245ms | 1.6x |
| vec only (warm) | 10-13s | 24ms | 415-540x |
| hybrid lex+vec (warm) | 60-120s | 255ms | 235-470x |

First vec query after deploy takes ~5s to load the 300MB embedding model.
Subsequent queries are sub-second.

### What reranking does (and why we skip it)

Reranking uses an LLM (640MB qwen3-reranker) to re-read full document text
against the query and re-score results. It improves result ordering but costs
60-120s on CPU. For a personal vault (~1000 docs) where the agent reads multiple
results and synthesizes answers, slightly imperfect ranking has minimal impact.

## Rollback Strategies

### Level 1: Restore BM25-only CLI (simplest, no SDK dependency)

```bash
git checkout main~N  # before SDK integration
railway up --service nanoclaw
```

Uses `qmd search` (BM25) at 400ms with `qmd query` (full hybrid) as fallback.
No semantic search, but reliable.

### Level 2: Three-tier with SDK (BM25 → vec → hybrid)

Modify `qmd-client.ts` to try BM25 first, then vec, then hybrid. Only reaches
vec/hybrid if BM25 returns nothing. Most queries stay at 245ms, semantic search
available as fallback.

### Level 3: Enable reranking (best quality)

Set `rerank: true` in the `store.search()` call. Results will be better ranked
but searches take 60-120s on CPU. Only consider if result quality is noticeably
poor.

## Architecture

```
Agent → IPC file → Host (Node.js) → QMD SDK store.search() → results
                                     ↑
                                     Models warm in process memory
                                     (~300MB embedding model resident)
```

No MCP HTTP server, no background processes, no Docker changes.

## Key Decisions & Findings

1. **SDK `rerank: false` existed in QMD 2.0.1 all along.** The MCP HTTP server
   approach was unnecessary — the SDK option was available from the start.

2. **MCP HTTP server always ran reranking.** The MCP `query` tool had no rerank
   toggle. We filed [tobi/qmd#478](https://github.com/tobi/qmd/pull/478) to add
   it (merged), but the SDK path is cleaner for our use case.

3. **Cold model loading was the CLI bottleneck.** Every `execFileSync('qmd', ...)`
   spawned a new process that loaded models from scratch. The SDK keeps models
   warm in the host process memory.

4. **Reranking is the CPU bottleneck.** The 640MB reranker model dominates
   latency on CPU. Skipping it (`rerank: false`) cuts hybrid from 60-120s to
   255ms with acceptable quality trade-off for a personal vault.

## Files Changed

| File | Change |
|------|--------|
| `src/qmd-client.ts` | New: SDK-based search with rerank:false + CLI fallback |
| `src/ipc.ts` | Replaced `qmdTwoTierSearch()` with `qmdSearch()` from qmd-client |
| `package.json` | Added `@tobilu/qmd` as project dependency |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Agent poll timeout 15s → 60s (earlier fix, kept) |
