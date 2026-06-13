import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initCodebase } from "../src/contextMap.js";
import { mapCallStack } from "../src/callGraph.js";
import { boundedCallStackView, DIAGRAM_NODE_CAP, visualizeArchitecture, visualizeCallStack } from "../src/visualize.js";
import type { CallEdge, CallGraphNode } from "../src/schema.js";
import { tempRepos } from "./helpers/fixtures.js";

const { makeRepo, cleanup } = tempRepos("ccm-viz-");
let root: string;

beforeAll(async () => {
  root = await makeRepo({
    "src/x.ts": "export function helper() { return 1; }\n",
    "src/a.ts": "import { helper } from './x';\nexport function main() { return helper(); }\n"
  });
  await initCodebase(root, { mode: "none" });
});

afterAll(cleanup);

describe("mapCallStack (CAP-23)", () => {
  it("builds a confidence-graded call graph rooted at an entry point", async () => {
    const cs = await mapCallStack(root, "main");
    expect(cs.analysisBoundary).toBe("codebase_only");
    expect(cs.rootId).toBe("src/a.ts#main");
    expect(cs.nodes.some((n) => n.symbol === "helper")).toBe(true);
    expect(cs.edges.some((e) => e.to === "src/x.ts#helper")).toBe(true);
    expect(cs.uncertainty.length).toBeGreaterThan(0);
  });

  it("honors maxDepth and sets maxDepthReached", async () => {
    const cs = await mapCallStack(root, "main", 0);
    expect(cs.maxDepthReached).toBe(true);
    expect(cs.nodes.map((n) => n.symbol)).not.toContain("helper");
  });

  it("returns an init-required envelope when not initialized", async () => {
    const empty = await makeRepo();
    const cs = await mapCallStack(empty, "x");
    expect(cs.nodes).toEqual([]);
    expect(cs.uncertainty[0].item).toMatch(/not initialized/i);
  });
});

describe("visualizeCallStack (CAP-24)", () => {
  it("emits a Mermaid diagram spec (default) with a legend, never an image", async () => {
    const r = await visualizeCallStack(root, "main");
    expect(r.visualization.format).toBe("mermaid");
    expect(typeof r.visualization.diagram).toBe("string");
    expect(r.visualization.diagram).toMatch(/flowchart|graph/);
    expect(r.visualization.diagram).not.toContain("-..->"); // invalid Mermaid (regression guard)
    expect(r.visualization.legend.length).toBeGreaterThan(0);
    expect(r.uncertainty.length).toBeGreaterThan(0);
  });

  it("emits DOT and ASCII on request", async () => {
    expect((await visualizeCallStack(root, "main", "dot")).visualization.diagram).toContain("digraph");
    const ascii = await visualizeCallStack(root, "main", "ascii");
    expect(ascii.visualization.format).toBe("ascii");
    expect(ascii.visualization.diagram).toContain("main");
  });
});

describe("visualizeArchitecture (CAP-25)", () => {
  it("emits a module/ownership diagram spec with uncertainty", async () => {
    const r = await visualizeArchitecture(root);
    expect(r.analysisBoundary).toBe("codebase_only");
    expect(typeof r.visualization.diagram).toBe("string");
    expect(r.visualization.legend.length).toBeGreaterThan(0);
    expect(r.uncertainty.length).toBeGreaterThan(0);
  });

  it("returns an init-required envelope when not initialized (does not throw)", async () => {
    const empty = await makeRepo();
    const r = await visualizeArchitecture(empty);
    expect(r.uncertainty[0].item).toMatch(/not initialized/i);
  });
});

// ADR 0034 S1 (issue #7) — a call-stack diagram from one entry point can still fan out to hundreds
// of nodes on a large repo, so the spec scales unbounded. boundedCallStackView renders a bounded,
// root-connected subgraph that stays a VALID diagram (no dangling edges), with the bound disclosed.
describe("boundedCallStackView is bounded and valid (ADR 0034 S1)", () => {
  const node = (id: string): CallGraphNode => ({ id, symbol: id, path: `${id}.ts`, kind: "function", confidence: "confirmed" });
  const edge = (from: string, to: string): CallEdge => ({ from, to, callKind: "direct", confidence: "confirmed", evidence: ["call"] });

  it("returns the full graph unchanged when under the cap", () => {
    const nodes = [node("r"), node("a")];
    const edges = [edge("r", "a")];
    const view = boundedCallStackView("r", nodes, edges, DIAGRAM_NODE_CAP);
    expect(view.truncated).toBe(false);
    expect(view.nodes).toBe(nodes);
    expect(view.edges).toBe(edges);
  });

  it("bounds a large fan-out to a root-connected subgraph with no dangling edges", () => {
    // 200 nodes in a branching tree rooted at n0 (each node fans to ~3 children).
    const nodes = Array.from({ length: 200 }, (_, i) => node(`n${i}`));
    const edges = Array.from({ length: 199 }, (_, i) => edge(`n${Math.floor(i / 3)}`, `n${i + 1}`));
    const view = boundedCallStackView("n0", nodes, edges, 40);
    expect(view.truncated).toBe(true);
    expect(view.nodes.length).toBeLessThanOrEqual(40);
    expect(view.nodes.some((n) => n.id === "n0")).toBe(true); // root is always kept
    // Valid by construction: every rendered edge's endpoints are in the node set (no dangling refs).
    const ids = new Set(view.nodes.map((n) => n.id));
    for (const e of view.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it("keeps the diagram bounded and discloses the bound in the legend end-to-end", async () => {
    // The fixture repo's graph is tiny (under the cap) → not truncated, no bound note. This pins
    // that a small graph is unaffected; the unit tests above pin the large-graph bound.
    const r = await visualizeCallStack(root, "main");
    expect(r.visualization.legend.some((l) => l.includes("diagram bounded to"))).toBe(false);
  });
});
