// Analytical capabilities of the product (CAS CAP-07..CAP-16). All operations
// require an initialized context map (CAS context-governance: init before deep
// claims) and stay codebase-only — reachability and change-impact are returned as
// evidence-graded hypotheses with explicit uncertainty, never runtime-proven.
//
// Traversal runs over a single `GraphSource` substrate (Decision 0024): the
// SQLite-backed `GraphIndex` when worthwhile, else the in-memory fallback from the
// JSON map. This module never hand-rolls adjacency.

import {
  clampConfidence,
  readContextMap,
  type CanonicalPath,
  type ChangeImpactArea,
  type Confidence,
  type DuplicatePath,
  type Finding,
  type ImpactLevel,
  type LegacyPath,
  type Recommendation,
  type StaticContextMap,
  type UncertaintyItem
} from "./contextMap.js";
import type { CallGraphNode } from "./callGraph.js";
import { loadGraphContext } from "./graphIndex.js";
import { resolveNodeIds, type GraphSource, type NeighborSource } from "./pathfinding.js";

/**
 * Structural (codebase-only) reachability grade — never a runtime proof.
 * Distinct from the six-class `LegacyReachability` taxonomy in contextMap.ts:
 * CAP-07 reachability emits THIS grade; CAP-09 legacy classification uses the
 * six classes. Keep the two vocabularies separate when implementing.
 */
export type Reachability = "reachable" | "possibly_reachable" | "apparently_unreachable" | "unresolved";

export interface ReachablePath {
  id: string;
  label: string;
  reachability: Reachability;
  confidence: Confidence;
  evidence: string[];
}

export interface ReachabilityResult {
  analysisBoundary: "codebase_only";
  subject: string;
  status: Confidence;
  summary: string;
  reachablePaths: ReachablePath[];
  uncertainty: UncertaintyItem[];
}

export interface DuplicateBehaviorResult {
  analysisBoundary: "codebase_only";
  subject: string;
  duplicatePaths: DuplicatePath[];
  recommendation?: Recommendation;
  uncertainty: UncertaintyItem[];
}

export interface LegacyClassificationResult {
  analysisBoundary: "codebase_only";
  legacyPaths: LegacyPath[];
  uncertainty: UncertaintyItem[];
}

export interface ChangeImpactResult {
  analysisBoundary: "codebase_only";
  target: string;
  changeImpact: ChangeImpactArea[];
  recommendation?: Recommendation;
  uncertainty: UncertaintyItem[];
}

export interface PreflightReviewResult {
  analysisBoundary: "codebase_only";
  subject: string;
  status: Confidence;
  summary: string;
  canonicalPaths: CanonicalPath[];
  duplicatePaths: DuplicatePath[];
  legacyPaths: LegacyPath[];
  changeImpact: ChangeImpactArea[];
  recommendation: Recommendation;
  uncertainty: UncertaintyItem[];
}

export type ChangeAlignment = "aligned" | "mixed" | "riskier";

export interface ChangeReviewResult {
  analysisBoundary: "codebase_only";
  subject: string;
  alignment: ChangeAlignment;
  findings: Finding[];
  uncertainty: UncertaintyItem[];
}

export interface OwnershipResult {
  analysisBoundary: "codebase_only";
  subject: string;
  canonicalPaths: CanonicalPath[];
  uncertainty: UncertaintyItem[];
}

export interface FailureInvestigationResult {
  analysisBoundary: "codebase_only";
  subject: string;
  hypotheses: Finding[];
  requiredRuntimeConfirmation: string[];
  uncertainty: UncertaintyItem[];
}

export interface TestPathResult {
  analysisBoundary: "codebase_only";
  target: string;
  reachingTests: ReachablePath[];
  uncertainty: UncertaintyItem[];
}

export interface ArchitectureDriftResult {
  analysisBoundary: "codebase_only";
  driftFindings: Finding[];
  uncertainty: UncertaintyItem[];
}

// ---- Shared analysis substrate (Decision 0016/0019/0024) ----

const BOUNDARY = "codebase_only" as const;
const MAX_DEPTH = 12;

interface AnalysisContext {
  map: StaticContextMap;
  /** The single traversal substrate (Decision 0024): indexed or in-memory. */
  source: GraphSource;
  categoryByPath: Map<string, string>;
}

