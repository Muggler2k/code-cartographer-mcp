// Static path-finding over the call graph (Decision 0023). Pure algorithms over a
// `NeighborSource` (in-memory or SQLite-backed), so correctness is testable in isolation
// from the index. CODEBASE-ONLY: every result is a STATIC path / possible path /
// reachability path — never a runtime stack or execution trace. Emitted confidence is
// clamped to `likely` (Decision 0016): a static path is never `confirmed` runtime truth.

import { clampConfidence, type Confidence } from "./contextMap.js";
import type { CallEdge, CallGraphNode } from "./callGraph.js";

/** Strength ordering (higher = stronger), mirrors contextMap's CONFIDENCE_RANK. */
const CONFIDENCE_RANK: Record<Confidence, number> = {
  confirmed: 5,
  likely: 4,
  candidate: 3,
  unclear: 2,
  unresolved: 1
};

/** A static path is never runtime-proven, so its reported confidence cannot exceed this. */
const PATH_CEILING: Confidence = "likely";

const DEFAULT_MAX_DEPTH = 24;
/** Safety bound for k-best best-first expansion so a dense graph cannot run unbounded. */
const KBEST_MAX_POPS = 200_000;

/**
 * Adjacency provider. `callees(id)` = outgoing edges (id is `from`); `callers(id)` =
 * incoming edges (id is `to`). Backed by an in-memory map or the SQLite graph index.
 */
export interface NeighborSource {
  callees(id: string): CallEdge[];
  callers(id: string): CallEdge[];
}

/** Structural query metrics — used by tests/benchmarks instead of brittle wall-clock thresholds. */
export interface QueryMetrics {
  /** Nodes whose neighbors were fetched (frontier expansions). */
  expandedNodeCount: number;
  /** Distinct nodes touched by the search. */
  visitedNodeCount: number;
  /** Calls into the NeighborSource — equals `sqliteQueryCount` when SQLite-backed. */
  neighborQueryCount: number;
  /** True if a bounded search hit its cap and may have dropped further results. */
  truncated: boolean;
}

export function createMetrics(): QueryMetrics {
  return { expandedNodeCount: 0, visitedNodeCount: 0, neighborQueryCount: 0, truncated: false };
}

export interface StaticPath {
  /** Ordered node ids, source → target (original ids — never condensed). */
  nodes: string[];
  /** The edges traversed, aligned with consecutive node pairs. */
  edges: CallEdge[];
  /** Edge count. */
  hops: number;
  /** Weakest edge confidence along the path (raw — used for ranking, not emitted as truth). */
  bottleneck: Confidence;
  /** Emitted path confidence: the bottleneck clamped to `likely` (Decision 0016). */
  confidence: Confidence;
  /** Sum of (confirmed-rank − edge-rank): 0 for an all-`confirmed` path; higher = weaker. */
  penalty: number;
}

export interface PathOptions {
  maxDepth?: number;
  /**
   * Cap on best-first pops for k-best enumeration (defaults to `KBEST_MAX_POPS`). Lets a
   * caller bound work on a dense graph; when hit, `metrics.truncated` is set so the cap is
   * never silent. Applies only to `findKBestPaths` (and `findBestConfidencePath`, which
   * delegates to it); `findFewestHopPath` ignores this option.
   */
  maxPops?: number;
}

// ---- In-memory adjacency ---------------------------------------------------

/** Build a NeighborSource backed by in-memory adjacency maps (fallback + test fixtures). */
export function inMemorySource(edges: CallEdge[]): NeighborSource {
  const fwd = new Map<string, CallEdge[]>();
  const rev = new Map<string, CallEdge[]>();
  for (const e of edges) {
    (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e);
    (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e);
  }
  return {
    callees: (id) => fwd.get(id) ?? [],
    callers: (id) => rev.get(id) ?? []
  };
}

// ---- Graph source: neighbors + node lookups (Decision 0024) -----------------

/**
 * A `NeighborSource` enriched with node-metadata lookups, so the analysis and
 * call-graph layers traverse ONE substrate (Decision 0024). Two implementations:
 * `inMemoryGraphSource` (from the JSON map — the guaranteed fallback) and the
 * SQLite-backed `GraphIndex` (the optimization). SQLite is optional, never required.
 */
