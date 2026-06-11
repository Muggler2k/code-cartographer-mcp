// Diff / PR mode (Epic O, ADR 0031): the pure comparator + the analyze_diff capability.
// Every assertion is about a STATIC delta; a "confidence regression" is weakened static
// evidence, never a runtime claim; the default mode must never persist anything (the
// baseline survives).

import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { analyzeDiff, compareMaps, gradeDelta, MAX_DELTA_LIST } from "../src/mapDiff.js";
import { initCodebase, readContextMap, getMapPath } from "../src/contextMap.js";
import type { DuplicatePath, Finding, LegacyPath, StaticContextMap } from "../src/schema.js";
import { tempRepos, testContextMap, testEdge, testFileEntry, testNode } from "./helpers/fixtures.js";

const repos = tempRepos("ccm-diff-");
afterAll(() => repos.cleanup());

function dup(id: string): DuplicatePath {
  return { id, label: id, confidence: "candidate", evidence: ["e"], risk: "r", uncertainty: [{ item: "x", reason: "y", requiredConfirmation: "z" }] };
}
function legacy(id: string, reachability: LegacyPath["reachability"]): LegacyPath {
  return { id, label: id, reachability, evidence: ["legacy naming signal"], recommendation: "confirm", uncertainty: [{ item: "no-dead", reason: "static", requiredConfirmation: "human" }] };
}
function risk(finding: string): Finding {
  return { finding, confidence: "candidate", evidence: ["e"], risk: "r", recommendation: "rec", uncertainty: [{ item: "x", reason: "y", requiredConfirmation: "z" }] };
}

