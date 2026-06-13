import { describe, expect, it } from "vitest";

import type { InitResult, InitStatusResult } from "../src/contextMap.js";
import type { CallEdge, CallGraphNode, OutputMode, StaticContextMap } from "../src/schema.js";
import { testContextMap, testFileEntry } from "./helpers/fixtures.js";
import type {
  ArchitectureDriftResult,
  ChangeImpactResult,
  ChangeReviewResult,
  DuplicateBehaviorResult,
  FailureInvestigationResult,
  LegacyClassificationResult,
  OwnershipResult,
  PreflightReviewResult,
  ReachabilityResult,
  TestPathResult
} from "../src/analysis.js";
import type { CallStackResult } from "../src/callGraph.js";
import type { ArchitectureVisualizationResult, CallStackVisualizationResult } from "../src/visualize.js";
import type { MapDiffResult } from "../src/mapDiff.js";
import type { ScopePreview } from "../src/scope.js";
import {
  formatArchitectureDrift,
  formatArchitectureVisualization,
  formatCallStack,
  formatCallStackVisualization,
  formatChangeImpact,
  formatChangeReview,
  formatContextSummary,
  formatDuplicateBehavior,
  formatFailureInvestigation,
  formatInitResult,
  formatInitStatus,
  formatLegacyClassification,
  formatOwnership,
  formatPreflightReview,
  formatReachability,
  formatMapDiff,
  formatScopePreview,
  formatTestPaths
} from "../src/output.js";

const preview: ScopePreview = {
  analysisBoundary: "codebase_only",
  repositoryRoot: "/repo",
  resolution: { source: "gitignore", languages: [], excludeDirs: [], patterns: ["dist/"], scopeHash: "abc123" },
  includedFileCount: 2,
  excludedDirCount: 1,
  excludedFileCount: 1,
  sampleIncluded: ["a.ts", "b.ts"],
  sampleExcluded: ["dist"]
};

describe("formatScopePreview (A3d, output-mode policy + ADR 0015)", () => {
  it("human_readable surfaces the codebase-only boundary, source, and counts", () => {
    const out = formatScopePreview(preview, "human_readable");
    expect(out.toLowerCase()).toContain("codebase-only");
    expect(out).toContain("gitignore");
    expect(out).toContain("2");
    expect(out).toContain("a.ts");
  });

  it("llm_readable is valid JSON carrying analysisBoundary", () => {
    const parsed = JSON.parse(formatScopePreview(preview, "llm_readable"));
    expect(parsed.analysisBoundary).toBe("codebase_only");
    expect(parsed.includedFileCount).toBe(2);
  });

  it("dual is the human block + a fenced json block (ADR 0015)", () => {
    const out = formatScopePreview(preview, "dual");
    expect(out.toLowerCase()).toContain("codebase-only");
    expect(out).toContain("```json");
    const json = out.split("```json")[1].split("```")[0];
    expect(JSON.parse(json)).toMatchObject({ analysisBoundary: "codebase_only" });
  });
});

// ---- All result formatters (Epic D) ----

function minimalMap(): StaticContextMap {
  const map = testContextMap({ files: [testFileEntry("src/index.ts")] });
  map.summary = {
    ...map.summary,
    categories: { ...map.summary.categories, source: 1 },
    languages: { ts: 1 },
    importantFiles: ["src/index.ts"],
    entryPoints: [{ path: "src/index.ts", kind: "source_entry", confidence: "likely", reason: "conventional entry" }],
    modules: [{ name: "src", root: "src", category: "source", files: ["src/index.ts"] }],
    ownershipSignals: [
      { symbol: "main", kind: "function", path: "src/index.ts", exported: true, confidence: "confirmed", reason: "exported" }
    ]
  };
  map.findings.canonicalPaths = [{ id: "c1", label: "canonical", confidence: "likely", evidence: ["e"], risks: [] }];
  map.findings.uncertainty = [{ item: "x", reason: "static-only", requiredConfirmation: "runtime check" }];
  return map;
}