/** Load the persisted map + a traversal source once. Returns null when not initialized. */
async function loadAnalysisContext(repositoryRoot: string): Promise<AnalysisContext | null> {
  const gc = await loadGraphContext(repositoryRoot);
  if (!gc) return null;
  const categoryByPath = new Map(gc.map.files.map((f) => [f.path, f.category]));
  return { map: gc.map, source: gc.source, categoryByPath };
}

/**
 * Run `fn` with a loaded context, guaranteeing the source is closed afterward (Decision 0024 —
 * open/close per call). Returns `whenUninitialized` if the map is not initialized.
 */
async function withContext<T>(repositoryRoot: string, whenUninitialized: T, fn: (ctx: AnalysisContext) => T | Promise<T>): Promise<T> {
  const ctx = await loadAnalysisContext(repositoryRoot);
  if (!ctx) return whenUninitialized;
  try {
    return await fn(ctx);
  } finally {
    ctx.source.close();
  }
}

const INIT_UNCERTAINTY: UncertaintyItem = {
  item: "Context map is not initialized",
  reason: "No baseline map at .code-cartographer-mcp/context-map.json (init before deep claims, Decision 0004).",
  requiredConfirmation: "Run init_codebase, then re-run this analysis."
};

const RUNTIME_UNCERTAINTY: UncertaintyItem = {
  item: "Reachability and change-impact are not runtime-proven",
  reason: "All conclusions are static inferences (ADR 0001/0002); dynamic dispatch, DI, reflection, and config are invisible.",
  requiredConfirmation: "Runtime trace / test execution (out of scope)."
};

/** Resolve a free-text subject to matching call-graph node ids (shared with the path-query tools). */
function resolveTargets(source: GraphSource, query: string): string[] {
  return resolveNodeIds(source, query);
}

function nodeLabel(source: GraphSource, id: string): string {
  const node = source.getNode(id);
  return node ? `${node.symbol} (${node.path})` : id;
}

/** Traverse callees (`forward`) or callers from `starts`, recording the weakest edge confidence + kinds. */
function traverse(source: NeighborSource, starts: string[], forward: boolean): Map<string, { conf: Confidence; kinds: Set<string> }> {
  const reached = new Map<string, { conf: Confidence; kinds: Set<string> }>();
  const visited = new Set(starts);
  // Seed at `likely` (not `confirmed`): a static PATH is never runtime-proven, so the ceiling
  // is enforced here, not only by callers (ADR 0016).
  let frontier = starts.map((id) => ({ id, depth: 0, conf: "likely" as Confidence, kinds: new Set<string>() }));
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const cur of frontier) {
      if (cur.depth >= MAX_DEPTH) continue;
      for (const edge of forward ? source.callees(cur.id) : source.callers(cur.id)) {
        const other = forward ? edge.to : edge.from;
        const conf = clampConfidence(cur.conf, edge.confidence);
        const kinds = new Set(cur.kinds).add(edge.callKind);
        const existing = reached.get(other);
        if (existing) {
          // Most-uncertain wins: never drop a weaker (dynamic/framework/unresolved) path to a node.
          existing.conf = clampConfidence(existing.conf, conf);
          for (const k of kinds) existing.kinds.add(k);
        } else {
          reached.set(other, { conf, kinds });
        }
        if (!visited.has(other)) {
          visited.add(other);
          next.push({ id: other, depth: cur.depth + 1, conf, kinds });
        }
      }
    }
    frontier = next;
  }
  return reached;
}

function reachGrade(kinds: Set<string>, conf: Confidence): { reachability: Reachability; confidence: Confidence } {
  if (kinds.has("unresolved")) return { reachability: "unresolved", confidence: "unresolved" };
  if (kinds.has("dynamic") || kinds.has("framework")) return { reachability: "possibly_reachable", confidence: "candidate" };
  return { reachability: "reachable", confidence: clampConfidence(conf, "likely") }; // never confirmed for a path (ADR 0016)
}

function strongest(levels: Confidence[]): Confidence {
  const rank: Record<Confidence, number> = { confirmed: 5, likely: 4, candidate: 3, unclear: 2, unresolved: 1 };
  return levels.reduce<Confidence>((best, l) => (rank[l] > rank[best] ? l : best), "unresolved");
}

/** Area (module/dir) a node path belongs to. */
function areaOf(ctx: AnalysisContext, path: string): string {
  const mod = ctx.map.summary.modules.find((m) => m.files.includes(path));
  return mod ? mod.root : path.slice(0, path.lastIndexOf("/")) || ".";
}

// ---- Capabilities (CAP-07..16) ----

