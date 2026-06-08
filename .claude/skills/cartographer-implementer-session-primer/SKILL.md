---
name: cartographer-implementer-session-primer
description: Prime a fresh implementer session on the Code Cartographer MCP. Reads both repos (impl + CAS source-of-truth) AND verifies live git/build/test state, then emits a single orientation brief — where everything is, the real current state, open decisions, and the next step — so a new agent picks up without wrong assumptions.
---

# Cartographer Implementer Session Primer

Use this at the **start of an implementation session** on the Code Cartographer MCP, before planning or writing code. It produces a grounded orientation so you do not start from stale assumptions.

This is a **two-repo** product:
- **Impl repo** (here, `code-cartographer-mcp`) — owns implementation only.
- **CAS repo** (`../debug_mcp_context_manager`, the Context Architecture System) — the **source of truth** for requirements, policies, and decisions. Not git-tracked from here.

The product itself is **codebase-only** (static analysis, never runtime truth). Honor that boundary while priming.

## Core principle: verify, don't trust

Docs drift. `docs/STATUS.md`, the CAS `index.md` "Latest session" pointer, and session logs all go stale between sessions. **Treat every doc claim as a hypothesis and confirm it against the live repo** (git, the filesystem, typecheck, the test count). When a doc and the repo disagree, the repo wins — and say so in the brief so the stale doc gets fixed.

## Steps

Run these read-only; do not edit anything during priming.

### 1. Live ground truth first (both repos)

```bash
# Impl repo
git -C . rev-parse --abbrev-ref HEAD            # current branch
git -C . log --oneline -8                       # recent history
git -C . status --short                         # uncommitted work
git -C . log --oneline @{u}.. 2>/dev/null       # unpushed commits (if upstream set)

# CAS repo
git -C ../debug_mcp_context_manager rev-parse --abbrev-ref HEAD
git -C ../debug_mcp_context_manager log --oneline -6
git -C ../debug_mcp_context_manager status --short
git -C ../debug_mcp_context_manager remote -v   # note if NO remote (can't be pushed)
```

### 2. Live build/contract state (impl)

```bash
npm run typecheck                                       # must be clean
npm test 2>&1 | grep -iE "todo|pass|fail"               # real test/it.todo count
grep -c registerTool src/index.ts                       # real MCP tool count
ls src/*.ts                                              # real source surface
ls ../debug_mcp_context_manager/context/07_decisions/   # real decision count (0001–N)
```

Use these numbers as truth. Do **not** repeat a tool count, test count, or "latest decision" from a doc without confirming it here.

### 3. Read the orientation docs (impl)

- `CLAUDE.md` — commands, conventions, current status line, the load-bearing rules (confidence vocabulary, ESM `.js` imports, codebase-only boundary).
- `docs/STATUS.md` — claimed state (cross-check against step 2).
- `docs/architecture.md` — component model and **§5 open design decisions (D1–D8)**: which are resolved vs open.
- `docs/backlog.md` — Epics A–G and per-story status (what is designed vs implemented vs not started).
- `AGENTS.md` — contributor guide, if present.

### 4. Read the source of truth (CAS)

- `context/00_index/index.md` — current phase; what is current vs stale; pointers. (Its "Latest session" line may be stale — confirm against the newest file in `context/sessions/`.)
- The **newest** log in `context/sessions/` — the real last-session narrative.
- `context/02_operations/` — `init-and-codebase-mapping-policy.md`, `output-mode-policy.md`, `context-governance.md`, `product-repository-boundary-policy.md`, `call-stack-and-visualization-policy.md`.
- `context/07_decisions/000N-*.md` — at minimum skim every decision newer than the last session log, since those are the changes the session narrative does not yet describe.

### 5. Reconcile and report

Build the brief below. Flag every doc-vs-repo mismatch you found (e.g., a STATUS tool count, a stale "Latest session" pointer, a decision not yet reflected in the session log) under **Drift**.

## Output: orientation brief

```markdown
# Cartographer Session Primer

## State (verified)
- Impl: branch <X>, <N> uncommitted, <M> unpushed; typecheck <clean/errors>; <T> tools, <K> it.todo.
- CAS: branch <X>, <N> uncommitted, remote <yes/none>; decisions 0001–<latest>.

## Where things are
- Impl surface: <one line per src/*.ts and what it owns>.
- CAS surface: index, latest session log <name+date>, active policies, decisions 0001–<N>.

## Current phase & progress
- <design vs implementation; which Epic/stories are designed vs implemented vs not started>.

## Open decisions
- <architecture.md §5 D-items still open; any CAS decision not yet implemented>.

## Drift (docs vs repo — fix these)
- <each stale doc claim observed, with the correct value>.

## Recommended next step
- <the single most logical next action, grounded in the above>.
```

## Guardrails

- **Read-only.** Priming never edits code, docs, or CAS. If you find drift, *report* it; fixing it is a separate, explicit action.
- **Do not make codebase-wide product claims** (reachability, duplication, impact) during priming — that is the product's job and requires an initialized map.
- **Honor the boundary:** never present static inference as runtime truth; preserve the confidence vocabulary (`confirmed | likely | candidate | unclear | unresolved`).
- Pairs with **`cartographer-context-sync`** (the bookend: at session end it propagates the session's changes across all docs + the CAS repo + memory and verifies no stale numbers/pointers remain), **`cas-snapshot`** (git-commits the CAS repo — the final step `cartographer-context-sync` hands off to), and **`cas-preflight`** (loads task-scoped CAS context before a specific change). This primer is the broad session bootstrap; `cas-preflight` is the focused pre-task load.
