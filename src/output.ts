// Formatting only (Decision 0015): one formatter per result type, each rendering in
// human_readable markdown, llm_readable JSON, or dual (both), kept in sync with the
// result shapes and preserving confidence labels and uncertainty in every mode
// (CAS output-mode-policy).

import type { InitResult, InitStatusResult } from "./contextMap.js";
import type {
  CanonicalPath,
  ChangeImpactArea,
  DuplicatePath,
  Finding,
  LegacyPath,
  OutputMode,
  Recommendation,
  StaticContextMap,
  UncertaintyItem
} from "./schema.js";
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
  ReachablePath,
  TestPathResult
} from "./analysis.js";
import type { CallStackResult } from "./callGraph.js";
import type { FindCallersResult, FindPathResult, StaticPathView } from "./pathQueries.js";
import type { MapDiffResult } from "./mapDiff.js";
import type {
  ArchitectureVisualizationResult,
  CallStackVisualizationResult,
  Visualization
} from "./visualize.js";
import type { ScopePreview } from "./scope.js";

// ---- Shared rendering helpers ----

/** Codebase-only banner — every human render surfaces this prominently (CAS POL-03). */
const CODEBASE_ONLY_BANNER =
  "> ⚠️ Codebase-only analysis — static inferences from checked-in files, never runtime truth.";

/**
 * Render a result by output mode (ADR 0015): `human` markdown as-is, `llm` as pretty JSON
 * of the raw value, `dual` = human + separator + a fenced json block. `dual` is composed
 * from the two single-mode renders, never a third rendering path.
 */
function byMode(human: string, value: unknown, mode: OutputMode): string {
  const json = (): string => JSON.stringify(value, null, 2);
  if (mode === "llm_readable") {
    return json();
  }
  if (mode === "dual") {
    return `${human}\n\n---\n\n\`\`\`json\n${json()}\n\`\`\``;
  }
  return human;
}

/** Bullet list of code-span items, or a single em-dash placeholder when empty. */
function sampleList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- \`${item}\``) : ["- —"];
}

/** A `## Title` section with its lines, or an em-dash when empty. Confidence stays visible. */
function section(title: string, lines: string[]): string[] {
  return ["", `## ${title}`, ...(lines.length > 0 ? lines : ["- —"])];
}

/** "showing N of M" suffix when a list is capped — true totals are never hidden. */
function capNote(shown: number, total: number): string {
  return total > shown ? ` _(showing ${shown} of ${total})_` : "";
}

/**
 * Shared sample cap for every `llm_readable` digest (ADR 0034 S1): the init/summary, call-stack,
 * drift, and reachability payloads previously serialized whole lists, so output scaled with repo /
 * graph / finding count (the worst measured ~536k tokens). Each digest caps its sample lists at
 * this many; `counts` carry the true totals + per-field breakdowns and the persisted map keeps
 * everything. One shared value so the tools cannot drift apart.
 */
const DIGEST_SAMPLE_CAP = 20;

/** A bounded list projection (ADR 0034 S1): a head `sample`, the true `total`, and a `truncated` flag. */
function cappedSample<T>(items: T[], cap = DIGEST_SAMPLE_CAP): { sample: T[]; total: number; truncated: boolean } {
  return { sample: items.slice(0, cap), total: items.length, truncated: items.length > cap };
}

/** Standard digest disclosure prefix (ADR 0034 S1) — the per-tool detail is appended by the caller. */
function digestNote(detail: string): string {
  return `llm digest (ADR 0034 S1): ${detail}`;
}

/**
 * A `## Title` section whose list is capped to `cap` with a "showing N of M" note in the title
 * (true total never hidden). `render` maps each item to one line or several. Mirrors the
 * `llm_readable` cap in `cappedSample` so the human and agent surfaces stay in lockstep.
 */
function cappedSection<T>(title: string, items: T[], render: (item: T) => string | string[], cap = DIGEST_SAMPLE_CAP): string[] {
  const lines = items.slice(0, cap).flatMap((item) => {
    const rendered = render(item);
    return Array.isArray(rendered) ? rendered : [rendered];
  });
  return section(`${title}${capNote(cap, items.length)}`, lines);
}