/** CAP-07 — structural reachability context (hypotheses + uncertainty; never runtime-proven). */
export async function analyzeReachability(repositoryRoot: string, target: string): Promise<ReachabilityResult> {
  return withContext(
    repositoryRoot,
    { analysisBoundary: BOUNDARY, subject: target, status: "unresolved", summary: "Not initialized.", reachablePaths: [], uncertainty: [INIT_UNCERTAINTY] },
    (ctx) => {
      const targets = resolveTargets(ctx.source, target);
      if (targets.length === 0) {
        return { analysisBoundary: BOUNDARY, subject: target, status: "unresolved", summary: `No declaration matching '${target}' in the map.`, reachablePaths: [], uncertainty: [{ item: "Subject not found in map", reason: "No node matched the query.", requiredConfirmation: "Check the symbol/path, or re-init if the map is stale." }] };
      }
      const reached = traverse(ctx.source, targets, true);
      const reachablePaths: ReachablePath[] = [...reached.entries()].map(([id, { conf, kinds }]) => {
        const grade = reachGrade(kinds, conf);
        return { id, label: nodeLabel(ctx.source, id), reachability: grade.reachability, confidence: grade.confidence, evidence: [`reached from ${target} via ${[...kinds].join("/")} edge(s)`] };
      });
      const status = reachablePaths.length > 0 ? strongest(reachablePaths.map((p) => p.confidence)) : "candidate";
      return {
        analysisBoundary: BOUNDARY,
        subject: target,
        status,
        summary: `${reachablePaths.length} node(s) have static paths from '${target}' (see per-entry confidence/reachability — not runtime-proven).`,
        reachablePaths,
        uncertainty: [RUNTIME_UNCERTAINTY]
      };
    }
  );
}

/** CAP-08 — duplicate-behavior detection (reads persisted candidates relevant to the subject). */
export async function findDuplicateBehavior(repositoryRoot: string, subject: string): Promise<DuplicateBehaviorResult> {
  return withContext(repositoryRoot, { analysisBoundary: BOUNDARY, subject, duplicatePaths: [], recommendation: undefined, uncertainty: [INIT_UNCERTAINTY] }, (ctx) => {
    const q = subject.toLowerCase();
    const duplicatePaths: DuplicatePath[] = ctx.map.findings.duplicatePathCandidates.filter(
      (d) => d.label.toLowerCase().includes(q) || d.evidence.some((e) => e.toLowerCase().includes(q))
    );
    const recommendation: Recommendation | undefined =
      duplicatePaths.length > 0 ? { action: "consolidate", target: subject, rationale: "Multiple candidate paths share this behavior; consolidate behind one owner." } : undefined;
    return {
      analysisBoundary: BOUNDARY,
      subject,
      duplicatePaths,
      recommendation,
      uncertainty: [
        { item: "Static name/shape similarity is not behavioral equivalence", reason: "Same-named symbols may behave differently.", requiredConfirmation: "Human/behavioral comparison or test execution." }
      ]
    };
  });
}

/** CAP-09 — legacy-path classification (reads the six-class candidates computed at build time). */
export async function classifyLegacyPaths(repositoryRoot: string): Promise<LegacyClassificationResult> {
  return withContext(repositoryRoot, { analysisBoundary: BOUNDARY, legacyPaths: [], uncertainty: [INIT_UNCERTAINTY] }, (ctx) => {
    return {
      analysisBoundary: BOUNDARY,
      legacyPaths: ctx.map.findings.legacyPathCandidates,
      uncertainty: [
        { item: "Legacy classification is static", reason: "True deadness depends on reflection/DI/config-driven invocation invisible to static analysis.", requiredConfirmation: "Human confirmation before removal." }
      ]
    };
  });
}

