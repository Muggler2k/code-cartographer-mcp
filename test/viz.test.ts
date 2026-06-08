import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { initCodebase } from "../src/contextMap.js";
import { mapCallStack } from "../src/callGraph.js";
import { visualizeArchitecture, visualizeCallStack } from "../src/visualize.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-viz-"));
  const files: Record<string, string> = {
    "src/x.ts": "export function helper() { return 1; }\n",
    "src/a.ts": "import { helper } from './x';\nexport function main() { return helper(); }\n"
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  await initCodebase(root, { mode: "none" });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

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
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-cs-empty-"));
    try {
      const cs = await mapCallStack(empty, "x");
      expect(cs.nodes).toEqual([]);
      expect(cs.uncertainty[0].item).toMatch(/not initialized/i);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
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
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-arch-empty-"));
    try {
      const r = await visualizeArchitecture(empty);
      expect(r.uncertainty[0].item).toMatch(/not initialized/i);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
