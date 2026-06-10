// Capability evaluation harness (Epic M, CAS ADR 0029). Runs the analyzer against a
// subject repo and SCORES the output against human-authored static ground truth
// (goldens) plus universal confidence invariants. CODEBASE-ONLY: the harness executes
// only OUR analyzer over subject files — fixture binaries exist to test binary
// HANDLING, never to run. A golden encodes ground truth, not current output: on
// disagreement either the golden is wrong (fix with reasoning) or the product is
// (file the bug). Goldens are never regenerated from output.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { initCodebase } from "../src/contextMap.js";
import { analyzeReachability, type ReachabilityResult } from "../src/analysis.js";
import { formatContextSummary, formatReachability } from "../src/output.js";
import { CONFIDENCE_RANK, type Confidence, type StaticContextMap } from "../src/schema.js";

// ---- Golden schema (human-authored static ground truth) ----

export interface GoldenEdge {
  from: string;
  to: string;
  callKind?: string;
  confidence?: Confidence;
}

export interface Golden {
  symbols?: { required?: string[]; forbidden?: string[] };
  /** node id → expected `exported` flag on its ownership signal. */
  exported?: Record<string, boolean>;
  edges?: { required?: GoldenEdge[]; forbidden?: { from: string; to: string }[] };
  entryPoints?: { required?: { path: string; kind: string }[] };
  duplicates?: { requiredIds?: string[]; forbiddenIds?: string[] };
  legacy?: { required?: { id: string; reachability?: string }[]; forbiddenIds?: string[] };
  riskAreas?: { requiredPatterns?: string[]; forbiddenPatterns?: string[] };
  reachability?: { target: string; mustReach?: string[]; mustNotReach?: string[] }[];
  files?: { nonAnalyzable?: string[] };
}

// ---- Result shapes ----

export interface CategoryScore {
  required: number;
  found: number;
  missing: string[];
  forbiddenHits: string[];
}

export interface SubjectResult {
  subject: string;
  scores: Record<string, CategoryScore>;
  invariantViolations: string[];
  perf: { initMs: number; files: number; nodes: number; edges: number };
  tokenShape: { summaryChars: number; summaryTokensApprox: number; reachabilityChars: number };
  /** True when every required item was found and nothing forbidden appeared. */
  pass: boolean;
}

function category(): CategoryScore {
  return { required: 0, found: 0, missing: [], forbiddenHits: [] };
}

function requireIds(score: CategoryScore, required: string[], present: Set<string>): void {
  for (const id of required) {
    score.required++;
    if (present.has(id)) score.found++;
    else score.missing.push(id);
  }
}

function forbidIds(score: CategoryScore, forbidden: string[], present: Set<string>): void {
  for (const id of forbidden) {
    if (present.has(id)) score.forbiddenHits.push(id);
  }
}

// ---- Universal confidence invariants (ADR 0029 §invariants; checked on EVERY subject) ----

