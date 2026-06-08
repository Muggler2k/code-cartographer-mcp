# Static Path-Finding & the Derived SQLite Graph Index

_Implementation note for Decision 0023 (CAS `0023-graph-index-and-pathfinding.md`)._

This documents the point-to-point **static** path-finding layer (`src/pathfinding.ts`) and the
derived SQLite graph index that backs it (`src/graphIndex.ts`). Everything here is
**codebase-only**: results are a **static path / possible path / reachability path / static
execution path**, never a runtime stack or execution trace. Emitted path confidence is
clamped to `likely` (Decision 0016) — a static path is never `confirmed` runtime truth.

## Components

- **`src/pathfinding.ts`** — pure algorithms over a `NeighborSource` (`callees(id)` /
  `callers(id)`), so they run identically over in-memory fixtures and the SQLite index.
- **`src/graphIndex.ts`** — `graph-index.sqlite`, a disposable projection of `map.callGraph`
  in `.code-cartographer-mcp/` (already gitignored). Stamped with the map's `mapHash`;
  rebuilt when missing, schema-stale, or hash-stale. The JSON `context-map.json` remains the
  single source of truth; `mapHash`/staleness composition (Decision 0011) is untouched.

## Algorithms used

| Query | Algorithm | Notes |
|---|---|---|
| `findCallees` / `findCallers` | single indexed lookup (`edges_from` / `edges_to` B-tree) | one SQLite statement, never a scan |
| `findFewestHopPath` | **bidirectional BFS** | expands both ends, meets in the middle; deterministic lexicographic tie-break among equal-length paths |
| `findBestConfidencePath` | **max-bottleneck (widest-path)** | maximizes the weakest edge confidence; ties → fewest hops → lowest penalty; implemented as the top of the k-best order so the two never disagree |
| `findKBestPaths` | **dominance-ordered best-first** | a prefix dominates its extensions on every ranking key, so popping complete paths from a binary heap yields them best-first — not arbitrary DFS |
| SCC condensation | **iterative Tarjan** | built once per snapshot, cached; same-component ⇒ static reachability candidate (structural co-membership — necessary, not sufficient, for runtime reachability); node ids preserved verbatim |

**k-best ordering:** (1) strongest bottleneck confidence, (2) fewest hops, (3) lowest
confidence penalty, (4) deterministic lexicographic tie-break. Respects both `k` and `maxDepth`.

**Confidence semantics:** the *raw* bottleneck (weakest edge, may be `confirmed`) is used only
for ranking; the *emitted* `confidence` is `clampConfidence(bottleneck, "likely")`. Cycles and
mutual recursion terminate via visited sets / simple-path constraints; no path is asserted dead.

## Complexity — before vs. after

| Operation | Before (in-memory JSON, per call) | After |
|---|---|---|
| caller/callee lookup | rebuild forward+reverse adjacency `O(V+E)`, then `O(deg)` | `O(log E + deg)` indexed lookup; no rebuild, no JSON scan |
| point-to-point shortest path | _did not exist_ (only reachable-set BFS) | bidirectional BFS, frontier `O(b^{d/2})` vs unidirectional `O(b^d)` |
| best-confidence path | _did not exist_ | widest-path best-first, bounded by `k`, `maxDepth`, `KBEST_MAX_POPS` |
| k-best paths | _did not exist_ | dominance-ordered best-first (lazy), bounded |
| SCC / cycle grouping | _did not exist_ | Tarjan `O(V+E)`, **built once per snapshot** (≈0 amortized per query) |

The key shift: per-query work no longer scales with the **whole graph**. Caller/callee is a
local indexed read; a close-pair path expands a small frontier; the only full-graph passes are
the one-time index build and the one-time SCC condensation.

## Measured results

Synthetic layered DAGs + a dense single-SCC ring (`test/pathfinding.bench.test.ts`,
`console.table` output). Indicative numbers on the dev machine (Node 25, Windows):

| graph | nodes | edges | query | durationMs | sqliteQueries | visited | hops |
|---|---|---|---|---|---|---|---|
| large | 10,000 | 49,000 | `findCallees` | ~0.10 | **1** | — | — |
| large | 10,000 | 49,000 | `findCallers` | ~0.10 | **1** | — | — |
| large | 10,000 | 49,000 | `fewest-hop(close)` | ~0.14 | 1 | **6** | 1 |
| large | 10,000 | 49,000 | `fewest-hop(end, 49 hops)` | ~440 | — | ~8,674 | 49 |
| medium | 1,000 | 4,750 | `fewest-hop(close)` | ~0.11 | 1 | **6** | 1 |
| large | 10,000 | 49,000 | `sqlite-build` | ~445 | — | — | — |
| dense-scc | 2,000 | 8,000 | `scc-build` (1 component) | ~19 | — | — | — |
| small/medium | — | — | `k-best(k=5)` | ~1–2 | — | — | ≤ maxDepth |

