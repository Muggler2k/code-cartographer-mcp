# Implementation Backlog & Requirement Traceability

_Last updated: 2026-06-10 · Status: **Epics A–G implemented** (✅ complete) + **Epic H** path-finding & SQLite graph index (ADR 0023); **Epic I done** (I1–I4) — graph-traversal unification (HF-1, ADR 0024) + `find_path`/`find_callers` tools; **Epic J done** (J1–J4) — internal-seams deepening (ADR 0025); **Epic K done** (K1–K2) — findings derivation v2 + re-export visibility (ADR 0026); **Epic L done** (L1–L2) — optional C# Roslyn provider tier (ADR 0027); **Epic M done** (M1–M2) — capability evaluation harness (ADR 0029); **Epic Q done** (Q1–Q2) — benchmark/performance gates (ADR 0030); **Epic O done** (O1–O2) — diff/PR mode `analyze_diff` (ADR 0031); **Epics N/R/S/T/P planned** per the v0.2 roadmap (ADR 0028); see per-epic notes below_

The full tool/type **surface** is implemented (20 tools + the complete type
vocabulary — see [`STATUS.md`](./STATUS.md)); this backlog records the ordered,
dependency-aware work behind that contract and a local index of the CAS
requirements each task serves. CAS (`../debug_mcp_context_manager/context/`) remains the source of
truth; this file mirrors the requirement IDs locally so a session can plan
without leaving the repo. Component IDs (`C1`–`C16`) are defined in
[`architecture.md`](./architecture.md).

> Sequencing rule: do not start an epic until its design decisions
> ([`architecture.md`](./architecture.md) §5) are resolved and recorded as ADRs
> in CAS `context/07_decisions/`.

## 1. Requirement traceability (local CAS index)

Source files are under `../debug_mcp_context_manager/`. `Scope`: **MVP** = in the
rebuild; **Defer** = stays `unresolved` by design; **Contract** = enforced by
docs/boundary, not a code feature.

| ID | Requirement | CAS source | Component(s) | Scope |
|---|---|---|---|---|
| CAP-01 | Explicit init (codebase mapping) | `02_operations/init-and-codebase-mapping-policy.md` | C1, C9 | MVP |
| CAP-02 | Init produces baseline map | same | C1, C2, C5, C6 | MVP |
| CAP-03 | Init summary (human + agent) | same | C10 | MVP |
| CAP-04 | Init state tracking (5 states) | same | C4 | MVP (see D6) |
| CAP-05 | Staleness detection + refresh advice | same | C3, C4 | MVP |
| CAP-06 | Context-map freshness check | `03_offers/code-cartographer-mcp.md` | C4 | MVP |
| CAP-18 | Multiple output modes | `02_operations/output-mode-policy.md` | C10 | MVP (see D7) |
| CAP-19 | Output-mode default selection | same | C10 | MVP |
| CAP-20 | Required six-field finding shape | `02_operations/context-governance.md` | C8, C10 | MVP |
| CAP-22 | State-gated operation checks | `02_operations/init-and-codebase-mapping-policy.md` | C4 | MVP |
| CAP-08 | Duplicate-behavior detection | `00_index/code-cartographer-mcp-system.md` | C7, C8 | MVP (heuristic) |
| CAP-09 | Legacy-path classification | same | C8 | MVP (heuristic) |
| CAP-13 | Canonical / ownership guidance | same | C7 | MVP |
| CAP-16 | Architecture-drift identification | same | C6, C8 | Partial |
| CAP-23 | Map call stack (static call graph) | `02_operations/call-stack-and-visualization-policy.md` · ADR 0007 | `callGraph.ts` | MVP (static, graded) |
| CAP-24 | Visualize call stack | same | `visualize.ts` | MVP (diagram spec) |
| CAP-25 | Visualize architecture | same | `visualize.ts` | MVP (diagram spec) |
| CAP-17 | Durable codebase memory | same | C9 | MVP (artifact) |
| CAP-07 | Reachability analysis | same | — | **Defer** (record `unresolved`) |
| CAP-10 | Change-impact (blast radius) | `03_offers/code-cartographer-mcp.md` | — | **Defer** (record `unresolved`) |
| CAP-11 | Agent preflight review | `06_workflows/agent-preflight-workflow.md` | — | Later phase |
| CAP-12 | Agent-generated change review | `06_workflows/change-review-workflow.md` | — | Later phase |
| CAP-14/15 | Failure-investigation / test-path analysis | `00_index/...system.md` | — | Later phase |
| BND-01..08 | Codebase-only / no-runtime / pre-init limits | `...system.md`, `init-...policy.md` | all | **Contract** |
| POL-03 | Confidence vocabulary load-bearing | `context-governance.md` (also `output-mode-policy.md`) | C8, C10 | **Contract** |
| POL-04 | Evidence over guessing | `context-governance.md` | C8 | **Contract** |
| POL-06 | Duplication is a first-class risk | `context-governance.md` | C8 | MVP |
| POL-07 | Legacy classified, not assumed | `context-governance.md` | C8 | MVP |
| POL-11/12/13 | Repo-boundary / role / feedback loop | `product-repository-boundary-policy.md` | process | **Contract** |

