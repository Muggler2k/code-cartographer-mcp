import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildGraphIndex,
  getGraphIndexPath,
  GRAPH_INDEX_SCHEMA_VERSION,
  GraphIndex,
  indexNeedsRebuild,
  loadGraphContext,
  openGraphIndex
} from "../src/graphIndex.js";
import { createMetrics, findFewestHopPath, findKBestPaths, inMemorySource } from "../src/pathfinding.js";
import type { CallEdge, CallGraphNode } from "../src/schema.js";
import { testContextMap, testEdge, testNode } from "./helpers/fixtures.js";

// ---- Minimal hand-written map (isolates the index from provider behavior) ----

function node(id: string): CallGraphNode {
  return testNode(id, { path: `${id}.ts` });
}
function edge(from: string, to: string, confidence: CallEdge["confidence"] = "confirmed"): CallEdge {
  return testEdge(from, to, { confidence });
}

async function writeMap(root: string, mapHash: string, nodes: CallGraphNode[], edges: CallEdge[]): Promise<void> {
  const dir = path.join(root, ".code-cartographer-mcp");
  await fs.mkdir(dir, { recursive: true });
  const map = testContextMap({ nodes, edges });
  map.meta = { ...map.meta, mapHash, repositoryRoot: root };
  await fs.writeFile(path.join(dir, "context-map.json"), JSON.stringify(map));
}

// Cyclic fixture: A->B->C->A (one SCC) plus C->Z (likely exit).
const NODES = [node("A"), node("B"), node("C"), node("Z")];
const EDGES = [edge("A", "B"), edge("B", "C"), edge("C", "A"), edge("C", "Z", "likely")];

let root: string;
let index: GraphIndex | null;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-gidx-"));
  index = null;
});

afterEach(async () => {
  index?.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("graph index — indexed caller/callee lookups", () => {
  it("findCallees/findCallers hit SQLite (one indexed query each)", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    index = await openGraphIndex(root);
    expect(index).not.toBeNull();

    const before = index!.sqliteQueryCount;
    expect(index!.findCallees("A").map((e) => e.to)).toEqual(["B"]);
    expect(index!.sqliteQueryCount).toBe(before + 1);

    expect(index!.findCallers("A").map((e) => e.from)).toEqual(["C"]); // C->A
    expect(index!.sqliteQueryCount).toBe(before + 2);
  });

  it("preserves edge confidence + kind through the index", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    index = await openGraphIndex(root);
    const exit = index!.findCallees("C").find((e) => e.to === "Z")!;
    expect(exit.confidence).toBe("likely");
    expect(exit.callKind).toBe("direct");
    expect(exit.evidence).toEqual(["C->Z"]);
  });
});

describe("graph index — path queries use the index, not a JSON scan", () => {
  it("path search runs over SQLite; neighborQueryCount equals the SQLite delta", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    index = await openGraphIndex(root);
    const m = createMetrics();
    const before = index!.sqliteQueryCount;
    const path = findFewestHopPath(index!, "A", "Z", undefined, m);
    expect(path?.nodes).toEqual(["A", "B", "C", "Z"]);
    expect(m.neighborQueryCount).toBeGreaterThan(0);
    expect(index!.sqliteQueryCount - before).toBe(m.neighborQueryCount);
  });

  it("does not re-read context-map.json per query (queries work after it is deleted)", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    index = await openGraphIndex(root);
    // Remove the JSON map entirely; an index that scanned it would now fail.
    await fs.rm(path.join(root, ".code-cartographer-mcp", "context-map.json"), { force: true });
    expect(index!.findCallees("A").map((e) => e.to)).toEqual(["B"]);
    expect(findFewestHopPath(index!, "A", "Z")?.nodes).toEqual(["A", "B", "C", "Z"]);
  });
});

