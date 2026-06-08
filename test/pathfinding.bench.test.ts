// Performance benchmarks for the static path-finding subsystem (Decision 0023).
// These are STRUCTURAL benchmarks: they record metrics (durationMs, expanded/visited/
// sqliteQueryCount, pathLength, resultCount) and assert structural invariants (indexed
// lookups, bidirectional locality, SCC-built-once, k/maxDepth respected) rather than
// brittle wall-clock thresholds. Durations are logged for visibility, not asserted tightly.

import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildGraphIndex, GraphIndex, openGraphIndex } from "../src/graphIndex.js";
import {
  createMetrics,
  findBestConfidencePath,
  findFewestHopPath,
  findKBestPaths,
  inMemorySource,
  tarjanScc,
  type QueryMetrics
} from "../src/pathfinding.js";

const CONF = ["confirmed", "likely", "candidate", "unclear", "unresolved"] as const;

interface MiniNode {
  id: string;
  symbol: string;
  path: string;
  kind: string;
  confidence: string;
}
interface MiniEdge {
  from: string;
  to: string;
  callKind: string;
  confidence: string;
  evidence: string[];
}

function mkNode(id: string): MiniNode {
  return { id, symbol: id, path: `${id}.ts`, kind: "function", confidence: "likely" };
}
function mkEdge(from: string, to: string, confidence: string): MiniEdge {
  return { from, to, callKind: "direct", confidence, evidence: [] };
}

/** Deterministic layered DAG: `layers` × `width`, each node fans out to `fanout` next-layer nodes. */
function makeLayered(layers: number, width: number, fanout: number): { nodes: MiniNode[]; edges: MiniEdge[] } {
  const nodes: MiniNode[] = [];
  const edges: MiniEdge[] = [];
  const id = (l: number, w: number) => `n${l}_${w}`;
  for (let l = 0; l < layers; l++) for (let w = 0; w < width; w++) nodes.push(mkNode(id(l, w)));
  for (let l = 0; l < layers - 1; l++) {
    for (let w = 0; w < width; w++) {
      for (let f = 0; f < fanout; f++) {
        const tw = (w * 7 + f * 13 + l) % width;
        edges.push(mkEdge(id(l, w), id(l + 1, tw), CONF[(w + f) % CONF.length]));
      }
    }
  }
  return { nodes, edges };
}

/** Dense single-SCC ring of `n` nodes with `chords` forward chords each (all mutually reachable). */
function makeDenseScc(n: number, chords: number): { nodes: MiniNode[]; edges: MiniEdge[] } {
  const nodes: MiniNode[] = [];
  const edges: MiniEdge[] = [];
  const id = (i: number) => `r${i}`;
  for (let i = 0; i < n; i++) nodes.push(mkNode(id(i)));
  for (let i = 0; i < n; i++) {
    edges.push(mkEdge(id(i), id((i + 1) % n), "confirmed")); // ring → one SCC
    for (let c = 1; c <= chords; c++) edges.push(mkEdge(id(i), id((i + 1 + c) % n), CONF[c % CONF.length]));
  }
  return { nodes, edges };
}

async function writeMap(root: string, mapHash: string, nodes: MiniNode[], edges: MiniEdge[]): Promise<void> {
  const dir = path.join(root, ".code-cartographer-mcp");
  await fs.mkdir(dir, { recursive: true });
  const map = {
    meta: { schemaVersion: 1, toolVersion: "0.1.0", generatedAt: "t", repositoryRoot: root, mapHash, codebaseOnlyBoundary: true },
    summary: {},
    files: [],
    callGraph: { nodes, edges },
    findings: {}
  };
  await fs.writeFile(path.join(dir, "context-map.json"), JSON.stringify(map));
}

interface MetricRow {
  graph: string;
  nodeCount: number;
  edgeCount: number;
  queryName: string;
  durationMs: number;
  expandedNodeCount?: number;
  visitedNodeCount?: number;
  sqliteQueryCount?: number;
  pathLength?: number;
  resultCount?: number;
}
const ROWS: MetricRow[] = [];

