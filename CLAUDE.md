# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies (pinned via `package-lock.json`).
- `npm run build` — compile `src/` to `dist/` via `tsc`.
- `npm run typecheck` — type-check without emitting.
- `npm test` — run the Vitest suite once.
- `npm run slop` — anti-slop gate: fails if `src/`/`test/` contain disabled/narrowed tests (`.skip`/`.only`/`.todo`), type-checker suppressions (`@ts-ignore`/`@ts-expect-error`), or tautological `expect(true)` assertions. Runs in CI (`.github/workflows/ci.yml`).
- `npx vitest run test/contextMap.test.ts` — run a single test file.
- `npx vitest run -t "stale"` — run tests matching a name.
- `npm run dev` — start the stdio MCP server through `tsx` (no build needed).
- `npm run cli -- <init|status|summary> <repositoryRoot> [--llm]` — exercise the tools as a CLI. `--llm` selects `llm_readable` JSON output instead of human-readable markdown.
- `npm start` — run the compiled `dist/index.js` (build first).
- MCP clients must point at the **built** `dist/index.js` (`npm run build` first); `dev`/`cli` run unbuilt `src/` via `tsx`. See `docs/mcp-client-config.md`.
- `git config core.hooksPath .githooks` — enable the local secret/PII scanning hooks. These are bash scripts: on this Windows-primary repo they run under Git Bash/WSL; on macOS/Linux also `chmod +x .githooks/*`.

## Status: implemented (Epics A–G)

**The full product is implemented and tested.** `init_codebase` builds, persists (atomic + gitignored), and `check_init_state` stale-checks a real `.code-cartographer-mcp/context-map.json` that carries files, languages, entry points, modules, ownership signals, a **static call graph** (provider-extracted), and confidence-graded findings. The **19 MCP tools** and the CLI all work end-to-end. Source layout:

