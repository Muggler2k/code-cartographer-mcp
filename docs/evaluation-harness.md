# Capability Evaluation Harness — Implementation Note (ADRs 0029/0030, Epics M + Q)

The harness (`eval/`) runs the analyzer against known repos and **scores** output quality,
so provider claims, findings precision, grading rules, performance, and output shape are
measured numbers. It exists because the product's dominant risk shifted from missing
features to unverified claims (ADR 0028).

## Usage

```powershell
npm run eval                       # scorecard for the five checked-in fixtures
$env:CCM_EVAL_EXTERNAL="D:\repos\a;D:\repos\b"; npm run eval   # + external real repos
npx vitest run test/evalHarness.test.ts                         # the CI gate
```

The runner prints a per-subject table (pass, required/found, forbidden hits, invariant
violations, init ms, files/nodes/edges, ~token shape) and writes
`eval/results/latest.json` (gitignored).

## Subjects

| Subject | Scored by | What it pins |
|---|---|---|
| `ts-small` | golden | TS tier: symbols/exports, `confirmed` direct edges, dynamic edge grading, duplicate (`parse` ×2), legacy classes (`possibly_reachable` / `apparently_unreachable`), entry points (manifest/source/test), findings-v2 untested + orphan module, reachability incl. must-NOT-reach |
| `python-small` | golden | tree-sitter tier: cross-file `likely` edges, test/source entries, heuristic-tier legacy capping (`requires_human_confirmation`) |
| `csharp-small` | golden (dotnet-gated) | Roslyn tier (ADR 0027): `Type.Method` ids, public/private exports, `direct/confirmed` vs interface `method/likely`, the honest static-dispatch limitation (see `eval/goldens/README.md`) |
| `mixed` | golden | provider routing across TS/Python/C#/text + binary handling (`analyzable: false`) |
| `edge-cases` | golden | empty/comment-only files; a re-export barrel and a shadowed non-exported name that must NOT read as duplicates; a cross-file cycle (findings v2); the >12-hop reachability depth cap |
| external repos | invariants + perf + shape only | real-world smoke (`CCM_EVAL_EXTERNAL`; never required) |

Fixtures are copied to a temp dir before init, so the checked-in trees stay pristine.
Golden semantics (static ground truth, never runtime claims, never regenerated from
output): `eval/goldens/README.md`.

## Universal invariants (every subject, golden or not)

`method` ≤ `likely` · `dynamic`/`framework` ≤ `candidate` · `unresolved` = `unresolved` ·
risk/duplicate findings ≤ `candidate`, risk areas carry uncertainty · legacy ≠
`still_reachable` carries the no-dead-code caveat, `still_reachable` carries none,
`safe_removal_candidate` never appears · reachability never `confirmed`, results carry the
`codebase_only` envelope · non-manifest entries ≤ `likely` · `meta.codebaseOnlyBoundary`.

## Baseline (Epic M close, this machine)

All five fixtures **PASS — 82/82 required, 0 forbidden, 0 invariant violations** (75 → 82 with the ADR 0032 csharp-small constructs: the BCL-bound internal edge + data-member signal/forbidden-node pins). External
subjects (invariant-clean): `Calculator-master` (5 files incl. a binary, ~0.8 s init) and a
2,661-file ASP.NET 9 repo (59 k edges, ~17–22 s init, **~357 k-token** `llm_readable`
summary — recorded as direct input to Epic Q gates and Epic O's changed-files mode).
Epic Q (ADR 0030) turned the structural numbers into HARD gates (test/benchGates.test.ts vs eval/baselines.json: file/node/edge counts, fixed-query expansion + SQLite query counts, SCC-built-once, summary size ±20%); wall-clock gates only at generous sanity ceilings; heap + external numbers stay record-only. Baselines are updated consciously, with reasoning — never auto-regenerated.

## Known limits

- Goldens encode tier-specific grades where deliberate (`csharp-small` = Roslyn tier) —
  evaluating that fixture without the .NET SDK would mis-score, so it is availability-gated.
- An empty golden category passes trivially (externals rely on this); every new fixture
  must ship a populated golden.
- Concurrent test workers each build the .NET sidecar in their own process; a transient
  MSBuild lock failure gets one delayed retry (`src/providers/csharp.ts`).