/**
 * A bounded projection of `summary` for `llm_readable` (ADR 0034 S1): counts + true totals +
 * capped samples, with each module's `files[]` reduced to `fileCount`. The codebase-only
 * boundary is intentionally omitted from this projection — the caller ships it alongside
 * (top-level `analysisBoundary` + `meta.codebaseOnlyBoundary`), so it is never duplicated here.
 */
function summaryDigest(summary: StaticContextMap["summary"]): Record<string, unknown> {
  const cap = DIGEST_SAMPLE_CAP;
  const importantFiles = cappedSample(summary.importantFiles, cap);
  const entryPoints = cappedSample(summary.entryPoints, cap);
  const modules = cappedSample(summary.modules, cap);
  const ownershipSignals = cappedSample(summary.ownershipSignals, cap);
  return {
    totalFiles: summary.totalFiles,
    categories: summary.categories,
    languages: summary.languages,
    counts: {
      importantFiles: importantFiles.total,
      entryPoints: entryPoints.total,
      modules: modules.total,
      ownershipSignals: ownershipSignals.total
    },
    importantFiles: importantFiles.sample,
    entryPoints: entryPoints.sample,
    modules: modules.sample.map((m) => ({ name: m.name, root: m.root, category: m.category, fileCount: m.files.length })),
    ownershipSignals: ownershipSignals.sample,
    excluded: summary.excluded,
    truncated: importantFiles.truncated || entryPoints.truncated || modules.truncated || ownershipSignals.truncated,
    digestNote: digestNote(`list samples capped at ${cap}; counts carry true totals; full data in .code-cartographer-mcp/context-map.json`)
  };
}

function uncertaintyLines(items: UncertaintyItem[]): string[] {
  return items.map((u) => `- **${u.item}** — ${u.reason} _(to confirm: ${u.requiredConfirmation})_`);
}

function findingLines(f: Finding): string[] {
  const lines = [
    `- **${f.finding}** \`${f.confidence}\``,
    `  - Risk: ${f.risk}`,
    `  - Evidence: ${f.evidence.join("; ") || "—"}`,
    `  - Recommendation: ${f.recommendation}`
  ];
  if (f.uncertainty.length > 0) {
    lines.push(`  - Uncertainty: ${f.uncertainty.map((u) => u.item).join("; ")}`);
  }
  return lines;
}

function canonicalLine(p: CanonicalPath): string {
  const risks = p.risks.length > 0 ? ` — risks: ${p.risks.join("; ")}` : "";
  return `- **${p.label}** \`${p.confidence}\` — ${p.evidence.join("; ") || "—"}${risks}`;
}

/** Per-record uncertainty caveats as indented sub-bullets (so they are never silently dropped). */
function uncertaintySubLines(items: UncertaintyItem[]): string[] {
  return items.map((u) => `  - ⚠ ${u.item} _(confirm: ${u.requiredConfirmation})_`);
}

function duplicateLine(p: DuplicatePath): string {
  return [`- **${p.label}** \`${p.confidence}\` — risk: ${p.risk} _(${p.evidence.join("; ") || "—"})_`, ...uncertaintySubLines(p.uncertainty)].join("\n");
}

function legacyLine(p: LegacyPath): string {
  return [`- **${p.label}** \`${p.reachability}\` — ${p.recommendation} _(${p.evidence.join("; ") || "—"})_`, ...uncertaintySubLines(p.uncertainty)].join("\n");
}

function impactLine(a: ChangeImpactArea): string {
  return `- **${a.area}** \`${a.impactLevel}\` — ${a.reason}`;
}

function reachLine(p: ReachablePath): string {
  return `- **${p.label}** \`${p.reachability}\`/\`${p.confidence}\` — ${p.evidence.join("; ") || "—"}`;
}

