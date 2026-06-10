import { describe, expect, it } from "vitest";

import type { InitResult, InitStatusResult } from "../src/contextMap.js";
import type { OutputMode, StaticContextMap } from "../src/schema.js";
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
  { name: "formatArchitectureVisualization", render: (m) => formatArchitectureVisualization(archViz, m), human: "graph TD" }
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
});
