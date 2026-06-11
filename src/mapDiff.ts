// Diff / PR mode (CAP-26, Decision 0031). Compares two STATIC maps — a baseline and the
// current tree — and answers the agent review question: did this change add a second path,
// bypass a canonical surface, revive legacy, or weaken the static evidence? CODEBASE-ONLY:
// the delta is between static inferences; a "confidence regression" means the static
// evidence for an edge weakened, never that runtime behavior changed; a removed+added
// symbol pair is reported as exactly that (renames are never guessed). Every list is
// capped (`MAX_DELTA_LIST`) with true counts in `totals` — bounded output regardless of
// repo size is the point (the 357k-token full-summary measurement, ADR 0030).

import { promises as fs } from "node:fs";

import { BOUNDARY, INIT_UNCERTAINTY } from "./analysisContext.js";
import { buildContextMapFromResolution, readContextMap } from "./contextMap.js";
import { recordedScopeToResolution } from "./scope.js";
import {
  CONFIDENCE_RANK,
  type Confidence,
  type DuplicatePath,
  type Finding,
  type LegacyPath,
  type LegacyReachability,
  type Recommendation,
  type StaticContextMap,
  type UncertaintyItem
} from "./schema.js";

/** Cap for every delta list; `totals` always carries the uncapped counts. */
export const MAX_DELTA_LIST = 25;

const WEAK_EDGE_KINDS = new Set(["dynamic", "framework", "unresolved"]);

const BYPASSED_ABSTRACTION_RE = /bypassed abstraction/i;

export interface LegacyTransition {
  id: string;
  from: LegacyReachability;
  to: LegacyReachability;
  /** True when the transition lands on `still_reachable` — a statically revived legacy path. */
  revived: boolean;
}

export interface ConfidenceRegression {
  /** `from → to (callKind)` of the edge whose static evidence weakened. */
  edge: string;
  from: Confidence;
  to: Confidence;
}

export interface ConfidenceDelta {
  /** Edges present in BOTH maps whose confidence got weaker (static evidence degraded). */
  regressions: ConfidenceRegression[];
  /** Count of shared edges whose confidence got stronger. */
  improvements: number;
  weakEdgeRatioBaseline: number;
  weakEdgeRatioCurrent: number;
  uncertaintyItemsBaseline: number;
  uncertaintyItemsCurrent: number;
}

export interface MapDelta {
  files: { added: string[]; removed: string[]; changed: string[] };
  graph: { nodesAdded: string[]; nodesRemoved: string[]; edgesAdded: string[]; edgesRemoved: string[] };
  /** Duplicate candidates present only in the current map — "added a second path". */
  newDuplicates: DuplicatePath[];
  resolvedDuplicateIds: string[];
  newLegacy: LegacyPath[];
  legacyTransitions: LegacyTransition[];
  newRiskAreas: Finding[];
  resolvedRiskAreaCount: number;
  /** Canonical owners present in the baseline but gone from the current map. */
  canonicalRemovedIds: string[];
  confidence: ConfidenceDelta;
  /** TRUE counts before list capping (every list above is capped at `MAX_DELTA_LIST`). */
  totals: {
    filesAdded: number;
    filesRemoved: number;
    filesChanged: number;
    nodesAdded: number;
    nodesRemoved: number;
    edgesAdded: number;
    edgesRemoved: number;
    newDuplicates: number;
    newLegacy: number;
    legacyTransitions: number;
    /** Transitions landing on `still_reachable` — the verdict must see these past the cap. */
    revivedLegacy: number;
    newRiskAreas: number;
    /** New bypassed-abstraction risk areas — the verdict must see these past the cap. */
    bypassedAbstractions: number;
    confidenceRegressions: number;
  };
}

/** The agent review verdict — each flag is a STATIC structural signal, never a runtime claim. */
export interface DiffVerdict {
  addedParallelPath: boolean;
  bypassedAbstraction: boolean;
  revivedLegacy: boolean;
  increasedUncertainty: boolean;
}

export interface MapDiffResult {
  analysisBoundary: "codebase_only";
  baseline: { mapHash: string; generatedAt: string };
  current: { mapHash: string };
  delta: MapDelta;
  verdict: DiffVerdict;
  recommendation: Recommendation;
  uncertainty: UncertaintyItem[];
}

// ---- Pure comparator --------------------------------------------------------

function cap<T>(list: T[]): T[] {
  return list.slice(0, MAX_DELTA_LIST);
}

