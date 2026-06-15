// Real-repo corpus regression gate (ADR 0034 S7 — the last autonomous roadmap item). The synthetic
// eval fixtures (evalHarness.test.ts) are small + hand-authored; this gates the codebase-only honesty
// contract on a REAL, dense dependency that ships in CI: node_modules/typescript/lib (the TS compiler's
// own lib — ~125 files / ~3000 nodes of .d.ts, pinned by package-lock so byte-identical dev↔CI; its
// 9MB typescript.js / 6MB _tsc.js are over the 5MB cap → metadata-hashed, never parsed, so init stays
// light). It runs the SAME checkInvariants the goldens use, but with NO golden (a real repo has no
// ground-truth annotation) — so a provider/findings change that breaks a confidence ceiling or the
// codebaseOnlyBoundary at real-code scale fails HERE, on every PR, instead of silently in production.
// It is distinct from latencySla.test.ts, which gates typescript/lib's cold-start TIME but never runs
// the invariant contract.
//
// Maps the dependency IN PLACE via buildContextMap (no temp copy, writes no artifact — like
// eval/measureColdStart.ts), so node_modules is never mutated. The structural bands live in
// eval/baselines.json (realCorpus) like every other gate's budget (benchGates/coldStartSla) — LOOSE
// bands (patch-drift robust, ADR 0030): a typescript patch bump stays in band; only an extraction
// collapse (→ near-zero) or an over-resolution blowup (→ multiples) trips them. The invariant check is
// version-INDEPENDENT (a contract, not a count) and is the load-bearing assertion. Auto-gates on the
// dependency existing (skips, never fails, if absent) so the gate stays portable.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildContextMap } from "../src/contextMap.js";
import { checkInvariants } from "../eval/harness.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS_LIB_KEY = "node_modules/typescript/lib";
const TS_LIB = path.join(REPO_ROOT, ...TS_LIB_KEY.split("/"));

interface CorpusBand {
  nodesMin: number;
  nodesMax: number;
  edgesMin: number;
}
const BANDS = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, "eval", "baselines.json"), "utf8")) as {
    realCorpus: { targets: Record<string, CorpusBand> };
  }
).realCorpus.targets[TS_LIB_KEY];

describe.runIf(existsSync(TS_LIB))("real-repo corpus gate — codebase-only invariants on dense real code (ADR 0034 S7)", () => {
  it("typescript/lib: zero invariant violations + structural sanity within loose patch-drift bands", async () => {
    // gitignore mode mirrors how the product maps a real repo (and is what measureColdStart uses);
    // typescript/lib ships no .gitignore, so the scope is deterministic.
    const map = await buildContextMap(TS_LIB, { mode: "gitignore" });

    // LOAD-BEARING: the codebase-only honesty contract holds on real dense code. On this golden-less
    // subject checkInvariants (passed [] reachability — no golden) exercises the branches that have
    // data: the edge tier ceilings (195 edges — unresolved/dynamic/direct gradings), the capped
    // findings (risk areas + their mandatory uncertainty, duplicates, legacy no-dead-code caveat), and
    // codebaseOnlyBoundary. The reachability/entry-point branches are vacuous here (no reach results;
    // lib has no entry points), and framework/method edge kinds are sparse in declaration-heavy code —
    // that breadth stays covered by the synthetic fixtures. Asserting the array (not a count) surfaces
    // the exact violation in the failure message.
    expect(checkInvariants(map, [])).toEqual([]);

    // Structural sanity — loose bands from baselines.json. nodesMin/Max catch extraction collapse and
    // over-resolution blowup; edgesMin catches a resolution regression that leaves nodes but no edges.
    const nodes = map.callGraph.nodes.length;
    const edges = map.callGraph.edges.length;
    expect(nodes).toBeGreaterThan(BANDS.nodesMin);
    expect(nodes).toBeLessThan(BANDS.nodesMax);
    expect(edges).toBeGreaterThan(BANDS.edgesMin);
  }, 120_000);
});
