const fs = require("fs");
const rw = (file, subs) => {
  let t = fs.readFileSync(file, "utf8");
  for (const [a, b] of subs) {
    if (!t.includes(a)) throw new Error(file + " missing anchor: " + a.slice(0, 70));
    t = t.replace(a, b);
  }
  fs.writeFileSync(file, t);
  console.log("updated", file);
};

rw("docs/STATUS.md", [
  ["**The full product is implemented and tested (Epics A–L).**", "**The full product is implemented and tested (Epics A–M).**"],
  [
    "**279 tests passing**;\nbuild/typecheck pass. Design is recorded in CAS Decisions 0001–0027. See",
    "A **capability evaluation harness** (ADR 0029, Epic M — the first step of the **v0.2 \"Verified Static Context\"** roadmap, ADR 0028) scores the analyzer against golden-annotated fixture repos + external real repos: all five fixtures pass 75/75 required golden items with zero invariant violations (`npm run eval`; CI-gated). **285 tests passing**;\nbuild/typecheck pass. Design is recorded in CAS Decisions 0001–0029. See"
  ],
  [
    "[`pathfinding-and-graph-index.md`](./pathfinding-and-graph-index.md), and [`csharp-roslyn-provider.md`](./csharp-roslyn-provider.md).",
    "[`pathfinding-and-graph-index.md`](./pathfinding-and-graph-index.md), [`csharp-roslyn-provider.md`](./csharp-roslyn-provider.md), and [`evaluation-harness.md`](./evaluation-harness.md)."
  ],
  [
    "| `test/*.test.ts` | **279 tests passing, 0 `it.todo`** across 18 files (core map, scope/exclusion, providers + the **C# Roslyn tier** (`describe.runIf(dotnetAvailable)`), derivation, findings + **derivation v2**, analysis,",
    "| `eval/` | **Implemented (ADR 0029).** The capability evaluation harness: five golden-annotated fixture repos (`ts-small`/`python-small`/`csharp-small`/`mixed`/`edge-cases`), a scorer with universal confidence invariants, `npm run eval` scorecard runner (+ `CCM_EVAL_EXTERNAL` real repos), and the `test/evalHarness.test.ts` CI gate. See [`evaluation-harness.md`](./evaluation-harness.md). |\n| `test/*.test.ts` | **285 tests passing, 0 `it.todo`** across 19 files (core map, scope/exclusion, providers + the **C# Roslyn tier** (`describe.runIf(dotnetAvailable)`), derivation, findings + **derivation v2**, the **evaluation gate**, analysis,"
  ],
  [
    "Epics A–L are implemented (ADR 0024 graph-traversal unification; ADR 0025 internal seams; ADR 0026 findings derivation v2; ADR 0027 C# Roslyn provider).",
    "Epics A–M are implemented (ADR 0024 graph-traversal unification; ADR 0025 internal seams; ADR 0026 findings derivation v2; ADR 0027 C# Roslyn provider; ADR 0029 capability evaluation harness). The **v0.2 \"Verified Static Context\"** roadmap (ADR 0028) ratifies the remaining order: Q (benchmark gates) → O (diff/PR mode) → N (C++ semantic tier) → R (onboarding) → S (CAS export) → T (canonical path registry) → P (incremental refresh) — and its anti-goals (no new findings/provider claims without harness scores)."
  ],
  ["context/sessions/2026-06-10_csharp-roslyn-adr-0027.md", "context/sessions/2026-06-10_eval-harness-adrs-0028-0029.md"],
  ["design is recorded in ADRs 0001–0027 under", "design is recorded in ADRs 0001–0029 under"],
  ["(ADR 0027 — the C# Roslyn provider — is implemented as Epic L).", "(ADR 0028 — the v0.2 roadmap; ADR 0029 — the evaluation harness, implemented as Epic M)."],
  [
    "## Next steps\n\n1. **Polish / depth** — additional language providers, richer findings rules.\n2. **Release prep** — confirm dependency pins (D5), bump `engines.node` to ≥ 22.5, promote draft CAS policies to accepted.",
    "## Next steps (per the ADR 0028 roadmap)\n\n1. **Epic Q — benchmark/performance gates** over the harness's recorded numbers.\n2. **Epic O — diff / PR mode** (the 357k-token full-summary measurement on the large external repo is the motivating datum).\n3. **Release prep** — confirm dependency pins (D5), bump `engines.node` to ≥ 22.5, promote draft CAS policies to accepted."
  ]
]);

rw("CLAUDE.md", [
  ["## Status: implemented (Epics A–K)", "## Status: implemented (Epics A–M)"],
  [
    "279 tests passing; build/typecheck pass. Decisions 0001–0027 in the CAS source of truth record the design.",
    "285 tests passing; build/typecheck pass. A capability evaluation harness (`eval/`, ADR 0029) scores the analyzer against golden-annotated fixtures + external repos (`npm run eval`; CI-gated via `test/evalHarness.test.ts`); per the v0.2 roadmap (ADR 0028), new findings rules and provider claims must land with fixture constructs + golden entries. Decisions 0001–0029 in the CAS source of truth record the design."
  ],
  [
    "- `npm run cli -- <init|status|summary> <repositoryRoot> [--llm]`",
    "- `npm run eval` — capability-evaluation scorecard (ADR 0029): scores the analyzer against `eval/fixtures/` goldens; `CCM_EVAL_EXTERNAL=<path;path>` adds external real repos (invariants/perf/shape only).\n- `npm run cli -- <init|status|summary> <repositoryRoot> [--llm]`"
  ]
]);

