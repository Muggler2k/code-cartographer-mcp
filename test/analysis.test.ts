import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { initCodebase } from "../src/contextMap.js";
import { tempRepos } from "./helpers/fixtures.js";
import {
  analyzeChangeImpact,
  analyzeReachability,
  analyzeTestPaths,
  classifyLegacyPaths,
  detectArchitectureDrift,
  findDuplicateBehavior,
  getOwnership,
  investigateFailure,
  reviewChange,
  reviewPreflight
} from "../src/analysis.js";

const { makeRepo, cleanup } = tempRepos("ccm-an-");
afterAll(cleanup);

let root: string;

beforeAll(async () => {
  const files: Record<string, string> = {
    "src/x.ts": "export function helper() { return 1; }\n",
    "src/a.ts": "import { helper } from './x';\nexport function main() { return helper(); }\n",
    "src/legacy/old.ts": "export function oldThing() { return 2; }\n",
    "test/a.test.ts": "import { main } from '../src/a';\nexport function t() { return main(); }\n"
  };
  root = await makeRepo(files);
  await initCodebase(root, { mode: "none" });
});

describe("analysis capabilities (Epic F, CAP-07..16)", () => {
  it("analyzeReachability reaches helper from main, never claims confirmed runtime truth", async () => {
    const r = await analyzeReachability(root, "main");
    expect(r.analysisBoundary).toBe("codebase_only");
    expect(r.reachablePaths.some((p) => p.label.includes("helper"))).toBe(true);
    expect(r.reachablePaths.every((p) => p.confidence !== "confirmed")).toBe(true);
    expect(r.uncertainty.length).toBeGreaterThan(0);
  });

  it("analyzeChangeImpact reverse-reaches dependents of helper", async () => {
    const r = await analyzeChangeImpact(root, "helper");
    expect(r.changeImpact.length).toBeGreaterThan(0);
    expect(r.uncertainty.some((u) => /blast radius/i.test(u.item))).toBe(true);
  });

  it("getOwnership resolves an exported owner at ≤ likely confidence", async () => {
    const r = await getOwnership(root, "helper");
    expect(r.canonicalPaths.length).toBeGreaterThan(0);
    expect(r.canonicalPaths.every((c) => c.confidence !== "confirmed")).toBe(true);
  });

  it("analyzeTestPaths finds the test that reaches main", async () => {
    const r = await analyzeTestPaths(root, "main");
    expect(r.reachingTests.some((t) => t.label.includes("test/a.test.ts"))).toBe(true);
  });

  it("investigateFailure always returns non-empty requiredRuntimeConfirmation", async () => {
    const r = await investigateFailure(root, "Error in helper at src/x.ts");
    expect(r.requiredRuntimeConfirmation.length).toBeGreaterThan(0);
    expect(r.analysisBoundary).toBe("codebase_only");
  });

  it("classifyLegacyPaths surfaces the legacy-named symbol (never asserting dead)", async () => {
    const r = await classifyLegacyPaths(root);
    const lp = r.legacyPaths.find((l) => l.label.includes("oldThing"));
    expect(lp).toBeDefined();
    expect(lp?.reachability).not.toBe("safe_removal_candidate");
  });

  it("reviewPreflight composes a recommendation", async () => {
    const r = await reviewPreflight(root, "helper");
    expect(r.recommendation.action).toBeTruthy();
    expect(r.analysisBoundary).toBe("codebase_only");
  });

  it("reviewChange flags a parallel-path description as riskier", async () => {
    const r = await reviewChange(root, "add a new parallel helper implementation");
    expect(r.alignment).toBe("riskier");
  });

  it("findDuplicateBehavior and detectArchitectureDrift stay codebase-only with uncertainty", async () => {
    const dup = await findDuplicateBehavior(root, "helper");
    expect(dup.analysisBoundary).toBe("codebase_only");
    const drift = await detectArchitectureDrift(root);
    expect(drift.analysisBoundary).toBe("codebase_only");
    expect(drift.uncertainty.length).toBeGreaterThan(0);
  });

  it("every capability returns the init-required envelope (not a throw) when uninitialized", async () => {
    const empty = await makeRepo();
    const r = await analyzeReachability(empty, "x");
    expect(r.status).toBe("unresolved");
    expect(r.uncertainty[0].item).toMatch(/not initialized/i);
  });
});