/** CAP-10 — change-impact (reverse-reach dependents; runtime blast-radius stays unresolved). */
export async function analyzeChangeImpact(repositoryRoot: string, target: string): Promise<ChangeImpactResult> {
  return withContext(repositoryRoot, { analysisBoundary: BOUNDARY, target, changeImpact: [], recommendation: undefined, uncertainty: [INIT_UNCERTAINTY] }, (ctx) => {
    const targets = resolveTargets(ctx.source, target);
    const reached = traverse(ctx.source, targets, false);
    const byArea = new Map<string, { count: number; crossModule: boolean; kinds: Set<string> }>();
    const targetAreas = new Set(targets.map((id) => areaOf(ctx, ctx.source.getNode(id)?.path ?? "")));
    for (const [id, { kinds }] of reached) {
      const path = ctx.source.getNode(id)?.path ?? id;
      const area = areaOf(ctx, path);
      const entry = byArea.get(area) ?? { count: 0, crossModule: false, kinds: new Set<string>() };
      entry.count++;
      if (!targetAreas.has(area)) entry.crossModule = true;
      for (const k of kinds) entry.kinds.add(k);
      byArea.set(area, entry);
    }
    const changeImpact: ChangeImpactArea[] = [...byArea.entries()].map(([area, info]) => {
      const level: ImpactLevel = info.count >= 5 || (info.crossModule && info.count >= 2) ? "high" : info.crossModule || info.count >= 2 ? "medium" : "low";
      return { area, impactLevel: level, reason: `${info.count} static dependent(s)${info.crossModule ? ", crosses a module boundary" : ""} (${[...info.kinds].join("/")}).` };
    });
    const recommendation: Recommendation | undefined =
      changeImpact.some((a) => a.impactLevel === "high") ? { action: "investigate", target, rationale: "Shared/high-fan-in behavior; analyze dependents before editing." } : undefined;
    return {
      analysisBoundary: BOUNDARY,
      target,
      changeImpact: changeImpact.sort((a, b) => (a.area < b.area ? -1 : 1)),
      recommendation,
      uncertainty: [{ item: "Runtime blast radius", reason: "Static dependents are not the runtime-affected set (dynamic dispatch, DI, config).", requiredConfirmation: "Tests + runtime validation (out of scope)." }]
    };
  });
}

/** CAP-11 — agent preflight review: compose ownership + duplicates + legacy + impact. */
export async function reviewPreflight(repositoryRoot: string, requestedChange: string): Promise<PreflightReviewResult> {
  // Preflight only composes the sub-capabilities (each loads + closes its own source), so it needs
  // a cheap init-check — not its own traversal substrate (Decision 0024; avoids holding a handle open).
  const map = await readContextMap(repositoryRoot);
  if (!map) {
    return { analysisBoundary: BOUNDARY, subject: requestedChange, status: "unresolved", summary: "Not initialized.", canonicalPaths: [], duplicatePaths: [], legacyPaths: [], changeImpact: [], recommendation: { action: "investigate", target: requestedChange, rationale: "Initialize the codebase map first." }, uncertainty: [INIT_UNCERTAINTY] };
  }
  const ownership = await getOwnership(repositoryRoot, requestedChange);
  const duplicates = await findDuplicateBehavior(repositoryRoot, requestedChange);
  const legacy = await classifyLegacyPaths(repositoryRoot);
  const canonicalTarget = ownership.canonicalPaths[0]?.id ?? requestedChange;
  const impact = await analyzeChangeImpact(repositoryRoot, canonicalTarget);
  const relevantLegacy = legacy.legacyPaths.filter((l) => l.label.toLowerCase().includes(requestedChange.toLowerCase()));

  const action: Recommendation["action"] =
    ownership.canonicalPaths.length > 0 ? "reuse" : duplicates.duplicatePaths.length > 0 ? "consolidate" : relevantLegacy.length > 0 ? "avoid" : "investigate";
  const recommendation: Recommendation = { action, target: canonicalTarget, rationale: action === "reuse" ? "A canonical owner exists; extend it rather than adding a parallel path." : action === "consolidate" ? "Duplicate paths exist; consolidate before adding more." : action === "avoid" ? "Legacy code is involved; avoid reviving it." : "No clear canonical owner found; investigate before implementing." };

  const parts = [ownership.uncertainty, duplicates.uncertainty, legacy.uncertainty, impact.uncertainty].flat();
  const seen = new Set<string>();
  const uncertainty = parts.filter((u) => (seen.has(u.item) ? false : (seen.add(u.item), true)));

  return {
    analysisBoundary: BOUNDARY,
    subject: requestedChange,
    status: strongest([ownership.canonicalPaths[0]?.confidence ?? "candidate", impact.changeImpact[0] ? "candidate" : "unclear"]),
    summary: `Preflight for '${requestedChange}': ${ownership.canonicalPaths.length} canonical owner(s), ${duplicates.duplicatePaths.length} duplicate risk(s), ${relevantLegacy.length} legacy risk(s).`,
    canonicalPaths: ownership.canonicalPaths,
    duplicatePaths: duplicates.duplicatePaths,
    legacyPaths: relevantLegacy,
    changeImpact: impact.changeImpact,
    recommendation,
    uncertainty
  };
}