const uncertainty = [{ item: "runtime path", reason: "static-only", requiredConfirmation: "execute to confirm" }];
const finding = {
  finding: "scattered ownership",
  confidence: "candidate" as const,
  evidence: ["two modules own X"],
  risk: "drift",
  recommendation: "consolidate",
  uncertainty
};
const recommendation = { action: "reuse" as const, target: "src/index.ts", rationale: "canonical owner" };

const initStatus: InitStatusResult = {
  analysisBoundary: "codebase_only",
  status: "initialized",
  mapPath: "/repo/.code-cartographer-mcp/context-map.json",
  message: "Context map is current.",
  previousMapHash: "deadbeef",
  currentMapHash: "deadbeef"
};
const initResult: InitResult = {
  analysisBoundary: "codebase_only",
  status: "initialized",
  mapPath: "/repo/.code-cartographer-mcp/context-map.json",
  map: minimalMap()
};
const reachability: ReachabilityResult = {
  analysisBoundary: "codebase_only",
  subject: "main",
  status: "likely",
  summary: "reachable from the entry point",
  reachablePaths: [{ id: "p1", label: "index -> main", reachability: "reachable", confidence: "likely", evidence: ["direct call"] }],
  uncertainty
};
const duplicate: DuplicateBehaviorResult = {
  analysisBoundary: "codebase_only",
  subject: "parseConfig",
  duplicatePaths: [
    { id: "d1", label: "two parseConfig", confidence: "candidate", evidence: ["same name"], risk: "parallel paths", uncertainty }
  ],
  recommendation,
  uncertainty
};
const legacy: LegacyClassificationResult = {
  analysisBoundary: "codebase_only",
  legacyPaths: [
    { id: "l1", label: "old/api.ts", reachability: "requires_human_confirmation", evidence: ["no inbound refs"], recommendation: "confirm before removal", uncertainty }
  ],
  uncertainty
};
const impact: ChangeImpactResult = {
  analysisBoundary: "codebase_only",
  target: "src/index.ts",
  changeImpact: [{ area: "src/app.ts", impactLevel: "medium", reason: "imports the target" }],
  recommendation,
  uncertainty
};
const preflight: PreflightReviewResult = {
  analysisBoundary: "codebase_only",
  subject: "add caching",
  status: "candidate",
  summary: "reuse the canonical path",
  canonicalPaths: [{ id: "c1", label: "cache.ts", confidence: "likely", evidence: ["owns caching"], risks: [] }],
  duplicatePaths: [],
  legacyPaths: [],
  changeImpact: [{ area: "src/app.ts", impactLevel: "low", reason: "uses cache" }],
  recommendation,
  uncertainty
};
const changeReview: ChangeReviewResult = {
  analysisBoundary: "codebase_only",
  subject: "PR #1",
  alignment: "mixed",
  findings: [finding],
  uncertainty
};
const ownership: OwnershipResult = {
  analysisBoundary: "codebase_only",
  subject: "caching",
  canonicalPaths: [{ id: "c1", label: "cache.ts", confidence: "likely", evidence: ["owns caching"], risks: [] }],
  uncertainty
};
const failure: FailureInvestigationResult = {
  analysisBoundary: "codebase_only",
  subject: "NPE in parse",
  hypotheses: [finding],
  requiredRuntimeConfirmation: ["reproduce the failure and inspect the stack"],
  uncertainty
};
const testPaths: TestPathResult = {
  analysisBoundary: "codebase_only",
  target: "helper",
  reachingTests: [{ id: "t1", label: "helper.test.ts", reachability: "possibly_reachable", confidence: "candidate", evidence: ["imports helper"] }],
  uncertainty
};
const drift: ArchitectureDriftResult = {
  analysisBoundary: "codebase_only",
  driftFindings: [finding],
  uncertainty
};
const callStack: CallStackResult = {
  analysisBoundary: "codebase_only",
  entryPoint: "main",
  rootId: "src/index.ts#main",
  nodes: [{ id: "src/index.ts#main", symbol: "main", path: "src/index.ts", kind: "function", confidence: "confirmed" }],
  edges: [{ from: "src/index.ts#main", to: "src/app.ts#run", callKind: "direct", confidence: "confirmed", evidence: ["call expr"] }],
  maxDepthReached: false,
  uncertainty
};
const callViz: CallStackVisualizationResult = {
  analysisBoundary: "codebase_only",
  entryPoint: "main",
  visualization: { format: "mermaid", diagram: "graph TD\n  main --> run", title: "Call stack", legend: ["solid = confirmed"] },
  uncertainty
};
const archViz: ArchitectureVisualizationResult = {
  analysisBoundary: "codebase_only",
  visualization: { format: "mermaid", diagram: "graph TD\n  src --> app", title: "Architecture", legend: ["box = module"] },
  uncertainty
};