// Regression coverage for the classification LOGIC (not just the boundary envelope): a prior
// review found analyzeChangeImpact's impact-level grading and detectArchitectureDrift's
// parallel-implementation derivation could break silently while tests still passed.
describe("analysis classification logic (HF-5 / HF-6 regression)", () => {
  let root2: string;

  beforeAll(async () => {
    const files: Record<string, string> = {
      // High fan-in: `core` is called by five dependents in one area -> a `high` impact area.
      "src/core/shared.ts": "export function core() { return 1; }\n",
      "src/feature/util.ts": "export function helper() { return 2; }\n",
      "src/feature/d1.ts": "import { core } from '../core/shared';\nimport { helper } from './util';\nexport function d1() { return core() + helper(); }\n",
      "src/feature/d2.ts": "import { core } from '../core/shared';\nexport function d2() { return core(); }\n",
      "src/feature/d3.ts": "import { core } from '../core/shared';\nexport function d3() { return core(); }\n",
      "src/feature/d4.ts": "import { core } from '../core/shared';\nexport function d4() { return core(); }\n",
      "src/feature/d5.ts": "import { core } from '../core/shared';\nexport function d5() { return core(); }\n",
      // Duplicate exported name across two files -> a duplicate candidate -> drift "Parallel implementations".
      "src/featA/parse.ts": "export function parse() { return 1; }\n",
      "src/featB/parse.ts": "export function parse() { return 2; }\n"
    };
    root2 = await makeRepo(files);
    await initCodebase(root2, { mode: "none" });
  });

  const RANK: Record<string, number> = { confirmed: 5, likely: 4, candidate: 3, unclear: 2, unresolved: 1 };

  it("grades a high-fan-in target as `high` impact and emits the investigate recommendation (HF-5)", async () => {
    const r = await analyzeChangeImpact(root2, "core");
    // Five dependents in one area trips the `count >= 5` arm -> at least one `high` area.
    expect(r.changeImpact.some((a) => a.impactLevel === "high")).toBe(true);
    expect(r.changeImpact.some((a) => /\d+ static dependent/.test(a.reason))).toBe(true);
    expect(r.recommendation?.action).toBe("investigate");
  });

  it("grades a single same-area dependent as `low` impact with no recommendation (HF-5)", async () => {
    const r = await analyzeChangeImpact(root2, "helper");
    expect(r.changeImpact.length).toBeGreaterThan(0);
    expect(r.changeImpact.every((a) => a.impactLevel === "low")).toBe(true);
    expect(r.recommendation).toBeUndefined();
  });

  it("derives a parallel-implementation drift finding from duplicate exports, clamped <= candidate (HF-6)", async () => {
    const drift = await detectArchitectureDrift(root2);
    expect(drift.driftFindings.length).toBeGreaterThan(0);
    expect(drift.driftFindings.some((f) => /parallel implementations/i.test(f.finding))).toBe(true);
    expect(drift.driftFindings.every((f) => RANK[f.confidence] <= RANK.candidate)).toBe(true);
    expect(drift.analysisBoundary).toBe("codebase_only");
  });
});

// Reachability semantics that the substrate swap (Decision 0024) must preserve: the depth cap
// and the weak-edge grading. A prior review (MF-4) flagged these as uncovered.
describe("analysis reachability — depth cap + weak-edge grading (MF-4 regression)", () => {
  let root3: string;

  beforeAll(async () => {
    const N = 15; // a0 -> a1 -> ... -> a14, a chain longer than MAX_DEPTH (12)
    let chain = "export function a0() { return a1(); }\n";
    for (let i = 1; i < N - 1; i++) chain += `function a${i}() { return a${i + 1}(); }\n`;
    chain += `function a${N - 1}() { return 0; }\n`;
    const files: Record<string, string> = {
      "src/chain.ts": chain,
      // `entry` reaches `helper` directly and an unknown symbol via an unresolved edge.
      "src/dyn.ts": "export function entry() { helper(); missingThing(); }\nfunction helper() { return 1; }\n"
    };
    root3 = await makeRepo(files);
    await initCodebase(root3, { mode: "none" });
  });

  it("does not report nodes beyond MAX_DEPTH (12) hops from the target", async () => {
    const r = await analyzeReachability(root3, "a0");
    const syms = new Set(r.reachablePaths.map((p) => p.label.split(" ")[0]));
    expect(syms.has("a1")).toBe(true); // depth 1
    expect(syms.has("a12")).toBe(true); // depth 12 — the cap
    expect(syms.has("a13")).toBe(false); // beyond the cap → truncated
    expect(syms.has("a14")).toBe(false);
  });

  it("grades a node reached via an unresolved edge as not-reachable, never `likely`/`confirmed`", async () => {
    const r = await analyzeReachability(root3, "entry");
    const helperPath = r.reachablePaths.find((p) => p.label.startsWith("helper "));
    expect(helperPath?.reachability).toBe("reachable"); // resolved direct edge
    const weak = r.reachablePaths.filter((p) => p.reachability === "unresolved" || p.reachability === "possibly_reachable");
    expect(weak.length).toBeGreaterThan(0); // the unresolved edge target
    expect(weak.every((p) => p.confidence !== "likely" && p.confidence !== "confirmed")).toBe(true);
    expect(r.reachablePaths.every((p) => p.confidence !== "confirmed")).toBe(true); // ADR 0016
  });
});
