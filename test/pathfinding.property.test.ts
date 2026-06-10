// Property-based tests for the static path-finding subsystem (Decision 0023). Dependency-free:
// a seeded PRNG generates random graphs and the algorithms are checked against simple reference
// ORACLES (naive BFS / reachability closure) plus structural INVARIANTS, over many cases. Seeds
// are deterministic, so any failure reprints the exact seed and `randomGraph(seed)` reproduces it.

import { describe, expect, it } from "vitest";

import type { CallEdge } from "../src/schema.js";
import { clampConfidence, type Confidence } from "../src/schema.js";
import {
  findBestConfidencePath,
  findFewestHopPath,
  findKBestPaths,
  inMemorySource,
  tarjanScc,
  type StaticPath
} from "../src/pathfinding.js";

// ---- Seeded PRNG (mulberry32) — deterministic, no Math.random ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONF = ["confirmed", "likely", "candidate", "unclear", "unresolved"] as const;
const RANK: Record<Confidence, number> = { confirmed: 5, likely: 4, candidate: 3, unclear: 2, unresolved: 1 };

/** A random graph: 2..7 nodes, edges (incl. self-loops + occasional parallel edges) with random confidence. */
function randomGraph(seed: number): { nodes: string[]; edges: CallEdge[] } {
  const rnd = mulberry32(seed);
  const n = 2 + Math.floor(rnd() * 6); // 2..7
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
  const edges: CallEdge[] = [];
  const add = (i: number, j: number) =>
    edges.push({ from: nodes[i], to: nodes[j], callKind: "direct", confidence: CONF[Math.floor(rnd() * CONF.length)], evidence: [] });
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (rnd() < 0.3) add(i, j); // includes i===j (self-loops)
      if (rnd() < 0.05) add(i, j); // occasional parallel edge (stresses k-best dedup)
    }
  }
  return { nodes, edges };
}

// ---- Reference oracles (ignore confidence; pure reachability) ----
function adjacency(nodes: string[], edges: CallEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>(nodes.map((id) => [id, []]));
  for (const e of edges) adj.get(e.from)!.push(e.to);
  return adj;
}
/** Fewest-hop distance s->t, or Infinity if unreachable. */
function bfsDist(adj: Map<string, string[]>, s: string, t: string): number {
  if (s === t) return 0;
  const dist = new Map<string, number>([[s, 0]]);
  const queue = [s];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const w of adj.get(cur) ?? []) {
      if (!dist.has(w)) {
        dist.set(w, dist.get(cur)! + 1);
        if (w === t) return dist.get(w)!;
        queue.push(w);
      }
    }
  }
  return Infinity;
}
/** Set of nodes reachable from s (including s). */
function reachableFrom(adj: Map<string, string[]>, s: string): Set<string> {
  const seen = new Set([s]);
  const queue = [s];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const w of adj.get(cur) ?? []) if (!seen.has(w)) (seen.add(w), queue.push(w));
  }
  return seen;
}

// ---- Shared invariant: a returned path is well-formed + confidence-correct ----
function assertValidPath(p: StaticPath, s: string, t: string): void {
  expect(p.nodes[0]).toBe(s);
  expect(p.nodes[p.nodes.length - 1]).toBe(t);
  expect(p.hops).toBe(p.edges.length);
  for (let i = 0; i < p.hops; i++) {
    expect(p.edges[i].from).toBe(p.nodes[i]);
    expect(p.edges[i].to).toBe(p.nodes[i + 1]);
  }
  expect(new Set(p.nodes).size).toBe(p.nodes.length); // simple path (no repeated node)
  // bottleneck is the weakest edge (or `likely` by convention for a zero-edge path).
  if (p.edges.length > 0) expect(RANK[p.bottleneck]).toBe(Math.min(...p.edges.map((e) => RANK[e.confidence])));
  else expect(p.bottleneck).toBe("likely");
  // emitted confidence is the bottleneck clamped to `likely` — never `confirmed` runtime truth.
  expect(p.confidence).toBe(clampConfidence(p.bottleneck, "likely"));
  expect(RANK[p.confidence]).toBeLessThanOrEqual(RANK.likely);
}

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);
/** Reprint the seed on any failure so the exact case is reproducible via randomGraph(seed). */
function forEachSeed(check: (seed: number) => void): void {
  for (const seed of SEEDS) {
    try {
      check(seed);
    } catch (e) {
      throw new Error(`seed ${seed}: ${(e as Error).message}`);
    }
  }
}