interface Case {
  name: string;
  render: (mode: OutputMode) => string;
  human: string; // substring expected in human mode
}

const mapDiff: MapDiffResult = {
  analysisBoundary: "codebase_only",
  baseline: { mapHash: "aaaa1111bbbb", generatedAt: "2026-06-10T00:00:00.000Z" },
  current: { mapHash: "cccc2222dddd" },
  delta: {
    files: { added: ["src/csv.ts"], removed: [], changed: ["src/json.ts"] },
    graph: { nodesAdded: ["src/csv.ts#parse"], nodesRemoved: [], edgesAdded: [], edgesRemoved: [] },
    newDuplicates: [{ id: "dup:name:parse", label: "Exported 'parse' declared in 2 locations", confidence: "candidate", evidence: ["e"], risk: "divergence", uncertainty: [{ item: "equivalence unproven", reason: "static", requiredConfirmation: "human" }] }],
    resolvedDuplicateIds: [],
    newLegacy: [],
    legacyTransitions: [{ id: "legacy/x.ts#old", from: "apparently_unreachable", to: "still_reachable", revived: true }],
    newRiskAreas: [],
    resolvedRiskAreaCount: 0,
    canonicalRemovedIds: [],
    confidence: { regressions: [], improvements: 0, weakEdgeRatioBaseline: 0.1, weakEdgeRatioCurrent: 0.2, uncertaintyItemsBaseline: 1, uncertaintyItemsCurrent: 2 },
    totals: { filesAdded: 1, filesRemoved: 0, filesChanged: 1, nodesAdded: 1, nodesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, newDuplicates: 1, newLegacy: 0, legacyTransitions: 1, revivedLegacy: 1, newRiskAreas: 0, bypassedAbstractions: 0, confidenceRegressions: 0 }
  },
  verdict: { addedParallelPath: true, bypassedAbstraction: false, revivedLegacy: true, increasedUncertainty: true },
  recommendation: { action: "consolidate", target: "dup:name:parse", rationale: "parallel path" },
  uncertainty: [{ item: "The delta compares static inferences, not behavior", reason: "static", requiredConfirmation: "tests" }]
};

