# Architecture & Tech-Stack Design Brief

_Last updated: 2026-06-14 · Status: **design ratified and implemented** (decisions D1–D8 resolved; see §5)_

This document records the architecture and tech-stack design for the engine. It
consolidates the constraints, the component model, and the design decisions —
all of which are now **resolved and implemented** (Epics A–M + Q + O; ADRs 0008–0035,
incl. the static path-finding + derived SQLite graph index of ADR 0023, the
internal-seams reorganization of ADR 0025, findings derivation v2 of ADR 0026, the optional C# Roslyn provider tier of ADR 0027 (deepened by ADR 0032: host-SDK references + data-member ownership), diff/PR mode of ADR 0031, the Visual Basic tier of ADR 0033, production validation of ADR 0034, and the Epic N C++ tree-sitter tier of ADR 0035 (N-S1 method qualification + N-S2 same-directory cross-file resolution + N-S3 namespace + `using` resolution + cross-file namespace resolution)).
The decision table in §5 carries the resolution for each open question; D5
(dependency pins) is the only item with a residual release-prep tail.

Authority: the **CAS** repo (`../debug_mcp_context_manager`) owns requirements.
Capability/policy IDs below (e.g. `CAP-05`, `POL-03`) refer to the catalog in
[`backlog.md`](./backlog.md), which traces each to its CAS source file.

## 1. Product constraints (non-negotiable — from CAS)

These bound every design choice and must survive the rebuild:

- **Codebase-only** (`BND-01`, `BND-02`): never execute the target app, run its
  tests, attach a debugger, or read telemetry/production. Outputs are inferences
  from checked-in files only.
- **Static context is not runtime truth** (`BND-02`, decision `0002`): never
  upgrade a static inference to a runtime claim.
- **Confidence vocabulary is load-bearing** (`POL-03`): every finding carries one
  of `confirmed | likely | candidate | unclear | unresolved`. Reachability and
  runtime state stay `unresolved` by design, not silently filled.
- **Init before deep analysis** (`CAP-22`, decision `0004`): operations check init
  state first; pre-init answers are limited and marked as such.
- **Dual output modes** (`CAP-18`, decision `0003`): `human_readable` markdown and
  `llm_readable` JSON, selectable per operation.
- **Evidence over guessing** (`POL-04`): a useful uncertain answer beats a
  confident false one; uncertainty is explicit, not buried in prose.

## 2. Component model (what the engine is made of)

The implemented layering:

```
src/index.ts      entry point: 2 adapters over the tool table (0025) [done]
src/tools.ts      declarative tool spec table: 20 specs (ADR 0025)   [done]
src/schema.ts     shared type vocabulary, behavior-free (ADR 0025)   [done]
src/scope.ts      scope/exclusion: 4 modes, walk, preview (ADR 0009) [done]
src/files.ts      hashFile + categorizeFile (ADR 0010)               [done]
src/providers/    registry + TS/C#-Roslyn/tree-sitter/heur. tiers    [done]
tools/roslyn-analyzer/ optional .NET sidecar for the C# tier (0027)   [done]
src/contextMap.ts map engine (build/persist/compare; types→schema)   [done]
src/findings.ts   D4 findings derivation (ADR 0017)                  [done]
src/analysisContext.ts shared withContext seam, injectable (0025)    [done]
src/analysis.ts   analysis capabilities over a GraphSource (ADR 0024)[done]
src/callGraph.ts  static call-graph + mapCallStack over GraphSource   [done]
src/visualize.ts  visualization types + functions (CAP-24/25)        [done]
src/pathfinding.ts GraphSource contract + path-finding (ADR 0023/24) [done]
src/graphIndex.ts graph-index.sqlite GraphSource (ADR 0023/0024)     [done]
src/pathQueries.ts find_callers / find_path over GraphSource (0024)  [done]
src/mapDiff.ts    diff/PR mode: map delta + analyze_diff (ADR 0031)  [done]
src/output.ts     formatting: results -> human / llm / dual          [done]
eval/             capability eval harness + bench gates (0029/0030)  [done]
```

Components inside the engine (all implemented):

| # | Component | Responsibility | Primary CAS reqs |
|---|---|---|---|
| C1 | **File walk** | Traverse repo, skip excluded dirs, list tracked-ish files | `CAP-01`, `CAP-02` |
| C2 | **Categorizer** | Classify each file (source/test/config/docs/context/generated/other) | `CAP-02` |
| C3 | **Hashing** | Per-file SHA-256 + size; large-file handling | `CAP-05`, `CAP-06` |
| C4 | **Map hash + staleness** | Derive `mapHash` from `[path, sha256]`; compare to detect `stale` | `CAP-04`, `CAP-05`, `CAP-06` |
| C5 | **Entry points** | Heuristic entry detection w/ confidence + reason | `CAP-02` |
| C6 | **Module groups** | Cluster source/test files into modules | `CAP-02`, `CAP-16` |
| C7 | **Ownership signals** | Exported declarations per file (which file "owns" an API) — provider-extracted (C11) | `CAP-13`, `CAP-08` |
| C8 | **Findings** | duplicate-path, legacy-path, canonical + risk candidates (ADR 0017) and derivation v2 (ADR 0026): cyclic clusters, visibility hotspots, source→test violations, scattered ownership, untested modules, fan-out hotspots, entry-point orphans — all ≤ `candidate`, capped, uncertainty-carrying; re-exports treated as aliases | `CAP-08`, `CAP-09`, `CAP-16`, `POL-06`, `POL-07` |
| C9 | **Persistence** | Write/read `.code-cartographer-mcp/context-map.json` | `CAP-01`, `CAP-17` |
| C10 | **Formatters** | `StaticContextMap` → markdown / JSON, kept in sync with the schema | `CAP-03`, `CAP-18`, `CAP-19`, `CAP-20` |
| C11 | **Language providers** | Pluggable per-language extraction of ownership signals, entry-point hints, and static call edges; tiered confidence ceiling (ADR 0012/0013). Four tiers: TS/JS compiler-API (`confirmed`), C#/VB Roslyn sidecar (`confirmed`, optional `dotnet` gate — ADR 0027; per ADR 0032 it references the host SDK's TPA so BCL-flowing internal bindings resolve — external targets stay `unresolved#name` — and emits property/field ownership signals that never become call-graph nodes; per ADR 0033 Visual Basic joins via a separate VisualBasicCompilation — same semantics, VB data access via invocation syntax never an edge, cross-language VB↔C# calls stay `unresolved#name`, no-SDK VB falls to the heuristic floor), tree-sitter for 8 languages (`likely`, cross-file for Go/Python/Rust — ADR 0021/0022), heuristic floor (`candidate`). Feeds C5/C7/C8 and the call graph. | `CAP-13`, `CAP-08`, `CAP-23` |
| C12 | **Graph traversal substrate** | The one traversal substrate (ADR 0024): a `GraphSource` (neighbors + node lookups) with two implementations — `inMemoryGraphSource` (fallback, from the JSON map) and the SQLite `graph-index.sqlite` (`src/graphIndex.ts`, built-in `node:sqlite`). `loadGraphContext` picks the index for large graphs, else in-memory — **SQLite optional**. `analysis.ts`/`callGraph.ts` traverse it (no hand-rolled adjacency). Path-finding (`src/pathfinding.ts`: bidirectional-BFS fewest-hop, max-bottleneck best-confidence, k-best, Tarjan SCC) runs over it; emitted path confidence clamped to `likely`. Index is a rebuildable projection stamped with `mapHash`. Codebase-only — no runtime trace (ADR 0023/0024). | `CAP-23`, `CAP-07` |
| C13 | **Path queries** | `find_callers` / `find_path` MCP tools (`src/pathQueries.ts`) surfacing the C12 path-finding algorithms over the shared `GraphSource` as codebase-only, `likely`-clamped, enveloped results (ADR 0024). | `CAP-23`, `CAP-07` |
| C14 | **Analysis context** | The shared analysis-context seam (`src/analysisContext.ts`, ADR 0025): `withContext` owns the load → init-guard → close envelope (ADR 0024 lifecycle) and the shared uncertainty wordings for every graph-query capability; `makeAnalysisContext` is the injectable adapter (capabilities take `AnalysisTarget` = root string or caller-owned context — the callee never closes an injected context). Makes the C12 seam the test surface. | `CAP-07..16`, `CAP-23` |
| C15 | **Tool surface** | The declarative tool spec table (`src/tools.ts`, ADR 0025): all 20 tools as `{ name, schema, cli, execute }` rows; the MCP registration and CLI dispatch in `src/index.ts` are two adapters over it, so the surfaces cannot drift and the table is testable without a transport. | `CAP-03`, `CAP-18` |
| C16 | **Map diff** | Diff/PR mode (`src/mapDiff.ts`, ADR 0031): a pure comparator (`compareMaps`) between two static maps + verdict grading (`gradeDelta`) behind the `analyze_diff` tool (CLI `diff`). Default compares the persisted baseline vs a fresh in-memory rebuild of the current tree under the baseline's RECORDED scope (never persisted — re-baselining stays an explicit `init_codebase`); optional `baselineMapPath` compares an explicit snapshot. Six capped sections (files, graph node/edge deltas, new/resolved duplicates, legacy reachability transitions, new/resolved risk areas, per-edge confidence regressions) + verdict booleans + one recommendation. Confidence regression = static evidence weakened, never a runtime claim. | `CAP-11`, `CAP-12`, `CAP-08` |

A **static call graph** is now in scope as shared substrate (`CAP-23`, ADR 0007):
`src/callGraph.ts` maps a confidence-graded static call stack from an entry point,
and `src/visualize.ts` renders call-stack/architecture diagram specs (`CAP-24/25`).
Still **out of scope** (`unresolved`): runtime-*proven* reachability (`CAP-07`) and
change-impact (`CAP-10`) — record as explicit uncertainty findings, never as proven
results (ADR 0001/0002).

## 3. Data model (ratified — Decision 0008)

The ratified `StaticContextMap` shape (`schemaVersion 1`):

- `meta`: `{ schemaVersion: 1, toolVersion, generatedAt, repositoryRoot, mapHash, codebaseOnlyBoundary: true }`.
- `summary`: `totalFiles`, `categories` counts, `languages` (files per language),
  `importantFiles`, `entryPoints[]`, `modules[]`, `ownershipSignals[]`,
  `excluded` (`{ source, languages, excludeDirs, patterns, scopeHash, dirs, fileCount }` — coverage transparency + re-walk inputs for staleness, Decisions 0009/0011).
- `files[]`: `{ path, category, sizeBytes, sha256, hashScope, analyzable, analysisReason, mtimeMs }` (Decisions 0010/0011; `mtimeMs` is fingerprint-only, excluded from `mapHash`).
- `findings`: `canonicalPaths[]`, `duplicatePathCandidates[]`,
  `legacyPathCandidates[]`, `riskAreas[]`, `uncertainty[]`.

Each inference-bearing record carries `confidence` + a human-readable `reason`
(the six-field finding shape, `CAP-20`).

## 4. Tech stack (current vs. to confirm)

Already chosen (in `package.json`); confirm or revisit:

- **Runtime/lang:** Node ≥ 20, TypeScript (strict), **NodeNext ESM** — relative
  imports use `.js` extensions even for `.ts`. `rootDir: src` (tests excluded from `dist`).
- **MCP:** `@modelcontextprotocol/sdk` (stdio transport), `zod` for tool input schemas.
- **Tests:** Vitest.
- **Dev/CLI:** `tsx` runs unbuilt `src/`; MCP clients point at built `dist/index.js`.
- **AST/semantic tiers:** the `typescript` compiler API is the live `confirmed`-tier
  provider (`src/providers/typescript.ts`; `typescript` is a RUNTIME dependency — ADR 0012,
  D5); `web-tree-sitter` + WASM grammars back the `likely` tier (ADR 0021); Roslyn backs
  the optional C# `confirmed` tier via the `tools/roslyn-analyzer` .NET sidecar (ADR 0027 —
  no npm dependency; `dotnet`-probe gated).