export interface GraphSource extends NeighborSource {
  /** Node metadata by id, or undefined if absent. */
  getNode(id: string): CallGraphNode | undefined;
  /** Nodes whose `symbol` equals the query (indexed lookup, not a scan). */
  findNodesBySymbol(symbol: string): CallGraphNode[];
  /** Nodes whose `path` equals the query (indexed lookup, not a scan). */
  findNodesByPath(path: string): CallGraphNode[];
  /** Every node — only for the substring-match fallback in subject resolution. */
  allNodes(): CallGraphNode[];
  /** Release held resources (a DB handle for the index; a no-op in-memory). */
  close(): void;
}

/** Build an in-memory `GraphSource` from a call graph — the guaranteed fallback (Decision 0024). */
export function inMemoryGraphSource(nodes: CallGraphNode[], edges: CallEdge[]): GraphSource {
  const neighbors = inMemorySource(edges);
  const byId = new Map<string, CallGraphNode>();
  const bySymbol = new Map<string, CallGraphNode[]>();
  const byPath = new Map<string, CallGraphNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    (bySymbol.get(n.symbol) ?? bySymbol.set(n.symbol, []).get(n.symbol)!).push(n);
    (byPath.get(n.path) ?? byPath.set(n.path, []).get(n.path)!).push(n);
  }
  return {
    callees: neighbors.callees,
    callers: neighbors.callers,
    getNode: (id) => byId.get(id),
    findNodesBySymbol: (symbol) => bySymbol.get(symbol) ?? [],
    findNodesByPath: (path) => byPath.get(path) ?? [],
    allNodes: () => nodes,
    close: () => {}
  };
}

// ---- Path construction helpers --------------------------------------------

function bottleneckOf(edges: CallEdge[]): Confidence {
  // A zero-edge path (from === to) has no measured weakest edge; report the ceiling by
  // convention. It is never `confirmed` — a static path is not runtime truth (Decision 0016).
  if (edges.length === 0) return PATH_CEILING;
  let weakest: Confidence = "confirmed";
  for (const e of edges) {
    if (CONFIDENCE_RANK[e.confidence] < CONFIDENCE_RANK[weakest]) weakest = e.confidence;
  }
  return weakest;
}

function penaltyOf(edges: CallEdge[]): number {
  return edges.reduce((sum, e) => sum + (CONFIDENCE_RANK.confirmed - CONFIDENCE_RANK[e.confidence]), 0);
}

function makePath(nodes: string[], edges: CallEdge[]): StaticPath {
  const bottleneck = bottleneckOf(edges);
  return {
    nodes,
    edges,
    hops: edges.length,
    bottleneck,
    confidence: clampConfidence(bottleneck, PATH_CEILING),
    penalty: penaltyOf(edges)
  };
}

