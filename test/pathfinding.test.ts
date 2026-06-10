import { describe, expect, it } from "vitest";

import type { CallEdge } from "../src/schema.js";
import {
  createMetrics,
  findBestConfidencePath,
  findFewestHopPath,
  findKBestPaths,
  inMemorySource,
  tarjanScc,
  type StaticPath
} from "../src/pathfinding.js";

// ---- Fixtures -------------------------------------------------------------

/** Build a CallEdge with a confidence and (optional) call kind. */
function edge(from: string, to: string, confidence: CallEdge["confidence"], callKind: CallEdge["callKind"] = "direct"): CallEdge {
  return { from, to, callKind, confidence, evidence: [`${from}->${to}`] };
}

const ids = (p: StaticPath | null): string[] | null => (p ? p.nodes : null);

describe("pathfinding — termination & cycles", () => {
  // A -> B -> C -> A  (mutual recursion / cycle), plus C -> Z exit.
  const cyclic = [edge("A", "B", "confirmed"), edge("B", "C", "confirmed"), edge("C", "A", "confirmed"), edge("C", "Z", "likely")];

  it("terminates on a cycle and returns a valid path when reachable", () => {
    const src = inMemorySource(cyclic);
    const path = findFewestHopPath(src, "A", "Z");
    expect(ids(path)).toEqual(["A", "B", "C", "Z"]);
  });

  it("terminates when the target is on the cycle itself (no infinite loop)", () => {
    const src = inMemorySource(cyclic);
    const path = findFewestHopPath(src, "A", "C");
    expect(ids(path)).toEqual(["A", "B", "C"]);
  });
});

describe("pathfinding — no-path case", () => {
  // A -> B ; Z is isolated (unreachable from A).
  const disjoint = [edge("A", "B", "confirmed"), edge("X", "Z", "confirmed")];

  it("returns null when the target is unreachable (no exception)", () => {
    const src = inMemorySource(disjoint);
    expect(findFewestHopPath(src, "A", "Z")).toBeNull();
    expect(findBestConfidencePath(src, "A", "Z")).toBeNull();
    expect(findKBestPaths(src, "A", "Z", 5)).toEqual([]);
  });

  it("returns a trivial zero-hop path when from === to", () => {
    const src = inMemorySource(disjoint);
    const path = findFewestHopPath(src, "A", "A");
    expect(ids(path)).toEqual(["A"]);
    expect(path?.hops).toBe(0);
  });
});

describe("pathfinding — best-confidence is not necessarily shortest", () => {
  //   A -> B -> Z          (likely, unclear)      bottleneck = unclear, 2 hops
  //   A -> C -> D -> Z      (confirmed x3)         bottleneck = confirmed, 3 hops
  const graph = [
    edge("A", "B", "likely"),
    edge("B", "Z", "unclear"),
    edge("A", "C", "confirmed"),
    edge("C", "D", "confirmed"),
    edge("D", "Z", "confirmed")
  ];

  it("fewest-hop path takes the 2-hop weak route", () => {
    const src = inMemorySource(graph);
    expect(ids(findFewestHopPath(src, "A", "Z"))).toEqual(["A", "B", "Z"]);
  });

  it("best-confidence path takes the longer all-confirmed route", () => {
    const src = inMemorySource(graph);
    expect(ids(findBestConfidencePath(src, "A", "Z"))).toEqual(["A", "C", "D", "Z"]);
  });

  it("emitted path confidence is clamped to `likely` (never confirmed runtime truth)", () => {
    const src = inMemorySource(graph);
    const best = findBestConfidencePath(src, "A", "Z");
    expect(best?.bottleneck).toBe("confirmed"); // raw bottleneck used for ranking
    expect(best?.confidence).toBe("likely"); // emitted confidence clamped (ADR 0016)
  });

  it("delegates the maxPops cap (best-confidence is bounded too)", () => {
    const src = inMemorySource(graph);
    const m = createMetrics();
    // A cap of 1 truncates before any complete path is popped → null, flag set.
    expect(findBestConfidencePath(src, "A", "Z", { maxPops: 1 }, m)).toBeNull();
    expect(m.truncated).toBe(true);
    // Uncapped, the same query still finds the all-confirmed route — default unchanged.
    expect(ids(findBestConfidencePath(src, "A", "Z"))).toEqual(["A", "C", "D", "Z"]);
  });
});