/** CAP-12 — review of an agent-generated change against canonical paths + risk signals. */
export async function reviewChange(repositoryRoot: string, changeDescription: string): Promise<ChangeReviewResult> {
  return withContext(repositoryRoot, { analysisBoundary: BOUNDARY, subject: changeDescription, alignment: "mixed", findings: [], uncertainty: [INIT_UNCERTAINTY] }, (ctx) => {
    const text = changeDescription.toLowerCase();
    const touchesCanonical = ctx.map.findings.canonicalPaths.some((c) => text.includes(c.label.toLowerCase().split(" ")[0]));
    const addsParallel = /\b(new|parallel|copy|duplicate|alternative|rewrite|reimplement)\b/.test(text);
    const revivesLegacy = ctx.map.findings.legacyPathCandidates.some((l) => text.includes(l.label.toLowerCase().split(" ")[0]));
    const alignment: ChangeAlignment = addsParallel || revivesLegacy ? "riskier" : touchesCanonical ? "aligned" : "mixed";
    const findings: Finding[] = [];
    if (addsParallel) findings.push({ finding: "Change appears to add a parallel/duplicate path.", confidence: "candidate", evidence: ["description mentions new/parallel/copy"], risk: "Parallel paths for one behavior drift and confuse callers.", recommendation: "Reuse the canonical path instead.", uncertainty: [{ item: "Review is over the description, not the live diff", reason: "The actual edit is not in the map.", requiredConfirmation: "Inspect the real diff." }] });
    if (revivesLegacy) findings.push({ finding: "Change appears to depend on a legacy path.", confidence: "candidate", evidence: ["description references a legacy-classified symbol"], risk: "Reviving legacy code reintroduces retired behavior.", recommendation: "Confirm the legacy path is intended before depending on it.", uncertainty: [{ item: "Legacy classification is static", reason: "Reachability is not runtime-proven.", requiredConfirmation: "Human confirmation." }] });
    if (findings.length === 0) findings.push({ finding: "No structural risk signals detected in the description.", confidence: "unclear", evidence: ["no parallel/legacy keywords; canonical reference " + (touchesCanonical ? "found" : "not found")], risk: "Description-level review only.", recommendation: "Verify against the real diff and tests.", uncertainty: [{ item: "Review is over the description, not the live diff", reason: "The actual edit is not in the map.", requiredConfirmation: "Inspect the real diff." }] });
    return { analysisBoundary: BOUNDARY, subject: changeDescription, alignment, findings, uncertainty: [RUNTIME_UNCERTAINTY] };
  });
}

/** CAP-13 — canonical-path / ownership guidance (pure map-resident; the one capability not on edges). */
export async function getOwnership(repositoryRoot: string, symbolOrPath: string): Promise<OwnershipResult> {
  return withContext(repositoryRoot, { analysisBoundary: BOUNDARY, subject: symbolOrPath, canonicalPaths: [], uncertainty: [INIT_UNCERTAINTY] }, (ctx) => {
    const q = symbolOrPath.toLowerCase();
    // Prefer persisted canonical paths matching the subject.
    const persisted = ctx.map.findings.canonicalPaths.filter((c) => c.label.toLowerCase().includes(q));
    const canonicalPaths: CanonicalPath[] = [...persisted];
    if (canonicalPaths.length === 0) {
      const owners = ctx.map.summary.ownershipSignals.filter((s) => s.exported && (s.symbol.toLowerCase() === q || s.symbol.toLowerCase().includes(q) || s.path.toLowerCase().includes(q)));
      for (const owner of owners.slice(0, 5)) {
        canonicalPaths.push({
          id: `${owner.path}#${owner.symbol}`,
          label: `${owner.symbol} (${owner.path})`,
          confidence: clampConfidence(owner.confidence, "likely"), // ownership judgment caps at likely (Decision 0016)
          evidence: [`exported ${owner.kind} — ${owner.reason}`],
          risks: owners.length > 1 ? [`${owners.length} exported candidates share this name/query`] : []
        });
      }
    }
    return {
      analysisBoundary: BOUNDARY,
      subject: symbolOrPath,
      canonicalPaths,
      uncertainty: canonicalPaths.length === 0 ? [{ item: "No owner found", reason: "No exported declaration matched the query.", requiredConfirmation: "Check the symbol or re-init." }] : [{ item: "Dynamic/DI ownership not resolved", reason: "Runtime-registered handlers are invisible to static analysis.", requiredConfirmation: "Runtime/human confirmation." }]
    };
  });
}