function edgeKey(e: { from: string; to: string; callKind: string }): string {
  return `${e.from}|${e.to}|${e.callKind}`;
}

function edgeLabel(e: { from: string; to: string; callKind: string }): string {
  return `${e.from} → ${e.to} (${e.callKind})`;
}

function weakRatio(map: StaticContextMap): number {
  const edges = map.callGraph.edges;
  if (edges.length === 0) return 0;
  const weak = edges.filter((e) => WEAK_EDGE_KINDS.has(e.callKind)).length;
  return Math.round((weak / edges.length) * 1000) / 1000;
}

/** Compare two static maps into a capped, totaled delta. Pure — no I/O, deterministic. */
export function compareMaps(baseline: StaticContextMap, current: StaticContextMap): MapDelta {
  // Files (identity = path; change = sha256).
  const baseFiles = new Map(baseline.files.map((f) => [f.path, f.sha256]));
  const curFiles = new Map(current.files.map((f) => [f.path, f.sha256]));
  const filesAdded = [...curFiles.keys()].filter((p) => !baseFiles.has(p)).sort();
  const filesRemoved = [...baseFiles.keys()].filter((p) => !curFiles.has(p)).sort();
  const filesChanged = [...curFiles.entries()]
    .filter(([p, sha]) => baseFiles.has(p) && baseFiles.get(p) !== sha)
    .map(([p]) => p)
    .sort();

  // Graph nodes/edges.
  const baseNodes = new Set(baseline.callGraph.nodes.map((n) => n.id));
  const curNodes = new Set(current.callGraph.nodes.map((n) => n.id));
  const nodesAdded = [...curNodes].filter((id) => !baseNodes.has(id)).sort();
  const nodesRemoved = [...baseNodes].filter((id) => !curNodes.has(id)).sort();
  const baseEdges = new Map(baseline.callGraph.edges.map((e) => [edgeKey(e), e]));
  const curEdges = new Map(current.callGraph.edges.map((e) => [edgeKey(e), e]));
  const edgesAdded = [...curEdges.values()].filter((e) => !baseEdges.has(edgeKey(e))).map(edgeLabel).sort();
  const edgesRemoved = [...baseEdges.values()].filter((e) => !curEdges.has(edgeKey(e))).map(edgeLabel).sort();

  // Duplicates.
  const baseDup = new Set(baseline.findings.duplicatePathCandidates.map((d) => d.id));
  const curDupList = current.findings.duplicatePathCandidates;
  const newDuplicates = curDupList.filter((d) => !baseDup.has(d.id));
  const curDup = new Set(curDupList.map((d) => d.id));
  const resolvedDuplicateIds = [...baseDup].filter((id) => !curDup.has(id)).sort();

  // Legacy: new candidates + reachability transitions.
  const baseLegacy = new Map(baseline.findings.legacyPathCandidates.map((l) => [l.id, l]));
  const newLegacy = current.findings.legacyPathCandidates.filter((l) => !baseLegacy.has(l.id));
  const legacyTransitions: LegacyTransition[] = [];
  for (const cur of current.findings.legacyPathCandidates) {
    const prev = baseLegacy.get(cur.id);
    if (prev && prev.reachability !== cur.reachability) {
      legacyTransitions.push({
        id: cur.id,
        from: prev.reachability,
        to: cur.reachability,
        revived: cur.reachability === "still_reachable"
      });
    }
  }

  // Risk areas (identity = the finding text — generated deterministically by the product).
  const baseRisk = new Set(baseline.findings.riskAreas.map((r) => r.finding));
  const curRiskList = current.findings.riskAreas;
  const newRiskAreas = curRiskList.filter((r) => !baseRisk.has(r.finding));
  const curRisk = new Set(curRiskList.map((r) => r.finding));
  const resolvedRiskAreaCount = [...baseRisk].filter((f) => !curRisk.has(f)).length;

  // Canonical owners that disappeared.
  const curCanonical = new Set(current.findings.canonicalPaths.map((c) => c.id));
  const canonicalRemovedIds = baseline.findings.canonicalPaths
    .map((c) => c.id)
    .filter((id) => !curCanonical.has(id))
    .sort();

  // Confidence over shared edges.
  const regressions: ConfidenceRegression[] = [];
  let improvements = 0;
  for (const [key, cur] of curEdges) {
    const prev = baseEdges.get(key);
    if (!prev) continue;
    if (CONFIDENCE_RANK[cur.confidence] < CONFIDENCE_RANK[prev.confidence]) {
      regressions.push({ edge: edgeLabel(cur), from: prev.confidence, to: cur.confidence });
    } else if (CONFIDENCE_RANK[cur.confidence] > CONFIDENCE_RANK[prev.confidence]) {
      improvements++;
    }
  }
  regressions.sort((a, b) => (a.edge < b.edge ? -1 : 1));

  return {
    files: { added: cap(filesAdded), removed: cap(filesRemoved), changed: cap(filesChanged) },
    graph: { nodesAdded: cap(nodesAdded), nodesRemoved: cap(nodesRemoved), edgesAdded: cap(edgesAdded), edgesRemoved: cap(edgesRemoved) },
    newDuplicates: cap(newDuplicates),
    resolvedDuplicateIds: cap(resolvedDuplicateIds),
    newLegacy: cap(newLegacy),
    legacyTransitions: cap(legacyTransitions),
    newRiskAreas: cap(newRiskAreas),
    resolvedRiskAreaCount,
    canonicalRemovedIds: cap(canonicalRemovedIds),
    confidence: {
      regressions: cap(regressions),
      improvements,
      weakEdgeRatioBaseline: weakRatio(baseline),
      weakEdgeRatioCurrent: weakRatio(current),
      uncertaintyItemsBaseline: baseline.findings.uncertainty.length,
      uncertaintyItemsCurrent: current.findings.uncertainty.length
    },
    totals: {
      filesAdded: filesAdded.length,
      filesRemoved: filesRemoved.length,
      filesChanged: filesChanged.length,
      nodesAdded: nodesAdded.length,
      nodesRemoved: nodesRemoved.length,
      edgesAdded: edgesAdded.length,
      edgesRemoved: edgesRemoved.length,
      newDuplicates: newDuplicates.length,
      newLegacy: newLegacy.length,
      legacyTransitions: legacyTransitions.length,
      revivedLegacy: legacyTransitions.filter((t) => t.revived).length,
      newRiskAreas: newRiskAreas.length,
      bypassedAbstractions: newRiskAreas.filter((r) => BYPASSED_ABSTRACTION_RE.test(r.finding)).length,
      confidenceRegressions: regressions.length
    }
  };
}

