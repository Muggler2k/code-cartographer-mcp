# Changelog

All notable changes to Code Cartographer MCP are recorded here. This project adheres to
[Semantic Versioning](https://semver.org/). The product boundary is **static, codebase-only**:
it never executes the target app, runs its tests, attaches a debugger, or claims runtime truth —
outputs stay evidence-based and carry explicit confidence/uncertainty.

## [1.0.0] — 2026-06-15 — GA (internal MCP tool)

First generally-available release, blessed for internal use as an MCP tool for the
agents-via-Claude-Code target (CAS ADR 0034). GA is an owner decision recorded in
`../debug_mcp_context_manager/context/09_outputs/adr-0034-ga-readiness-and-runbook.md` §4.

**What GA rests on** — the static-correctness + safety gates are CI-protected on every PR:
- **Codebase-only honesty SLO** — zero false `confirmed`; gated by exact-confidence edge matching
  on golden fixtures + `checkInvariants`, and verified on real dense code (`test/realCorpusGate.test.ts`
  over `node_modules/typescript/lib`).
- **Token budget** — every tool's `llm_readable` payload clears the ~2000-token agent budget
  (shared `cappedSample`/`cappedSection`/`digestNote` digests; counts + true totals + boundary preserved).
- **Never-throw** — the build degrades pathological inputs (unreadable/over-cap/binary/non-UTF8/
  broken-syntax/symlinks/submodule-gitlinks, and >125k-edge aggregation) to disclosed non-analyzable
  records, never a throw (`test/robustness.test.ts`); validated at VS Code scale (211,706 edges).
- **Cold-start latency SLAs** — fresh-process gates on all named drivers (WASM grammar load, TS Program,
  Roslyn warm-up, count-scaling, a real pinned corpus) with anti-flakiness headroom (`test/latencySla.test.ts`).
- **Staleness under churn** — ADR 0011 incremental re-analysis validated (`test/churn.test.ts`).

**Honest residual (post-GA, not a release blocker):** a full multi-human live trust A/B
(the preliminary single-operator A/B showed 0/12 false `confirmed`, ~2.5 files saved/task,
omission-never-commission); GA ships as a *trustworthy navigator* — supplement with grep for
exhaustive refactors, which the tool's own uncertainty markers communicate.

### Capabilities at GA
- **20 MCP tools** + a CLI, both adapters over one declarative tool spec table (ADR 0025): 3 core map,
  10 analysis (reachability/duplicates/legacy/impact/preflight/review/ownership/failure/test-paths/drift),
  1 diff (`analyze_diff`), 3 call-stack/visualization, 2 path queries (`find_callers`/`find_path`), + scope preview.
- **Static, confidence-graded call graph** with a load-bearing confidence vocabulary
  (`confirmed`|`likely`|`candidate`|`unclear`|`unresolved`), clamped to the weakest edge.
- **Provider tiers:** TS/JS (TS compiler API → `confirmed`), C#/VB (optional Roslyn sidecar → `confirmed`),
  Python/Go/Java/Rust/Ruby/C#/C++/C (tree-sitter → `likely`, with cross-file resolution for Go/Python/Rust
  and a feature-complete C++ resolver through cross-directory `#include`-graph), and a heuristic floor.
- **Persistence:** atomic, gitignored `.code-cartographer-mcp/context-map.json` (the single source of truth)
  + a derived `graph-index.sqlite` cache; two-tier staleness (ADR 0011).
- **Quality infrastructure:** a capability evaluation harness (ADR 0029), structural benchmark gates
  (ADR 0030), and an anti-slop gate — all CI-enforced.

Design is recorded in CAS Decisions 0001–0035.