/** CAP-14 — failure-investigation hypotheses (not a debugger; runtime confirmation always required). */
export async function investigateFailure(repositoryRoot: string, failureReference: string): Promise<FailureInvestigationResult> {
  return withContext(
    repositoryRoot,
    { analysisBoundary: BOUNDARY, subject: failureReference, hypotheses: [], requiredRuntimeConfirmation: ["Initialize the map, then investigate."], uncertainty: [INIT_UNCERTAINTY] },
    (ctx) => {
      const tokens = failureReference.match(/[A-Za-z_][\w.]*/g) ?? [];
      const matched = new Map<string, CallGraphNode>();
      for (const token of tokens) {
        for (const id of resolveTargets(ctx.source, token)) {
          const node = ctx.source.getNode(id);
          if (node) matched.set(id, node);
        }
      }
      const hypotheses: Finding[] = [...matched.values()].slice(0, 8).map((node) => {
        const callers = ctx.source.callers(node.id).map((e) => e.from);
        const callees = ctx.source.callees(node.id).map((e) => e.to);
        return {
          finding: `${node.symbol} (${node.path}) appears in the failure reference.`,
          confidence: "candidate",
          evidence: [`${callers.length} static caller(s), ${callees.length} static callee(s)`, ...callers.slice(0, 3).map((c) => `caller: ${c}`)],
          risk: "A static neighborhood is a hypothesis, not the proven cause.",
          recommendation: "Inspect this symbol's callers/callees while reproducing the failure.",
          uncertainty: [RUNTIME_UNCERTAINTY]
        };
      });
      return {
        analysisBoundary: BOUNDARY,
        subject: failureReference,
        hypotheses,
        requiredRuntimeConfirmation: [
          "Reproduce the failure and capture the actual runtime stack.",
          "Confirm which dynamic/DI/framework edge was taken.",
          "Inspect runtime values/state not represented in the codebase."
        ],
        uncertainty: [RUNTIME_UNCERTAINTY]
      };
    }
  );
}

/** CAP-15 — which tests can statically reach a target. */
export async function analyzeTestPaths(repositoryRoot: string, target: string): Promise<TestPathResult> {
  return withContext(repositoryRoot, { analysisBoundary: BOUNDARY, target, reachingTests: [], uncertainty: [INIT_UNCERTAINTY] }, (ctx) => {
    const targets = resolveTargets(ctx.source, target);
    const reached = traverse(ctx.source, targets, false);
    const reachingTests: ReachablePath[] = [];
    for (const [id, { conf, kinds }] of reached) {
      const node = ctx.source.getNode(id);
      if (!node || ctx.categoryByPath.get(node.path) !== "test") continue;
      const grade = reachGrade(kinds, conf);
      reachingTests.push({ id, label: nodeLabel(ctx.source, id), reachability: grade.reachability, confidence: grade.confidence, evidence: [`test reaches ${target} via ${[...kinds].join("/")} edge(s)`] });
    }
    return {
      analysisBoundary: BOUNDARY,
      target,
      reachingTests,
      uncertainty: [{ item: "Test discovery is framework-driven", reason: "Which tests actually exercise the target depends on the runner (collection, parametrization, skips).", requiredConfirmation: "Run the tests." }]
    };
  });
}

/** CAP-16 — architecture drift: scattered ownership / parallel systems / risk areas. */
export async function detectArchitectureDrift(repositoryRoot: string): Promise<ArchitectureDriftResult> {
  return withContext(repositoryRoot, { analysisBoundary: BOUNDARY, driftFindings: [], uncertainty: [INIT_UNCERTAINTY] }, (ctx) => {
    const driftFindings: Finding[] = [...ctx.map.findings.riskAreas];
    // Parallel systems from duplicate candidates.
    for (const dup of ctx.map.findings.duplicatePathCandidates) {
      driftFindings.push({
        finding: `Parallel implementations: ${dup.label}.`,
        confidence: clampConfidence(dup.confidence, "candidate"),
        evidence: dup.evidence,
        risk: dup.risk,
        recommendation: "Consolidate behind a single canonical owner.",
        uncertainty: dup.uncertainty
      });
    }
    return {
      analysisBoundary: BOUNDARY,
      driftFindings,
      uncertainty: [{ item: "No persisted design intent", reason: "Drift is inferred from structure, not compared to an authoritative design model.", requiredConfirmation: "Architecture owner review." }]
    };
  });
}