/** Sort outgoing edges by target id for deterministic expansion order. */
function sortedByTarget(edges: CallEdge[]): CallEdge[] {
  return [...edges].sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** Lexicographic compare of two node-id sequences (deterministic tie-break). */
function seqCompare(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

// ---- Fewest-hop: bidirectional BFS ----------------------------------------

interface FwdParent {
  prev: string;
  edge: CallEdge;
}
interface BwdParent {
  next: string;
  edge: CallEdge;
}

/**
 * Minimum-hop static path via **bidirectional BFS** — expands from both endpoints and
 * meets in the middle, so a close pair never expands the whole graph. Among equal-length
 * shortest paths a deterministic one is returned (stable across runs via sorted expansion
 * and a lexicographic tie-break over meeting nodes) — not guaranteed to be the globally
 * lexicographically-smallest path. Returns null when the target is unreachable or the
 * shortest path exceeds `maxDepth`.
 */
export function findFewestHopPath(
  source: NeighborSource,
  from: string,
  to: string,
  opts?: PathOptions,
  metrics?: QueryMetrics
): StaticPath | null {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (from === to) {
    if (metrics) metrics.visitedNodeCount = 1;
    return makePath([from], []);
  }

  const distF = new Map<string, number>([[from, 0]]);
  const distB = new Map<string, number>([[to, 0]]);
  const parentF = new Map<string, FwdParent>();
  const parentB = new Map<string, BwdParent>();
  let frontierF = [from];
  let frontierB = [to];
  let expandForward = true; // toggled on ties for deterministic, balanced expansion

  const finish = (result: StaticPath | null): StaticPath | null => {
    if (metrics) {
      const union = new Set<string>([...distF.keys(), ...distB.keys()]);
      metrics.visitedNodeCount = union.size;
    }
    return result;
  };

  while (frontierF.length > 0 && frontierB.length > 0) {
    const goForward = frontierF.length < frontierB.length || (frontierF.length === frontierB.length && expandForward);
    if (frontierF.length === frontierB.length) expandForward = !expandForward;

    if (goForward) {
      const next: string[] = [];
      for (const cur of frontierF) {
        if (metrics) {
          metrics.expandedNodeCount++;
          metrics.neighborQueryCount++;
        }
        for (const edge of sortedByTarget(source.callees(cur))) {
          if (!distF.has(edge.to)) {
            distF.set(edge.to, distF.get(cur)! + 1);
            parentF.set(edge.to, { prev: cur, edge });
            next.push(edge.to);
          }
        }
      }
      frontierF = next;
    } else {
      const next: string[] = [];
      for (const cur of frontierB) {
        if (metrics) {
          metrics.expandedNodeCount++;
          metrics.neighborQueryCount++;
        }
        for (const edge of [...source.callers(cur)].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))) {
          if (!distB.has(edge.from)) {
            distB.set(edge.from, distB.get(cur)! + 1);
            parentB.set(edge.from, { next: cur, edge });
            next.push(edge.from);
          }
        }
      }
      frontierB = next;
    }

    // Meet check: any node known to both searches completes a path.
    const meets: string[] = [];
    const [small, large] = distF.size <= distB.size ? [distF, distB] : [distB, distF];
    for (const id of small.keys()) {
      if (large.has(id)) meets.push(id);
    }
    if (meets.length > 0) {
      let best: StaticPath | null = null;
      for (const meet of meets) {
        const candidate = reconstructBidi(meet, from, to, parentF, parentB);
        if (candidate.hops > maxDepth) continue;
        if (!best || candidate.hops < best.hops || (candidate.hops === best.hops && seqCompare(candidate.nodes, best.nodes) < 0)) {
          best = candidate;
        }
      }
      return finish(best);
    }
  }
  return finish(null);
}

function reconstructBidi(
  meet: string,
  from: string,
  to: string,
  parentF: Map<string, FwdParent>,
  parentB: Map<string, BwdParent>
): StaticPath {
  const fNodes: string[] = [meet];
  const fEdges: CallEdge[] = [];
  let cur = meet;
  while (cur !== from) {
    const p = parentF.get(cur)!;
    fEdges.push(p.edge);
    fNodes.push(p.prev);
    cur = p.prev;
  }
  fNodes.reverse();
  fEdges.reverse();

  const bNodes: string[] = [];
  const bEdges: CallEdge[] = [];
  cur = meet;
  while (cur !== to) {
    const p = parentB.get(cur)!;
    bEdges.push(p.edge);
    bNodes.push(p.next);
    cur = p.next;
  }
  return makePath([...fNodes, ...bNodes], [...fEdges, ...bEdges]);
}

// ---- k-best: best-first ordered enumeration -------------------------------

interface PartialPath {
  nodes: string[];
  edges: CallEdge[];
  bottleneckRank: number;
  hops: number;
  penalty: number;
}

/**
 * Order: (1) strongest bottleneck confidence, (2) fewest hops, (3) lowest confidence
 * penalty, (4) deterministic lexicographic tie-break. Returns negative when `a` ranks
 * ahead of `b`. A prefix DOMINATES its extensions on every key (bottleneck can only
 * weaken, hops/penalty only grow), so popping complete paths in this order yields them
 * best-first — a principled k-best, not arbitrary DFS enumeration.
 */
function comparePartial(a: PartialPath, b: PartialPath): number {
  if (a.bottleneckRank !== b.bottleneckRank) return b.bottleneckRank - a.bottleneckRank;
  if (a.hops !== b.hops) return a.hops - b.hops;
  if (a.penalty !== b.penalty) return a.penalty - b.penalty;
  return seqCompare(a.nodes, b.nodes);
}