**Reading the numbers:** caller/callee lookups are flat (~0.1 ms, **one** indexed query) from
100 to 10,000 nodes — the index size does not change per-lookup cost. A *close-pair* path visits
~6 nodes on a 10,000-node graph (bidirectional locality). The end-to-end 49-hop path on the
large graph is inherently expensive — the endpoints are maximally far apart, so any correct
search touches most of the graph; bidirectional still roughly halves the frontier vs. one-sided
BFS. SCC condensation is one pass and then cached (`sccBuildCount` stays 1 across 100 queries).

## Conditional optimizations — implemented

- Bidirectional BFS for point-to-point fewest-hop (vs. one-sided expansion).
- Max-bottleneck widest-path search for best-confidence; shared dominance-ordered best-first
  for k-best (one ordering, two entry points).
- SQLite B-tree indexes on `from_id` / `to_id`; incremental neighbor expansion (no per-query
  adjacency materialization).
- SCC condensation built once per snapshot and cached.
- Deterministic lexicographic tie-breaks throughout (reproducible results).

## Conditional optimizations — skipped, and why

- **Yen's / Eppstein k-shortest paths:** not justified. The ranking key has the *prefix-
  dominance* property (extending a path can only weaken the bottleneck and increase hops/
  penalty), so a lazy best-first that emits complete paths as they surface is already correct
  k-best for bounded `k`/`maxDepth` — without Yen's deviation bookkeeping.
- **Fibonacci-heap Dijkstra:** not justified at these graph sizes; a binary heap is simpler and
  fast enough.
- **Condensation-DAG transitive closure** for O(1) *cross*-component reachability: not built —
  the spec's requirement is *same*-SCC immediacy, which the cached condensation already gives.
  Cross-component reachability uses the (cheap, indexed) search. Add the closure later only if
  cross-component reachability becomes a hot path.
- **Cross-query path memoization:** skipped — invalidation complexity is not justified while the
  index already makes individual queries cheap.
- **SQLite WAL mode / connection pooling:** skipped — single-process, read-mostly access; the
  default rollback journal avoids `-wal`/`-shm` sidecar files that would complicate the atomic
  temp-file→rename rebuild.
- **Bulk/multi-row insert on build:** skipped for now — per-row inserts in one transaction build
  a 49k-edge index in ~0.4 s; revisit if build time matters at larger scales.

## Known limits

- k-best is bounded by `KBEST_MAX_POPS` (200,000); if hit, `metrics.truncated` is set so the cap
  is **never silent**. Best-confidence/k-best enumerate *simple* paths — keep `maxDepth` modest
  on very dense graphs.
- Default `maxDepth` is 24; deeper end-to-end paths require an explicit `maxDepth`.
- `node:sqlite` is experimental (its single import warning is suppressed narrowly and restored
  immediately). If a future Node removes it, the pure algorithms still run via `inMemorySource`
  built from the JSON map — the index is an accelerator, not a requirement.
- The index is opened read-only per process and rebuilt on `mapHash` mismatch; concurrent
  rebuilds in one artifact dir are not coordinated (consistent with the single-instance,
  marker-based init model).

## Integration note (when surfacing via a tool/formatter)

`StaticPath` and the `GraphIndex` query methods are internal substructures — like
`ReachablePath` / `CanonicalPath` in `contextMap.ts`, they carry `confidence` but not the
envelope marker. When a tool result or formatter surfaces them, it MUST wrap them in a result
envelope carrying `analysisBoundary: "codebase_only"` and an explicit `uncertainty` entry (e.g.
"static path only — not runtime-proven; dynamic/framework/unresolved edges degrade confidence"),
exactly as the existing `ReachabilityResult` / `CallStackResult` envelopes do. The `bottleneck`
field is a ranking aid (raw weakest edge), never the emitted truth — emit `confidence` (clamped
to `likely`).

## Boundary

Nothing here executes the target, traces runtime, or asserts dead code. The index stores only
statically-derived, confidence-graded edges; path-finding emits hypotheses with explicit
uncertainty, clamped to `likely`. SCC co-membership is a static structural signal, not proven
runtime reachability. See Decisions 0001/0002/0016 and `src/pathfinding.ts`.
