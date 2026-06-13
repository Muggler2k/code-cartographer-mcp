// Visualization (CAP-24 call stack, CAP-25 architecture). Codebase-only: a visualizer
// returns a diagram SPEC (Mermaid / Graphviz DOT / ASCII text) that the client renders —
// the server never produces rendered images. The diagram carries a legend so
// confidence/edge-kind grading stays visible. Requires an initialized context map.

import { BOUNDARY, INIT_UNCERTAINTY, withContext, type AnalysisTarget } from "./analysisContext.js";
import type { CallEdge, CallGraphNode, UncertaintyItem } from "./schema.js";
import { mapCallStack } from "./callGraph.js";
import { detectArchitectureDrift } from "./analysis.js";

/** Diagram spec formats a visualizer can emit (the client renders them). */
export type VisualizationFormat = "mermaid" | "dot" | "ascii";

export interface Visualization {
  format: VisualizationFormat;
  /** The diagram source text (e.g. a Mermaid graph or Graphviz DOT document). */
  diagram: string;
  title: string;
  /** Legend lines so confidence/edge-kind labels stay visible in the render. */
  legend: string[];
}

export interface CallStackVisualizationResult {
  analysisBoundary: "codebase_only";
  entryPoint: string;
  visualization: Visualization;
  uncertainty: UncertaintyItem[];
}

export interface ArchitectureVisualizationResult {
  analysisBoundary: "codebase_only";
  visualization: Visualization;
  uncertainty: UncertaintyItem[];
}

const BOUNDARY_LEGEND = "Codebase-only static inference — confidence-graded, never a runtime trace.";

/** Edge line style by (callKind × confidence); most-uncertain wins so uncertainty is never hidden. */
function edgeStyle(edge: CallEdge): "solid" | "dashed" | "dotted" {
  if (edge.callKind === "unresolved" || edge.confidence === "unresolved") return "dotted";
  if (edge.callKind === "dynamic" || edge.callKind === "framework" || edge.confidence === "candidate" || edge.confidence === "unclear") return "dashed";
  if ((edge.callKind === "direct" || edge.callKind === "method") && (edge.confidence === "confirmed" || edge.confidence === "likely")) return "solid";
  return "dashed"; // never solid by default
}

/** Deterministic short ids (n0, n1, ...) for diagram tokens; sanitizes path#symbol. */
function idMapper(nodes: CallGraphNode[]): Map<string, string> {
  const map = new Map<string, string>();
  [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1)).forEach((n, i) => map.set(n.id, `n${i}`));
  return map;
}

function nodeLabelText(node: CallGraphNode): string {
  const suffix = node.confidence === "unresolved" ? " (unresolved)" : node.confidence === "candidate" || node.confidence === "unclear" ? " ?" : "";
  return `${node.symbol}${suffix}`;
}

function legendFor(edges: CallEdge[]): string[] {
  const styles = new Set(edges.map(edgeStyle));
  const legend = [BOUNDARY_LEGEND];
  if (styles.has("solid")) legend.push("solid arrow = confirmed/likely direct or method call");
  if (styles.has("dashed")) legend.push("dashed arrow = candidate edge (dynamic dispatch / framework-invoked; target not statically resolved)");
  if (styles.has("dotted")) legend.push("dotted arrow = unresolved edge (reflection / unknown target — runtime required to confirm)");
  return legend;
}

function renderCallStackMermaid(nodes: CallGraphNode[], edges: CallEdge[], ids: Map<string, string>, maxDepthReached: boolean): string {
  const lines = ["flowchart TD"];
  for (const node of nodes) lines.push(`  ${ids.get(node.id)}["${nodeLabelText(node)}"]`);
  for (const edge of edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    const style = edgeStyle(edge);
    const kindLabel = edge.callKind === "direct" || edge.callKind === "method" ? "" : edge.callKind;
    if (style === "solid") {
      lines.push(`  ${from} --> ${to}`);
    } else if (style === "dotted") {
      lines.push(`  ${from} -. "unresolved" .-> ${to}`);
    } else {
      // dashed: with a label uses `-. "x" .->`, without uses `-.->` (never the invalid `-..->`).
      lines.push(kindLabel ? `  ${from} -. "${kindLabel}" .-> ${to}` : `  ${from} -.-> ${to}`);
    }
  }
  if (maxDepthReached) lines.push('  trunc(("⋯ truncated: max depth reached"))');
  return lines.join("\n");
}