describe("pathfinding — k-best ordering", () => {
  // Ordering: (1) strongest bottleneck, (2) fewest hops, (3) lowest penalty, (4) deterministic tie-break.
  const graph = [
    edge("A", "B", "likely"),
    edge("B", "Z", "unclear"), // path1: A,B,Z  bottleneck unclear, 2 hops
    edge("A", "C", "confirmed"),
    edge("C", "D", "confirmed"),
    edge("D", "Z", "confirmed"), // path2: A,C,D,Z bottleneck confirmed, 3 hops
    edge("A", "E", "confirmed"),
    edge("E", "Z", "likely") // path3: A,E,Z bottleneck likely, 2 hops
  ];

  it("orders by strongest bottleneck first, then fewest hops", () => {
    const src = inMemorySource(graph);
    const paths = findKBestPaths(src, "A", "Z", 5);
    expect(paths.map(ids)).toEqual([
      ["A", "C", "D", "Z"], // confirmed bottleneck
      ["A", "E", "Z"], // likely bottleneck, 2 hops
      ["A", "B", "Z"] // unclear bottleneck
    ]);
  });

  it("respects the k limit", () => {
    const src = inMemorySource(graph);
    expect(findKBestPaths(src, "A", "Z", 2).map(ids)).toEqual([
      ["A", "C", "D", "Z"],
      ["A", "E", "Z"]
    ]);
  });

  it("respects maxDepth (drops paths that exceed it)", () => {
    const src = inMemorySource(graph);
    // maxDepth 2 (<=2 hops) excludes the 3-hop confirmed path.
    const paths = findKBestPaths(src, "A", "Z", 5, { maxDepth: 2 });
    expect(paths.map(ids)).toEqual([
      ["A", "E", "Z"],
      ["A", "B", "Z"]
    ]);
  });
});

describe("pathfinding — fewest-hop bidirectional search stays local", () => {
  // Long chain A0->A1->...->A6 ; query close pair should not expand the whole chain.
  const chain: CallEdge[] = [];
  for (let i = 0; i < 6; i++) chain.push(edge(`A${i}`, `A${i + 1}`, "confirmed"));

  it("returns the shortest hop path on a chain", () => {
    const src = inMemorySource(chain);
    expect(ids(findFewestHopPath(src, "A0", "A6"))).toEqual(["A0", "A1", "A2", "A3", "A4", "A5", "A6"]);
  });

  it("expands fewer nodes than the full graph for a close pair (bidirectional)", () => {
    // Star: HUB called by many, calls many; A -> HUB -> B is 2 hops but HUB has high degree.
    const star: CallEdge[] = [edge("A", "HUB", "confirmed"), edge("HUB", "B", "confirmed")];
    for (let i = 0; i < 50; i++) star.push(edge("HUB", `leaf${i}`, "confirmed"));
    const src = inMemorySource(star);
    const m = createMetrics();
    const path = findFewestHopPath(src, "A", "B", undefined, m);
    expect(ids(path)).toEqual(["A", "HUB", "B"]);
    // Bidirectional BFS meeting at HUB must not expand all 50 leaves from HUB before stopping.
    expect(m.visitedNodeCount).toBeLessThan(50);
  });
});

describe("pathfinding — SCC condensation", () => {
  // {A,B,C} is one strongly connected component (A->B->C->A); plus C->Z (Z alone).
  const edges = [edge("A", "B", "confirmed"), edge("B", "C", "confirmed"), edge("C", "A", "confirmed"), edge("C", "Z", "likely")];
  const nodeIds = ["A", "B", "C", "Z"];

  it("groups the mutually-recursive nodes into one component", () => {
    const scc = tarjanScc(nodeIds, edges);
    const compA = scc.componentOf.get("A");
    expect(scc.componentOf.get("B")).toBe(compA);
    expect(scc.componentOf.get("C")).toBe(compA);
    expect(scc.componentOf.get("Z")).not.toBe(compA);
  });

  it("same-SCC reachability is immediate and the path uses original node IDs", () => {
    const scc = tarjanScc(nodeIds, edges);
    // A and C share a component -> reachable without a full search.
    expect(scc.componentOf.get("A")).toBe(scc.componentOf.get("C"));
    // The concrete path is still reconstructed with the original IDs.
    const src = inMemorySource(edges);
    expect(ids(findFewestHopPath(src, "A", "C"))).toEqual(["A", "B", "C"]);
  });
});

