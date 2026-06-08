# Project Status

_Last updated: 2026-06-08_

## TL;DR

**The full product is implemented and tested (Epics A–G).** `init_codebase`
builds, persists (atomic + gitignored), and `check_init_state` stale-checks a real
`.code-cartographer-mcp/context-map.json` carrying files, languages, entry points,
modules, ownership signals, a provider-extracted **static call graph**, and
confidence-graded findings. Three provider tiers: the **TS/JS provider** (TS
compiler API) type-resolves cross-file edges (`confirmed`); the **tree-sitter
provider** parses 8 languages (Python, Go, Java, Rust, Ruby, C#, C++, C) via WASM
grammars (`likely`), with cross-file resolution for Go (packages), Python
(imports), and Rust (`use`/modules); a heuristic regex floor covers the rest
(`candidate`). All **17 MCP tools** and the CLI work end-to-end (dogfooded on this
repo). A **static path-finding subsystem** (bidirectional-BFS fewest-hop, max-bottleneck
best-confidence, k-best, Tarjan SCC) over a **derived `graph-index.sqlite`** (built-in
`node:sqlite`) backs indexed caller/callee/path queries (ADR 0023). **~221 tests passing**;
build/typecheck pass. Design is recorded in CAS Decisions 0001–0023. See
[`architecture.md`](./architecture.md), [`backlog.md`](./backlog.md), and
[`pathfinding-and-graph-index.md`](./pathfinding-and-graph-index.md).

## What exists today (implemented)

| Area | State |
|---|---|
| `src/index.ts` | **Implemented.** Registers all **17 MCP tools** on an `McpServer` and a `main()` that dispatches the CLI (`preview`/`init`/`status`/`summary`/`reachability`/`duplicates`/`legacy`/`impact`/`preflight`/`review`/`ownership`/`failure`/`test-paths`/`drift`/`callstack`/`viz-callstack`/`viz-arch`) or connects `StdioServerTransport`. Each handler calls a working engine/analysis function and formats via `output`. |
| `src/contextMap.ts` | **Implemented.** The full shared vocabulary (`Confidence`, 3-mode `OutputMode`, 5-state `InitState`, six-field `Finding`, `Recommendation`, path/legacy/impact substructures), the ratified `StaticContextMap` shape (schema v1; `FileEntry` carries `hashScope`/`analyzable`/`analysisReason`/`mtimeMs`; `mapHash`/staleness per ADR 0011), and the map engine: `buildContextMap` (providers → ownership/entry hints/call graph + findings), atomic persistence, `initCodebase`/`checkInitState`, entry-point/module derivation. |
| `src/scope.ts` | **Implemented.** Configurable scope/exclusion subsystem (ADR 0009): 4 modes, `ScopeResolution`/`ScopePreview`/`WalkResult`/`RecordedScope`, and `detectLanguages`/`resolveScope`/`previewScope`/`walkFiles` (gitignore via the `ignore` pkg). |
| `src/files.ts` | **Implemented.** `hashFile` (per-file SHA-256 + size, 5 MB cap→metadata hash, binary sniff, `analyzable`/`analysisReason`; ADR 0010) + `categorizeFile`. |
| `src/providers/` | **Implemented.** `LanguageProvider` registry + three tiers: TS/JS provider (TS compiler API, type-resolved cross-file → `confirmed`), tree-sitter provider (Python/Go/Java/Rust/Ruby/C#/C++/C via WASM grammars → `likely`; cross-file resolution for Go/Python/Rust), and the heuristic regex floor (`candidate`). Engine clamps each to the provider's ceiling. (ADRs 0012/0013/0018/0021/0022.) |
| `src/findings.ts` | **Implemented.** D4 derivation (ADR 0017): duplicate / legacy (six-class, never dead) / risk / canonical + D3 parallel modules + R3 bypassed abstraction, all ≤ `candidate` with in-record uncertainty. |
| `src/analysis.ts` | **Implemented.** The **10 capability functions** for CAP-07..16 (reachability, duplicate, legacy, change-impact, preflight, change-review, ownership, failure, test-paths, drift) over the persisted map + call graph; init-gated, confidence-capped, uncertainty-explicit (ADR 0019). |
| `src/callGraph.ts` | **Implemented.** Static call-graph types + `mapCallStack` (CAP-23) over the persisted call graph; dynamic/DI/framework/reflection edges → `candidate`/`unresolved`. |
| `src/visualize.ts` | **Implemented.** `Visualization` (mermaid/dot/ascii) + `visualizeCallStack` (CAP-24) and `visualizeArchitecture` (CAP-25) — emit diagram **specs**, never rendered images (ADR 0020). |
| `src/output.ts` | **Implemented.** All **17 formatters** (one per result type, incl. `formatScopePreview`) in `human_readable` / `llm_readable` / `dual` (ADR 0015). |
| `src/pathfinding.ts` | **Implemented.** Static point-to-point path-finding over a `NeighborSource` (ADR 0023): bidirectional-BFS fewest-hop, max-bottleneck (widest-path) best-confidence, dominance-ordered k-best, iterative Tarjan SCC, structural `QueryMetrics`. Emitted confidence clamped to `likely`. |
| `src/graphIndex.ts` | **Implemented.** Derived `graph-index.sqlite` via built-in `node:sqlite` (ADR 0023): indexed `findCallers`/`findCallees`, SCC cached once per snapshot, stamped with `mapHash`, rebuilt when missing/schema-stale/hash-stale. A disposable projection of `map.callGraph` — never a second source of truth. |
| `test/*.test.ts` | **221 tests passing, 0 `it.todo`** across 13 files (core map, scope/exclusion, providers, derivation, findings, analysis, viz, call-stack, **pathfinding**, **graphIndex**, and a structural **benchmark** suite). |
| Build / typecheck | **Pass** — compiles clean under strict TypeScript. |
| `.code-cartographer-mcp/context-map.json` | **Produced** — `initCodebase` writes it atomically (temp + fsync + rename), artifact dir gitignored. Dogfooded on this repo (509 ownership signals, 467 call edges / 157 cross-file). |
| `.code-cartographer-mcp/graph-index.sqlite` | **Derived (ADR 0023).** A rebuildable projection of `map.callGraph` (same gitignored dir). Stamped with `mapHash`; rebuilt on mismatch. The JSON map stays the single source of truth — `mapHash`/staleness composition is unchanged. |

## Remaining work

Epics A–H are implemented. PR #1 (the genesis review PR) got a 5-dimension multi-reviewer pass; its boundary-wording (HF-2/3/4) and analysis-classification test (HF-5/6) findings are fixed. What's left:

- **▶ NEXT — Wire the graph index as the single traversal substrate (HF-1 · Epic I · design pending ADR 0024).** The ADR-0023 path-finding + `graph-index.sqlite` subsystem is implemented and tested but **unwired**: `src/index.ts` references neither file, while `analysis.ts`/`callGraph.ts` hand-roll their own adjacency/BFS over `map.callGraph`. Make `GraphIndex`/`NeighborSource` the one traversal substrate (and optionally surface `find_path`/`find_callers` tools), wrapping results in the codebase-only envelope. Resolves review findings HF-1, MF-8, MF-9, MF-12.
- **More language-specific providers** behind the existing `LanguageProvider` interface (e.g. C#/Roslyn, deeper Python/Go), and richer findings rules.
- **Promote draft CAS policies** (`output-mode-policy.md`, workflows, prompts) from draft → accepted now that they are realized in code.
- **Confirm final dependency pins** (architecture D5: `typescript` is a runtime dep; confirm SDK/zod/vitest pins; bump `engines.node` to ≥ 22.5 for `node:sqlite`) before any release.

## Source of truth

Product requirements, policies, and decisions live in the sibling **CAS** repo
`../debug_mcp_context_manager` (see [`cas-source-of-truth.md`](./cas-source-of-truth.md)).
This repo owns implementation only. The CAS-side current-state record is
`context/sessions/2026-06-08_local-multireview-and-boundary-fixes.md` and
`context/00_index/index.md`; design is recorded in ADRs 0001–0023 under
`context/07_decisions/` (ADR 0024 — graph-index wiring — is the next planned decision).

## Next steps

1. **▶ Design the graph-index wiring (HF-1 / Epic I) → ADR 0024**, then implement test-first: make `GraphIndex`/`NeighborSource` the single traversal substrate for `analysis.ts`/`callGraph.ts`.
2. **Polish / depth** — additional providers, findings rules, surface `find_path`/`find_callers` tools.
3. **Release prep** — confirm dependency pins (D5), bump `engines.node` to ≥ 22.5, promote draft CAS policies to accepted.
