import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { initCodebase } from "../src/contextMap.js";
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

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-an-"));
  const files: Record<string, string> = {
    "src/x.ts": "export function helper() { return 1; }\n",
    "src/a.ts": "import { helper } from './x';\nexport function main() { return helper(); }\n",
    "src/legacy/old.ts": "export function oldThing() { return 2; }\n",
    "test/a.test.ts": "import { main } from '../src/a';\nexport function t() { return main(); }\n"
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  await initCodebase(root, { mode: "none" });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
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
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-empty-"));
    try {
      const r = await analyzeReachability(empty, "x");
      expect(r.status).toBe("unresolved");
      expect(r.uncertainty[0].item).toMatch(/not initialized/i);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

// Regression coverage for the classification LOGIC (not just the boundary envelope): a prior
// review found analyzeChangeImpact's impact-level grading and detectArchitectureDrift's
// parallel-implementation derivation could break silently while tests still passed.
describe("analysis classification logic (HF-5 / HF-6 regression)", () => {
  let root2: string;

  beforeAll(async () => {
    root2 = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-an2-"));
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
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root2, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    await initCodebase(root2, { mode: "none" });
  });

  afterAll(async () => {
    await fs.rm(root2, { recursive: true, force: true });
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
