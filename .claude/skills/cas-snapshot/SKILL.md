---
name: cas-snapshot
description: Snapshot the CAS source-of-truth repo (../debug_mcp_context_manager) into git so its decisions and policies gain version history. Use after editing CAS context files.
disable-model-invocation: true
---

# CAS Snapshot

The CAS repo at `../debug_mcp_context_manager` is the product source of truth but is not currently git-tracked, so its decisions/policies have no history. This skill initializes git (first run) and commits the current state. It never pushes (push is human-only per CAS `CONTEXT.md`).

## Steps

1. **Check state:** `git -C ../debug_mcp_context_manager rev-parse --is-inside-work-tree` — is it already a repo?
2. **If not a repo:** `git -C ../debug_mcp_context_manager init` (the repo already ships a `.gitignore` and `.githooks`).
3. **Enable the CAS secret hooks:** `git -C ../debug_mcp_context_manager config core.hooksPath .githooks`.
4. **Stage + review:** `git -C ../debug_mcp_context_manager add -A`, then show `git -C ../debug_mcp_context_manager status` and a short `git -C ../debug_mcp_context_manager diff --staged --stat`.
5. **Commit** with a message describing the context change (e.g. `context: add decision 0007 + call-stack/visualization policy`). Do NOT push.

Honor `CONTEXT.md` governance: no secrets/PII in context files, commit with meaningful messages explaining why, never force-push, and leave pushing to the human owner.