Decisions: D2 (ownership extraction) and the tier model are resolved — see §5; D5's residual is release-prep pinning.

## 5. Open design decisions (resolve in the design session)

| ID | Decision | Notes |
|---|---|---|
| **D1** ✓ | `schemaVersion` value | **Resolved — ADR 0008: `1`.** `SCHEMA_VERSION = 1` in `schema.ts` (moved from `contextMap.ts` by ADR 0025); provenance grouped under `meta`; added `summary.languages` + `summary.excluded`. |
| **D2** ✓ | Ownership-signal extraction | **Resolved — ADR 0012/0013 + 0018/0021/0022.** Pluggable `LanguageProvider`, polyglot + tiered: TS/JS compiler-API (`confirmed`), **C# Roslyn sidecar** (`confirmed`, optional — ADR 0027), **tree-sitter for Python/Go/Java/Rust/Ruby/C#/C++/C** (`likely`, with cross-file resolution for Go/Python/Rust), heuristic floor (`candidate`). Batch-per-language `analyze`, `maxConfidence` clamp, first-match selection. |
| **D3** ✓ | Staleness algorithm | **Resolved — ADR 0010 + 0011.** Large-file/binary handling (0010); `mapHash` = sha256 of `schemaVersion` + `scopeHash` + sorted file-identity records (0011); staleness via cheap fingerprint (size+mtime+count+scopeHash+schemaVersion) → rehash → `mapHash` compare. Atomic temp+fsync+rename persistence; `.code-cartographer-mcp/` gitignored. |
| **D4** ✓ | Findings heuristics | **Resolved — ADR 0017** (`src/findings.ts`): duplicate (exported-name collision), legacy (six-class, never dead), risk (god-file), canonical (sole owner), all ≤ `candidate` with in-record uncertainty. |
| **D5** ◐ | Dependencies | **`typescript` becomes a runtime dependency** (the TS/JS provider needs the compiler API at runtime — ADR 0012); `ignore` already added (ADR 0009). Still open: confirm final SDK/zod/vitest pins before release. |
| **D6** ✓ | Init states | **Resolved — ADR 0014.** `initializing` is surfaced via a `.code-cartographer-mcp/.initializing` marker (`{ startedAt, pid }`, written pre-build, removed in `finally`); `check_init_state` reports `initializing` while the marker's pid is alive, `failed` if the pid is dead (crashed init). |
| **D7** ✓ | Output "dual" mode | **Resolved — ADR 0015.** `dual` = `human_readable` markdown + separator + fenced ```json `llm_readable`, composed from the two single-mode renders (no third rendering path). |
| **D8** ✓ | Call-graph extraction + diagram defaults | **Resolved — ADR 0012/0018 (extraction) + 0020 (diagrams):** edges are a `LanguageProvider` responsibility (the persisted call graph, ADR 0016); diagrams default to mermaid (also DOT/ASCII) with edge styling by callKind×confidence and a dynamic legend. |

## 6. Recommended sequence

1. Ratify the data model (§3) and resolve D1, D3, D6, D7 — these gate the schema and the tests.
2. Resolve D2, D4, D5 — these gate the engine components C5–C8.
3. Record decisions as ADRs in CAS (`context/07_decisions/`), then derive the
   ordered work in [`backlog.md`](./backlog.md) and execute test-first.

## 7. References

- Current state: [`STATUS.md`](./STATUS.md)
- Work breakdown + requirement traceability: [`backlog.md`](./backlog.md)
- Source of truth: [`cas-source-of-truth.md`](./cas-source-of-truth.md) → CAS `context/`
- Prior implementation: git commit `fc65a79`
