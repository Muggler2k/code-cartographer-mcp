# MCP Tools Reference

_Reference for Code Cartographer MCP v1.0.0 · 20 tools · Last updated: 2026-06-15_

This is a lookup reference for the 20 MCP tools (and their CLI equivalents). It assumes you
already know *which* tool you want; each entry gives the exact inputs, what the tool returns,
the confidence it carries, and the CLI form.

Code Cartographer is **static and codebase-only**: it reads source files and produces an
evidence-graded map. It never executes the target app, runs its tests, attaches a debugger, or
claims runtime truth — every result carries an explicit confidence label and, where relevant, an
uncertainty caveat. Keep that boundary in mind reading the "Output" of every tool.

- **Setup** (pointing an MCP client at the server): [`mcp-client-config.md`](./mcp-client-config.md)
- **Why static / how it works**: [`architecture.md`](./architecture.md) and the CAS decision records
- **Current state**: [`STATUS.md`](./STATUS.md)

### How to read an entry

Every tool follows the same template:

- **Purpose** — one line.
- **Inputs** — only the *tool-specific* parameters (the shared `repositoryRoot` and `outputMode`
  apply to every tool; see [Conventions](#conventions)).
- **Output** — what information the tool returns and the confidence it carries.
- **CLI** — the equivalent command-line form.
- **Requires** — preconditions (most analysis tools require an initialized map).

---

## Conventions

Read this once; it applies to every tool below.

### Two surfaces, one behavior

Each tool is exposed two ways from a single definition, so they cannot drift:

- **MCP tool** — called by an MCP client (e.g. Claude Code) pointed at the built `dist/index.js`.
  See [`mcp-client-config.md`](./mcp-client-config.md).
- **CLI command** — the same capability from a shell:

  ```
  code-cartographer-mcp <command> <repositoryRoot> [args...] [--llm | --dual]
  ```

  In development you can run the unbuilt source with `npm run cli -- <command> <repositoryRoot> …`.

### Shared parameters

| Parameter | Type | Required | Applies to | Meaning |
|---|---|---|---|---|
| `repositoryRoot` | string | yes | every tool | Absolute or relative path to the repository root. On the CLI it is the first positional after the command (defaults to the current working directory). |
| `outputMode` | `"human_readable"` \| `"llm_readable"` \| `"dual"` | no (default `human_readable`) | every tool | Output rendering — see [Output modes](#output-modes-in-depth). On the CLI: `--llm` → `llm_readable`, `--dual` → `dual`, default `human_readable`. |

Tool-specific parameters are listed per entry. The scope tools (`preview_scope`, `init_codebase`)
additionally take `exclusionMode` and `languages` — see [Exclusion modes](#exclusion-modes). The
visualization tools take `format` — see [Visualization formats](#visualization-formats).

### Confidence vocabulary

Every edge, path, and finding is graded on a five-level scale, **clamped to the weakest evidence**
in the chain:

| Level | Meaning |
|---|---|
| `confirmed` | Type-resolved static fact (TS compiler / Roslyn semantic model). |
| `likely` | Strong static signal (tree-sitter cross-file resolution, fewest-hop/best-confidence paths). |
| `candidate` | Heuristic or derived signal (regex floor, derived findings, dynamic/framework dispatch). |
| `unclear` | Ambiguous — the evidence does not decide. |
| `unresolved` | No static evidence (dynamic dispatch, DI, reflection, runtime-only behavior). |

Two contract limits are load-bearing and appear throughout:

- **Reachability and ownership never exceed `likely`.** Static paths are clamped to `likely`.
- **Dead code is never asserted.** The most aggressive legacy class is `apparently_unreachable`,
  always with a human-confirmation caveat — runtime-proven reachability stays an `unresolved`
  uncertainty, never a claim.

### Preconditions: the init flow

Most tools read a persisted map and require it to exist first. The normal flow:

1. **`preview_scope`** — confirm which files will be in scope (no map written).
2. **`init_codebase`** — build and persist `.code-cartographer-mcp/context-map.json`.
3. Any analysis / path / call-stack / visualization / diff tool — operates over that map.
4. **`check_init_state`** — re-check whether the map is still fresh; re-run `init_codebase` if stale.

Tools that **do not** require an existing map: `preview_scope` (static file-system resolution),
`init_codebase` (it builds the map), and `check_init_state` (it reports whether a map exists). All
other tools **require an initialized map** and return an init-required result if none is present —
they degrade with a disclosed message, never throw.

---

## 3.1 Core map & scope

### `preview_scope` — Preview scope/exclusions

> Step 1 of init: resolve which files would be in scope under an exclusion strategy — without
> writing a map or executing any target code.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `exclusionMode` | `"auto"` \| `"gitignore"` \| `"language"` \| `"none"` | no (default `auto`) | Scope strategy — see [Exclusion modes](#exclusion-modes). |
| `languages` | string[] | no | For `exclusionMode=language`: language(s) whose conventional build/dependency directories to exclude, instead of auto-detecting. |

**Output** — a resolved plan: the chosen source, excluded directories, detected languages, and
included/excluded file counts with sample paths. Purely static file-system resolution.

**CLI** — `code-cartographer-mcp preview <repositoryRoot> [--mode=<auto|gitignore|language|none>] [--lang=<name> …]`

**Requires** — nothing (no map needed).

### `init_codebase` — Initialize codebase context

> Step 2 of init: map the repository under the chosen exclusion strategy and persist
> `.code-cartographer-mcp/context-map.json`.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `exclusionMode` | `"auto"` \| `"gitignore"` \| `"language"` \| `"none"` | no (default `auto`) | Scope strategy — see [Exclusion modes](#exclusion-modes). |
| `languages` | string[] | no | For `exclusionMode=language`: as above. |

**Output** — an initialization summary: files mapped, languages, entry points, modules, and the
high-level call-graph/findings counts. The map is written atomically and the artifact directory is
gitignored. Run `preview_scope` first to confirm what will be excluded.

**CLI** — `code-cartographer-mcp init <repositoryRoot> [--mode=…] [--lang=… …]`

**Requires** — nothing (it creates the map).

### `check_init_state` — Check init state

> Report whether a repository has a saved baseline map and whether it appears stale.

**Inputs** — no tool-specific parameters (shared `repositoryRoot` + `outputMode` only).

**Output** — one of the five init states (e.g. *not initialized*, *fresh*, *stale*), derived from a
cheap fingerprint and the `mapHash`. Use it to decide whether to re-run `init_codebase`.

**CLI** — `code-cartographer-mcp status <repositoryRoot>`

**Requires** — nothing.

### `get_context_summary` — Get context summary

> Read the saved baseline map and return a compact summary.

**Inputs** — no tool-specific parameters.

**Output** — a token-bounded digest of the map: file/language counts, entry points, modules,
ownership signals, and the confidence-graded findings overview. In `llm_readable` mode the payload
is capped (counts + true totals preserved) to clear the agent token budget.

**CLI** — `code-cartographer-mcp summary <repositoryRoot>`

**Requires** — an initialized map.

---

## 3.2 Analysis

All analysis tools require an initialized map, are codebase-only, and return evidence-graded
hypotheses with explicit uncertainty — never runtime proof.

### `analyze_reachability` — Analyze reachability

> Structural reachability hypotheses for a target, with confidence labels and explicit uncertainty.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `target` | string | yes | Symbol, file, or workflow to analyze. |

**Output** — reachable-path hypotheses graded per path (clamped to `likely`), each carrying a
codebase-only envelope. Never claims runtime-proven reachability.

**CLI** — `code-cartographer-mcp reachability <repositoryRoot> <target>`

**Requires** — an initialized map.

### `analyze_change_impact` — Analyze change impact

> Blast-radius hypotheses for a target — what a change here might affect.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `target` | string | yes | Symbol, file, or area to assess for impact. Pass a symbol or path, not a sentence. |

**Output** — impact-level hypotheses (dependents grouped by area) with explicit uncertainty. Not a
runtime proof.

**CLI** — `code-cartographer-mcp impact <repositoryRoot> <target>`

**Requires** — an initialized map.

### `find_duplicate_behavior` — Find duplicate behavior

> Candidate code paths that perform the same behavior as a subject — to prevent parallel/duplicate
> workflows.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `subject` | string | yes | Behavior, workflow, or symbol to compare against. |

**Output** — duplicate-path candidates (≤ `candidate` confidence) with in-record uncertainty.

**CLI** — `code-cartographer-mcp duplicates <repositoryRoot> <subject>`

**Requires** — an initialized map.

### `classify_legacy_paths` — Classify legacy paths

> Classify legacy paths by reachability/risk.

**Inputs** — no tool-specific parameters.

**Output** — legacy paths labeled `still_reachable`, `possibly_reachable`, `apparently_unreachable`,
`replaced_but_present`, or `requires_human_confirmation`. The most aggressive class emitted is
`apparently_unreachable`, **always** with a human-confirmation caveat. The tool never asserts a
symbol is safe to delete and never assumes code is dead without classification.

**CLI** — `code-cartographer-mcp legacy <repositoryRoot>`

**Requires** — an initialized map.

### `get_ownership` — Get canonical ownership

> Identify which path canonically owns a behavior/symbol, and what to reuse instead of recreating.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `symbol` | string | yes | Symbol, behavior, or path to resolve ownership for. |

**Output** — the canonical owner plus re-export/alias relationships (clamped to `likely`); barrels
are surfaced as aliases, never as parallel implementations.

**CLI** — `code-cartographer-mcp ownership <repositoryRoot> <symbol>`

**Requires** — an initialized map.

### `review_preflight` — Agent preflight review

> Pre-coding orientation for a requested change: what to reuse, what to avoid, likely impact, and a
> recommendation.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `requestedChange` | string | yes | The change the agent is about to make. |

**Output** — canonical paths to reuse, duplicate/legacy risks to avoid, likely impact, and one
recommendation. Designed to run *before* an agent edits.

**CLI** — `code-cartographer-mcp preflight <repositoryRoot> <requestedChange>`

**Requires** — an initialized map.

### `review_change` — Review a change

> Review an agent-generated change for duplication, bypassed abstractions, reachable legacy, and
> unexpected impact.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `changeDescription` | string | yes | Description or diff of the change to review. |

**Output** — evidence-based findings across duplication / bypassed-abstraction / revived-legacy /
unexpected-impact, each graded and caveated.

**CLI** — `code-cartographer-mcp review <repositoryRoot> <changeDescription>`

**Requires** — an initialized map.

### `investigate_failure` — Investigate failure

> Form codebase-only hypotheses around a failure and state what runtime confirmation is still
> required. Not a debugger.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `failureReference` | string | yes | Stack trace, method name, test name, or failure area. |

**Output** — ranked static hypotheses with an explicit "what runtime confirmation would still be
required" section. Never claims to have reproduced or proven the failure.

**CLI** — `code-cartographer-mcp failure <repositoryRoot> <failureReference>`

**Requires** — an initialized map.

### `analyze_test_paths` — Analyze test paths

> Identify which tests can reach a target from codebase-only signals.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `target` | string | yes | Symbol, helper, or workflow to trace tests for. |

**Output** — tests that statically reach the target (helper / workflow / setup-teardown paths),
confidence-graded.

**CLI** — `code-cartographer-mcp test-paths <repositoryRoot> <target>`

**Requires** — an initialized map.

### `detect_architecture_drift` — Detect architecture drift

> Identify where implementation has diverged from intended design.

**Inputs** — no tool-specific parameters.

**Output** — drift findings: scattered ownership, accidental parallel systems, bypassed
abstractions (≤ `candidate`, each with uncertainty). Token-bounded in `llm_readable` mode.

**CLI** — `code-cartographer-mcp drift <repositoryRoot>`

**Requires** — an initialized map.

---

## 3.3 Path queries

Static path-finding over the call graph, codebase-only and clamped to `likely`.

### `find_callers` — Find callers

> The direct static callers of a symbol.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `symbol` | string | yes | Symbol, function, or file whose callers to list. |

**Output** — the direct caller set, confidence-graded. Dynamic / DI / framework / reflection callers
are graded down; this is never a runtime-proven caller set.

**CLI** — `code-cartographer-mcp find-callers <repositoryRoot> <symbol>`

**Requires** — an initialized map.

### `find_path` — Find static path

> Static call paths between two symbols.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | string | yes | Source symbol/file. |
| `to` | string | yes | Target symbol/file. |

**Output** — two paths: the **fewest-hop** path and the **best-confidence** (widest-path) path,
clamped to `likely`. A static path, never a runtime stack/trace.

**CLI** — `code-cartographer-mcp find-path <repositoryRoot> <from> <to>`

**Requires** — an initialized map.

---

## 3.4 Diff / PR

### `analyze_diff` — Analyze diff (changed files only)

> Compare the persisted baseline map against the current working tree (or an explicit snapshot) and
> return the static delta plus an agent verdict.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `baselineMapPath` | string | no | An explicit baseline `context-map.json` to compare against (CI use: `map@main` vs `map@head`). **Omit** to diff the persisted baseline against the current tree (rebuilt in memory under the baseline's recorded scope; nothing persisted). *MCP-only — not exposed on the CLI.* |

**Output** — six capped sections (changed files, call-graph adds/removes, new duplicate paths,
legacy reachability transitions, new risk areas, per-edge confidence regressions — each with true
totals) plus the verdict booleans: *added a parallel path? · bypassed a public surface? · revived
legacy? · increased uncertainty?* A confidence regression means **static evidence weakened**, never
a runtime claim.

**CLI** — `code-cartographer-mcp diff <repositoryRoot>` (always diffs persisted-baseline vs
current-tree; `baselineMapPath` is MCP-only).

**Requires** — an initialized map (the persisted baseline).

---

## 3.5 Call stack & visualization

### `map_call_stack` — Map call stack

> The static call stack/graph rooted at an entry point.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entryPoint` | string | yes | Entry point to root the call stack at (symbol, function, or file). |
| `maxDepth` | integer > 0 | no | Maximum traversal depth. *MCP-only — not exposed on the CLI.* |

**Output** — the rooted call graph, confidence-graded: dynamic dispatch, DI, reflection, and
framework-invoked calls are labeled `candidate`/`unresolved`. Token-bounded in `llm_readable` mode
(bounded to a root-connected subgraph, with counts + boundary preserved). Not a runtime trace.

**CLI** — `code-cartographer-mcp callstack <repositoryRoot> <entryPoint>`

**Requires** — an initialized map.

### `visualize_call_stack` — Visualize call stack

> Render the call stack as a diagram **spec** (the client renders it; the server returns no image).

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entryPoint` | string | yes | Entry point to root the call stack at. |
| `format` | `"mermaid"` \| `"dot"` \| `"ascii"` | no (default `mermaid`) | Diagram source format — see [Visualization formats](#visualization-formats). *MCP-only — not exposed on the CLI.* |
| `maxDepth` | integer > 0 | no | Maximum traversal depth. *MCP-only — not exposed on the CLI.* |

**Output** — diagram source (Mermaid/DOT/ASCII text) with a confidence/edge-kind legend, bounded to
a root-connected subgraph so the diagram stays valid and within budget.

**CLI** — `code-cartographer-mcp viz-callstack <repositoryRoot> <entryPoint>` (default `mermaid`).

**Requires** — an initialized map.

### `visualize_architecture` — Visualize architecture

> Render the repository architecture (modules, ownership, drift) as a diagram spec.

**Inputs**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `format` | `"mermaid"` \| `"dot"` \| `"ascii"` | no (default `mermaid`) | Diagram source format. *MCP-only — not exposed on the CLI.* |

**Output** — diagram source for the architecture view (modules + ownership + drift), client-rendered.

**CLI** — `code-cartographer-mcp viz-arch <repositoryRoot>` (default `mermaid`).

**Requires** — an initialized map.

---

## Appendices

### Exclusion modes

Used by `preview_scope` and `init_codebase` via `exclusionMode` (CLI `--mode=`):

| Mode | Scopes |
|---|---|
| `auto` (default) | Gitignore-first; falls back to conventional language build/dependency defaults when no `.gitignore` is present. |
| `gitignore` | Honor the repository's `.gitignore` only. |
| `language` | Exclude conventional build/dependency directories for the given `languages` (CLI `--lang=`, repeatable), or auto-detected languages. |
| `none` | Map everything — no exclusions. |

### Visualization formats

Used by `visualize_call_stack` and `visualize_architecture` via `format`:

| Format | Output |
|---|---|
| `mermaid` (default) | Mermaid diagram source. |
| `dot` | Graphviz DOT source. |
| `ascii` | Plain-text ASCII diagram. |

In every case the server returns **diagram source for the client to render, never a rendered
image**, with a confidence/edge-kind legend.

### Output modes in depth

The `outputMode` parameter (CLI `--llm` / `--dual`) controls rendering:

| Mode | Use when | Shape |
|---|---|---|
| `human_readable` (default) | A person is reading the result. | Markdown prose + tables. |
| `llm_readable` | An agent consumes the result programmatically. | Structured JSON, **token-bounded** — over-budget payloads are digested (sample lists capped) while preserving counts, true totals, and the codebase-only boundary, so every tool clears the agent token budget. |
| `dual` | You want both at once. | Human-readable followed by the `llm_readable` payload. |

To see a tool's exact `llm_readable` JSON shape, run it with `--llm` (or set `outputMode:
"llm_readable"`) against a sample repository.

### Error & degrade behavior

- Tools that require a map but find none return a disclosed **init-required** result — they never
  throw. Run `init_codebase` first.
- The build degrades pathological inputs (unreadable, over-size-cap, binary, non-UTF8, broken
  syntax, symlinks, submodule gitlinks) to disclosed non-analyzable records rather than failing.
- The CLI prints a usage message and exits non-zero on an unknown command or a missing required
  positional argument.