describe("property: Tarjan SCC equals the mutual-reachability partition", () => {
  it("componentOf groups nodes exactly by mutual reachability (oracle), and partitions the node set", () => {
    forEachSeed((seed) => {
      const { nodes, edges } = randomGraph(seed);
      const adj = adjacency(nodes, edges);
      const scc = tarjanScc(nodes, edges);

      // Partition: every node placed once, components cover the node set exactly.
      for (const id of nodes) expect(scc.componentOf.has(id)).toBe(true);
      const flat = scc.components.flat();
      expect(flat.length).toBe(new Set(flat).size); // no node in two components
      expect(new Set(flat)).toEqual(new Set(nodes)); // cover exactly

      // Oracle: a,b share a component  <=>  each reaches the other.
      const reach = new Map(nodes.map((id) => [id, reachableFrom(adj, id)]));
      for (const a of nodes) {
        for (const b of nodes) {
          const sameComponent = scc.componentOf.get(a) === scc.componentOf.get(b);
          const mutuallyReachable = reach.get(a)!.has(b) && reach.get(b)!.has(a);
          expect(sameComponent).toBe(mutuallyReachable);
        }
      }
    });
  });
});

describe("property: fewest-hop matches a naive BFS oracle", () => {
  it("returns null iff unreachable, else a valid path whose hop count equals BFS distance", () => {
    forEachSeed((seed) => {
      const { nodes, edges } = randomGraph(seed);
      const adj = adjacency(nodes, edges);
      const src = inMemorySource(edges);
      for (const s of nodes) {
        for (const t of nodes) {
          const p = findFewestHopPath(src, s, t);
          const d = bfsDist(adj, s, t);
          if (d === Infinity) {
            expect(p).toBeNull();
          } else {
            expect(p).not.toBeNull();
            expect(p!.hops).toBe(d); // bidirectional search == naive BFS distance
            assertValidPath(p!, s, t);
          }
        }
      }
    });
  });
});

describe("property: k-best paths are valid, distinct, ordered, and consistent", () => {
  it("each result is a valid simple path; results are distinct, ordered, and best == k-best[0]", () => {
    forEachSeed((seed) => {
      const { nodes, edges } = randomGraph(seed);
      const src = inMemorySource(edges);
      const k = 4;
      for (const s of nodes) {
        for (const t of nodes) {
          const ks = findKBestPaths(src, s, t, k);
          expect(ks.length).toBeLessThanOrEqual(k);

          const seqs = new Set<string>();
          for (const p of ks) {
            assertValidPath(p, s, t);
            seqs.add(p.nodes.join(">"));
          }
          expect(seqs.size).toBe(ks.length); // distinct node sequences (parallel edges never duplicate a path)

          // Ordering: non-increasing bottleneck, then non-decreasing hops, then non-decreasing penalty.
          for (let i = 1; i < ks.length; i++) {
            const a = ks[i - 1];
            const b = ks[i];
            const keyA = [-RANK[a.bottleneck], a.hops, a.penalty];
            const keyB = [-RANK[b.bottleneck], b.hops, b.penalty];
            // keyA <= keyB lexicographically (ties broken below these keys are allowed)
            let cmp = 0;
            for (let j = 0; j < keyA.length && cmp === 0; j++) cmp = keyA[j] - keyB[j];
            expect(cmp).toBeLessThanOrEqual(0);
          }

          // best-confidence is exactly the top of the k-best ordering.
          const best = findBestConfidencePath(src, s, t);
          if (ks.length === 0) expect(best).toBeNull();
          else expect(best?.nodes).toEqual(ks[0].nodes);
        }
      }
    });
  });
});

describe("clampConfidence — exhaustive over its finite 5x5 domain (stronger than sampling)", () => {
  it("never strengthens, never exceeds the ceiling, and is idempotent for every (level, ceiling) pair", () => {
    for (const level of CONF) {
      for (const ceiling of CONF) {
        const out = clampConfidence(level, ceiling);
        expect(RANK[out]).toBeLessThanOrEqual(RANK[ceiling]); // never exceeds ceiling
        expect(RANK[out]).toBeLessThanOrEqual(RANK[level]); // only weakens (or keeps)
        if (RANK[level] <= RANK[ceiling]) expect(out).toBe(level); // identity below the ceiling
        expect(clampConfidence(out, ceiling)).toBe(out); // idempotent
      }
    }
  });
});