describe("compareMaps (pure comparator)", () => {
  it("detects file adds/removes/changes by sha256 and graph node/edge deltas", () => {
    const baseline = testContextMap({
      files: [testFileEntry("a.ts", { sha256: "1".repeat(64) }), testFileEntry("gone.ts")],
      nodes: [testNode("a.ts#f")],
      edges: []
    });
    const current = testContextMap({
      files: [testFileEntry("a.ts", { sha256: "2".repeat(64) }), testFileEntry("new.ts")],
      nodes: [testNode("a.ts#f"), testNode("new.ts#g")],
      edges: [testEdge("a.ts#f", "new.ts#g")]
    });
    const d = compareMaps(baseline, current);
    expect(d.files.added).toEqual(["new.ts"]);
    expect(d.files.removed).toEqual(["gone.ts"]);
    expect(d.files.changed).toEqual(["a.ts"]);
    expect(d.graph.nodesAdded).toEqual(["new.ts#g"]);
    expect(d.totals.edgesAdded).toBe(1);
  });

  it("flags new duplicates (added parallel path) and resolves removed ones", () => {
    const baseline = testContextMap({});
    baseline.findings.duplicatePathCandidates = [dup("dup:name:old")];
    const current = testContextMap({});
    current.findings.duplicatePathCandidates = [dup("dup:name:parse")];
    const d = compareMaps(baseline, current);
    expect(d.newDuplicates.map((x) => x.id)).toEqual(["dup:name:parse"]);
    expect(d.resolvedDuplicateIds).toEqual(["dup:name:old"]);
    const { verdict, recommendation } = gradeDelta(d);
    expect(verdict.addedParallelPath).toBe(true);
    expect(recommendation.action).toBe("consolidate");
  });

  it("reports legacy reachability transitions and marks still_reachable as revived", () => {
    const baseline = testContextMap({});
    baseline.findings.legacyPathCandidates = [legacy("legacy/x.ts#old", "apparently_unreachable")];
    const current = testContextMap({});
    current.findings.legacyPathCandidates = [legacy("legacy/x.ts#old", "still_reachable")];
    const d = compareMaps(baseline, current);
    expect(d.legacyTransitions).toEqual([{ id: "legacy/x.ts#old", from: "apparently_unreachable", to: "still_reachable", revived: true }]);
    const { verdict, recommendation } = gradeDelta(d);
    expect(verdict.revivedLegacy).toBe(true);
    expect(recommendation.action).toBe("avoid");
  });

  it("flags a new bypassed-abstraction risk area in the verdict", () => {
    const baseline = testContextMap({});
    const current = testContextMap({});
    current.findings.riskAreas = [risk("caller.ts calls internal helper in svc.ts, which exposes a public API — possible bypassed abstraction.")];
    const { verdict, recommendation } = gradeDelta(compareMaps(baseline, current));
    expect(verdict.bypassedAbstraction).toBe(true);
    expect(recommendation.action).toBe("investigate");
  });

  it("detects per-edge confidence regressions (static evidence weakening) and improvements", () => {
    const baseline = testContextMap({
      nodes: [testNode("a.ts#f"), testNode("b.ts#g"), testNode("c.ts#h")],
      edges: [testEdge("a.ts#f", "b.ts#g", { confidence: "confirmed" }), testEdge("b.ts#g", "c.ts#h", { confidence: "candidate" })]
    });
    const current = testContextMap({
      nodes: baseline.callGraph.nodes,
      edges: [testEdge("a.ts#f", "b.ts#g", { confidence: "likely" }), testEdge("b.ts#g", "c.ts#h", { confidence: "confirmed" })]
    });
    const d = compareMaps(baseline, current);
    expect(d.confidence.regressions).toEqual([{ edge: "a.ts#f → b.ts#g (direct)", from: "confirmed", to: "likely" }]);
    expect(d.confidence.improvements).toBe(1);
    expect(gradeDelta(d).verdict.increasedUncertainty).toBe(true);
  });

  it("caps every list at MAX_DELTA_LIST while totals carry the true counts", () => {
    const baseline = testContextMap({});
    const current = testContextMap({ files: Array.from({ length: 30 }, (_, i) => testFileEntry(`f${String(i).padStart(2, "0")}.ts`)) });
    const d = compareMaps(baseline, current);
    expect(d.files.added).toHaveLength(MAX_DELTA_LIST);
    expect(d.totals.filesAdded).toBe(30);
  });

  it("verdict flags see signals past the list cap (graded from totals, not the capped lists)", () => {
    // The ONLY revived transition and the ONLY bypassed-abstraction finding sort/land
    // beyond MAX_DELTA_LIST — the capped lists miss them, the verdict must not.
    const baseline = testContextMap({});
    baseline.findings.legacyPathCandidates = Array.from({ length: MAX_DELTA_LIST + 1 }, (_, i) =>
      legacy(`legacy/${String(i).padStart(2, "0")}.ts#old`, "apparently_unreachable")
    );
    const current = testContextMap({});
    current.findings.legacyPathCandidates = baseline.findings.legacyPathCandidates.map((l, i) =>
      legacy(l.id, i === MAX_DELTA_LIST ? "still_reachable" : "unclear")
    );
    current.findings.riskAreas = [
      ...Array.from({ length: MAX_DELTA_LIST }, (_, i) => risk(`a-risk ${String(i).padStart(2, "0")}: god file`)),
      risk("z-risk: caller.ts uses an internal helper — possible bypassed abstraction.")
    ];
    const d = compareMaps(baseline, current);
    expect(d.legacyTransitions).toHaveLength(MAX_DELTA_LIST);
    expect(d.legacyTransitions.some((t) => t.revived)).toBe(false);
    expect(d.newRiskAreas.some((r) => /bypassed abstraction/i.test(r.finding))).toBe(false);
    expect(d.totals.revivedLegacy).toBe(1);
    expect(d.totals.bypassedAbstractions).toBe(1);
    const { verdict } = gradeDelta(d);
    expect(verdict.revivedLegacy).toBe(true);
    expect(verdict.bypassedAbstraction).toBe(true);
  });

  it("a clean delta yields an all-no verdict and a reuse recommendation", () => {
    const map = testContextMap({ files: [testFileEntry("a.ts")], nodes: [testNode("a.ts#f")] });
    const { verdict, recommendation } = gradeDelta(compareMaps(map, map));
    expect(Object.values(verdict)).toEqual([false, false, false, false]);
    expect(recommendation.action).toBe("reuse");
  });
});