function timed<T>(fn: () => T): { result: T; durationMs: number } {
  const start = performance.now();
  const result = fn();
  return { result, durationMs: +(performance.now() - start).toFixed(3) };
}

const tmpRoots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-bench-"));
  tmpRoots.push(r);
  return r;
}

afterAll(async () => {
  // Emit the recorded metrics table for the implementation note.
  // eslint-disable-next-line no-console
  console.table(ROWS);
  for (const r of tmpRoots) await fs.rm(r, { recursive: true, force: true });
});

interface Sized {
  label: string;
  layers: number;
  width: number;
  fanout: number;
}
const SIZES: Sized[] = [
  { label: "small", layers: 10, width: 10, fanout: 5 }, // ~100 nodes / ~450 edges
  { label: "medium", layers: 20, width: 50, fanout: 5 }, // ~1,000 nodes / ~4,750 edges
  { label: "large", layers: 50, width: 200, fanout: 5 } // ~10,000 nodes / ~49,000 edges
];

describe("benchmarks — layered DAG (in-memory + SQLite)", () => {
  for (const size of SIZES) {
    it(`${size.label}: indexed lookups, bidirectional locality, build time`, async () => {
      const { nodes, edges } = makeLayered(size.layers, size.width, size.fanout);
      const root = await freshRoot();
      await writeMap(root, `h-${size.label}`, nodes, edges);

      // SQLite build time.
      const buildStart = performance.now();
      await buildGraphIndex(root);
      const buildMs = +(performance.now() - buildStart).toFixed(3);
      ROWS.push({ graph: size.label, nodeCount: nodes.length, edgeCount: edges.length, queryName: "sqlite-build", durationMs: buildMs });

      const index = (await openGraphIndex(root)) as GraphIndex;
      try {
        // findCallees / findCallers — must be single indexed lookups, never a scan.
        const src0 = "n0_0";
        const before = index.sqliteQueryCount;
        const callees = timed(() => index.findCallees(src0));
        expect(index.sqliteQueryCount - before).toBe(1);
        ROWS.push({ graph: size.label, nodeCount: nodes.length, edgeCount: edges.length, queryName: "findCallees", durationMs: callees.durationMs, sqliteQueryCount: 1, resultCount: callees.result.length });

        const before2 = index.sqliteQueryCount;
        const callers = timed(() => index.findCallers("n1_0"));
        expect(index.sqliteQueryCount - before2).toBe(1);
        ROWS.push({ graph: size.label, nodeCount: nodes.length, edgeCount: edges.length, queryName: "findCallers", durationMs: callers.durationMs, sqliteQueryCount: 1, resultCount: callers.result.length });

        // Fewest-hop on a CLOSE pair (adjacent layers): bidirectional must stay local.
        const target = index.findCallees(src0)[0].to;
        const mClose: QueryMetrics = createMetrics();
        const before3 = index.sqliteQueryCount;
        const close = timed(() => findFewestHopPath(index, src0, target, undefined, mClose));
        ROWS.push({ graph: size.label, nodeCount: nodes.length, edgeCount: edges.length, queryName: "fewest-hop(close)", durationMs: close.durationMs, expandedNodeCount: mClose.expandedNodeCount, visitedNodeCount: mClose.visitedNodeCount, sqliteQueryCount: index.sqliteQueryCount - before3, pathLength: close.result?.hops });
        expect(close.result?.hops).toBe(1);
        expect(mClose.visitedNodeCount).toBeLessThan(nodes.length); // did NOT expand the whole graph

        // Fewest-hop END-TO-END (layer 0 → last layer): still bounded by bidirectional search.
        const dst = "n" + (size.layers - 1) + "_0";
        const mEnd: QueryMetrics = createMetrics();
        // Explicit maxDepth: an N-layer DAG needs N-1 hops end-to-end (default cap is 24).
        const end = timed(() => findFewestHopPath(index, src0, dst, { maxDepth: size.layers }, mEnd));
        ROWS.push({ graph: size.label, nodeCount: nodes.length, edgeCount: edges.length, queryName: "fewest-hop(end)", durationMs: end.durationMs, expandedNodeCount: mEnd.expandedNodeCount, visitedNodeCount: mEnd.visitedNodeCount, pathLength: end.result?.hops });
        expect(end.result).not.toBeNull();
        expect(end.result!.hops).toBeLessThanOrEqual(size.layers - 1);
      } finally {
        index.close();
      }
    });
  }
});

