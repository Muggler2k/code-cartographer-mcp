# Project Status

_Last updated: 2026-06-11_

## TL;DR

**The full product is implemented and tested (Epics A–Q*, incl. O).** (*epic letters follow the ADR 0028 roadmap order — Q, then O, landed after M.) `init_codebase`
builds, persists (atomic + gitignored), and `check_init_state` stale-checks a real
`.code-cartographer-mcp/context-map.json` carrying files, languages, entry points,
modules, ownership signals, a provider-extracted **static call graph**, and
confidence-graded findings. Four provider tiers: the **TS/JS provider** (TS
compiler API) type-resolves cross-file edges (`confirmed`); the **C# Roslyn
provider** (ADR 0027 — an optional .NET sidecar, `confirmed`; without a .NET SDK
C# falls back to tree-sitter; per ADR 0032 it binds through the host SDK's BCL
surface — repo-internal calls flowing through LINQ/framework types resolve, external
targets stay `unresolved#name` — and emits property/field ownership signals that
never become call-graph nodes); the **tree-sitter
provider** parses 8 languages (Python, Go, Java, Rust, Ruby, C#, C++, C) via WASM
grammars (`likely`), with cross-file resolution for Go (packages), Python
(imports), and Rust (`use`/modules); a heuristic regex floor covers the rest
(`candidate`). All **20 MCP tools** and the CLI work end-to-end (dogfooded on this
repo). A **static path-finding subsystem** (bidirectional-BFS fewest-hop, max-bottleneck
best-confidence, k-best, Tarjan SCC) over a **derived `graph-index.sqlite`** (built-in
`node:sqlite`) backs indexed caller/callee/path queries (ADR 0023). Internal seams are
unified per **ADR 0025**: every graph query runs through one analysis-context envelope
(`src/analysisContext.ts`, injectable for tests), the MCP + CLI surfaces are two adapters
over one declarative tool table (`src/tools.ts`), and the type vocabulary lives in
`src/schema.ts` apart from the map engine. Findings derivation v2 (**ADR 0026**) adds
seven map-only rules — cycles, visibility hotspots, source→test violations, scattered
ownership, statically untested modules, fan-out hotspots, entry-point orphans — plus
re-export visibility (`OwnershipSignal.reExport`; barrels stop false-positiving the
duplicate rule). A **capability evaluation harness** (ADR 0029, Epic M — the first step of the **v0.2 "Verified Static Context"** roadmap, ADR 0028) scores the analyzer against golden-annotated fixture repos + external real repos: all five fixtures pass 82/82 required golden items with zero invariant violations (`npm run eval`; CI-gated). **Benchmark gates** (ADR 0030, Epic Q) pin the structural metrics — node/edge counts, fixed-query expansion + SQLite query counts, SCC-built-once, output size ±20% — against `eval/baselines.json` (hard, deterministic), with wall-clock under generous sanity ceilings and heap/external numbers record-only. **Diff/PR mode** (ADR 0031, Epic O) ships the review primitive as one tool, **`analyze_diff`** (CLI `diff`): a bounded six-section delta between the persisted baseline map and a fresh in-memory rebuild of the current tree under the baseline's recorded scope (or an explicit `baselineMapPath` snapshot) — changed files, graph node/edge deltas, new/resolved duplicates, legacy reachability transitions, new/resolved risk areas, per-edge confidence regressions (static evidence weakening, never a runtime claim) — plus the `addedParallelPath`/`bypassedAbstraction`/`revivedLegacy`/`increasedUncertainty` verdict and one recommendation. **311 tests passing**;
build/typecheck pass. Design is recorded in CAS Decisions 0001–0032. See
[`architecture.md`](./architecture.md), [`backlog.md`](./backlog.md),
[`pathfinding-and-graph-index.md`](./pathfinding-and-graph-index.md), [`csharp-roslyn-provider.md`](./csharp-roslyn-provider.md), and [`evaluation-harness.md`](./evaluation-harness.md).

## What exists today (implemented)

| Area | State |
|---|---|
| `src/index.ts` | **Implemented (ADR 0025).** The entry point is two thin adapters over the tool spec table: `registerTools(server)` for MCP (then `StdioServerTransport`), and a CLI dispatch that resolves the same table via `findCliSpec`/`cliArgs`. ~50 lines; tool definitions live in `tools.ts`. |
| `src/tools.ts` | **Implemented (ADR 0025).** The declarative table of all **20 tool specs** — name, title, description, zod schema, CLI command/positionals (`preview`/`init`/`status`/`summary`/`reachability`/`duplicates`/`legacy`/`impact`/`preflight`/`review`/`ownership`/`failure`/`test-paths`/`drift`/`diff`/`callstack`/`find-callers`/`find-path`/`viz-callstack`/`viz-arch`), and an `execute` that runs the capability and formats via `output`. The MCP and CLI surfaces render the same table, so they cannot drift; usage text derives from it. |
| `src/schema.ts` | **Implemented (ADR 0025).** The behavior-free shared vocabulary: `Confidence` + rank + `clampConfidence`, 3-mode `OutputMode`, 5-state `InitState`, six-field `Finding`, `Recommendation`, path/legacy/impact substructures, `FileEntry` (`hashScope`/`analyzable`/`analysisReason`/`mtimeMs`), `CallGraphNode`/`CallEdge`, `OwnershipSignal` (incl. the optional `reExport` alias flag, ADR 0026 — additive, schema stays v1), and the ratified `StaticContextMap` shape (schema v1, ADR 0008). |
| `src/contextMap.ts` | **Implemented.** The map **engine** behind a three-function interface: `buildContextMap` (providers → ownership/entry hints/call graph + findings; `buildContextMapFromResolution` split out for the diff rebuild, ADR 0031), atomic persistence, `initCodebase`/`checkInitState`/`readContextMap`, entry-point/module derivation, `mapHash`/staleness per ADR 0011. Types live in `schema.ts` (ADR 0025). |
| `src/analysisContext.ts` | **Implemented (ADR 0025).** The shared analysis-context seam: `withContext` owns the load → init-guard → close envelope (ADR 0024 open/close-per-call) and the shared uncertainty wordings; `makeAnalysisContext` is the injectable adapter that makes the `GraphSource` seam the test surface. Capabilities accept `AnalysisTarget` (root string or caller-owned context). |
| `src/scope.ts` | **Implemented.** Configurable scope/exclusion subsystem (ADR 0009): 4 modes, `ScopeResolution`/`ScopePreview`/`WalkResult`/`RecordedScope`, and `detectLanguages`/`resolveScope`/`previewScope`/`walkFiles` (gitignore via the `ignore` pkg). |
| `src/files.ts` | **Implemented.** `hashFile` (per-file SHA-256 + size, 5 MB cap→metadata hash, binary sniff, `analyzable`/`analysisReason`; ADR 0010) + `categorizeFile`. |
| `src/providers/` | **Implemented.** `LanguageProvider` registry + four tiers: TS/JS provider (TS compiler API, type-resolved cross-file → `confirmed`), **C# Roslyn provider** (`src/providers/csharp.ts` + the `tools/roslyn-analyzer` sidecar, ADR 0027 — optional `dotnet` gate, semantic-model-resolved cross-file edges → `confirmed`; dispatch capped `likely`; no SDK → tree-sitter keeps C#; **ADR 0032**: host-SDK TPA references so BCL-flowing internal bindings resolve while external targets stay `unresolved#name`, plus property/field ownership signals — never call-graph nodes), tree-sitter provider (Python/Go/Java/Rust/Ruby/C#/C++/C via WASM grammars → `likely`; cross-file resolution for Go/Python/Rust), and the heuristic regex floor (`candidate`). Engine clamps each to the provider's ceiling. (ADRs 0012/0013/0018/0021/0022/0027/0032.) |
| `src/findings.ts` | **Implemented.** D4 derivation (ADR 0017) + derivation v2 (ADR 0026): duplicate / legacy (six-class, never dead) / canonical + parallel modules + risk areas — god-file, bypassed abstraction, **cyclic dependency clusters** (Tarjan SCC over resolved edges), **low-static-visibility hotspots**, **source→test violations**, **scattered ownership**, **statically untested modules**, **fan-out hotspots**, **entry-point-orphan modules** — all ≤ `candidate`, capped, with in-record uncertainty. Re-exports are aliases, never parallel implementations. |
| `src/analysis.ts` | **Implemented.** The **10 capability functions** for CAP-07..16 (reachability, duplicate, legacy, change-impact, preflight, change-review, ownership, failure, test-paths, drift) over the persisted map, traversing a shared `GraphSource` (ADR 0024) — never hand-rolled adjacency; init-gated, confidence-capped, uncertainty-explicit (ADR 0019). |
| `src/callGraph.ts` | **Implemented.** Static call-graph types + `mapCallStack` (CAP-23) over the shared `GraphSource` (ADR 0024); dynamic/DI/framework/reflection edges → `candidate`/`unresolved`. |
| `src/visualize.ts` | **Implemented.** `Visualization` (mermaid/dot/ascii) + `visualizeCallStack` (CAP-24) and `visualizeArchitecture` (CAP-25) — emit diagram **specs**, never rendered images (ADR 0020). |
| `src/output.ts` | **Implemented.** All **20 formatters** (one per result type, incl. `formatScopePreview` and `formatMapDiff`) in `human_readable` / `llm_readable` / `dual` (ADR 0015). |
| `src/pathfinding.ts` | **Implemented.** The `NeighborSource`/`GraphSource` contract + `inMemoryGraphSource` fallback + `resolveNodeIds` + static point-to-point path-finding (ADR 0023/0024): bidirectional-BFS fewest-hop, max-bottleneck (widest-path) best-confidence, dominance-ordered k-best, iterative Tarjan SCC, structural `QueryMetrics`. Emitted confidence clamped to `likely`. |
| `src/graphIndex.ts` | **Implemented.** A `GraphSource` backed by `graph-index.sqlite` (built-in `node:sqlite`, ADR 0023/0024): indexed caller/callee + `nodes_symbol`/`nodes_path` lookups, SCC cached once, stamped with `mapHash`, rebuilt when missing/schema-stale/hash-stale. `loadGraphContext` picks it for large graphs, else the in-memory fallback (SQLite optional). A disposable projection of `map.callGraph` — never a second source of truth. |
| `src/pathQueries.ts` | **Implemented (ADR 0024).** The `find_callers` / `find_path` capabilities surfacing the path-finding algorithms over the shared `GraphSource` as codebase-only, `likely`-clamped, enveloped results. |
| `src/mapDiff.ts` | **Implemented (ADR 0031).** Diff/PR mode: `compareMaps` (pure comparator between two static maps) + `gradeDelta` (verdict) + the `analyzeDiff` capability behind the `analyze_diff` tool (CLI `diff`). Default mode rebuilds the current tree in memory under the baseline's RECORDED scope (`recordedScopeToResolution` — the delta is never scope noise; nothing persisted); optional `baselineMapPath` compares an explicit snapshot (CI: map@main vs map@head). Six sections, every list capped at 25 with true counts in totals — bounded output regardless of repo size. Init-gated; findings ≤ `candidate`; confidence regression = static evidence weakened, never a runtime claim. |
| `eval/` | **Implemented (ADR 0029 + 0030).** The capability evaluation harness: five golden-annotated fixture repos (`ts-small`/`python-small`/`csharp-small`/`mixed`/`edge-cases`), a scorer with universal confidence invariants **and a bench section** (per-provider timings, SQLite index build, fixed-query `QueryMetrics`, heap delta), `npm run eval` scorecard runner (+ `CCM_EVAL_EXTERNAL` real repos), `eval/baselines.json` structural baselines, and two CI gates: `test/evalHarness.test.ts` (accuracy) + `test/benchGates.test.ts` (benchmarks). See [`evaluation-harness.md`](./evaluation-harness.md). |
| `test/*.test.ts` | **311 tests passing, 0 `it.todo`** across 21 files (core map, scope/exclusion, providers + the **C# Roslyn tier** (`describe.runIf(dotnetAvailable)`), derivation, findings + **derivation v2**, the **evaluation gate**, the **benchmark gates**, analysis, viz, call-stack, **pathfinding**, **graphIndex**, **pathQueries**, **mapDiff** (pure comparator + init→edit→diff integration), the **analysisContext** seam, the **tools** table, and a structural **benchmark** suite). Shared fixtures (`test/helpers/fixtures.ts`): `tempRepos` + `testContextMap` builders (ADR 0025). |
| Build / typecheck | **Pass** — compiles clean under strict TypeScript. |
| `.code-cartographer-mcp/context-map.json` | **Produced** — `initCodebase` writes it atomically (temp + fsync + rename), artifact dir gitignored. Dogfooded on this repo (gitignore scope: 72 files, 459 ownership signals, 861 call edges as of Epic L). |
| `.code-cartographer-mcp/graph-index.sqlite` | **Derived (ADR 0023).** A rebuildable projection of `map.callGraph` (same gitignored dir). Stamped with `mapHash`; rebuilt on mismatch. The JSON map stays the single source of truth — `mapHash`/staleness composition is unchanged. |

## Remaining work

Epics A–M + Q + O are implemented (ADR 0024 graph-traversal unification; ADR 0025 internal seams; ADR 0026 findings derivation v2; ADR 0027 C# Roslyn provider; ADR 0029 capability evaluation harness; ADR 0030 benchmark gates; ADR 0031 diff/PR mode). The **v0.2 "Verified Static Context"** roadmap (ADR 0028) ratifies the remaining order: N (C++ semantic tier) → R (onboarding) → S (CAS export) → T (canonical path registry) → P (incremental refresh) — and its anti-goals (no new findings/provider claims without harness scores). PR #1 (the genesis review PR) got a 5-dimension multi-reviewer pass; its boundary-wording (HF-2/3/4) and analysis-classification (HF-5/6) findings are fixed, and the top architectural finding (HF-1) is fully resolved. What's left:

- **✅ DONE — Graph-traversal unification (HF-1 · Epic I · ADR 0024)** and **internal-seams deepening (Epic J · ADR 0025)**: one analysis-context envelope, one tool spec table behind MCP + CLI, schema/engine split, shared test fixtures.
- **More language-specific providers** behind the existing `LanguageProvider` interface (C#/Roslyn ✅ done, ADR 0027; ✅ deepened by ADR 0032 — host-SDK references + data-member signals; still deferred there: Tier 2 `project.assets.json` package references, C# events, field-initializer edges; next candidates: deeper Python/Go). Signature-aware duplicate detection was reviewed and deferred (ADR 0026).
- **Promote draft CAS policies** (`output-mode-policy.md`, workflows, prompts) from draft → accepted now that they are realized in code.
- **Confirm final dependency pins** (architecture D5: `typescript` is a runtime dep; confirm SDK/zod/vitest pins; bump `engines.node` to ≥ 22.5 for `node:sqlite`) before any release.

## Source of truth

Product requirements, policies, and decisions live in the sibling **CAS** repo
`../debug_mcp_context_manager` (see [`cas-source-of-truth.md`](./cas-source-of-truth.md)).
This repo owns implementation only. The CAS-side current-state record is
`context/sessions/2026-06-11_csharp-parity-adr-0032.md` and
`context/00_index/index.md`; design is recorded in ADRs 0001–0032 under
`context/07_decisions/` (ADR 0028 — the v0.2 roadmap; ADR 0032 — C# tier parity: host-SDK references + data-member ownership).

## Next steps (per the ADR 0028 roadmap)

1. **Epic N — C++ semantic tier** (optional clangd/libclang provider; fallback clang → tree-sitter → heuristic).
2. **Epics R/S/T/P** — onboarding, CAS export, canonical path registry, incremental refresh (last).
3. **Release prep** — confirm dependency pins (D5), bump `engines.node` to ≥ 22.5, promote draft CAS policies to accepted.