function renderCallStackDot(nodes: CallGraphNode[], edges: CallEdge[], ids: Map<string, string>): string {
  const lines = ["digraph callstack {", "  rankdir=TB;", "  node [shape=box];"];
  for (const node of nodes) lines.push(`  ${ids.get(node.id)} [label="${nodeLabelText(node)}"];`);
  for (const edge of edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    const style = edgeStyle(edge);
    const label = edge.callKind === "direct" || edge.callKind === "method" ? "" : ` label="${edge.callKind}"`;
    lines.push(style === "solid" ? `  ${from} -> ${to};` : `  ${from} -> ${to} [style=${style}${label}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function renderCallStackAscii(rootId: string, nodes: CallGraphNode[], edges: CallEdge[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, CallEdge[]>();
  for (const e of edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
  const lines: string[] = [`root: ${byId.get(rootId)?.symbol ?? rootId}`];
  const visited = new Set<string>();
  const walk = (id: string, prefix: string): void => {
    if (visited.has(id)) {
      lines.push(`${prefix}${byId.get(id)?.symbol ?? id} (cycle)`);
      return;
    }
    visited.add(id);
    const children = out.get(id) ?? [];
    children.forEach((edge, i) => {
      const last = i === children.length - 1;
      const kind = edge.callKind === "direct" || edge.callKind === "method" ? "" : `:${edge.callKind}`;
      const target = byId.get(edge.to);
      lines.push(`${prefix}${last ? "└─" : "├─"}[${edgeStyle(edge)}${kind}] ${target ? nodeLabelText(target) : edge.to}`);
      walk(edge.to, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  walk(rootId, "");
  return lines.join("\n");
}

/**
 * Diagram node budget (ADR 0034 S1, issue #7): a call-stack diagram from one entry point can still
 * fan out to hundreds of nodes on a large repo, so the rendered spec scales unbounded. The diagram
 * is rendered from a bounded subgraph capped at this many nodes — the diagram string can never be
 * truncated mid-syntax (it must stay a valid spec), so the bound is applied to the graph, not the text.
 */
export const DIAGRAM_NODE_CAP = 40;

/**
 * Return a bounded, root-connected subgraph for rendering (ADR 0034 S1): a BFS from `rootId` keeping
 * up to `cap` nodes and only the edges among them. Valid by construction — every retained edge's
 * endpoints are in the node set, so no renderer emits a dangling reference. Under the cap, the inputs
 * pass through unchanged. The dropped portion is disclosed by the caller (legend) and the full graph
 * stays available via `map_call_stack` / the persisted map.
 */
export function boundedCallStackView(
  rootId: string,
  nodes: CallGraphNode[],
  edges: CallEdge[],
  cap = DIAGRAM_NODE_CAP
): { nodes: CallGraphNode[]; edges: CallEdge[]; truncated: boolean } {
  if (nodes.length <= cap) return { nodes, edges, truncated: false };
  const adjacency = new Map<string, string[]>();
  for (const e of edges) (adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e.to);
  const keep = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0 && keep.size < cap) {
    const current = queue.shift()!;
    for (const to of adjacency.get(current) ?? []) {
      if (keep.size >= cap) break;
      if (!keep.has(to)) {
        keep.add(to);
        queue.push(to);
      }
    }
  }
  return {
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    truncated: true
  };
}

/** CAP-24 — Render the static call stack rooted at an entry point as a diagram spec. */
export async function visualizeCallStack(
  repoOrContext: AnalysisTarget,
  entryPoint: string,
  format: VisualizationFormat = "mermaid",
  maxDepth?: number
): Promise<CallStackVisualizationResult> {
  const cs = await mapCallStack(repoOrContext, entryPoint, maxDepth);
  const view = boundedCallStackView(cs.rootId, cs.nodes, cs.edges);
  const ids = idMapper(view.nodes);
  const diagram =
    format === "dot"
      ? renderCallStackDot(view.nodes, view.edges, ids)
      : format === "ascii"
        ? renderCallStackAscii(cs.rootId, view.nodes, view.edges)
        : renderCallStackMermaid(view.nodes, view.edges, ids, cs.maxDepthReached);
  // Legend is computed from the FULL edge set so every edge style (incl. unresolved) stays explained
  // even if the bound dropped some; the bound itself is disclosed as an extra legend line.
  const legend = legendFor(cs.edges);
  if (cs.maxDepthReached) legend.push("truncated node = traversal stopped at max depth, not a leaf");
  if (view.truncated) {
    legend.push(
      `diagram bounded to ${view.nodes.length} of ${cs.nodes.length} nodes (${view.edges.length} of ${cs.edges.length} edges) — full graph via map_call_stack or the persisted map`
    );
  }
  return {
    analysisBoundary: BOUNDARY,
    entryPoint,
    visualization: { format, diagram, title: `Call stack from ${entryPoint}`, legend },
    uncertainty: cs.uncertainty
  };
}

/** CAP-25 — Render the repository architecture (modules / ownership / drift) as a diagram spec. */
export async function visualizeArchitecture(
  repoOrContext: AnalysisTarget,
  format: VisualizationFormat = "mermaid"
): Promise<ArchitectureVisualizationResult> {
  return withContext(
    repoOrContext,
    {
      analysisBoundary: BOUNDARY,
      visualization: { format, diagram: "", title: "Architecture (not initialized)", legend: [BOUNDARY_LEGEND] },
      uncertainty: [INIT_UNCERTAINTY]
    },
    async (ctx) => {
      const map = ctx.map;
      const drift = await detectArchitectureDrift(ctx);
      const modules = map.summary.modules;
      const exportedByModule = new Map<string, string[]>();
      for (const sig of map.summary.ownershipSignals) {
        if (!sig.exported) continue;
        const mod = modules.find((m) => m.files.includes(sig.path));
        if (!mod) continue;
        (exportedByModule.get(mod.root) ?? exportedByModule.set(mod.root, []).get(mod.root)!).push(sig.symbol);
      }

      let diagram: string;
      if (format === "dot") {
        const lines = ["digraph architecture {", "  rankdir=LR;", "  node [shape=box];"];
        modules.forEach((m, i) => lines.push(`  m${i} [label="${m.name} (${m.category}) — ${m.files.length} file(s)"];`));
        lines.push("}");
        diagram = lines.join("\n");
      } else if (format === "ascii") {
        const lines = modules.map((m) => `${m.root}/ (${m.category}) — ${m.files.length} file(s)`);
        lines.push("", "Drift findings:");
        for (const f of drift.driftFindings) lines.push(`  [${f.confidence}] ${f.finding} — ${f.risk}`);
        diagram = lines.join("\n");
      } else {
        const lines = ["flowchart LR"];
        modules.forEach((m, i) => lines.push(`  m${i}["${m.name} (${m.category})\\n${(exportedByModule.get(m.root) ?? []).slice(0, 3).join(", ") || "—"}"]`));
        drift.driftFindings.forEach((f, i) => lines.push(`  d${i}[/"drift: ${f.finding.slice(0, 50)} ⚠"/]`));
        diagram = lines.join("\n");
      }

      const legend = [BOUNDARY_LEGEND, "box = module (name, category, sample exports)", "⚠ note = architecture-drift finding (see uncertainty)"];
      const moduleNote: UncertaintyItem = {
        item: "Module groupings are static path/category groupings",
        reason: "They reflect directory layout, not proven runtime ownership or call relationships.",
        requiredConfirmation: "Runtime tracing or human architectural review."
      };
      const uncertainty = [...drift.uncertainty];
      if (!uncertainty.some((u) => u.item === moduleNote.item)) uncertainty.push(moduleNote);

      return {
        analysisBoundary: BOUNDARY,
        visualization: { format, diagram, title: `Architecture: ${modules.length} module(s)`, legend },
        uncertainty
      };
    }
  );
}