describe("benchmarks — best-confidence & k-best (small/medium)", () => {
  for (const size of SIZES.slice(0, 2)) {
    it(`${size.label}: best-confidence + bounded k-best`, async () => {
      const { nodes, edges } = makeLayered(size.layers, size.width, size.fanout);
      const src = inMemorySource(edges);
      const from = "n0_0";
      const maxDepth = Math.min(size.layers - 1, 8);

      // Reachable target via fewest-hop, so k-best terminates fast.
      const reach = findFewestHopPath(src, from, "n" + (size.layers - 1) + "_0", { maxDepth: size.layers });
      const to = reach ? reach.nodes[Math.min(reach.nodes.length - 1, maxDepth)] : from;

      const mBest = createMetrics();
      const best = timed(() => findBestConfidencePath(src, from, to, { maxDepth }, mBest));
      ROWS.push({ graph: size.label, nodeCount: nodes.length, edgeCount: edges.length, queryName: "best-confidence", durationMs: best.durationMs, expandedNodeCount: mBest.expandedNodeCount, pathLength: best.result?.hops, resultCount: best.result ? 1 : 0 });
      expect(best.result).not.toBeNull();

      const k = 5;
      const mK = createMetrics();
      const kbest = timed(() => findKBestPaths(src, from, to, k, { maxDepth }, mK));
      ROWS.push({ graph: size.label, nodeCount: nodes.length, edgeCount: edges.length, queryName: `k-best(k=${k})`, durationMs: kbest.durationMs, expandedNodeCount: mK.expandedNodeCount, resultCount: kbest.result.length });
      expect(kbest.result.length).toBeLessThanOrEqual(k); // respects k
      for (const p of kbest.result) expect(p.hops).toBeLessThanOrEqual(maxDepth); // respects maxDepth
      // Ordering invariant: non-increasing bottleneck strength across the k results.
      const rank: Record<string, number> = { confirmed: 5, likely: 4, candidate: 3, unclear: 2, unresolved: 1 };
      for (let i = 1; i < kbest.result.length; i++) {
        expect(rank[kbest.result[i].bottleneck]).toBeLessThanOrEqual(rank[kbest.result[i - 1].bottleneck]);
      }
    });
  }
});

describe("benchmarks — SCC build on a dense cyclic graph", () => {
  it("condenses one big SCC; build is a single pass", async () => {
    const n = 2000;
    const chords = 3;
    const { nodes, edges } = makeDenseScc(n, chords);
    const root = await freshRoot();
    await writeMap(root, "h-scc", nodes, edges);
    const index = (await openGraphIndex(root)) as GraphIndex;
    try {
      const built = timed(() => index.getScc());
      ROWS.push({ graph: "dense-scc", nodeCount: nodes.length, edgeCount: edges.length, queryName: "scc-build", durationMs: built.durationMs, resultCount: built.result.components.length });
      // The ring makes all n nodes one strongly-connected component.
      expect(built.result.components.length).toBe(1);
      expect(built.result.components[0].length).toBe(n);

      // Many same-component queries must NOT rebuild the condensation.
      for (let i = 0; i < 100; i++) index.sameComponent("r0", `r${i}`);
      expect(index.sccBuildCount).toBe(1);

      // Pure Tarjan timing on the same graph (no SQLite), for the record.
      const pure = timed(() => tarjanScc(nodes.map((x) => x.id), edges as never));
      ROWS.push({ graph: "dense-scc", nodeCount: nodes.length, edgeCount: edges.length, queryName: "scc-tarjan(pure)", durationMs: pure.durationMs, resultCount: pure.result.components.length });
    } finally {
      index.close();
    }
  });
});
