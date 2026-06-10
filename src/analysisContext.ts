// The shared analysis-context seam (Decision 0025). Every graph-query capability —
// the 10 analysis functions, mapCallStack, findCallers, findPath — runs through
// `withContext`, which owns the whole envelope: load the persisted map + traversal
// source, fall back to the codebase-only uninitialized result, and guarantee the
// source is closed (Decision 0024 — open/close per call). Capabilities accept an
// `AnalysisTarget`: a repository root (production) or an injected `AnalysisContext`
// (tests, and compositions like reviewPreflight that share one load).

import { loadGraphContext } from "./graphIndex.js";
import { inMemoryGraphSource, type GraphSource } from "./pathfinding.js";
import type { StaticContextMap, UncertaintyItem } from "./schema.js";

export const BOUNDARY = "codebase_only" as const;

export interface AnalysisContext {
  map: StaticContextMap;
  /** The single traversal substrate (Decision 0024): indexed or in-memory. */
  source: GraphSource;
  categoryByPath: Map<string, string>;
}

/**
 * What a capability runs over: a repository root (the context is loaded from disk and
 * closed by `withContext`) or an already-built `AnalysisContext` (owned — and closed —
 * by the caller; this is the injectable seam tests and compositions use).
 */
export type AnalysisTarget = string | AnalysisContext;

/** Build a context from a map and an optional source (defaults to the in-memory adapter). */
export function makeAnalysisContext(map: StaticContextMap, source?: GraphSource): AnalysisContext {
  const callGraph = map.callGraph ?? { nodes: [], edges: [] };
  return {
    map,
    source: source ?? inMemoryGraphSource(callGraph.nodes, callGraph.edges),
    categoryByPath: new Map(map.files.map((f) => [f.path, f.category]))
  };
}

/** Load the persisted map + a traversal source once. Returns null when not initialized. */
export async function loadAnalysisContext(repositoryRoot: string): Promise<AnalysisContext | null> {
  const gc = await loadGraphContext(repositoryRoot);
  if (!gc) return null;
  return makeAnalysisContext(gc.map, gc.source);
}

/**
 * Run `fn` with an analysis context. For a repository-root target the context is loaded
 * here and its source is ALWAYS closed afterward (Decision 0024 — open/close per call),
 * with `whenUninitialized` returned if no map exists. An injected context is used as-is
 * and NOT closed — the caller owns its lifecycle.
 */
export async function withContext<T>(
  target: AnalysisTarget,
  whenUninitialized: T,
  fn: (ctx: AnalysisContext) => T | Promise<T>
): Promise<T> {
  if (typeof target !== "string") {
    return fn(target);
  }
  const ctx = await loadAnalysisContext(target);
  if (!ctx) return whenUninitialized;
  try {
    return await fn(ctx);
  } finally {
    ctx.source.close();
  }
}

/** Display label for a node id: `symbol (path)` when the node is known, else the id. */
export function nodeLabel(source: GraphSource, id: string): string {
  const node = source.getNode(id);
  return node ? `${node.symbol} (${node.path})` : id;
}

// ---- Shared uncertainty items (one wording, every capability) ----

export const INIT_UNCERTAINTY: UncertaintyItem = {
  item: "Context map is not initialized",
  reason: "No baseline map at .code-cartographer-mcp/context-map.json (init before deep claims, Decision 0004).",
  requiredConfirmation: "Run init_codebase, then re-run this analysis."
};

export const RUNTIME_UNCERTAINTY: UncertaintyItem = {
  item: "Reachability and change-impact are not runtime-proven",
  reason: "All conclusions are static inferences (ADR 0001/0002); dynamic dispatch, DI, reflection, and config are invisible.",
  requiredConfirmation: "Runtime trace / test execution (out of scope)."
};

export const STATIC_PATH_UNCERTAINTY: UncertaintyItem = {
  item: "Static paths are not runtime-proven",
  reason: "Edges are static inferences (ADR 0001/0002); dynamic dispatch, DI, reflection, and config are invisible.",
  requiredConfirmation: "Runtime trace / debugger (out of scope)."
};