rw("AGENTS.md", [
  [
    "and the optional C# Roslyn provider tier (ADR 0027).**",
    "the optional C# Roslyn provider tier (ADR 0027), and the capability evaluation harness (ADR 0029; `npm run eval`).**"
  ],
  ["`test/` holds 279 passing tests (0 `it.todo`).", "`test/` holds 285 passing tests (0 `it.todo`)."],
  ["Design is recorded in CAS Decisions 0001–0027 — read", "Design is recorded in CAS Decisions 0001–0029 — read"],
  [
    "`npm run build` / `npm run typecheck` pass; `npm test` runs the full Vitest suite (279 tests; the C# Roslyn suite runs only where the `dotnet` CLI exists).",
    "`npm run build` / `npm run typecheck` pass; `npm test` runs the full Vitest suite (285 tests; the C# Roslyn + C# eval suites run only where the `dotnet` CLI exists). `npm run eval` produces the capability scorecard (ADR 0029)."
  ]
]);

rw("README.md", [
  ["## Status: implemented (Epics A–L)", "## Status: implemented (Epics A–M)"],
  [
    "279 tests pass; build/typecheck pass. Design is recorded in CAS Decisions 0001–0027.",
    "A capability evaluation harness (`npm run eval`, ADR 0029) scores the analyzer against golden-annotated fixture repos — all five pass with zero confidence-invariant violations. 285 tests pass; build/typecheck pass. Design is recorded in CAS Decisions 0001–0029."
  ],
  [
    "`npm run build` and `npm run typecheck` pass. `npm test` runs the full Vitest suite (279 tests;",
    "`npm run build` and `npm run typecheck` pass. `npm test` runs the full Vitest suite (285 tests;"
  ]
]);

rw("docs/architecture.md", [
  [
    "all of which are now **resolved and implemented** (Epics A–L; ADRs 0008–0027,",
    "all of which are now **resolved and implemented** (Epics A–M; ADRs 0008–0029,"
  ],
  [
    "src/output.ts     formatting: results -> human / llm / dual          [done]",
    "src/output.ts     formatting: results -> human / llm / dual          [done]\neval/             capability evaluation harness (ADR 0029)           [done]"
  ]
]);

rw("docs/backlog.md", [
  [
    "**Epic L done** (L1–L2) — optional C# Roslyn provider tier (ADR 0027); see per-epic notes below_",
    "**Epic L done** (L1–L2) — optional C# Roslyn provider tier (ADR 0027); **Epic M done** (M1–M2) — capability evaluation harness (ADR 0029); **Epics N–T planned** per the v0.2 roadmap (ADR 0028); see per-epic notes below_"
  ],
  [
    "### Epic E — Verification — ✅ COMPLETE",
    `### Epic M — Capability evaluation harness (ADR 0029) — ✅ DONE (M1–M2)
Eval-first (ADR 0028): the engine's risk is unverified claims, so quality is now a measured number.
- **M1.** ✅ \`eval/\` — five golden-annotated fixture repos + \`eval/harness.ts\` scorer (symbol/exported/edge/entry accuracy, duplicate + legacy correctness incl. class, findings-v2 patterns, reachability mustReach/mustNotReach, binary handling) + universal confidence invariants checked on every subject + perf/token-shape recording. Goldens are human-authored static ground truth (\`eval/goldens/README.md\`), never regenerated from output.
- **M2.** ✅ \`npm run eval\` scorecard runner (external real repos via \`CCM_EVAL_EXTERNAL\`, auto scope, invariants-only) + \`test/evalHarness.test.ts\` CI gate (100% required / 0 forbidden / 0 violations; C# fixture dotnet-gated). Baseline: 75/75 across five fixtures; two external repos invariant-clean; the 357k-token \`llm_readable\` summary on a 2.6k-file repo recorded as Epic O/Q input.

### Epics N–T — planned (v0.2 "Verified Static Context", ADR 0028 — in ratified order)
- **Epic Q — Benchmark/performance gates:** init/provider/index/query durations, expanded nodes, SQLite query counts, memory estimate, output size; regression thresholds where stable.
- **Epic O — Diff / PR mode:** \`analyze_diff\`, changed-path review, map comparison, new-duplicate/new-legacy detection, confidence-regression detection.
- **Epic N — C++ semantic tier:** optional clangd/libclang provider (compile_commands.json/CMake detection, header/source + namespace resolution, include graph, macro-aware confidence); fallback clang → tree-sitter → heuristic.
- **Epic R — Productized setup/onboarding:** npx story, MCP config examples, init wizard, \`doctor\`/provider-availability report, \`explain-tools\`, sample walkthrough.
- **Epic S — CAS export integration:** export workflows (product context, decision records, findings summary, drift report, preflight context) into CAS-friendly paths.
- **Epic T — Canonical path registry:** user-declared intended architecture (canonical/deprecated workflows, owned modules, forbidden dependencies) upgrading findings from generic to intent-aware.
- **Epic P — Incremental refresh** (last; needs M/Q measurements): changed-file detection, affected symbols/edges/findings, partial rebuild, provider cache, section invalidation.
- **Anti-goals until Q lands:** no new findings rules or provider claims without harness scores; no new visualizers before accuracy metrics; no runtime features (permanent); SQLite stays optional.

### Epic E — Verification — ✅ COMPLETE`
  ]
]);

console.log("all docs synced");