describe("graph index — rebuild & staleness", () => {
  it("rebuilds a missing graph-index.sqlite from context-map.json", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    const target = getGraphIndexPath(root);
    expect(await buildGraphIndex(root)).toBe(target);
    await fs.access(target); // exists

    await fs.rm(target, { force: true }); // simulate a deleted/absent index
    await expect(fs.access(target)).rejects.toThrow();

    index = await openGraphIndex(root); // must transparently rebuild
    await fs.access(target); // recreated
    expect(index!.findCallees("A").map((e) => e.to)).toEqual(["B"]);
  });

  it("a stale map never returns fresh-looking results (rebuild on mapHash mismatch)", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    index = await openGraphIndex(root);
    expect(index!.builtFromMapHash).toBe("hash-v1");
    expect(index!.sameComponent("A", "C")).toBe(true); // cyclic in v1
    index!.close();
    index = null;

    // The codebase changed: new map, new hash, broken cycle + a new edge A->Q.
    const v2Nodes = [node("A"), node("B"), node("Q")];
    const v2Edges = [edge("A", "B"), edge("A", "Q")];
    await writeMap(root, "hash-v2", v2Nodes, v2Edges);

    index = await openGraphIndex(root);
    expect(index!.builtFromMapHash).toBe("hash-v2"); // rebuilt to the new snapshot
    expect(index!.findCallees("A").map((e) => e.to).sort()).toEqual(["B", "Q"]);
    expect(index!.sameComponent("A", "C")).toBe(false); // old cycle is gone
  });
});

describe("graph index — SCC condensation is built once per snapshot", () => {
  it("sccBuildCount stays 1 across many reachability queries", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    index = await openGraphIndex(root);
    expect(index!.sameComponent("A", "B")).toBe(true);
    expect(index!.sameComponent("A", "C")).toBe(true);
    expect(index!.sameComponent("A", "Z")).toBe(false);
    index!.getScc();
    expect(index!.sccBuildCount).toBe(1);
  });
});

describe("graph index — staleness on an index schema-version bump", () => {
  it("is fresh for the current schema version but stale for a newer one (mapHash unchanged)", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    const target = getGraphIndexPath(root);
    await buildGraphIndex(root);
    // Same mapHash + current index schema version → no rebuild needed.
    expect(await indexNeedsRebuild(target, "hash-v1")).toBe(false);
    // A future binary bumps the index schema → must rebuild even though the map is unchanged.
    expect(await indexNeedsRebuild(target, "hash-v1", GRAPH_INDEX_SCHEMA_VERSION + 1)).toBe(true);
  });
});

describe("graph index — corrupt index forces a clean rebuild", () => {
  it("rebuilds transparently rather than throwing when graph-index.sqlite is not a database", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    await buildGraphIndex(root);
    // Clobber the index file with garbage — readIndexMeta must treat it as missing.
    await fs.writeFile(getGraphIndexPath(root), "this is not a sqlite database");
    expect(await indexNeedsRebuild(getGraphIndexPath(root), "hash-v1")).toBe(true);

    index = await openGraphIndex(root); // must not throw — rebuilds first
    expect(index).not.toBeNull();
    expect(index!.findCallees("A").map((e) => e.to)).toEqual(["B"]);
  });
});

describe("graph index — graceful degradation", () => {
  it("buildGraphIndex returns null when no map is initialized", async () => {
    expect(await buildGraphIndex(root)).toBeNull(); // empty temp dir, no context-map.json
  });

  it("openGraphIndex returns null when no map is initialized", async () => {
    expect(await openGraphIndex(root)).toBeNull();
  });

  it("tolerates a map with no callGraph (empty, queryable index — no throw)", async () => {
    const dir = path.join(root, ".code-cartographer-mcp");
    await fs.mkdir(dir, { recursive: true });
    const map = {
      meta: { schemaVersion: 1, toolVersion: "0.1.0", generatedAt: "t", repositoryRoot: root, mapHash: "hash-v1", codebaseOnlyBoundary: true },
      summary: {},
      files: [],
      findings: {}
      // callGraph deliberately omitted
    };
    await fs.writeFile(path.join(dir, "context-map.json"), JSON.stringify(map));

    index = await openGraphIndex(root);
    expect(index).not.toBeNull();
    expect(index!.findCallees("A")).toEqual([]);
    expect(index!.getScc().components).toEqual([]);
  });
});