describe("pathfinding — duplicate/parallel edges", () => {
  // Two A->B edges (e.g. a `direct` and a re-emitted edge) plus B->Z.
  const parallel = [edge("A", "B", "confirmed"), edge("A", "B", "likely"), edge("B", "Z", "confirmed")];

  it("k-best does not emit duplicate node sequences from parallel edges", () => {
    const src = inMemorySource(parallel);
    const paths = findKBestPaths(src, "A", "Z", 5);
    expect(paths.map(ids)).toEqual([["A", "B", "Z"]]); // exactly one distinct path, not two
  });
});

describe("pathfinding — k-best pop cap is never silent (truncation flag)", () => {
  // Three distinct 2-hop S->T paths; a tiny maxPops forces the cap before all are emitted.
  const fan = [
    edge("S", "A", "confirmed"),
    edge("S", "B", "confirmed"),
    edge("S", "C", "confirmed"),
    edge("A", "T", "confirmed"),
    edge("B", "T", "confirmed"),
    edge("C", "T", "confirmed")
  ];

  it("sets metrics.truncated and returns a bounded (partial) result when the cap trips", () => {
    const src = inMemorySource(fan);
    const m = createMetrics();
    const paths = findKBestPaths(src, "S", "T", 100, { maxPops: 5 }, m);
    expect(m.truncated).toBe(true); // the cap was hit — not silent
    expect(paths.length).toBeGreaterThanOrEqual(1); // it still returned what it found...
    expect(paths.length).toBeLessThan(3); // ...but stopped short of all three paths
    // What it did return is a real, well-formed S->T path, not garbage.
    for (const p of paths) {
      expect(p.nodes[0]).toBe("S");
      expect(p.nodes[p.nodes.length - 1]).toBe("T");
      expect(p.hops).toBe(p.edges.length);
    }
  });

  it("leaves metrics.truncated false on a normal (uncapped) search", () => {
    const src = inMemorySource(fan);
    const m = createMetrics();
    const paths = findKBestPaths(src, "S", "T", 100, undefined, m);
    expect(m.truncated).toBe(false);
    expect(paths.length).toBe(3); // all distinct paths, no truncation
  });
});

describe("pathfinding — fewest-hop respects maxDepth", () => {
  const chain: CallEdge[] = [];
  for (let i = 0; i < 4; i++) chain.push(edge(`A${i}`, `A${i + 1}`, "confirmed")); // A0..A4, shortest = 4 hops

  it("returns the path when it is within maxDepth", () => {
    const src = inMemorySource(chain);
    expect(ids(findFewestHopPath(src, "A0", "A4", { maxDepth: 4 }))).toEqual(["A0", "A1", "A2", "A3", "A4"]);
  });

  it("returns null when the shortest path exceeds maxDepth", () => {
    const src = inMemorySource(chain);
    expect(findFewestHopPath(src, "A0", "A4", { maxDepth: 3 })).toBeNull();
  });
});

describe("pathfinding — determinism (stable, insertion-order-independent tie-break)", () => {
  // Two equal-length routes A->B->Z and A->C->Z. A naive first-meet-wins search records
  // whichever route's edges were inserted first, so the two insertion orders below would
  // diverge (A,B,Z vs A,C,Z); the sorted expansion + lexicographic tie-break must collapse
  // both to the SAME path. This is what makes the test fail if the tie-break/sort regresses.
  const ab = [edge("A", "B", "confirmed"), edge("B", "Z", "confirmed")];
  const ac = [edge("A", "C", "confirmed"), edge("C", "Z", "confirmed")];

  it("returns the same shortest path on every run", () => {
    const src = inMemorySource([...ab, ...ac]);
    const first = ids(findFewestHopPath(src, "A", "Z"));
    for (let i = 0; i < 5; i++) expect(ids(findFewestHopPath(src, "A", "Z"))).toEqual(first);
  });

  it("returns the same path regardless of edge-insertion order", () => {
    const bFirst = ids(findFewestHopPath(inMemorySource([...ab, ...ac]), "A", "Z"));
    const cFirst = ids(findFewestHopPath(inMemorySource([...ac, ...ab]), "A", "Z"));
    // The load-bearing assertion: order independence. Removing the tie-break makes these differ.
    expect(cFirst).toEqual(bFirst);
    expect(bFirst).toEqual(["A", "B", "Z"]); // and the stable winner is the lexicographic minimum
  });
});