- `src/scope.ts` — scope/exclusion (4 modes, gitignore via `ignore`, preview→confirm).
- `src/files.ts` — `hashFile` (cap→metadata, binary sniff) + `categorizeFile`.
- `src/providers/` — `LanguageProvider` registry, three tiers: **TS/JS provider** (TS compiler API, one Program/checker, type-resolved cross-file → `confirmed`), **tree-sitter provider** (Python/Go/Java/Rust/Ruby/C#/C++/C via WASM grammars → `likely`; cross-file resolution for Go/Python/Rust), and the **heuristic** regex floor (`candidate`). Engine clamps each to the provider's ceiling.
- `src/contextMap.ts` — types + map engine: `buildContextMap` (runs providers → ownership/entry hints/call graph + findings), persistence, `mapHash`/staleness, entry-point/module derivation.
- `src/findings.ts` — D4 derivation (duplicate/legacy/risk/canonical + uncertainty register).
- `src/analysis.ts` — the 10 capabilities (CAP-07..16) over the persisted map, traversing a shared `GraphSource` substrate (ADR 0024) — never hand-rolled adjacency.
- `src/callGraph.ts` / `src/visualize.ts` — `mapCallStack` (over the same `GraphSource`) + Mermaid/DOT/ASCII diagram specs.
- `src/pathfinding.ts` — `NeighborSource`/`GraphSource` contract + `inMemoryGraphSource` fallback + `resolveNodeIds` + static path-finding (ADR 0023): bidirectional-BFS fewest-hop, max-bottleneck best-confidence, k-best, Tarjan SCC; emitted confidence clamped to `likely`.
- `src/graphIndex.ts` — derived `graph-index.sqlite` (built-in `node:sqlite`, ADR 0023/0024): a `GraphSource` with indexed caller/callee + symbol/path lookups, SCC cached once, stamped with `mapHash`, rebuilt on mismatch. `loadGraphContext` picks it for large graphs, else the in-memory fallback (SQLite optional). A disposable projection of `map.callGraph`, never a second source of truth.
- `src/pathQueries.ts` — the `find_callers` / `find_path` capabilities (ADR 0024/0023): surface the path-finding algorithms over the shared `GraphSource` as codebase-only, `likely`-clamped results.
- `src/output.ts` — 19 formatters (human/llm/dual).

~231 tests passing; build/typecheck pass. Decisions 0001–0024 in the CAS source of truth record the design. The codebase-only contract is load-bearing: confidence is clamped to the weakest edge, reachability/ownership never exceed `likely`, dead code is never asserted, and runtime claims stay `unresolved`.

## Architecture

This is an MCP server that produces **static, codebase-only** context maps of a target repository. The hard product boundary: it never executes the target app, runs tests, attaches a debugger, or claims runtime truth — outputs stay evidence-based and carry explicit uncertainty.

Source files:

- `src/index.ts` — entry point. Registers all **19 MCP tools** (3 core map + 10 analysis + 3 call-stack/visualization + 2 path queries (`find_callers`/`find_path`), plus the scope `preview`) on an `McpServer`. The same `main()` doubles as a CLI: if `process.argv` has extra args it dispatches `runCli` (`preview`/`init`/`status`/`summary`/`reachability`/`duplicates`/`legacy`/`impact`/`preflight`/`review`/`ownership`/`failure`/`test-paths`/`drift`/`callstack`/`find-callers`/`find-path`/`viz-callstack`/`viz-arch`); otherwise it connects a `StdioServerTransport`. Each tool calls an engine/analysis function and formats via `output`.
- `src/contextMap.ts` — core type system + map engine. The full shared vocabulary (`Confidence`, 3-mode `OutputMode`, 5-state `InitState`, six-field `Finding`, `Recommendation`, path/legacy/impact substructures), the `StaticContextMap` shape, and the engine: `buildContextMap` walks the repo (skipping `EXCLUDED_DIRS`), categorizes files, runs providers, derives the map; `initCodebase` writes `.code-cartographer-mcp/context-map.json`; `checkInitState` compares `mapHash` + `schemaVersion` to detect `stale`. Component model + open decisions: [`docs/architecture.md`](docs/architecture.md).
- `src/analysis.ts` — analytical capabilities (CAP-07..16). Result types + 10 functions (reachability, duplicate, legacy, change-impact, preflight, change-review, ownership, failure, test-paths, drift). All require an initialized map; reachability/impact/failure return evidence-graded hypotheses with explicit uncertainty, never runtime proof.
- `src/callGraph.ts` — static call-stack mapping (CAP-23). Call-graph types + `mapCallStack`. A **static**, confidence-graded call graph (dynamic/DI/framework/reflection edges → `candidate`/`unresolved`), never a runtime trace.
- `src/visualize.ts` — visualization (CAP-24/25). `Visualization` (mermaid/dot/ascii) + `visualizeCallStack` / `visualizeArchitecture`. Returns a diagram **spec** the client renders, never an image; carries a confidence/edge-kind legend.
- `src/pathfinding.ts` — static path-finding (ADR 0023). Pure algorithms over a `NeighborSource`: bidirectional-BFS fewest-hop, max-bottleneck (widest-path) best-confidence, dominance-ordered k-best, iterative Tarjan SCC. Static path / possible path / reachability path — never a runtime stack; emitted confidence clamped to `likely`.
- `src/graphIndex.ts` — derived SQLite graph index (ADR 0023). `graph-index.sqlite` via built-in `node:sqlite` (Node ≥ 22.5; no third-party dep). Indexed `findCallers`/`findCallees`, SCC built once per snapshot. A projection of `map.callGraph` stamped with `mapHash` and rebuilt on mismatch — the JSON map stays the single source of truth; `mapHash`/staleness composition (ADR 0011) is unchanged.
- `src/output.ts` — formatting only. 19 formatters, one per result type, each rendering in `human_readable`, `llm_readable`, or `dual`, kept in sync with the result shapes and preserving confidence + uncertainty.

Persisted artifact: `<repo>/.code-cartographer-mcp/context-map.json` — written atomically (temp + fsync + rename) with the artifact dir gitignored (ADR 0011). Staleness (ADR 0011) is two-tier: a cheap fingerprint (per-file `sizeBytes`+`mtimeMs`, `fileCount`, `scopeHash`, `schemaVersion`) short-circuits to `fresh`; if it differs, files are rehashed and `mapHash` (= sha256 of `schemaVersion` + `scopeHash` + sorted file-identity records) is compared to flip to `stale`. The `schemaVersion` value is **resolved** (ADR 0008: `1`) — `SCHEMA_VERSION = 1` in `src/contextMap.ts`, with provenance grouped under `MapMeta`, `summary.languages`/`summary.excluded` (incl. `scopeHash`), and `FileEntry` carrying `hashScope`/`analyzable`/`analysisReason`/`mtimeMs` (ADRs 0010/0011).

### Conventions that matter

- **Strict TypeScript, NodeNext ESM.** Relative imports must use `.js` extensions even for `.ts` files (e.g. `import ... from "./contextMap.js"`). `rootDir` is `src`, so tests are not compiled into `dist`.
- **Confidence vocabulary is load-bearing.** The `Confidence` union (`confirmed` | `likely` | `candidate` | `unclear` | `unresolved`) and the `codebaseOnlyBoundary`/uncertainty findings encode the codebase-only contract (CAS `POL-03`). Preserve them: do not upgrade a static inference to `confirmed` runtime truth. Confidence is clamped to the weakest edge, and reachability/ownership never exceed `likely`.
- **Runtime-proven reachability is out of scope.** The static, confidence-graded call graph and reachability hypotheses are implemented, but runtime *proof* of reachability/dead code is not — it must stay an `unresolved` uncertainty, never asserted.
- Naming: `camelCase` functions/vars, `PascalCase` types/interfaces, `UPPER_SNAKE_CASE` module constants. Two-space indent.

### Product boundary (CAS)

Requirements, policies, prompts, and decisions live in the sibling repository `../debug_mcp_context_manager` (the Context Architecture System), which is the source of truth — see `docs/cas-source-of-truth.md`. This repo owns implementation only. Read CAS for guidance before planning; if implementation reveals a requirement gap, propose a CAS update rather than changing product scope here. Do not copy CAS context files into this repo as code.

See `AGENTS.md` for the full contributor guide.