const cases: Case[] = [
  { name: "formatInitStatus", render: (m) => formatInitStatus(initStatus, m), human: "initialized" },
  { name: "formatInitResult", render: (m) => formatInitResult(initResult, m), human: "Initial" },
  { name: "formatContextSummary", render: (m) => formatContextSummary(minimalMap(), m), human: "src/index.ts" },
  { name: "formatReachability", render: (m) => formatReachability(reachability, m), human: "main" },
  { name: "formatDuplicateBehavior", render: (m) => formatDuplicateBehavior(duplicate, m), human: "parseConfig" },
  { name: "formatLegacyClassification", render: (m) => formatLegacyClassification(legacy, m), human: "requires_human_confirmation" },
  { name: "formatChangeImpact", render: (m) => formatChangeImpact(impact, m), human: "src/app.ts" },
  { name: "formatPreflightReview", render: (m) => formatPreflightReview(preflight, m), human: "cache.ts" },
  { name: "formatChangeReview", render: (m) => formatChangeReview(changeReview, m), human: "mixed" },
  { name: "formatOwnership", render: (m) => formatOwnership(ownership, m), human: "cache.ts" },
  { name: "formatFailureInvestigation", render: (m) => formatFailureInvestigation(failure, m), human: "reproduce" },
  { name: "formatTestPaths", render: (m) => formatTestPaths(testPaths, m), human: "helper.test.ts" },
  { name: "formatArchitectureDrift", render: (m) => formatArchitectureDrift(drift, m), human: "scattered ownership" },
  { name: "formatCallStack", render: (m) => formatCallStack(callStack, m), human: "main" },
  { name: "formatCallStackVisualization", render: (m) => formatCallStackVisualization(callViz, m), human: "graph TD" },
  { name: "formatArchitectureVisualization", render: (m) => formatArchitectureVisualization(archViz, m), human: "graph TD" },
  { name: "formatMapDiff", render: (m) => formatMapDiff(mapDiff, m), human: "statically revived" }
];

describe("all result formatters (Epic D, output-mode policy)", () => {
  for (const c of cases) {
    it(`${c.name}: human surfaces the codebase-only boundary and key content`, () => {
      const out = c.render("human_readable");
      expect(out.toLowerCase()).toContain("codebase-only");
      expect(out).toContain(c.human);
    });

    it(`${c.name}: llm_readable is valid JSON with analysisBoundary`, () => {
      const parsed = JSON.parse(c.render("llm_readable"));
      expect(parsed.analysisBoundary).toBe("codebase_only");
    });

    it(`${c.name}: dual contains a fenced json block`, () => {
      const out = c.render("dual");
      expect(out).toContain("```json");
      const json = out.split("```json")[1].split("```")[0];
      expect(() => JSON.parse(json)).not.toThrow();
    });
  }

  it("formatContextSummary handles a null (not-initialized) map", () => {
    const out = formatContextSummary(null, "human_readable");
    expect(out.toLowerCase()).toContain("not");
    const parsed = JSON.parse(formatContextSummary(null, "llm_readable"));
    expect(parsed.status).toBe("not_initialized");
  });

  it("formatLegacyClassification surfaces the per-path uncertainty caveat in human mode", () => {
    const out = formatLegacyClassification(legacy, "human_readable");
    expect(out).toContain(legacy.legacyPaths[0].uncertainty[0].item);
  });

  it("formatMapDiff surfaces the static-not-behavior uncertainty in both modes", () => {
    const out = formatMapDiff(mapDiff, "human_readable");
    expect(out).toContain(mapDiff.uncertainty[0].item);
    const parsed = JSON.parse(formatMapDiff(mapDiff, "llm_readable"));
    expect(parsed.uncertainty.length).toBeGreaterThan(0);
  });
});