/** Derive the agent verdict + recommendation from a delta. Pure. */
export function gradeDelta(delta: MapDelta): { verdict: DiffVerdict; recommendation: Recommendation } {
  const verdict: DiffVerdict = {
    addedParallelPath: delta.totals.newDuplicates > 0,
    // Flags read `totals` (uncapped), never the display-capped lists — a signal past the
    // cap must still flip the verdict.
    bypassedAbstraction: delta.totals.bypassedAbstractions > 0,
    revivedLegacy: delta.totals.revivedLegacy > 0,
    increasedUncertainty:
      delta.totals.confidenceRegressions > 0 ||
      delta.confidence.weakEdgeRatioCurrent > delta.confidence.weakEdgeRatioBaseline ||
      delta.confidence.uncertaintyItemsCurrent > delta.confidence.uncertaintyItemsBaseline
  };
  let recommendation: Recommendation;
  if (verdict.addedParallelPath) {
    recommendation = { action: "consolidate", target: delta.newDuplicates[0]?.id ?? "new duplicate path", rationale: "The change introduces a parallel path for an existing behavior; consolidate behind one owner." };
  } else if (verdict.revivedLegacy) {
    recommendation = { action: "avoid", target: delta.legacyTransitions.find((t) => t.revived)?.id ?? "revived legacy", rationale: "The change adds a static reference to a legacy path; avoid reviving it without confirmation." };
  } else if (verdict.bypassedAbstraction) {
    recommendation = { action: "investigate", target: delta.newRiskAreas.find((r) => BYPASSED_ABSTRACTION_RE.test(r.finding))?.finding.slice(0, 80) ?? "bypassed abstraction", rationale: "The static structure suggests an internal symbol may be used past a public surface; route through the exported API or promote it intentionally." };
  } else if (verdict.increasedUncertainty) {
    recommendation = { action: "investigate", target: delta.confidence.regressions[0]?.edge ?? "weakened static evidence", rationale: "The static evidence got weaker (more dynamic/unresolved structure); confirm the affected paths." };
  } else {
    recommendation = { action: "reuse", target: "current change", rationale: "No structural regressions in the static delta — no new parallel paths, revived legacy, bypasses, or weakened evidence." };
  }
  return { verdict, recommendation };
}

