// The shared analysis-context seam (Decision 0025): withContext owns the
// load → init-guard → close envelope, and an injected AnalysisContext makes the
// GraphSource seam (Decision 0024) the test surface — capabilities run over an
// in-memory graph with no filesystem or init pipeline.

import { afterAll, describe, expect, it } from "vitest";

import { makeAnalysisContext, withContext } from "../src/analysisContext.js";
import { analyzeReachability, analyzeTestPaths, reviewPreflight } from "../src/analysis.js";
import { mapCallStack } from "../src/callGraph.js";
import { findCallers, findPath } from "../src/pathQueries.js";
import { inMemoryGraphSource, type GraphSource } from "../src/pathfinding.js";
import type { StaticContextMap } from "../src/schema.js";
import { tempRepos, testContextMap, testEdge, testFileEntry, testNode } from "./helpers/fixtures.js";

const repos = tempRepos("ccm-ctx-");
afterAll(() => repos.cleanup());

/** A -> B -> C chain plus a test file calling A. */
function chainMap(): StaticContextMap {
  return testContextMap({
    nodes: [
      testNode("src/a.ts#a", { symbol: "a", path: "src/a.ts" }),
      testNode("src/b.ts#b", { symbol: "b", path: "src/b.ts" }),
      testNode("src/c.ts#c", { symbol: "c", path: "src/c.ts" }),
      testNode("test/a.test.ts#spec", { symbol: "spec", path: "test/a.test.ts" })
    ],
    edges: [
      testEdge("src/a.ts#a", "src/b.ts#b"),
      testEdge("src/b.ts#b", "src/c.ts#c"),
      testEdge("test/a.test.ts#spec", "src/a.ts#a")
    ],
    files: [
      testFileEntry("src/a.ts"),
      testFileEntry("src/b.ts"),
      testFileEntry("src/c.ts"),
      testFileEntry("test/a.test.ts", { category: "test" })
    ]
  });
}

/** Wrap a GraphSource so close() calls are observable. */
function closeSpy(source: GraphSource): { source: GraphSource; closes: () => number } {
  let count = 0;
  return {
    source: { ...source, close: () => { count++; source.close(); } },
    closes: () => count
  };
}

describe("withContext (Decision 0025 — one envelope, caller-owned injection)", () => {
  it("returns the uninitialized fallback for a root with no map, without running fn", async () => {
    const root = await repos.makeRepo({ "a.ts": "export const a = 1;" });
    let ran = false;
    const out = await withContext(root, "fallback", () => {
      ran = true;
      return "ran";
    });
    expect(out).toBe("fallback");
    expect(ran).toBe(false);
  });

  it("never closes an injected context — the caller owns its lifecycle", async () => {
    const map = chainMap();
    const spy = closeSpy(inMemoryGraphSource(map.callGraph.nodes, map.callGraph.edges));
    const ctx = makeAnalysisContext(map, spy.source);
    await withContext(ctx, null, () => 1);
    await withContext(ctx, null, () => 2);
    expect(spy.closes()).toBe(0);
  });
});

describe("capabilities over an injected context (no filesystem, no init pipeline)", () => {
  const map = chainMap();

  it("analyzeReachability traverses the in-memory graph, clamped ≤ likely", async () => {
    const r = await analyzeReachability(makeAnalysisContext(map), "a");
    expect(r.analysisBoundary).toBe("codebase_only");
    const ids = r.reachablePaths.map((p) => p.id);
    expect(ids).toContain("src/b.ts#b");
    expect(ids).toContain("src/c.ts#c");
    for (const p of r.reachablePaths) expect(p.confidence).not.toBe("confirmed");
    expect(r.uncertainty.length).toBeGreaterThan(0);
  });

  it("analyzeTestPaths sees file categories from the injected map", async () => {
    const r = await analyzeTestPaths(makeAnalysisContext(map), "b");
    expect(r.reachingTests.map((t) => t.id)).toContain("test/a.test.ts#spec");
  });

  it("findCallers returns the direct caller, clamped to likely", async () => {
    const r = await findCallers(makeAnalysisContext(map), "b");
    expect(r.callers.map((c) => c.id)).toEqual(["src/a.ts#a"]);
    expect(r.callers[0].confidence).toBe("likely");
  });

  it("findPath returns a fewest-hop static path, never confirmed", async () => {
    const r = await findPath(makeAnalysisContext(map), "a", "c");
    expect(r.fewestHop?.hops).toBe(2);
    expect(r.fewestHop?.confidence).toBe("likely");
  });

  it("mapCallStack roots at the entry point over the injected source", async () => {
    const r = await mapCallStack(makeAnalysisContext(map), "a");
    expect(r.rootId).toBe("src/a.ts#a");
    expect(r.nodes.map((n) => n.id)).toContain("src/c.ts#c");
    expect(r.uncertainty.some((u) => u.item.includes("not a runtime trace"))).toBe(true);
  });

  it("reviewPreflight composes sub-capabilities over ONE shared context and leaves it open", async () => {
    const spy = closeSpy(inMemoryGraphSource(map.callGraph.nodes, map.callGraph.edges));
    const r = await reviewPreflight(makeAnalysisContext(map, spy.source), "b");
    expect(r.analysisBoundary).toBe("codebase_only");
    expect(spy.closes()).toBe(0);
  });
});