// ADR 0034 S1 — the summary/init llm payload must stay bounded regardless of repo size.
describe("context-summary llm digest is bounded (ADR 0034 S1)", () => {
  function bigMap(): StaticContextMap {
    const map = testContextMap({ files: [testFileEntry("src/index.ts")] });
    map.summary = {
      ...map.summary,
      totalFiles: 5000,
      importantFiles: Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`),
      entryPoints: Array.from({ length: 500 }, (_, i) => ({
        path: `src/entry${i}.ts`,
        kind: "source_entry" as const,
        confidence: "likely" as const,
        reason: "conventional entry point with a deliberately long reason to inflate size"
      })),
      modules: Array.from({ length: 500 }, (_, i) => ({
        name: `mod${i}`,
        root: `src/mod${i}`,
        category: "source" as const,
        files: Array.from({ length: 50 }, (_, j) => `src/mod${i}/f${j}.ts`)
      })),
      ownershipSignals: Array.from({ length: 5000 }, (_, i) => ({
        symbol: `Symbol${i}`,
        kind: "function" as const,
        path: `src/file${i}.ts`,
        exported: true,
        confidence: "confirmed" as const,
        reason: "exported declaration with a long descriptive reason field"
      }))
    };
    return map;
  }

  it("caps every sample list at 20 while keeping true totals and the codebase-only boundary", () => {
    const parsed = JSON.parse(formatContextSummary(bigMap(), "llm_readable"));
    expect(parsed.analysisBoundary).toBe("codebase_only");
    expect(parsed.meta.codebaseOnlyBoundary).toBe(true);
    expect(parsed.summary.ownershipSignals).toHaveLength(20);
    expect(parsed.summary.modules).toHaveLength(20);
    expect(parsed.summary.entryPoints).toHaveLength(20);
    expect(parsed.summary.importantFiles).toHaveLength(20);
    expect(parsed.summary.counts).toMatchObject({ ownershipSignals: 5000, modules: 500, entryPoints: 500, importantFiles: 500 });
    expect(parsed.summary.truncated).toBe(true);
    // modules collapse to fileCount — the full files[] never ships in the digest.
    expect(parsed.summary.modules[0].fileCount).toBe(50);
    expect(parsed.summary.modules[0].files).toBeUndefined();
  });

  it("stays small regardless of repo size (5000 signals → bounded payload)", () => {
    const out = formatContextSummary(bigMap(), "llm_readable");
    expect(out.length).toBeLessThan(15000);
  });

  it("does not mark a small summary truncated", () => {
    const parsed = JSON.parse(formatContextSummary(minimalMap(), "llm_readable"));
    expect(parsed.summary.truncated).toBe(false);
    expect(parsed.summary.counts.ownershipSignals).toBe(1);
    expect(parsed.summary.ownershipSignals).toHaveLength(1);
  });

  it("formatInitResult applies the same bounded digest", () => {
    const parsed = JSON.parse(formatInitResult(initResult, "llm_readable"));
    expect(parsed.summary.digestNote).toContain("ADR 0034 S1");
    expect(parsed.summary.counts).toBeDefined();
    expect(parsed.analysisBoundary).toBe("codebase_only");
    expect(parsed.meta.codebaseOnlyBoundary).toBe(true);
  });
});

// ADR 0034 S1 (issue #7) — the map_call_stack llm payload must stay bounded regardless of
// graph size, WITHOUT hiding unresolved edges (call-stack-and-visualization-policy: edges that
// cannot be resolved are disclosed, never omitted). The capped edge sample is backstopped by a
// per-confidence / per-kind count breakdown so the full unresolved distribution stays visible.
describe("call-stack llm digest is bounded (ADR 0034 S1)", () => {
  function bigCallStack(): CallStackResult {
    const nodes: CallGraphNode[] = Array.from({ length: 500 }, (_, i) => ({
      id: `src/mod${i}.ts#fn${i}`,
      symbol: `fn${i}`,
      path: `src/mod${i}.ts`,
      kind: "function" as const,
      confidence: "confirmed" as const
    }));
    // Every 5th edge is unresolved → 100 unresolved edges, all of which land past the sample cap.
    const edges: CallEdge[] = Array.from({ length: 500 }, (_, i) => ({
      from: "src/index.ts#main",
      to: `src/mod${i}.ts#fn${i}`,
      callKind: (i % 5 === 0 ? "unresolved" : "direct") as const,
      confidence: (i % 5 === 0 ? "unresolved" : "confirmed") as const,
      evidence: [`call expression at src/index.ts:${i}`]
    }));
    return {
      analysisBoundary: "codebase_only",
      entryPoint: "main",
      rootId: "src/index.ts#main",
      nodes,
      edges,
      maxDepthReached: true,
      uncertainty
    };
  }

  it("caps node/edge samples but keeps true totals, the confidence/kind breakdown, boundary, and uncertainty", () => {
    const parsed = JSON.parse(formatCallStack(bigCallStack(), "llm_readable"));
    expect(parsed.analysisBoundary).toBe("codebase_only");
    expect(parsed.entryPoint).toBe("main");
    expect(parsed.rootId).toBe("src/index.ts#main");
    expect(parsed.maxDepthReached).toBe(true);
    expect(parsed.nodes.length).toBeLessThanOrEqual(20);
    expect(parsed.edges.length).toBeLessThanOrEqual(20);
    expect(parsed.counts.nodes).toBe(500);
    expect(parsed.counts.edges).toBe(500);
    // Unresolved edges stay disclosed via the breakdown even though they fall past the sample.
    expect(parsed.counts.edgesByConfidence.unresolved).toBe(100);
    expect(parsed.counts.edgesByKind.unresolved).toBe(100);
    expect(parsed.truncated).toBe(true);
    expect(Array.isArray(parsed.uncertainty)).toBe(true);
    expect(parsed.uncertainty.length).toBeGreaterThan(0);
    expect(parsed.digestNote).toContain("ADR 0034 S1");
  });

  it("stays small regardless of graph size (500 edges → bounded payload)", () => {
    const out = formatCallStack(bigCallStack(), "llm_readable");
    expect(out.length).toBeLessThan(9000);
  });

  it("does not mark a small call stack truncated and keeps the full edge list", () => {
    const parsed = JSON.parse(formatCallStack(callStack, "llm_readable"));
    expect(parsed.truncated).toBe(false);
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.counts.edges).toBe(1);
    expect(parsed.counts.edgesByConfidence.confirmed).toBe(1);
  });

  it("human_readable keeps the true edge total visible even when the Edges section is capped", () => {
    const out = formatCallStack(bigCallStack(), "human_readable");
    expect(out).toContain("**Edges:** 500"); // Root line carries the true total
    expect(out).toContain("showing 20 of 500"); // capNote discloses the cap
  });
});