function recommendationLine(r: Recommendation): string {
  return `**Recommendation:** ${r.action} \`${r.target}\` — ${r.rationale}`;
}

/** Render a diagram spec (Mermaid/DOT/ASCII) as a fenced block + legend — never an image. */
function visualizationLines(viz: Visualization): string[] {
  return [
    `_Format: ${viz.format} — a diagram spec the client renders, not an image._`,
    "",
    "```" + viz.format,
    viz.diagram,
    "```",
    ...section("Legend", viz.legend.map((l) => `- ${l}`))
  ];
}

export function formatInitStatus(result: InitStatusResult, mode: OutputMode): string {
  const human = [
    `# Init State: ${result.status}`,
    "",
    CODEBASE_ONLY_BANNER,
    "",
    result.message,
    `- **Map:** \`${result.mapPath}\``,
    ...(result.previousMapHash ? [`- **Previous map hash:** \`${result.previousMapHash}\``] : []),
    ...(result.currentMapHash ? [`- **Current map hash:** \`${result.currentMapHash}\``] : [])
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatInitResult(result: InitResult, mode: OutputMode): string {
  const { summary, meta } = result.map;
  const categoryLine = Object.entries(summary.categories)
    .filter(([, n]) => n > 0)
    .map(([cat, n]) => `${cat} ${n}`)
    .join(", ");
  const languageLine = Object.entries(summary.languages)
    .map(([lang, n]) => `${lang} ${n}`)
    .join(", ");
  const human = [
    "# Initialization Complete",
    "",
    CODEBASE_ONLY_BANNER,
    "",
    `- **Files mapped:** ${summary.totalFiles}`,
    `- **Categories:** ${categoryLine || "—"}`,
    `- **Languages:** ${languageLine || "—"}`,
    `- **Entry points:** ${summary.entryPoints.length} · **Modules:** ${summary.modules.length} · **Ownership signals:** ${summary.ownershipSignals.length}`,
    `- **Excluded:** ${summary.excluded.dirs.length} dir(s), ${summary.excluded.fileCount} skipped file(s) (source: ${summary.excluded.source})`,
    `- **Map written:** \`${result.mapPath}\``,
    `- **Map hash:** \`${meta.mapHash}\``
  ].join("\n");
  // Project the llm payload: keep meta, but digest the summary (ADR 0034 S1) so output does
  // not scale with repo size — drop files[], cap sample lists, reduce modules to fileCount.
  const llmValue = { analysisBoundary: result.analysisBoundary, status: result.status, mapPath: result.mapPath, meta, summary: summaryDigest(summary) };
  return byMode(human, llmValue, mode);
}

export function formatContextSummary(map: StaticContextMap | null, mode: OutputMode): string {
  if (map === null) {
    const human = [
      "# Context: not initialized",
      "",
      CODEBASE_ONLY_BANNER,
      "",
      "No context map exists yet. Run `init_codebase` first; answers before init are limited."
    ].join("\n");
    return byMode(human, { analysisBoundary: "codebase_only", status: "not_initialized" }, mode);
  }
  const { summary, meta } = map;
  const categoryLine = Object.entries(summary.categories)
    .filter(([, n]) => n > 0)
    .map(([cat, n]) => `${cat} ${n}`)
    .join(", ");
  const human = [
    "# Context Summary",
    "",
    CODEBASE_ONLY_BANNER,
    "",
    `- **Files:** ${summary.totalFiles} (${categoryLine || "—"})`,
    `- **Languages:** ${Object.keys(summary.languages).join(", ") || "—"}`,
    `- **Generated:** ${meta.generatedAt} · **Map hash:** \`${meta.mapHash}\``,
    ...cappedSection("Important files", summary.importantFiles, (f) => `- \`${f}\``),
    ...cappedSection("Entry points", summary.entryPoints, (e) => `- \`${e.path}\` \`${e.confidence}\` — ${e.reason}`),
    ...cappedSection("Modules", summary.modules, (m) => `- **${m.name}** (${m.category}) — ${m.files.length} file(s)`),
    ...section("Uncertainty", uncertaintyLines(map.findings.uncertainty))
  ].join("\n");
  const llmValue = { analysisBoundary: "codebase_only", meta, summary: summaryDigest(summary) };
  return byMode(human, llmValue, mode);
}

export function formatFindCallers(result: FindCallersResult, mode: OutputMode): string {
  const human = [
    `# Callers of: ${result.subject}`,
    "",
    CODEBASE_ONLY_BANNER,
    ...section("Static callers (confidence-graded)", result.callers.map((c) => `- **${c.label}** \`${c.callKind}\`/\`${c.confidence}\``)),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

/** Render one static path as an arrow chain, or an em-dash when none was found. */
function pathViewLines(title: string, p: StaticPathView | null): string[] {
  if (!p) return section(title, ["- — (no static path found)"]);
  return section(`${title} \`${p.confidence}\` (${p.hops} hop(s))`, [`- ${p.nodes.map((n) => `\`${n.label}\``).join(" → ")}`]);
}

export function formatFindPath(result: FindPathResult, mode: OutputMode): string {
  const human = [
    `# Static path: ${result.from} → ${result.to}`,
    "",
    CODEBASE_ONLY_BANNER,
    ...pathViewLines("Fewest-hop path", result.fewestHop),
    ...pathViewLines("Best-confidence path", result.bestConfidence),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

/**
 * A bounded projection of a `ReachabilityResult` for `llm_readable` (ADR 0034 S1): boundary,
 * subject, status, summary, and the full `uncertainty` pass through; `reachablePaths` is capped to
 * a sample. `counts` carries the true total AND per-confidence + per-reachability breakdowns so
 * capping never hides the reachability distribution (a ≤`likely`, never-runtime-proven signal).
 */
function reachabilityDigest(result: ReachabilityResult): Record<string, unknown> {
  const paths = cappedSample(result.reachablePaths);
  return {
    analysisBoundary: result.analysisBoundary,
    subject: result.subject,
    status: result.status,
    summary: result.summary,
    counts: {
      reachablePaths: paths.total,
      byConfidence: tally(result.reachablePaths, (p) => p.confidence),
      byReachability: tally(result.reachablePaths, (p) => p.reachability)
    },
    reachablePaths: paths.sample,
    uncertainty: result.uncertainty,
    truncated: paths.truncated,
    digestNote: digestNote(
      `reachable-paths sample capped at ${DIGEST_SAMPLE_CAP}; counts carry the true total + per-confidence/per-reachability breakdowns; full paths in .code-cartographer-mcp/context-map.json. \`apparently_unreachable\` is a static candidate observation, never a confirmed dead-code claim.`
    )
  };
}

export function formatReachability(result: ReachabilityResult, mode: OutputMode): string {
  const human = [
    `# Reachability: ${result.subject} \`${result.status}\``,
    "",
    CODEBASE_ONLY_BANNER,
    "",
    result.summary,
    ...cappedSection("Reachable paths", result.reachablePaths, reachLine),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  // Digest the llm payload (ADR 0034 S1) so output does not scale with path count — cap the
  // sample, keep the true total + per-confidence/per-reachability breakdowns.
  return byMode(human, reachabilityDigest(result), mode);
}

export function formatDuplicateBehavior(result: DuplicateBehaviorResult, mode: OutputMode): string {
  const human = [
    `# Duplicate Behavior: ${result.subject}`,
    "",
    CODEBASE_ONLY_BANNER,
    ...section("Candidate duplicate paths", result.duplicatePaths.map(duplicateLine)),
    ...(result.recommendation ? ["", recommendationLine(result.recommendation)] : []),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatLegacyClassification(result: LegacyClassificationResult, mode: OutputMode): string {
  const human = [
    "# Legacy Path Classification",
    "",
    CODEBASE_ONLY_BANNER,
    ...section("Legacy paths", result.legacyPaths.map(legacyLine)),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatChangeImpact(result: ChangeImpactResult, mode: OutputMode): string {
  const human = [
    `# Change Impact: ${result.target}`,
    "",
    CODEBASE_ONLY_BANNER,
    ...section("Impacted areas", result.changeImpact.map(impactLine)),
    ...(result.recommendation ? ["", recommendationLine(result.recommendation)] : []),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatPreflightReview(result: PreflightReviewResult, mode: OutputMode): string {
  const human = [
    `# Preflight Review: ${result.subject} \`${result.status}\``,
    "",
    CODEBASE_ONLY_BANNER,
    "",
    result.summary,
    ...section("Canonical paths to reuse", result.canonicalPaths.map(canonicalLine)),
    ...section("Duplicate risks", result.duplicatePaths.map(duplicateLine)),
    ...section("Legacy risks", result.legacyPaths.map(legacyLine)),
    ...section("Change impact areas (static estimate)", result.changeImpact.map(impactLine)),
    "",
    recommendationLine(result.recommendation),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatChangeReview(result: ChangeReviewResult, mode: OutputMode): string {
  const human = [
    `# Change Review: ${result.subject} — alignment \`${result.alignment}\``,
    "",
    CODEBASE_ONLY_BANNER,
    ...section("Findings", result.findings.flatMap(findingLines)),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatOwnership(result: OwnershipResult, mode: OutputMode): string {
  const human = [
    `# Ownership: ${result.subject}`,
    "",
    CODEBASE_ONLY_BANNER,
    ...section("Canonical owner(s)", result.canonicalPaths.map(canonicalLine)),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatFailureInvestigation(result: FailureInvestigationResult, mode: OutputMode): string {
  const human = [
    `# Failure Investigation: ${result.subject}`,
    "",
    CODEBASE_ONLY_BANNER,
    "",
    "_Codebase-only hypotheses — not a debugger; runtime confirmation is still required._",
    ...section("Hypotheses", result.hypotheses.flatMap(findingLines)),
    ...section("Required runtime confirmation", result.requiredRuntimeConfirmation.map((c) => `- ${c}`)),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatTestPaths(result: TestPathResult, mode: OutputMode): string {
  const human = [
    `# Test Paths: ${result.target}`,
    "",
    CODEBASE_ONLY_BANNER,
    ...section("Tests with static paths to the target (confidence-graded)", result.reachingTests.map(reachLine)),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

/**
 * A bounded projection of an `ArchitectureDriftResult` for `llm_readable` (ADR 0034 S1, issue #7):
 * the drift-findings list is capped to a sample (a repo can accumulate hundreds — ~60k tokens on
 * a medium repo), while `counts` carries the true total plus a per-confidence breakdown and the
 * full `uncertainty` list passes through. The persisted map keeps the complete findings.
 */
function driftDigest(result: ArchitectureDriftResult): Record<string, unknown> {
  const findings = cappedSample(result.driftFindings);
  return {
    analysisBoundary: result.analysisBoundary,
    counts: {
      driftFindings: findings.total,
      byConfidence: tally(result.driftFindings, (f) => f.confidence)
    },
    driftFindings: findings.sample,
    uncertainty: result.uncertainty,
    truncated: findings.truncated,
    digestNote: digestNote(
      `drift-findings sample capped at ${DIGEST_SAMPLE_CAP}; counts carry the true total + per-confidence breakdown; full findings in .code-cartographer-mcp/context-map.json`
    )
  };
}

export function formatArchitectureDrift(result: ArchitectureDriftResult, mode: OutputMode): string {
  const human = [
    "# Architecture Drift",
    "",
    CODEBASE_ONLY_BANNER,
    ...cappedSection("Drift findings", result.driftFindings, findingLines),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  // Digest the llm payload (ADR 0034 S1) so output does not scale with finding count — cap the
  // sample, keep the true total + per-confidence breakdown. The true count is on the section title.
  return byMode(human, driftDigest(result), mode);
}

/** Tally values produced by `key` into a `{ value: count }` record — used for digest breakdowns. */
function tally<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * A bounded projection of a `CallStackResult` for `llm_readable` (ADR 0034 S1): the boundary,
 * entry/root, `maxDepthReached`, and the full (already-bounded) `uncertainty` pass through; the
 * `nodes`/`edges` arrays are capped to samples. `counts` carries the true totals AND a per-edge
 * confidence/kind breakdown so capping NEVER hides unresolved/dynamic/framework edges — the
 * call-stack policy requires those be disclosed, not omitted.
 */
function callStackDigest(result: CallStackResult): Record<string, unknown> {
  const nodes = cappedSample(result.nodes);
  const edges = cappedSample(result.edges);
  return {
    analysisBoundary: result.analysisBoundary,
    entryPoint: result.entryPoint,
    rootId: result.rootId,
    maxDepthReached: result.maxDepthReached,
    counts: {
      nodes: nodes.total,
      edges: edges.total,
      edgesByConfidence: tally(result.edges, (e) => e.confidence),
      edgesByKind: tally(result.edges, (e) => e.callKind)
    },
    nodes: nodes.sample,
    edges: edges.sample,
    uncertainty: result.uncertainty,
    truncated: nodes.truncated || edges.truncated,
    digestNote: digestNote(
      `node/edge samples capped at ${DIGEST_SAMPLE_CAP}; counts carry true totals + the per-confidence/per-kind edge breakdown (unresolved edges are disclosed there, never dropped); full graph in .code-cartographer-mcp/context-map.json`
    )
  };
}

export function formatCallStack(result: CallStackResult, mode: OutputMode): string {
  const human = [
    `# Call Stack: ${result.entryPoint}`,
    "",
    CODEBASE_ONLY_BANNER,
    "",
    `_Static call graph — dynamic/DI/reflection/framework edges are graded down, never a runtime trace._`,
    `- **Root:** \`${result.rootId}\` · **Nodes:** ${result.nodes.length} · **Edges:** ${result.edges.length}${result.maxDepthReached ? " · ⚠️ max depth reached" : ""}`,
    ...cappedSection(
      "Edges",
      result.edges,
      (e) => `- \`${e.from}\` → \`${e.to}\` \`${e.callKind}\`/\`${e.confidence}\` — ${e.evidence.join("; ") || "—"}`
    ),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  // Digest the llm payload (ADR 0034 S1) so output does not scale with graph size — cap the
  // node/edge samples, keep true totals + the per-confidence/kind edge breakdown so unresolved
  // edges stay disclosed. The true edge count stays visible on the Root line above.
  return byMode(human, callStackDigest(result), mode);
}

export function formatCallStackVisualization(result: CallStackVisualizationResult, mode: OutputMode): string {
  const human = [
    `# ${result.visualization.title}: ${result.entryPoint}`,
    "",
    CODEBASE_ONLY_BANNER,
    "",
    ...visualizationLines(result.visualization),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatArchitectureVisualization(result: ArchitectureVisualizationResult, mode: OutputMode): string {
  const human = [
    `# ${result.visualization.title}`,
    "",
    CODEBASE_ONLY_BANNER,
    "",
    ...visualizationLines(result.visualization),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatScopePreview(result: ScopePreview, mode: OutputMode): string {
  const { resolution: r } = result;
  const human = [
    "# Scope Preview",
    "",
    CODEBASE_ONLY_BANNER,
    "",
    `- **Exclusion source:** ${r.source}`,
    `- **Languages:** ${r.languages.length > 0 ? r.languages.join(", ") : "—"}`,
    `- **Excluded directories:** ${r.excludeDirs.length > 0 ? r.excludeDirs.join(", ") : "—"}`,
    `- **Patterns:** ${r.patterns.length} gitignore-style pattern(s)`,
    `- **Included files:** ${result.includedFileCount}`,
    `- **Excluded directories (walked):** ${result.excludedDirCount}`,
    `- **Skipped files:** ${result.excludedFileCount}`,
    "",
    "## Sample included",
    ...sampleList(result.sampleIncluded),
    "",
    "## Sample excluded directories",
    ...sampleList(result.sampleExcluded),
    "",
    "_No map was written — this is a preview (step 1 of init)._"
  ].join("\n");
  return byMode(human, result, mode);
}

/** CAP-26 — diff/PR mode (Decision 0031): the static delta between baseline and current. */
export function formatMapDiff(result: MapDiffResult, mode: OutputMode): string {
  const d = result.delta;
  const t = d.totals;
  const verdictLine = (label: string, hit: boolean): string => `- ${hit ? "⚠ **YES**" : "no"} — ${label}`;
  const human = [
    "# Static Diff (baseline → current)",
    "",
    CODEBASE_ONLY_BANNER,
    "",
    `- **Baseline:** \`${result.baseline.mapHash.slice(0, 12) || "—"}\` (${result.baseline.generatedAt || "—"})`,
    `- **Current:** \`${result.current.mapHash.slice(0, 12) || "—"}\``,
    "",
    "## Verdict (static structural signals — never runtime claims)",
    verdictLine("added a parallel/duplicate path", result.verdict.addedParallelPath),
    verdictLine("bypassed a public surface", result.verdict.bypassedAbstraction),
    verdictLine("revived a legacy path (statically referenced again)", result.verdict.revivedLegacy),
    verdictLine("weakened the static evidence / increased uncertainty", result.verdict.increasedUncertainty),
    "",
    recommendationLine(result.recommendation),
    ...section(`Files (+${t.filesAdded} / −${t.filesRemoved} / ~${t.filesChanged})`, [
      ...d.files.added.map((p) => `- added \`${p}\``),
      ...d.files.removed.map((p) => `- removed \`${p}\``),
      ...d.files.changed.map((p) => `- changed \`${p}\``)
    ]),
    ...section(`Call graph (nodes +${t.nodesAdded}/−${t.nodesRemoved}, edges +${t.edgesAdded}/−${t.edgesRemoved})${capNote(d.graph.edgesAdded.length, t.edgesAdded)}`, [
      ...d.graph.nodesAdded.map((id) => `- node added \`${id}\``),
      ...d.graph.nodesRemoved.map((id) => `- node removed \`${id}\` _(removed+added pairs may be renames — never guessed)_`),
      ...d.graph.edgesAdded.map((e) => `- edge added ${e}`),
      ...d.graph.edgesRemoved.map((e) => `- edge removed ${e}`)
    ]),
    ...section(`New duplicate paths (${t.newDuplicates})${capNote(d.newDuplicates.length, t.newDuplicates)}`, d.newDuplicates.map(duplicateLine)),
    ...section(`Legacy (${t.newLegacy} new, ${t.legacyTransitions} transition(s))`, [
      ...d.newLegacy.map(legacyLine),
      ...d.legacyTransitions.map((tr) => `- **${tr.id}**: \`${tr.from}\` → \`${tr.to}\`${tr.revived ? " — ⚠ statically revived" : ""}`)
    ]),
    ...section(`New risk areas (${t.newRiskAreas}; ${d.resolvedRiskAreaCount} resolved)`, d.newRiskAreas.flatMap(findingLines)),
    ...section(`Canonical owners removed (${d.canonicalRemovedIds.length})`, d.canonicalRemovedIds.map((id) => `- \`${id}\``)),
    ...section(`Static evidence (confidence)`, [
      `- Regressions: ${t.confidenceRegressions}${capNote(d.confidence.regressions.length, t.confidenceRegressions)}; improvements: ${d.confidence.improvements}`,
      ...d.confidence.regressions.map((r) => `- ${r.edge}: \`${r.from}\` → \`${r.to}\` (static evidence weakened)`),
      `- Weak-edge ratio: ${d.confidence.weakEdgeRatioBaseline} → ${d.confidence.weakEdgeRatioCurrent}`,
      `- Map-wide uncertainty items: ${d.confidence.uncertaintyItemsBaseline} → ${d.confidence.uncertaintyItemsCurrent}`
    ]),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}