(Decisions `0001`–`0007` are accepted ADRs; `0006` records the reset + phase plan, `0007` adds static call-stack mapping + visualization.)

## 2. Implementation backlog (ordered)

### Epic A — Foundations (unblocks everything) — ✅ COMPLETE (implemented + tested)
- **A1.** Ratify `StaticContextMap` schema & set the `schemaVersion` constant (D1). → `CAP-20` ✅ _(Decision 0008: `SCHEMA_VERSION = 1`)_
- **A2.** Re-introduce the `Confidence` union + the six-field finding type. → `POL-03`, `CAP-20` ✅ _(unified `Finding.uncertainty: UncertaintyItem[]`, Decision 0008)_
- **A3.** Configurable scope/exclusion strategy + file walk → `files[]` as relative POSIX paths. → C1 / `CAP-01`,`CAP-02` ✅ _(Decision 0009; `src/scope.ts`)_
  - **A3a.** ✅ `detectLanguages` — manifests + file extensions (5 tests).
  - **A3b.** ✅ `resolveScope` — 4 modes (`auto`/`gitignore`/`language`/`none`) → `ScopeResolution`; `ignore` package for gitignore semantics (9 tests).
  - **A3c.** ✅ `walkFiles` — dir prune + gitignore patterns → sorted relative POSIX `files[]` + excluded info (5 tests).
  - **A3d.** ✅ `previewScope` + `formatScopePreview` — preview without writing; codebase-only in every mode (5 tests).
  - **A3e.** ✅ `init_codebase` takes the config and records resolved scope under `summary.excluded` (covered in `init.test.ts`).
- **A4.** Per-file SHA-256 + size; large-file & binary policy. → C3 / `CAP-05` ✅ _(Decision 0010; `src/files.ts` `hashFile`: 5 MB cap → metadata hash; binaries content-hashed + `analyzable: false`; `FileEntry` has `hashScope`/`analyzable`/`analysisReason`)_
- **A5.** `mapHash` (schemaVersion + scopeHash + sorted file-identity records); atomic persistence + staleness fingerprint. → C4,C9 / `CAP-01`,`CAP-17` ✅ _(Decision 0011: temp+fsync+rename, gitignored artifact dir, fingerprint → rehash → mapHash compare; marker-based `initializing`/`failed` per ADR 0014; `RecordedScope` carries re-walk inputs)_

_Note: `categorizeFile` (Epic B1) was implemented early as a prerequisite for the init build. Provider `analyze` (Epic B) and the formatters (Epic D) are now complete, so init/status/summary are fully reachable through the tool/CLI surface._

### Epic B — Map derivation — ✅ COMPLETE (providers + entry points + modules + findings; ADRs 0016–0018)
- **B1.** `categorizeFile` taxonomy. → C2 / `CAP-02`
- **B2.** Entry-point detection (confidence + reason). → C5 / `CAP-02`
- **B3.** Module grouping. → C6 / `CAP-02`,`CAP-16`
- **B4.** Ownership signals (approach per D2). → C7 / `CAP-13`,`CAP-08`

### Epic C — Findings & state — ✅ COMPLETE (D4 findings derivation, ADR 0017; init-state model in Epic A)
- **C1.** Init-state model + staleness (`mapHash`/`schemaVersion` compare); refresh advice. → C4 / `CAP-04`,`CAP-05`,`CAP-06`,`CAP-22`
- **C2.** Duplicate-path candidates (heuristic + confidence). → C8 / `CAP-08`,`POL-06`
- **C3.** Legacy-path candidates (heuristic + confidence). → C8 / `CAP-09`,`POL-07`
- **C4.** Risk areas + `codebaseOnlyBoundary` + uncertainty findings (incl. reachability & change-impact as `unresolved`). → C8 / `CAP-07`,`CAP-10`,`POL-04`

