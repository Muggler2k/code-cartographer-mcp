# Agent Instructions

## Repository Role

This is the product implementation repository for the Code Cartographer MCP.

The CAS repository at `../debug_mcp_context_manager` owns product context, requirements, workflows, prompts, operating policies, and decision records. This repository owns source code, tests, build files, packaging, and implementation artifacts.

## Current Implementation Status

**The full product is implemented and tested (Epics A–I), incl. static path-finding + a SQLite graph index (ADR 0023) unified behind a single `GraphSource` traversal substrate (ADR 0024).** `src/contextMap.ts`, `src/analysis.ts`, `src/callGraph.ts`, `src/visualize.ts`, `src/output.ts`, `src/scope.ts`, `src/files.ts`, `src/providers/`, `src/pathfinding.ts`, `src/graphIndex.ts`, and `src/pathQueries.ts` are all implemented; `test/` holds ~231 passing tests (0 `it.todo`). `src/index.ts` registers all **19 MCP tools** (3 core map + 10 analysis + 3 call-stack/visualization + 2 path queries (`find_callers`/`find_path`), plus the scope `preview`) and the CLI, all working end-to-end. Build and typecheck pass. Design is recorded in CAS Decisions 0001–0024 — read [`docs/STATUS.md`](docs/STATUS.md), [`docs/architecture.md`](docs/architecture.md), [`docs/backlog.md`](docs/backlog.md), and [`docs/pathfinding-and-graph-index.md`](docs/pathfinding-and-graph-index.md) before planning. The Operating Rules below are **product invariants** the implementation honors and must continue to.

## Required Context Before Planning

Before codebase-wide claims, implementation planning, reachability analysis, duplicate-path analysis, legacy-path analysis, or change-impact review, read the CAS source-of-truth files:

```text
../debug_mcp_context_manager/context/00_index/code-cartographer-mcp-manifest.md
../debug_mcp_context_manager/context/00_index/code-cartographer-mcp-system.md
../debug_mcp_context_manager/context/02_operations/init-and-codebase-mapping-policy.md
../debug_mcp_context_manager/context/02_operations/output-mode-policy.md
../debug_mcp_context_manager/context/02_operations/product-repository-boundary-policy.md
../debug_mcp_context_manager/context/06_workflows/agent-preflight-workflow.md
../debug_mcp_context_manager/context/06_workflows/change-review-workflow.md
../debug_mcp_context_manager/context/08_prompts/agent-preflight-questions.md
../debug_mcp_context_manager/context/08_prompts/review-agent-questions.md
```

For setup or first-use work, also read:

```text
../debug_mcp_context_manager/context/08_prompts/code-cartographer-mcp-init-skill.md
../debug_mcp_context_manager/skills/code-cartographer-mcp-init/SKILL.md
```

## Operating Rules

- Keep this product codebase codebase-only by default.
- Do not claim runtime truth from static analysis.
- Preserve uncertainty labels: `confirmed`, `likely`, `candidate`, `unclear`, `unresolved`.
- Prefer canonical paths over duplicate helpers or parallel workflows.
- Treat legacy code as unknown until reachability is checked.
- Do not add secrets, credentials, tokens, private keys, or identity-grade PII.

## Development Commands

```powershell
npm install
npm run build
npm test
```

`npm run build` / `npm run typecheck` pass; `npm test` runs the full Vitest suite (~231 tests).

Enable hooks once:

```powershell
git config core.hooksPath .githooks
```