/** Binary min-heap keyed by `comparePartial` (best = top). */
class PathHeap {
  private items: PartialPath[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: PartialPath): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (comparePartial(items[i], items[parent]) >= 0) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }
  pop(): PartialPath | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < items.length && comparePartial(items[l], items[smallest]) < 0) smallest = l;
        if (r < items.length && comparePartial(items[r], items[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Up to `k` best static paths from `from` to `to`, ordered by the k-best criteria above.
 * Only simple paths (no repeated node) up to `maxDepth` hops are considered. Bounded by
 * `KBEST_MAX_POPS`; if hit, `metrics.truncated` is set so the cap is never silent.
 */
export function findKBestPaths(
  source: NeighborSource,
  from: string,
  to: string,
  k: number,
  opts?: PathOptions,
  metrics?: QueryMetrics
): StaticPath[] {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPops = opts?.maxPops ?? KBEST_MAX_POPS;
  const results: StaticPath[] = [];
  if (k <= 0) return results;

  const heap = new PathHeap();
  heap.push({ nodes: [from], edges: [], bottleneckRank: CONFIDENCE_RANK.confirmed, hops: 0, penalty: 0 });
  const seen = new Set<string>(); // distinct node sequences — parallel/duplicate edges must not duplicate a path

  let pops = 0;
  while (heap.size > 0 && results.length < k) {
    if (pops++ >= maxPops) {
      if (metrics) metrics.truncated = true;
      break;
    }
    const cur = heap.pop()!;
    const last = cur.nodes[cur.nodes.length - 1];
    if (last === to) {
      // Emit each distinct node sequence once. `to` is a path endpoint and the simple-path
      // guard below forbids revisiting it, so there is no cycle-back-to-`to` to explore.
      const key = cur.nodes.join(" ");
      if (!seen.has(key)) {
        seen.add(key);
        results.push(makePath(cur.nodes, cur.edges));
      }
      continue;
    }
    if (cur.hops >= maxDepth) continue;
    if (metrics) {
      metrics.expandedNodeCount++;
      metrics.neighborQueryCount++;
    }
    for (const edge of sortedByTarget(source.callees(last))) {
      if (cur.nodes.includes(edge.to)) continue; // simple paths only
      heap.push({
        nodes: [...cur.nodes, edge.to],
        edges: [...cur.edges, edge],
        bottleneckRank: Math.min(cur.bottleneckRank, CONFIDENCE_RANK[edge.confidence]),
        hops: cur.hops + 1,
        penalty: cur.penalty + (CONFIDENCE_RANK.confirmed - CONFIDENCE_RANK[edge.confidence])
      });
    }
  }
  if (metrics) metrics.visitedNodeCount = Math.max(metrics.visitedNodeCount, results.reduce((n, p) => n + p.nodes.length, 0));
  return results;
}

/**
 * Single best-confidence static path: a **max-bottleneck (widest-path) search** that
 * maximizes the weakest edge confidence, ties broken by fewest hops then lowest penalty.
 * Implemented as the top of the k-best ordering so the two stay consistent. Returns null
 * when unreachable.
 */
export function findBestConfidencePath(
  source: NeighborSource,
  from: string,
  to: string,
  opts?: PathOptions,
  metrics?: QueryMetrics
): StaticPath | null {
  return findKBestPaths(source, from, to, 1, opts, metrics)[0] ?? null;
}

// ---- Strongly-connected components: Tarjan (iterative) --------------------

export interface SccResult {
  /** Each entry is the node ids of one strongly-connected component. */
  components: string[][];
  /** node id → index into `components`. */
  componentOf: Map<string, number>;
}

/**
 * Tarjan's SCC, iterative (no recursion → safe for deep/large graphs). Built ONCE per
 * graph snapshot by the index and cached; same-component membership answers reachability
 * immediately (Decision 0023). Isolated nodes are singleton components. Node ids are
 * preserved verbatim — the condensation never renames or replaces them.
 */
export function tarjanScc(nodeIds: string[], edges: CallEdge[]): SccResult {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
  }
  const allIds = [...adj.keys()];

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();
  const components: string[][] = [];
  let counter = 0;

  for (const start of allIds) {
    if (index.has(start)) continue;
    // Iterative DFS frame: node + the position of the next successor to visit.
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    index.set(start, counter);
    lowlink.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const succ = adj.get(frame.node)!;
      if (frame.next < succ.length) {
        const w = succ[frame.next++];
        if (!index.has(w)) {
          index.set(w, counter);
          lowlink.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, next: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(w)!));
        }
      } else {
        // All successors done: if root of an SCC, pop it off the stack.
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const comp: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            componentOf.set(w, components.length);
            comp.push(w);
            if (w === frame.node) break;
          }
          components.push(comp);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].node;
          lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(frame.node)!));
        }
      }
    }
  }
  return { components, componentOf };
}