### Epic D — Output — ✅ COMPLETE (all 19 formatters, human/llm/dual; ADR 0015)
- **D1.** `formatInitStatus` / `formatInitResult` / `formatContextSummary` in both modes, kept in sync with the schema. → C10 / `CAP-03`,`CAP-18`,`CAP-19`
- **D2.** Confirm pre-init / not-initialized messaging matches CAS policy. → C10 / `CAP-22`

### Epic F — Analysis capabilities (CAP-07..16) — ✅ COMPLETE (ADR 0019)
- **F1.** Reachability hypotheses (`analyze_reachability`) — graded + uncertainty, never runtime-proven. → `CAP-07`
- **F2.** Duplicate-behavior (`find_duplicate_behavior`) + ownership (`get_ownership`). → `CAP-08`,`CAP-13`
- **F3.** Legacy classification (`classify_legacy_paths`) — six reachability/risk classes. → `CAP-09`
- **F4.** Change-impact (`analyze_change_impact`) + test-path tracing (`analyze_test_paths`). → `CAP-10`,`CAP-15`
- **F5.** Preflight (`review_preflight`) + change review (`review_change`). → `CAP-11`,`CAP-12`
- **F6.** Failure investigation (`investigate_failure`) + architecture-drift (`detect_architecture_drift`). → `CAP-14`,`CAP-16`

### Epic G — Call stack & visualization (CAP-23..25) — ✅ COMPLETE (ADR 0020)
- **G1.** Static call-graph extraction (`map_call_stack`) — parsed calls + import resolution; grade dynamic/DI/framework/reflection edges as candidate/unresolved (ties to D2). → `CAP-23`
- **G2.** Call-stack visualization (`visualize_call_stack`) — emit Mermaid/DOT/ASCII spec + confidence legend. → `CAP-24`
- **G3.** Architecture visualization (`visualize_architecture`) — modules/ownership/drift diagram spec. → `CAP-25`

### Epic H — Path-finding & graph index (post-MVP) — ✅ COMPLETE (ADR 0023)
- **H1.** Static point-to-point path-finding (`src/pathfinding.ts`): bidirectional-BFS fewest-hop, max-bottleneck (widest-path) best-confidence, dominance-ordered k-best, iterative Tarjan SCC; emitted confidence clamped to `likely`. → `CAP-23`, `CAP-07`
- **H2.** Derived `graph-index.sqlite` (`src/graphIndex.ts`, built-in `node:sqlite`): indexed caller/callee/path queries, SCC cached once, stamped with `mapHash` and rebuilt on mismatch; the JSON map stays the single source of truth. → `CAP-23`
- **H3.** Correctness + structural performance tests + the implementation note [`pathfinding-and-graph-index.md`](./pathfinding-and-graph-index.md). _Implemented + tested but **not yet wired** into the analysis/call-graph traversal layer — see **Epic I** (HF-1)._

### Epic I — Unify graph traversal behind `GraphSource` (HF-1, ADR 0024) — ✅ DONE (I1–I4)
`analysis.ts` and `callGraph.ts` now traverse a single `GraphSource` substrate instead of two hand-rolled adjacency engines. `GraphSource` (neighbors + node lookups) has two implementations: `inMemoryGraphSource` (fallback, from the JSON map) and the SQLite-backed `GraphIndex`; `loadGraphContext` picks the index for large graphs, else the in-memory source — **SQLite is optional** (no hard Node ≥ 22.5 floor on the critical path). Resolves review findings HF-1, MF-8, MF-9, MF-12.
- **I1.** ✅ `GraphSource` is the single substrate — `loadAnalysisContext`/`traverse` (analysis.ts) and `mapCallStack` (callGraph.ts) consume `callees`/`callers` + node lookups; hand-rolled adjacency deleted; dead `RESOLVED_KINDS` removed (A5). Reachability semantics preserved + tested (MF-4). → `CAP-23`, `CAP-07..16`
- **I2.** ✅ Indexed symbol/path lookups (`GraphIndex` `nodes_symbol`/`nodes_path`, schema v2; `Map`s in-memory) so `resolveTargets` stops linear-scanning (review MF-8). → perf
- **I3.** ✅ `find_callers` / `find_path` MCP tools (`src/pathQueries.ts` + formatters + CLI) wrap the path-finding algorithms over the shared substrate in the codebase-only envelope (`likely`-clamped) — `findFewestHopPath`/`findBestConfidencePath`/`findKBestPaths` are now live in the product (19 tools total). → `CAP-23`
- **I4.** ✅ `GraphIndex` raw query methods kept internal; the analysis/call-graph layer wraps every result in the `analysisBoundary`/uncertainty envelope; headline docs corrected (no longer imply the index was already in use).