describe("analyzeDiff (CAP-26 — capability over the working tree)", () => {
  it("returns the init-required envelope when no baseline exists", async () => {
    const empty = await repos.makeRepo({ "a.ts": "export const a = 1;" });
    const r = await analyzeDiff(empty);
    expect(r.analysisBoundary).toBe("codebase_only");
    expect(r.uncertainty[0].item).toMatch(/not initialized/i);
    expect(r.recommendation.action).toBe("investigate");
  });

  it("diffs the persisted baseline against the edited tree WITHOUT persisting anything", async () => {
    const root = await repos.makeRepo({
      "src/json.ts": "export function parse(s: string): unknown { return JSON.parse(s); }\n",
      "src/main.ts": "import { parse } from './json.js';\nexport function main(): unknown { return parse('1'); }\n"
    });
    await initCodebase(root, { mode: "none" });
    const baselineHashBefore = (await readContextMap(root))!.meta.mapHash;

    // The "agent change": a second exported `parse` (parallel path) + a brand-new file.
    await fs.writeFile(path.join(root, "src", "csv.ts"), "export function parse(s: string): string[] { return s.split(','); }\n");

    const r = await analyzeDiff(root);
    expect(r.delta.files.added).toEqual(["src/csv.ts"]);
    expect(r.delta.totals.nodesAdded).toBeGreaterThan(0);
    expect(r.verdict.addedParallelPath).toBe(true);
    expect(r.delta.newDuplicates.some((d) => d.id === "dup:name:parse")).toBe(true);
    expect(r.recommendation.action).toBe("consolidate");
    expect(r.baseline.mapHash).toBe(baselineHashBefore);
    expect(r.current.mapHash).not.toBe(baselineHashBefore);

    // The baseline on disk survived (re-baselining stays an explicit init_codebase).
    const persistedAfter = (await readContextMap(root))!;
    expect(persistedAfter.meta.mapHash).toBe(baselineHashBefore);
    expect(persistedAfter.files.some((f) => f.path === "src/csv.ts")).toBe(false);
  }, 120_000);

  it("compares an explicit baseline snapshot against the persisted map (CI shape)", async () => {
    const root = await repos.makeRepo({ "src/a.ts": "export function one(): number { return 1; }\n" });
    await initCodebase(root, { mode: "none" });
    const snapshot = path.join(root, "baseline-snapshot.json");
    await fs.copyFile(getMapPath(root), snapshot);

    await fs.writeFile(path.join(root, "src", "b.ts"), "export function two(): number { return 2; }\n");
    await initCodebase(root, { mode: "none" }); // re-baseline = the PR-head map

    const r = await analyzeDiff(root, { baselineMapPath: snapshot });
    // The snapshot itself becomes a changed/added artifact too; the load-bearing assertion is b.ts.
    expect(r.delta.files.added).toContain("src/b.ts");
    expect(r.delta.graph.nodesAdded).toContain("src/b.ts#two");
  }, 120_000);

  it("degrades gracefully on an unreadable explicit baseline", async () => {
    const root = await repos.makeRepo({ "a.ts": "export const a = 1;" });
    await initCodebase(root, { mode: "none" });
    const r = await analyzeDiff(root, { baselineMapPath: path.join(root, "missing.json") });
    expect(r.uncertainty[0].item).toMatch(/baseline map not readable/i);
  }, 120_000);

  it("every diff result carries the codebase_only envelope and non-empty uncertainty", async () => {
    const root = await repos.makeRepo({ "a.ts": "export const a = 1;" });
    await initCodebase(root, { mode: "none" });
    const r = await analyzeDiff(root);
    expect(r.analysisBoundary).toBe("codebase_only");
    expect(r.uncertainty.length).toBeGreaterThan(0);
    expect(r.uncertainty.some((u) => /static inferences, not behavior/i.test(u.item))).toBe(true);
  }, 120_000);
});