// ---- The capability ---------------------------------------------------------

const DIFF_UNCERTAINTY: UncertaintyItem[] = [
  {
    item: "The delta compares static inferences, not behavior",
    reason: "Identical structure does not prove behavioral equivalence, and a removed+added symbol pair may be a rename (never guessed, ADR 0001/0002).",
    requiredConfirmation: "Tests / human review of the actual diff."
  },
  {
    item: "Runtime impact of the change is not assessed",
    reason: "All sections are derived from parsed structure; dynamic dispatch, DI, reflection, and config remain invisible.",
    requiredConfirmation: "Test execution (out of scope)."
  }
];

function emptyDelta(): MapDelta {
  return {
    files: { added: [], removed: [], changed: [] },
    graph: { nodesAdded: [], nodesRemoved: [], edgesAdded: [], edgesRemoved: [] },
    newDuplicates: [],
    resolvedDuplicateIds: [],
    newLegacy: [],
    legacyTransitions: [],
    newRiskAreas: [],
    resolvedRiskAreaCount: 0,
    canonicalRemovedIds: [],
    confidence: { regressions: [], improvements: 0, weakEdgeRatioBaseline: 0, weakEdgeRatioCurrent: 0, uncertaintyItemsBaseline: 0, uncertaintyItemsCurrent: 0 },
    totals: { filesAdded: 0, filesRemoved: 0, filesChanged: 0, nodesAdded: 0, nodesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, newDuplicates: 0, newLegacy: 0, legacyTransitions: 0, revivedLegacy: 0, newRiskAreas: 0, bypassedAbstractions: 0, confidenceRegressions: 0 }
  };
}

function uninitializedResult(items: UncertaintyItem[]): MapDiffResult {
  return {
    analysisBoundary: BOUNDARY,
    baseline: { mapHash: "", generatedAt: "" },
    current: { mapHash: "" },
    delta: emptyDelta(),
    verdict: { addedParallelPath: false, bypassedAbstraction: false, revivedLegacy: false, increasedUncertainty: false },
    recommendation: { action: "investigate", target: "baseline map", rationale: "A baseline context map is required before a diff can be computed." },
    uncertainty: items
  };
}

export interface AnalyzeDiffOptions {
  /**
   * Compare an EXPLICIT baseline snapshot file against the repository's persisted map
   * (CI: map@main vs map@head). Default (omitted): the persisted map is the baseline and
   * the current tree is rebuilt IN MEMORY under the baseline's recorded scope — nothing
   * is persisted, so the baseline survives (re-baselining stays an explicit init_codebase).
   */
  baselineMapPath?: string;
}

/** CAP-26 — diff/PR mode: the static delta between a baseline map and the current tree. */
export async function analyzeDiff(repositoryRoot: string, options: AnalyzeDiffOptions = {}): Promise<MapDiffResult> {
  let baseline: StaticContextMap | null;
  let current: StaticContextMap | null;

  if (options.baselineMapPath) {
    try {
      baseline = JSON.parse(await fs.readFile(options.baselineMapPath, "utf8")) as StaticContextMap;
    } catch {
      return uninitializedResult([
        { item: "Baseline map not readable", reason: `Could not read/parse '${options.baselineMapPath}'.`, requiredConfirmation: "Point baselineMapPath at a persisted context-map.json." }
      ]);
    }
    current = await readContextMap(repositoryRoot);
    if (!current) return uninitializedResult([INIT_UNCERTAINTY]);
  } else {
    baseline = await readContextMap(repositoryRoot);
    if (!baseline) return uninitializedResult([INIT_UNCERTAINTY]);
    // Rebuild the current tree under the BASELINE's recorded scope (never persisted):
    // the delta must reflect the change, not a scope difference (Decision 0031).
    current = await buildContextMapFromResolution(repositoryRoot, recordedScopeToResolution(baseline.summary.excluded));
  }

  const delta = compareMaps(baseline, current);
  const { verdict, recommendation } = gradeDelta(delta);
  return {
    analysisBoundary: BOUNDARY,
    baseline: { mapHash: baseline.meta.mapHash, generatedAt: baseline.meta.generatedAt },
    current: { mapHash: current.meta.mapHash },
    delta,
    verdict,
    recommendation,
    uncertainty: DIFF_UNCERTAINTY
  };
}