describe("graph index — hasNode", () => {
  it("reflects node presence and counts one indexed query each", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    index = await openGraphIndex(root);
    const before = index!.sqliteQueryCount;
    expect(index!.hasNode("A")).toBe(true);
    expect(index!.hasNode("does-not-exist")).toBe(false);
    expect(index!.sqliteQueryCount).toBe(before + 2);
  });
});

describe("graph index — node lookups (GraphSource, ADR 0024)", () => {
  it("getNode / findNodesBySymbol / findNodesByPath / allNodes return indexed nodes", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);
    index = await openGraphIndex(root);
    expect(index!.getNode("A")?.symbol).toBe("A");
    expect(index!.getNode("missing")).toBeUndefined();
    expect(index!.findNodesBySymbol("A").map((n) => n.id)).toEqual(["A"]);
    expect(index!.findNodesByPath("A.ts").map((n) => n.id)).toEqual(["A"]); // node("A").path === "A.ts"
    expect(index!.findNodesBySymbol("nope")).toEqual([]);
    expect(index!.allNodes().map((n) => n.id).sort()).toEqual(["A", "B", "C", "Z"]);
  });
});

describe("loadGraphContext — source selection + fallback (ADR 0024)", () => {
  it("returns null when no map is initialized", async () => {
    expect(await loadGraphContext(root)).toBeNull();
  });

  it("picks the in-memory source for a small graph, the SQLite index when forced, and both agree", async () => {
    await writeMap(root, "hash-v1", NODES, EDGES);

    const small = await loadGraphContext(root); // default threshold → in-memory (4 edges)
    const forced = await loadGraphContext(root, { minIndexEdges: 0 }); // force the SQLite index
    try {
      expect(small!.source instanceof GraphIndex).toBe(false); // in-memory fallback
      expect(forced!.source instanceof GraphIndex).toBe(true); // SQLite optimization

      // The two substrates are interchangeable: identical neighbors + node metadata.
      for (const id of ["A", "B", "C", "Z"]) {
        expect(forced!.source.getNode(id)).toEqual(small!.source.getNode(id));
        expect(forced!.source.callees(id)).toEqual(small!.source.callees(id));
        expect(forced!.source.callers(id)).toEqual(small!.source.callers(id));
      }
      expect(forced!.source.findNodesBySymbol("A")).toEqual(small!.source.findNodesBySymbol("A"));
    } finally {
      small!.source.close();
      forced!.source.close();
    }
  });
});

describe("graph index — parity with the in-memory source", () => {
  // A branching graph with three A->Z routes of differing confidence/length, so k-best
  // ordering, edge payloads, and penalties all have room to diverge if the SQLite round-trip
  // (evidence JSON, confidence, callKind) is lossy.
  const BRANCH_NODES = ["A", "B", "C", "D", "E", "Z"].map(node);
  const BRANCH_EDGES = [
    edge("A", "B", "likely"),
    edge("B", "Z", "unclear"),
    edge("A", "C", "confirmed"),
    edge("C", "D", "confirmed"),
    edge("D", "Z", "confirmed"),
    edge("A", "E", "confirmed"),
    edge("E", "Z", "likely")
  ];

  it("produces byte-identical path objects (nodes, edges, confidence, penalty) on a branching graph", async () => {
    await writeMap(root, "hash-branch", BRANCH_NODES, BRANCH_EDGES);
    index = await openGraphIndex(root);
    const mem = inMemorySource(BRANCH_EDGES as unknown as CallEdge[]);

    // Full StaticPath equality — not just node ids — across both shortest-hop and ranked k-best.
    expect(findFewestHopPath(index!, "A", "Z")).toEqual(findFewestHopPath(mem, "A", "Z"));
    expect(findKBestPaths(index!, "A", "Z", 5)).toEqual(findKBestPaths(mem, "A", "Z", 5));

    // Sanity: the index path actually carries the edge payloads through SQLite.
    const best = findKBestPaths(index!, "A", "Z", 5);
    expect(best[0].nodes).toEqual(["A", "C", "D", "Z"]); // confirmed bottleneck ranks first
    expect(best[0].edges.map((e) => e.confidence)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(best[0].edges[0].evidence).toEqual(["A->C"]); // evidence survived the JSON round-trip
  });
});
