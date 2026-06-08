---
name: cas-preflight
description: Before planning or implementing a change in the Code Cartographer MCP, load the CAS source-of-truth files and summarize the requirements, decisions, and codebase-only boundary relevant to the task.
---

# CAS Preflight

The CAS repository at `../debug_mcp_context_manager` is the source of truth for product requirements, policies, and decisions, and is NOT git-tracked from here. Read it before codebase-wide claims, planning, or implementation.

## Steps

1. **Current state first:**
   - `../debug_mcp_context_manager/context/00_index/index.md` (current phase; what is current vs stale)
   - the latest log in `../debug_mcp_context_manager/context/sessions/`
2. **Source-of-truth set:**
   - `context/00_index/code-cartographer-mcp-system.md`, `code-cartographer-mcp-manifest.md`
   - `context/02_operations/` — `init-and-codebase-mapping-policy.md`, `output-mode-policy.md`, `context-governance.md`, `product-repository-boundary-policy.md`, `call-stack-and-visualization-policy.md`
   - `context/06_workflows/agent-preflight-workflow.md`, `change-review-workflow.md`
   - the relevant `context/07_decisions/000N-*.md` for the task at hand
3. **Summarize for the task:** the capabilities/requirements it touches, the confidence-vocabulary + codebase-only boundary constraints, any open design decision (`docs/architecture.md` D1–D8), and whether the change needs a CAS update.

Do not copy CAS files into this repo as code. If implementation reveals a requirement gap, propose a CAS update rather than expanding product scope unilaterally.
