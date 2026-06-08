// Static path queries (CAP-23, Decisions 0023/0024). Surfaces the path-finding algorithms over the
// shared `GraphSource` substrate as codebase-only, confidence-graded results. Every path is a STATIC
// path — never a runtime trace; emitted confidence is clamped to `likely` (ADR 0016). Requires an
// initialized context map; the source is opened and closed per call (Decision 0024).

import { clampConfidence, type Confidence, type UncertaintyItem } from "./contextMap.js";
import { loadGraphContext } from "./graphIndex.js";
import { findBestConfidencePath, findFewestHopPath, resolveNodeIds, type GraphSource, type StaticPath } from "./pathfinding.js";
import type { CallEdgeKind } from "./callGraph.js";

const BOUNDARY = "codebase_only" as const;

const RUNTIME_UNCERTAINTY: UncertaintyItem = {
  item: "Static paths are not runtime-proven",
  reason: "Edges are static inferences (ADR 0001/0002); dynamic dispatch, DI, reflection, and config are invisible.",
  requiredConfirmation: "Runtime trace / debugger (out of scope)."
};
const INIT_UNCERTAINTY: UncertaintyItem = {
  item: "Context map is not initialized",
  reason: "No baseline map at .code-cartographer-mcp/context-map.json (Decision 0004).",
  requiredConfirmation: "Run init_codebase, then retry."
};

export interface CallerRef {
  id: string;
  label: string;
  callKind: CallEdgeKind;
  confidence: Confidence; // clamped to likely (ADR 0016) — never confirmed runtime truth
}

export interface FindCallersResult {
  analysisBoundary: "codebase_only";
  subject: string;
  callers: CallerRef[];
  uncertainty: UncertaintyItem[];
}

export interface StaticPathView {
  nodes: { id: string; label: string }[];
  hops: number;
  confidence: Confidence; // clamped to likely
}

export interface FindPathResult {
  analysisBoundary: "codebase_only";
  from: string;
  to: string;
  fewestHop: StaticPathView | null;
  bestConfidence: StaticPathView | null;
  uncertainty: UncertaintyItem[];
}

function labelOf(source: GraphSource, id: string): string {
  const n = source.getNode(id);
  return n ? `${n.symbol} (${n.path})` : id;
}

/** CAP-23 — direct static callers of a symbol over the shared substrate; confidence clamped to `likely`. */
export async function findCallers(repositoryRoot: string, symbol: string): Promise<FindCallersResult> {
  const gc = await loadGraphContext(repositoryRoot);
  if (!gc) return { analysisBoundary: BOUNDARY, subject: symbol, callers: [], uncertainty: [INIT_UNCERTAINTY] };
  try {
    const source = gc.source;
    const targets = resolveNodeIds(source, symbol);
    const byKey = new Map<string, CallerRef>();
    for (const t of targets) {
      for (const e of source.callers(t)) {
        byKey.set(`${e.from}|${e.callKind}`, {
          id: e.from,
          label: labelOf(source, e.from),
          callKind: e.callKind,
          confidence: clampConfidence(e.confidence, "likely")
        });
      }
    }
    const callers = [...byKey.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      analysisBoundary: BOUNDARY,
      subject: symbol,
      callers,
      uncertainty:
        targets.length === 0
          ? [{ item: "Subject not found in map", reason: "No node matched the query.", requiredConfirmation: "Check the symbol/path, or re-init if stale." }]
          : [RUNTIME_UNCERTAINTY]
    };
  } finally {
    gc.source.close();
  }
}

/** CAP-23 — static path(s) between two symbols: fewest-hop + best-confidence. Confidence clamped to `likely`. */
export async function findPath(repositoryRoot: string, from: string, to: string): Promise<FindPathResult> {
  const gc = await loadGraphContext(repositoryRoot);
  if (!gc) return { analysisBoundary: BOUNDARY, from, to, fewestHop: null, bestConfidence: null, uncertainty: [INIT_UNCERTAINTY] };
  try {
    const source = gc.source;
    const fromIds = resolveNodeIds(source, from);
    const toIds = resolveNodeIds(source, to);
    if (fromIds.length === 0 || toIds.length === 0) {
      return {
        analysisBoundary: BOUNDARY,
        from,
        to,
        fewestHop: null,
        bestConfidence: null,
        uncertainty: [{ item: "Endpoint not found in map", reason: `No node matched ${fromIds.length === 0 ? `'${from}'` : `'${to}'`}.`, requiredConfirmation: "Check the symbol/path, or re-init if stale." }]
      };
    }
    const fromId = fromIds[0];
    const toId = toIds[0];
    const view = (p: StaticPath | null): StaticPathView | null =>
      p ? { nodes: p.nodes.map((id) => ({ id, label: labelOf(source, id) })), hops: p.hops, confidence: p.confidence } : null;
    return {
      analysisBoundary: BOUNDARY,
      from,
      to,
      fewestHop: view(findFewestHopPath(source, fromId, toId)),
      bestConfidence: view(findBestConfidencePath(source, fromId, toId)),
      uncertainty: [RUNTIME_UNCERTAINTY]
    };
  } finally {
    gc.source.close();
  }
}
