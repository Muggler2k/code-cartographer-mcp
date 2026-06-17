# cartographer-dev (Claude Code plugin)

Bundles the Code Cartographer MCP development workflow so it travels with you — across clones, a
teammate's machine, and the sibling CAS repo (`../debug_mcp_context_manager`). This is the
**distribution** packaging of automation that lives "live" under the impl repo's `.claude/`.

## What it bundles

**Skills** (the two-repo workflow):
- `cartographer-implementer-session-primer` — prime a fresh session from live state.
- `cartographer-context-sync` — write the new state back to docs / CAS / memory (the inverse).
- `cas-preflight` — focused per-task CAS load.
- `cas-snapshot` — git-commit the CAS repo (never pushes; human-only push).
- `release` — bump the version everywhere, CHANGELOG, tag, GitHub Release (user-invoked).

**Agents** (read-only reviewers):
- `boundary-reviewer` — the codebase-only contract (confidence vocabulary, `analysisBoundary`).
- `provider-over-resolution-reviewer` — false-edge / over-the-ceiling grading in provider diffs.
- `eval-fixture-completeness-reviewer` — the ADR 0028 eval-first contract (fixture + golden per claim).

## How to populate it for distribution

The component bodies are maintained as the live copies under the impl repo's `.claude/`. To produce a
self-contained, installable plugin, copy them in:

```bash
# from the impl repo root
mkdir -p plugins/cartographer-dev/skills plugins/cartographer-dev/agents
cp -r .claude/skills/{cartographer-implementer-session-primer,cartographer-context-sync,cas-preflight,cas-snapshot,release} plugins/cartographer-dev/skills/
cp .claude/agents/{boundary-reviewer,provider-over-resolution-reviewer,eval-fixture-completeness-reviewer}.md plugins/cartographer-dev/agents/
```

(Keeping the live copies under `.claude/` as the source of truth avoids a maintenance fork; re-run the
copy when they change, or script it in CI before publishing the plugin.)

## How to install

Add this directory (or a published copy) as a plugin marketplace entry, then enable it:

```bash
claude plugin marketplace add <path-or-repo-to>/plugins
claude plugin install cartographer-dev
```

The `release` skill is `disable-model-invocation: true` (user-only — it tags + publishes), so it runs
only when you invoke `/release <version>`. The review agents are read-only.