describe("pathfinding — path structural integrity", () => {
  const graph = [edge("A", "C", "confirmed"), edge("C", "D", "confirmed"), edge("D", "Z", "confirmed")];

  it("edges align with consecutive node pairs and confidence is clamped to <= likely", () => {
    const p = findBestConfidencePath(inMemorySource(graph), "A", "Z")!;
    expect(p.nodes).toEqual(["A", "C", "D", "Z"]);
    expect(p.hops).toBe(p.edges.length);
    for (let i = 0; i < p.hops; i++) {
      expect(p.edges[i].from).toBe(p.nodes[i]);
      expect(p.edges[i].to).toBe(p.nodes[i + 1]);
    }
    expect(p.bottleneck).toBe("confirmed"); // raw ranking value
    expect(p.confidence).not.toBe("confirmed"); // emitted confidence never asserts runtime truth
    expect(p.confidence).toBe("likely"); // clamped (ADR 0016)
    expect(p.penalty).toBe(0); // all-confirmed path has zero penalty
  });

  it("zero-hop path (from === to) reports `likely`, never `confirmed`", () => {
    const p = findFewestHopPath(inMemorySource(graph), "A", "A")!;
    expect(p.hops).toBe(0);
    expect(p.edges).toEqual([]);
    expect(p.bottleneck).toBe("likely");
    expect(p.confidence).toBe("likely");
    expect(p.penalty).toBe(0);
  });
});

describe("pathfinding — k-best guard", () => {
  const src = inMemorySource([edge("A", "Z", "confirmed")]);

  it("returns [] for k <= 0", () => {
    expect(findKBestPaths(src, "A", "Z", 0)).toEqual([]);
    expect(findKBestPaths(src, "A", "Z", -3)).toEqual([]);
  });
});

describe("pathfinding — SCC beyond a single cycle", () => {
  it("separates two distinct components joined by a one-way bridge", () => {
    // {A,B} cycle and {C,D} cycle, with a DAG bridge A->C between them.
    const edges = [
      edge("A", "B", "confirmed"),
      edge("B", "A", "confirmed"),
      edge("C", "D", "confirmed"),
      edge("D", "C", "confirmed"),
      edge("A", "C", "confirmed")
    ];
    const scc = tarjanScc(["A", "B", "C", "D"], edges);
    expect(scc.components.length).toBe(2);
    expect(scc.componentOf.get("A")).toBe(scc.componentOf.get("B"));
    expect(scc.componentOf.get("C")).toBe(scc.componentOf.get("D"));
    expect(scc.componentOf.get("A")).not.toBe(scc.componentOf.get("C")); // bridge is one-way
  });

  it("treats a self-loop as its own singleton SCC and includes edge-only nodes", () => {
    // 'A' has a self-loop; 'B' is introduced only via an edge (never in nodeIds).
    const scc = tarjanScc(["A"], [edge("A", "A", "confirmed"), edge("A", "B", "confirmed")]);
    expect(scc.componentOf.has("A")).toBe(true);
    expect(scc.componentOf.has("B")).toBe(true);
    expect(scc.componentOf.get("A")).not.toBe(scc.componentOf.get("B"));
  });

  it("makes every node a singleton on an acyclic graph", () => {
    const scc = tarjanScc(["A", "B", "C"], [edge("A", "B", "confirmed"), edge("B", "C", "confirmed")]);
    expect(scc.components.length).toBe(3);
    for (const id of ["A", "B", "C"]) expect(scc.componentOf.has(id)).toBe(true);
  });

  it("handles the empty graph", () => {
    const scc = tarjanScc([], []);
    expect(scc.components).toEqual([]);
    expect(scc.componentOf.size).toBe(0);
  });
});