export function checkInvariants(map: StaticContextMap, reachability: ReachabilityResult[]): string[] {
  const violations: string[] = [];
  const atMost = (level: Confidence, ceiling: Confidence): boolean => CONFIDENCE_RANK[level] <= CONFIDENCE_RANK[ceiling];

  for (const edge of map.callGraph.edges) {
    if (edge.callKind === "method" && !atMost(edge.confidence, "likely")) {
      violations.push(`edge ${edge.from}→${edge.to}: method dispatch graded ${edge.confidence} (> likely)`);
    }
    if ((edge.callKind === "dynamic" || edge.callKind === "framework") && !atMost(edge.confidence, "candidate")) {
      violations.push(`edge ${edge.from}→${edge.to}: ${edge.callKind} graded ${edge.confidence} (> candidate)`);
    }
    if (edge.callKind === "unresolved" && edge.confidence !== "unresolved") {
      violations.push(`edge ${edge.from}→${edge.to}: unresolved kind graded ${edge.confidence}`);
    }
  }
  for (const risk of map.findings.riskAreas) {
    if (!atMost(risk.confidence, "candidate")) violations.push(`risk area graded ${risk.confidence} (> candidate): ${risk.finding.slice(0, 60)}`);
    if (risk.uncertainty.length === 0) violations.push(`risk area without uncertainty: ${risk.finding.slice(0, 60)}`);
  }
  for (const dup of map.findings.duplicatePathCandidates) {
    if (!atMost(dup.confidence, "candidate")) violations.push(`duplicate graded ${dup.confidence} (> candidate): ${dup.id}`);
  }
  for (const legacy of map.findings.legacyPathCandidates) {
    if (legacy.reachability === "safe_removal_candidate") violations.push(`safe_removal_candidate emitted: ${legacy.id}`);
    if (legacy.reachability !== "still_reachable" && legacy.uncertainty.length === 0) {
      violations.push(`legacy ${legacy.id} (${legacy.reachability}) missing the no-dead-code caveat`);
    }
    if (legacy.reachability === "still_reachable" && legacy.uncertainty.length > 0) {
      violations.push(`legacy ${legacy.id} still_reachable but carries uncertainty (expected empty — ADR 0017)`);
    }
  }
  for (const ep of map.summary.entryPoints) {
    if (ep.kind !== "package_manifest" && !atMost(ep.confidence, "likely")) {
      violations.push(`entry point ${ep.path} (${ep.kind}) graded ${ep.confidence} (> likely)`);
    }
  }
  for (const r of reachability) {
    if (r.analysisBoundary !== "codebase_only") violations.push(`reachability result for '${r.subject}' missing the codebase_only envelope`);
    for (const p of r.reachablePaths) {
      if (p.confidence === "confirmed") violations.push(`reachability path ${p.id} graded confirmed`);
    }
  }
  if (map.meta.codebaseOnlyBoundary !== true) violations.push("meta.codebaseOnlyBoundary is not true");
  return violations;
}

// ---- Subject runner ----

export interface RunOptions {
  /**
   * Scope mode for the init. Fixtures use "none" (no .gitignore → deterministic, every
   * file in scope); external real repos default to "auto" so the measurement reflects
   * how the product actually maps them.
   */
  scopeMode?: "auto" | "gitignore" | "language" | "none";
}