// ADR 0034 S1 (issue #7) — detect_architecture_drift's llm payload must stay bounded regardless
// of how many drift findings the repo accumulates (~60k tokens on a medium repo). Cap the
// findings sample; counts + a per-confidence breakdown keep the true total disclosed.
describe("architecture-drift llm digest is bounded (ADR 0034 S1)", () => {
  function bigDrift(): ArchitectureDriftResult {
    const driftFindings: Finding[] = Array.from({ length: 300 }, (_, i) => ({
      finding: `drift finding ${i} with a deliberately long description to inflate per-item size`,
      // Every 3rd is `candidate`, the rest `unclear` → 100 candidate, 200 unclear.
      confidence: (i % 3 === 0 ? "candidate" : "unclear") as const,
      evidence: [`module ${i} owns symbol ${i}`, `parallel owner at src/dup${i}.ts`],
      risk: "drift",
      recommendation: "consolidate",
      uncertainty
    }));
    return { analysisBoundary: "codebase_only", driftFindings, uncertainty };
  }

  it("caps the findings sample but keeps the true total, confidence breakdown, boundary, and uncertainty", () => {
    const parsed = JSON.parse(formatArchitectureDrift(bigDrift(), "llm_readable"));
    expect(parsed.analysisBoundary).toBe("codebase_only");
    expect(parsed.driftFindings.length).toBeLessThanOrEqual(20);
    expect(parsed.counts.driftFindings).toBe(300);
    expect(parsed.counts.byConfidence.candidate).toBe(100);
    expect(parsed.counts.byConfidence.unclear).toBe(200);
    expect(parsed.truncated).toBe(true);
    expect(Array.isArray(parsed.uncertainty)).toBe(true);
    expect(parsed.uncertainty.length).toBeGreaterThan(0);
    expect(parsed.digestNote).toContain("ADR 0034 S1");
  });

  it("stays small regardless of finding count (300 findings → bounded payload)", () => {
    const out = formatArchitectureDrift(bigDrift(), "llm_readable");
    expect(out.length).toBeLessThan(12000);
  });

  it("does not mark a small drift result truncated and keeps the full findings list", () => {
    const parsed = JSON.parse(formatArchitectureDrift(drift, "llm_readable"));
    expect(parsed.truncated).toBe(false);
    expect(parsed.driftFindings).toHaveLength(1);
    expect(parsed.counts.driftFindings).toBe(1);
    expect(parsed.counts.byConfidence.candidate).toBe(1);
  });

  it("human_readable keeps the true finding total visible even when the section is capped", () => {
    const out = formatArchitectureDrift(bigDrift(), "human_readable");
    expect(out).toContain("showing 20 of 300");
  });
});

