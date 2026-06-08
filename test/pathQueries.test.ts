import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { initCodebase } from "../src/contextMap.js";
import { findCallers, findPath } from "../src/pathQueries.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-pq-"));
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

describe("find_callers (CAP-23, ADR 0024)", () => {
  it("lists the static caller of a symbol, never claiming confirmed runtime truth", async () => {
    const r = await findCallers(root, "helper");
    expect(r.analysisBoundary).toBe("codebase_only");
    expect(r.callers.some((c) => c.label.includes("main"))).toBe(true);
    expect(r.callers.every((c) => c.confidence !== "confirmed")).toBe(true); // clamped to <= likely (ADR 0016)
    expect(r.uncertainty.length).toBeGreaterThan(0);
  });

  it("returns an init-required envelope when not initialized (no throw)", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-pq-empty-"));
    try {
      const r = await findCallers(empty, "x");
      expect(r.callers).toEqual([]);
      expect(r.uncertainty[0].item).toMatch(/not initialized/i);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe("find_path (CAP-23, ADR 0024)", () => {
  it("returns a static path between two symbols, confidence clamped to <= likely", async () => {
    const r = await findPath(root, "main", "helper");
    expect(r.fewestHop).not.toBeNull();
    expect(r.fewestHop!.nodes[0].label).toContain("main");
    expect(r.fewestHop!.nodes[r.fewestHop!.nodes.length - 1].label).toContain("helper");
    expect(r.fewestHop!.hops).toBe(1);
    expect(["likely", "candidate", "unclear", "unresolved"]).toContain(r.fewestHop!.confidence); // never confirmed
    expect(r.bestConfidence).not.toBeNull();
  });

  it("returns null paths when the target is unreachable from the source", async () => {
    const r = await findPath(root, "helper", "main"); // helper does not call main
    expect(r.fewestHop).toBeNull();
    expect(r.bestConfidence).toBeNull();
  });

  it("reports a not-found endpoint without throwing", async () => {
    const r = await findPath(root, "main", "doesNotExist");
    expect(r.fewestHop).toBeNull();
    expect(r.uncertainty[0].item).toMatch(/not found/i);
  });
});
