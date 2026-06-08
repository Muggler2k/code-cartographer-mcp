// Skeleton only. Formatting is not implemented yet — every function throws.
// Implementations must render each result in human_readable markdown, llm_readable
// JSON, or dual (both), kept in sync with the result shapes, and must preserve
// confidence labels and uncertainty in every mode (CAS output-mode-policy).

import type {
  CanonicalPath,
  ChangeImpactArea,
  DuplicatePath,
  Finding,
  InitResult,
  InitStatusResult,
  LegacyPath,
  OutputMode,
  Recommendation,
  StaticContextMap,
  UncertaintyItem
} from "./contextMap.js";
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
  // Project the llm payload: keep meta + summary, drop the (potentially large) files[].
  const llmValue = { analysisBoundary: result.analysisBoundary, status: result.status, mapPath: result.mapPath, meta, summary };
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
    ...section("Important files", sampleList(summary.importantFiles)),
    ...section(
      "Entry points",
      summary.entryPoints.map((e) => `- \`${e.path}\` \`${e.confidence}\` — ${e.reason}`)
    ),
    ...section(
      "Modules",
      summary.modules.map((m) => `- **${m.name}** (${m.category}) — ${m.files.length} file(s)`)
    ),
    ...section("Uncertainty", uncertaintyLines(map.findings.uncertainty))
  ].join("\n");
  const llmValue = { analysisBoundary: "codebase_only", meta, summary };
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

export function formatReachability(result: ReachabilityResult, mode: OutputMode): string {
  const human = [
    `# Reachability: ${result.subject} \`${result.status}\``,
    "",
    CODEBASE_ONLY_BANNER,
    "",
    result.summary,
    ...section("Reachable paths", result.reachablePaths.map(reachLine)),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
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

export function formatArchitectureDrift(result: ArchitectureDriftResult, mode: OutputMode): string {
  const human = [
    "# Architecture Drift",
    "",
    CODEBASE_ONLY_BANNER,
    ...section("Drift findings", result.driftFindings.flatMap(findingLines)),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
}

export function formatCallStack(result: CallStackResult, mode: OutputMode): string {
  const human = [
    `# Call Stack: ${result.entryPoint}`,
    "",
    CODEBASE_ONLY_BANNER,
    "",
    `_Static call graph — dynamic/DI/reflection/framework edges are graded down, never a runtime trace._`,
    `- **Root:** \`${result.rootId}\` · **Nodes:** ${result.nodes.length} · **Edges:** ${result.edges.length}${result.maxDepthReached ? " · ⚠️ max depth reached" : ""}`,
    ...section(
      "Edges",
      result.edges.map((e) => `- \`${e.from}\` → \`${e.to}\` \`${e.callKind}\`/\`${e.confidence}\` — ${e.evidence.join("; ") || "—"}`)
    ),
    ...section("Uncertainty", uncertaintyLines(result.uncertainty))
  ].join("\n");
  return byMode(human, result, mode);
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