### Epic J — Internal seams: analysis context, tool table, schema split, fixtures (ADR 0025) — ✅ DONE (J1–J4)
A post-Epic-I architecture review surfaced four internal-friction findings; ADR 0025 reorganized the implementation around them. Product surface (19 tools, CLI commands, output formats, schema v1) byte-compatible.
- **J1.** ✅ `src/schema.ts` — the behavior-free shared type vocabulary, split from the map engine (`contextMap.ts` keeps build/persist/staleness/derivation behind init/status/read). Pure file move; schema v1 (ADR 0008) and mapHash/staleness (ADR 0011) unchanged.
- **J2.** ✅ `src/analysisContext.ts` — one `withContext` envelope (load → init-guard → close, ADR 0024 lifecycle) for all 13 graph-query capabilities; `makeAnalysisContext` makes the `GraphSource` seam injectable (capabilities take `AnalysisTarget`); `reviewPreflight`/`visualizeArchitecture` compose sub-capabilities over ONE shared context; close-ownership pinned by tests (never close an injected context). → `CAP-07..16`, `CAP-23`
- **J3.** ✅ `src/tools.ts` — declarative table of 19 tool specs; MCP registration and CLI dispatch become two adapters over it (`registerTools` / `findCliSpec`+`cliArgs`); usage derives from the table; the previously-uncovered `index.ts` surface gains table + CLI-mapping + execute round-trip tests.
- **J4.** ✅ `test/helpers/fixtures.ts` — shared `tempRepos` factory + `testContextMap`/`testFileEntry`/`testNode`/`testEdge` builders; the five files that hand-rolled mkdtemp fixtures and the two hand-written map literals now build on it. (Suite at Epic J close: 253 tests / 16 files.)