/** Copy the subject to a temp dir (fixtures stay pristine), init, score, clean up. */
export async function runSubject(name: string, subjectDir: string, golden: Golden = {}, options: RunOptions = {}): Promise<SubjectResult> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `ccm-eval-${name.replace(/[^a-z0-9-]/gi, "_")}-`));
  try {
    await fs.cp(subjectDir, tmp, { recursive: true });
    await fs.rm(path.join(tmp, ".code-cartographer-mcp"), { recursive: true, force: true });

    const start = performance.now();
    const { map } = await initCodebase(tmp, { mode: options.scopeMode ?? "none" });
    const initMs = performance.now() - start;

    const scores: Record<string, CategoryScore> = {};

    // Symbols.
    const symbolScore = (scores.symbols = category());
    const nodeIds = new Set(map.callGraph.nodes.map((n) => n.id));
    requireIds(symbolScore, golden.symbols?.required ?? [], nodeIds);
    forbidIds(symbolScore, golden.symbols?.forbidden ?? [], nodeIds);

    // Exported flags.
    const exportedScore = (scores.exported = category());
    const exportedById = new Map(map.summary.ownershipSignals.map((s) => [`${s.path}#${s.symbol}`, s.exported]));
    for (const [id, expected] of Object.entries(golden.exported ?? {})) {
      exportedScore.required++;
      if (exportedById.get(id) === expected) exportedScore.found++;
      else exportedScore.missing.push(`${id} expected exported=${expected}, got ${exportedById.get(id)}`);
    }

    // Edges.
    const edgeScore = (scores.edges = category());
    for (const want of golden.edges?.required ?? []) {
      edgeScore.required++;
      const hit = map.callGraph.edges.find(
        (e) =>
          e.from === want.from &&
          e.to === want.to &&
          (want.callKind === undefined || e.callKind === want.callKind) &&
          (want.confidence === undefined || e.confidence === want.confidence)
      );
      if (hit) edgeScore.found++;
      else edgeScore.missing.push(`${want.from}→${want.to}${want.callKind ? ` (${want.callKind}/${want.confidence ?? "*"})` : ""}`);
    }
    for (const bad of golden.edges?.forbidden ?? []) {
      if (map.callGraph.edges.some((e) => e.from === bad.from && e.to === bad.to)) {
        edgeScore.forbiddenHits.push(`${bad.from}→${bad.to}`);
      }
    }

    // Entry points.
    const entryScore = (scores.entryPoints = category());
    for (const want of golden.entryPoints?.required ?? []) {
      entryScore.required++;
      if (map.summary.entryPoints.some((e) => e.path === want.path && e.kind === want.kind)) entryScore.found++;
      else entryScore.missing.push(`${want.path} (${want.kind})`);
    }

    // Duplicates.
    const dupScore = (scores.duplicates = category());
    const dupIds = new Set(map.findings.duplicatePathCandidates.map((d) => d.id));
    requireIds(dupScore, golden.duplicates?.requiredIds ?? [], dupIds);
    forbidIds(dupScore, golden.duplicates?.forbiddenIds ?? [], dupIds);

    // Legacy.
    const legacyScore = (scores.legacy = category());
    const legacyById = new Map(map.findings.legacyPathCandidates.map((l) => [l.id, l]));
    for (const want of golden.legacy?.required ?? []) {
      legacyScore.required++;
      const hit = legacyById.get(want.id);
      if (hit && (want.reachability === undefined || hit.reachability === want.reachability)) legacyScore.found++;
      else legacyScore.missing.push(`${want.id}${want.reachability ? ` (${want.reachability}, got ${hit?.reachability ?? "absent"})` : ""}`);
    }
    forbidIds(legacyScore, golden.legacy?.forbiddenIds ?? [], new Set(legacyById.keys()));

    // Risk areas (pattern-matched).
    const riskScore = (scores.riskAreas = category());
    const riskTexts = map.findings.riskAreas.map((r) => r.finding);
    for (const pattern of golden.riskAreas?.requiredPatterns ?? []) {
      riskScore.required++;
      if (riskTexts.some((t) => t.includes(pattern))) riskScore.found++;
      else riskScore.missing.push(pattern);
    }
    for (const pattern of golden.riskAreas?.forbiddenPatterns ?? []) {
      if (riskTexts.some((t) => t.includes(pattern))) riskScore.forbiddenHits.push(pattern);
    }

    // Non-analyzable files.
    const fileScore = (scores.files = category());
    for (const rel of golden.files?.nonAnalyzable ?? []) {
      fileScore.required++;
      const entry = map.files.find((f) => f.path === rel);
      if (entry && !entry.analyzable) fileScore.found++;
      else fileScore.missing.push(`${rel} expected analyzable=false, got ${entry ? entry.analyzable : "absent"}`);
    }

    // Reachability queries (static paths over resolved evidence — never runtime claims).
    const reachScore = (scores.reachability = category());
    const reachResults: ReachabilityResult[] = [];
    for (const query of golden.reachability ?? []) {
      const result = await analyzeReachability(tmp, query.target);
      reachResults.push(result);
      const reached = new Set(result.reachablePaths.map((p) => p.id));
      for (const id of query.mustReach ?? []) {
        reachScore.required++;
        if (reached.has(id)) reachScore.found++;
        else reachScore.missing.push(`${query.target} should reach ${id}`);
      }
      for (const id of query.mustNotReach ?? []) {
        if (reached.has(id)) reachScore.forbiddenHits.push(`${query.target} leaked to ${id}`);
      }
    }

    const invariantViolations = checkInvariants(map, reachResults);

    const summaryJson = formatContextSummary(map, "llm_readable");
    const reachJson = reachResults.length > 0 ? formatReachability(reachResults[0], "llm_readable") : "";
    const tokenShape = {
      summaryChars: summaryJson.length,
      summaryTokensApprox: Math.round(summaryJson.length / 4),
      reachabilityChars: reachJson.length
    };

    const pass =
      invariantViolations.length === 0 &&
      Object.values(scores).every((s) => s.found === s.required && s.forbiddenHits.length === 0);

    return {
      subject: name,
      scores,
      invariantViolations,
      perf: { initMs: Math.round(initMs), files: map.summary.totalFiles, nodes: map.callGraph.nodes.length, edges: map.callGraph.edges.length },
      tokenShape,
      pass
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function loadGolden(goldenPath: string): Promise<Golden> {
  return JSON.parse(await fs.readFile(goldenPath, "utf8")) as Golden;
}