// ADR 0034 S1 (issue #7) — analyze_reachability's llm payload must stay bounded regardless of how
// many reachable paths exist. Cap the paths sample; counts keep the true total + a per-confidence
// AND per-reachability breakdown, so the reachability distribution (a load-bearing, ≤likely signal)
// stays disclosed even when most paths fall past the cap.
describe("reachability llm digest is bounded (ADR 0034 S1)", () => {
  function bigReach(): ReachabilityResult {
    const reachablePaths = Array.from({ length: 400 }, (_, i) => ({
      id: `p${i}`,
      label: `index -> mod${i} -> target`,
      // Every 4th path is apparently_unreachable → 100 of them, all past the sample cap.
      reachability: (i % 4 === 0 ? "apparently_unreachable" : "reachable") as const,
      confidence: (i % 4 === 0 ? "candidate" : "likely") as const,
      evidence: [`call chain through src/mod${i}.ts with a long evidence string`]
    }));
    // A multi-item uncertainty so the no-truncation pin below is meaningful (a slice would shrink it).
    const multiUncertainty = [
      { item: "runtime path", reason: "static-only", requiredConfirmation: "execute to confirm" },
      { item: "dynamic dispatch", reason: "DI/reflection edges unresolved", requiredConfirmation: "runtime trace" },
      { item: "framework entry", reason: "invoked by the framework", requiredConfirmation: "runtime confirmation" }
    ];
    return {
      analysisBoundary: "codebase_only",
      subject: "target",
      status: "likely",
      summary: "reachable from several entry points",
      reachablePaths,
      uncertainty: multiUncertainty
    };
  }

  it("caps the paths sample but keeps the true total, confidence + reachability breakdowns, and boundary", () => {
    const parsed = JSON.parse(formatReachability(bigReach(), "llm_readable"));
    expect(parsed.analysisBoundary).toBe("codebase_only");
    expect(parsed.subject).toBe("target");
    expect(parsed.status).toBe("likely");
    expect(parsed.reachablePaths.length).toBeLessThanOrEqual(20);
    expect(parsed.counts.reachablePaths).toBe(400);
    expect(parsed.counts.byConfidence.candidate).toBe(100);
    // The reachability distribution stays visible even though all 100 unreachable paths are sampled out.
    expect(parsed.counts.byReachability.apparently_unreachable).toBe(100);
    expect(parsed.counts.byReachability.reachable).toBe(300);
    expect(parsed.truncated).toBe(true);
    // Uncertainty is never truncated by the digest — pin the exact count, not just > 0.
    expect(parsed.uncertainty).toHaveLength(3);
    expect(parsed.digestNote).toContain("ADR 0034 S1");
    // The most boundary-sensitive label carries its disclaimer at the point of consumption.
    expect(parsed.digestNote).toContain("apparently_unreachable");
  });

  it("stays small regardless of path count (400 paths → bounded payload)", () => {
    const out = formatReachability(bigReach(), "llm_readable");
    expect(out.length).toBeLessThan(10000);
  });

  it("does not mark a small reachability result truncated and keeps the full paths list", () => {
    const parsed = JSON.parse(formatReachability(reachability, "llm_readable"));
    expect(parsed.truncated).toBe(false);
    expect(parsed.reachablePaths).toHaveLength(1);
    expect(parsed.counts.reachablePaths).toBe(1);
    expect(parsed.counts.byReachability.reachable).toBe(1);
  });

  it("human_readable keeps the true path total visible even when the section is capped", () => {
    const out = formatReachability(bigReach(), "human_readable");
    expect(out).toContain("showing 20 of 400");
  });
});