### Epic K — Findings derivation v2 + re-export visibility (ADR 0026) — ✅ DONE (K1–K2)
An architecture/product exploration chose seven richer findings rules + re-export visibility; ratified as ADR 0026 (amends 0017 — the "scattered ownership" claim becomes true). All findings ≤ `candidate`, capped, uncertainty-carrying; dead code never asserted.
- **K1.** ✅ Seven map-only rules in `deriveFindings`: cyclic dependency clusters (Tarjan SCC over resolved edges, ≥ 2 files), low-static-visibility hotspots (weak-edge ratio — grades the map's own evidence), source→test dependency violations, scattered ownership (≥ 3 modules), statically untested modules (forward closure from test declarations; skipped without test decls), god-functions (fan-out ≥ 20), entry-point-orphan modules (closure from detected entry points; source modules only; never "dead"/"unused"). → `CAP-08`, `CAP-09`, `CAP-16`
- **K2.** ✅ Re-export visibility: optional `OwnershipSignal.reExport` (additive, schema stays v1, `mapHash` untouched); the TS provider emits an alias signal — no call-graph node — for every exported name with no local declaration (`export {x} from` / `export * from` / import-then-export; `default` skipped); findings exclude aliases from duplicate/scatter grouping. → `CAP-13`
- Deferred (recorded in ADR 0026): signature-aware duplicate detection.

### Epic L — C# Roslyn provider: optional .NET sidecar, confirmed tier (ADR 0027) — ✅ DONE (L1–L2)
The first post-MVP language-provider upgrade: C# moves from the tree-sitter tier (`likely`, no cross-file) to a compiler-API tier when the environment allows. Strictly optional — availability chooses the tier, never correctness (the SQLite pattern, ADR 0024).
- **L1.** ✅ `tools/roslyn-analyzer` — single-file Roslyn console tool: ONE ad-hoc compilation over the batch's syntax trees (no MSBuild, `.Emit()` never called, no target execution/loading); emits namespace types + methods (`path#Type`/`path#Type.Method`, exported = public), CLEAN-binding-only resolved edges (virtual/abstract/override/interface dispatch → `method`; candidate/failed bindings → `unresolved` — never graded resolved), ctor/accessor calls attributed to the TYPE node, entry hints (static Main / top-level statements). → `CAP-13`, `CAP-23`
- **L2.** ✅ `src/providers/csharp.ts` — `confirmed`-ceiling provider gated on a memoized `dotnet` probe; registry order `[typescript, csharp, treeSitter, heuristic]`; build memoized per process; file TEXTS passed to the sidecar (honors the `readFile` contract); `direct`→`confirmed`, `method`→`likely` (ADR 0016/0018); every failure path → empty extraction. Tests via `describe.runIf(dotnetAvailable)` — the ratified optional-dependency pattern. → `CAP-13`
- Deferred (ADR 0027): fields/properties as ownership signals; multi-batch cross-project resolution; richer external references.

### Epic M — Capability evaluation harness (ADR 0029) — ✅ DONE (M1–M2)
Eval-first (ADR 0028): the engine's risk is unverified claims, so quality is now a measured number.
- **M1.** ✅ `eval/` — five golden-annotated fixture repos + `eval/harness.ts` scorer (symbol/exported/edge/entry accuracy, duplicate + legacy correctness incl. class, findings-v2 patterns, reachability mustReach/mustNotReach, binary handling) + universal confidence invariants checked on every subject + perf/token-shape recording. Goldens are human-authored static ground truth (`eval/goldens/README.md`), never regenerated from output.
- **M2.** ✅ `npm run eval` scorecard runner (external real repos via `CCM_EVAL_EXTERNAL`, auto scope, invariants-only) + `test/evalHarness.test.ts` CI gate (100% required / 0 forbidden / 0 violations; C# fixture dotnet-gated). Baseline: 75/75 across five fixtures; two external repos invariant-clean; the 357k-token `llm_readable` summary on a 2.6k-file repo recorded as Epic O/Q input.

### Epic Q — Benchmark/performance gates (ADR 0030) — ✅ DONE (Q1–Q2)
Deterministic-first gating: a red gate always means a real product change.
- **Q1.** ✅ Instrumentation: `InitResult.timings` (per-provider `{id, files, ms}` + total — additive, never persisted, `mapHash` untouched, verified); the eval harness bench section (explicit SQLite `GraphIndex` open + build timing, fixed path query with `QueryMetrics`, `sqliteQueryCount`, `sccBuildCount`, heap delta record-only). → protects ADR 0023/0024
- **Q2.** ✅ `eval/baselines.json` (structural baselines from a verified-good run; update-with-reasoning, never auto-regenerated) + `test/benchGates.test.ts`: HARD gates on file/node/edge counts, fixed-query expansion/neighbor/SQLite counts, SCC-built-once, summary size ±20%; SOFT sanity ceilings on wall-clock; Roslyn-tier fixtures dotnet-gated. `npm run eval` prints idxMs + pq columns.

### Epic O — Diff / PR mode (ADR 0031) — ✅ DONE (O1–O2)
The roadmap's six capability names (`analyze_diff`, `review_changed_paths`, `compare_maps`, `detect_new_duplicate_paths`, `detect_new_legacy_reachability`, `detect_confidence_regression`) share one primitive — a delta between two static maps — so they shipped as six sections of ONE tool, `analyze_diff` (CLI `diff`; tool count 19 → 20).
- **O1.** ✅ `src/mapDiff.ts` — pure comparator (`compareMaps`) + verdict grading (`gradeDelta`) + the `analyzeDiff` capability. Default: persisted baseline vs a fresh in-memory rebuild of the current tree under the baseline's RECORDED scope (`recordedScopeToResolution` — the delta is never scope noise; nothing persisted, re-baselining stays an explicit `init_codebase`); optional `baselineMapPath` for CI (map@main vs map@head). Six capped sections (every list capped at 25 with true counts): files, graph node/edge deltas, new/resolved duplicates, legacy reachability transitions (revived = `still_reachable`), new/resolved risk areas, per-edge confidence regressions + weak-edge-ratio/uncertainty-register deltas. Verdict: `addedParallelPath`/`bypassedAbstraction`/`revivedLegacy`/`increasedUncertainty` + one `Recommendation`. Engine: `buildContextMapFromResolution` split out of `buildContextMap` (additive; persistence/`mapHash`/schema v1 untouched). → `CAP-11`, `CAP-12`
- **O2.** ✅ `formatMapDiff` (20th formatter) + the `analyze_diff` tool spec; 15 new tests (7 pure-comparator incl. list caps, 5 integration incl. baseline-survives + CI shape + envelope) + formatter sweep + tool pins. Deferred with reasoning (ADR 0031): eval-harness diff goldens need *paired* fixture snapshots; semantic rename detection; three-way diffs.

### Epics N/R/S/T/P — planned (v0.2 "Verified Static Context", ADR 0028 — in ratified order)
- **Epic N — C++ semantic tier:** optional clangd/libclang provider (compile_commands.json/CMake detection, header/source + namespace resolution, include graph, macro-aware confidence); fallback clang → tree-sitter → heuristic.
- **Epic R — Productized setup/onboarding:** npx story, MCP config examples, init wizard, `doctor`/provider-availability report, `explain-tools`, sample walkthrough.
- **Epic S — CAS export integration:** export workflows (product context, decision records, findings summary, drift report, preflight context) into CAS-friendly paths.
- **Epic T — Canonical path registry:** user-declared intended architecture (canonical/deprecated workflows, owned modules, forbidden dependencies) upgrading findings from generic to intent-aware.
- **Epic P — Incremental refresh** (last; needs M/Q measurements): changed-file detection, affected symbols/edges/findings, partial rebuild, provider cache, section invalidation.
- **Anti-goals until Q lands:** no new findings rules or provider claims without harness scores; no new visualizers before accuracy metrics; no runtime features (permanent); SQLite stays optional.

### Epic E — Verification — ✅ COMPLETE
- **E1.** ✅ The original 25 `it.todo` tests (core + analysis + call-stack/visualization, see §3) are long since filled and grown far past — the suite has 0 `it.todo` (current count in [`STATUS.md`](./STATUS.md)).
- **E2.** ✅ PostToolUse typecheck+test hooks wired; `npm test` green; the anti-slop gate (`npm run slop`) keeps it meaningful.

## 3. Test plan — core map tests (HISTORICAL: the original 25 `it.todo` seeds, all implemented since)

The table below covers the core map tests. The 11 analysis `it.todo` tests (one per analysis tool plus the init-gating test) are tracked under Epic F and follow the same evidence/confidence/uncertainty acceptance shape.

| Test | Asserts | Acceptance |
|---|---|---|
| reports `not_initialized` before init | `checkInitState` on a fresh repo | status `not_initialized`; message advises init |
| writes a baseline map and reports `initialized` | `initCodebase` then `checkInitState` | artifact written at `.code-cartographer-mcp/context-map.json`; status `initialized`; category counts correct |
| reports `stale` when content changes | mutate a tracked file post-init | status `stale`; `mapHash` differs |
| records entry points / modules / ownership | mapped fixture repo | expected `entryPoints`/`modules`/`ownershipSignals` present with confidence + reason |
| detects duplicate / legacy / risk findings | fixture with a copy + a `legacy/` path | findings populated with correct labels + confidence |
| renders findings in human + llm output | both modes | markdown has the sections; `llm_readable` is valid JSON with `analysis_boundary: "codebase_only"` |

Fixtures: build small temp repos (the prior tests used `mkdtemp`-style fixtures —
see git `fc65a79` `test/contextMap.test.ts` for reference shapes).

## 4. Definition of done (per task)

- Behavior traces to a CAS requirement ID above; no scope added without a CAS update (`POL-11`/`POL-13`).
- Confidence labels correct; no static inference upgraded to runtime truth (`BND-02`, `POL-03`).
- Covered by a test; `npm run typecheck` and `npm test` green.
- Schema changes reflected in **both** `output.ts` renderings and bump `schemaVersion` per the chosen policy.

## 5. References
- [`STATUS.md`](./STATUS.md) · [`architecture.md`](./architecture.md) · [`cas-source-of-truth.md`](./cas-source-of-truth.md)
- Prior implementation for reference shapes: git commit `fc65a79`.
