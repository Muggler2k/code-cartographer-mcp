# Code Cartographer MCP

This is the product implementation repository for the Code Cartographer MCP.

The Context Architecture System repository at `../debug_mcp_context_manager` remains the source of truth for product context, policies, prompts, workflows, and decisions. This repository owns source code, tests, build configuration, and implementation artifacts.

## Status: implemented (Epics A–M, Q)

**The full product is implemented and tested.** The MCP server registers all **19 tools** and the CLI dispatches them — both surfaces are adapters over one declarative tool spec table (ADR 0025); `init_codebase` builds and persists a real `.code-cartographer-mcp/context-map.json`, and the analysis, call-stack, and visualization tools run end-to-end over it. A static path-finding subsystem over a derived `graph-index.sqlite` (ADR 0023) backs indexed caller/callee/path queries. A capability evaluation harness (`npm run eval`, ADR 0029) scores the analyzer against golden-annotated fixture repos — all five pass with zero confidence-invariant violations — and benchmark gates (ADR 0030) pin the structural performance metrics against checked-in baselines. 290 tests pass; build/typecheck pass. Design is recorded in CAS Decisions 0001–0030. See [`docs/STATUS.md`](docs/STATUS.md), [`docs/architecture.md`](docs/architecture.md), [`docs/backlog.md`](docs/backlog.md), [`docs/pathfinding-and-graph-index.md`](docs/pathfinding-and-graph-index.md), and [`docs/csharp-roslyn-provider.md`](docs/csharp-roslyn-provider.md).

## Scope

A local stdio MCP server with codebase-only tools.

Core map tools:

- `check_init_state` — report whether a repository has a baseline map and whether it is stale.
- `preview_scope` — step 1 of init: resolve which files would be in scope under an exclusion strategy, without writing anything.
- `init_codebase` — scan a repository and write `.code-cartographer-mcp/context-map.json`.
- `get_context_summary` — read the saved baseline map and return a compact summary.

Analysis tools (each requires an initialized map; all codebase-only):

- `analyze_reachability`, `analyze_change_impact`, `investigate_failure` — return evidence-graded **hypotheses with explicit uncertainty**, never runtime-proven.
- `find_duplicate_behavior`, `classify_legacy_paths`, `get_ownership`, `detect_architecture_drift` — duplicate / legacy / ownership / drift signals.
- `review_preflight`, `review_change`, `analyze_test_paths` — pre-coding orientation, change review, and test-path tracing.

Call stack & visualization tools (codebase-only; visualizers return a diagram **spec** the client renders, not an image):

- `map_call_stack` — static call graph rooted at an entry point, confidence-graded (dynamic / DI / framework edges → candidate/unresolved); never a runtime trace.
- `find_callers` / `find_path` — direct static callers of a symbol, and fewest-hop / best-confidence static paths between two symbols (clamped to `likely`; never a runtime stack).
- `visualize_call_stack` — render that call stack as a Mermaid / DOT / ASCII diagram spec with a confidence legend.
- `visualize_architecture` — render modules / ownership / drift as a diagram spec.

By design the server never runs the target application, executes tests, attaches a debugger, inspects telemetry, or claims runtime truth.

## Setup

```powershell
npm install
npm run build
npm test
```

`npm run build` and `npm run typecheck` pass. `npm test` runs the full Vitest suite (290 tests; the C# Roslyn provider suite runs only where the `dotnet` CLI exists — without it C# analysis falls back to the tree-sitter tier).

## Run Locally

```powershell
npm run dev
```

> Note: MCP clients must point at the **built** `dist/index.js` (`npm run build` first); `dev`/`cli` run the unbuilt `src/` via `tsx`. See [`docs/mcp-client-config.md`](docs/mcp-client-config.md).

## Run Init Directly

```powershell
npm run cli -- init D:\_dev\debug_mcp_context_manager
npm run cli -- status D:\_dev\debug_mcp_context_manager
npm run cli -- summary D:\_dev\debug_mcp_context_manager --llm
```

For MCP clients, build first and point the client at the compiled entry point:

```json
{
  "mcpServers": {
    "code-cartographer-mcp": {
      "command": "node",
      "args": ["D:\\_dev\\code-cartographer-mcp\\dist\\index.js"]
    }
  }
}
```

See `docs/mcp-client-config.md` for the same snippet and operating notes.

## Product Boundary

Do not copy CAS context files into this repository as implementation. Read CAS as source-of-truth guidance, then implement code here. If implementation reveals a requirement gap, propose a CAS update instead of silently changing product scope.
