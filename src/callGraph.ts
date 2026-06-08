// Skeleton contract for static call-stack mapping (CAP-23). Every function throws
// "not implemented". Codebase-only: the call stack is derived from parsed call
// expressions and import resolution, graded with confidence labels. Dynamic
// dispatch, dependency injection, reflection, and framework-invoked calls are
// graded `candidate`/`unresolved` — this is a STATIC call graph, never a
// runtime-proven trace. Requires an initialized context map.

import { readContextMap, type Confidence, type OwnershipSignalKind, type UncertaintyItem } from "./contextMap.js";

/** How a call edge was resolved from static analysis. */
export type CallEdgeKind = "direct" | "method" | "dynamic" | "framework" | "unresolved";

export interface CallGraphNode {
  /** Stable id, e.g. `${path}#${symbol}`. */
  id: string;
  symbol: string;
  path: string;
  kind: OwnershipSignalKind;
  confidence: Confidence;
}

export interface CallEdge {
  from: string;
  to: string;
  callKind: CallEdgeKind;
  confidence: Confidence;
  evidence: string[];
}

export interface CallStackResult {
  analysisBoundary: "codebase_only";
  entryPoint: string;
  rootId: string;
  nodes: CallGraphNode[];
  edges: CallEdge[];
  /** True if traversal stopped at a depth/size limit rather than a leaf. */
  maxDepthReached: boolean;
  uncertainty: UncertaintyItem[];
}

const DEFAULT_MAX_DEPTH = 12;

/** A synthetic node for an unresolved/external edge target not present in the node set. */
function syntheticNode(id: string): CallGraphNode {
  return { id, symbol: id.replace(/^unresolved#/, ""), path: "", kind: "function", confidence: "unresolved" };
}

/**
 * CAP-23 — Map the static call stack/graph rooted at an entry point (symbol,
 * function, or file). Codebase-only and confidence-graded; never a runtime trace.
 */
export async function mapCallStack(
  repositoryRoot: string,
  entryPoint: string,
  maxDepth: number = DEFAULT_MAX_DEPTH
): Promise<CallStackResult> {
  const map = await readContextMap(repositoryRoot);
  const boundary = "codebase_only" as const;
  if (!map) {
    return {
      analysisBoundary: boundary,
      entryPoint,
      rootId: entryPoint,
      nodes: [],
      edges: [],
      maxDepthReached: false,
      uncertainty: [{ item: "Context map is not initialized", reason: "Run init_codebase before mapping a call stack (Decision 0004).", requiredConfirmation: "Run init_codebase, then retry." }]
    };
  }

  const nodeById = new Map(map.callGraph.nodes.map((n) => [n.id, n]));
  const forward = new Map<string, CallEdge[]>();
  for (const edge of map.callGraph.edges) {
    (forward.get(edge.from) ?? forward.set(edge.from, []).get(edge.from)!).push(edge);
  }

  // Resolve the entry point to root node id(s).
  const nodes = map.callGraph.nodes;
  const roots =
    nodeById.has(entryPoint)
      ? [entryPoint]
      : nodes.filter((n) => n.symbol === entryPoint).map((n) => n.id).length > 0
        ? nodes.filter((n) => n.symbol === entryPoint).map((n) => n.id)
        : nodes.filter((n) => n.path === entryPoint || n.symbol.toLowerCase().includes(entryPoint.toLowerCase())).map((n) => n.id);
  const rootId = roots[0] ?? entryPoint;

  const includedNodeIds = new Set<string>(roots);
  const includedEdges: CallEdge[] = [];
  const seenEdge = new Set<string>();
  let maxDepthReached = false;
  const visited = new Set(roots);
  let frontier = roots.map((id) => ({ id, depth: 0 }));
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const cur of frontier) {
      const outgoing = forward.get(cur.id) ?? [];
      if (cur.depth >= maxDepth) {
        if (outgoing.length > 0) maxDepthReached = true;
        continue;
      }
      for (const edge of outgoing) {
        const key = `${edge.from}|${edge.to}|${edge.callKind}`;
        if (!seenEdge.has(key)) {
          seenEdge.add(key);
          includedEdges.push(edge);
        }
        includedNodeIds.add(edge.to);
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          next.push({ id: edge.to, depth: cur.depth + 1 });
        }
      }
    }
    frontier = next;
  }

  const resultNodes = [...includedNodeIds]
    .map((id) => nodeById.get(id) ?? syntheticNode(id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const uncertainty: UncertaintyItem[] = [
    { item: "Static call stack is not a runtime trace", reason: "Edges are statically derived; dynamic dispatch, DI, reflection, and framework calls are graded down, not executed (ADR 0001/0002).", requiredConfirmation: "Runtime trace / debugger (out of scope)." }
  ];
  if (roots.length === 0) {
    uncertainty.push({ item: "Entry point not resolved", reason: `No declaration matched '${entryPoint}'.`, requiredConfirmation: "Check the symbol/path or re-init if stale." });
  }
  if (includedEdges.some((e) => e.callKind === "dynamic" || e.callKind === "framework" || e.callKind === "unresolved")) {
    uncertainty.push({ item: "Dynamic / framework / unresolved edges present", reason: "These cannot be statically resolved to a target.", requiredConfirmation: "Runtime confirmation of the actual call target." });
  }

  return { analysisBoundary: boundary, entryPoint, rootId, nodes: resultNodes, edges: includedEdges, maxDepthReached, uncertainty };
}
