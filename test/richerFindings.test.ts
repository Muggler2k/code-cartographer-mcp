// Derivation v2 (Epic K, Decision 0026): seven map-only rules + re-export alias handling.
// Everything stays <= candidate with in-record uncertainty; dead code is never asserted.

import { describe, expect, it } from "vitest";

import type { CallEdge, FileEntry, ModuleGroup, OwnershipSignal } from "../src/schema.js";
import { deriveFindings, type FindingsInput } from "../src/findings.js";
import { testEdge, testFileEntry, testNode } from "./helpers/fixtures.js";

function own(path: string, symbol: string, exported: boolean, reExport?: boolean): OwnershipSignal {
  return { symbol, kind: "function", path, exported, confidence: "confirmed", reason: "x", ...(reExport === undefined ? {} : { reExport }) };
}
function mod(root: string, files: string[], category: ModuleGroup["category"] = "source"): ModuleGroup {
  return { name: root.split("/").pop() ?? root, root, category, files };
}
function node(id: string) {
  const [path, symbol] = id.split("#");
  return testNode(id, { path, symbol, confidence: "confirmed" });
}
function edge(from: string, to: string, overrides: Partial<CallEdge> = {}): CallEdge {
  return testEdge(from, to, overrides);
}
function testFile(path: string): FileEntry {
  return testFileEntry(path, { category: "test" });
}
function input(partial: Partial<FindingsInput>): FindingsInput {
  return { files: [], languages: {}, modules: [], entryPoints: [], ownershipSignals: [], declarations: [], callEdges: [], ...partial };
}

describe("rule 1 — cyclic dependency clusters", () => {
  it("flags a cross-file resolved cycle as a candidate risk with uncertainty", () => {
    const f = deriveFindings(
      input({
        declarations: [node("a.ts#f"), node("b.ts#g")],
        callEdges: [edge("a.ts#f", "b.ts#g"), edge("b.ts#g", "a.ts#f")]
      })
    );
    const cycle = f.riskAreas.find((r) => /cyclic dependency cluster/i.test(r.finding));
    expect(cycle).toBeDefined();
    expect(cycle?.confidence).toBe("candidate");
    expect(cycle?.uncertainty.length).toBeGreaterThan(0);
    expect(cycle?.evidence.join(" ")).toContain("a.ts#f");
  });

  it("ignores same-file recursion and cycles through unresolved edges", () => {
    const sameFile = deriveFindings(
      input({
        declarations: [node("a.ts#f"), node("a.ts#g")],
        callEdges: [edge("a.ts#f", "a.ts#g"), edge("a.ts#g", "a.ts#f")]
      })
    );
    expect(sameFile.riskAreas.some((r) => /cyclic/i.test(r.finding))).toBe(false);

    const viaDynamic = deriveFindings(
      input({
        declarations: [node("a.ts#f"), node("b.ts#g")],
        callEdges: [edge("a.ts#f", "b.ts#g"), edge("b.ts#g", "a.ts#f", { callKind: "dynamic", confidence: "candidate" })]
      })
    );
    expect(viaDynamic.riskAreas.some((r) => /cyclic/i.test(r.finding))).toBe(false);
  });
});

describe("rule 2 — low-static-visibility hotspots", () => {
  it("flags a file whose outgoing edges are mostly weak, describing evidence quality", () => {
    const edges = [
      edge("dyn.ts#a", "unresolved#x", { callKind: "unresolved", confidence: "unresolved" }),
      edge("dyn.ts#a", "unresolved#y", { callKind: "dynamic", confidence: "candidate" }),
      edge("dyn.ts#b", "unresolved#z", { callKind: "framework", confidence: "candidate" }),
      edge("dyn.ts#b", "ok.ts#r"),
      edge("dyn.ts#b", "ok.ts#s")
    ];
    const f = deriveFindings(input({ declarations: [node("dyn.ts#a"), node("dyn.ts#b"), node("ok.ts#r"), node("ok.ts#s")], callEdges: edges }));
    const hot = f.riskAreas.find((r) => /low static visibility/i.test(r.finding));
    expect(hot).toBeDefined();
    expect(hot?.finding).toContain("dyn.ts");
    expect(hot?.finding).toContain("3 of 5");
  });

  it("stays silent below the edge-count threshold", () => {
    const f = deriveFindings(
      input({
        declarations: [node("dyn.ts#a")],
        callEdges: [edge("dyn.ts#a", "unresolved#x", { callKind: "unresolved", confidence: "unresolved" })]
      })
    );
    expect(f.riskAreas.some((r) => /low static visibility/i.test(r.finding))).toBe(false);
  });
});

describe("rule 3 — source→test dependency", () => {
  it("flags a resolved edge from source into a test file, but not the reverse", () => {
    const f = deriveFindings(
      input({
        files: [testFileEntry("src/a.ts"), testFile("test/util.test.ts")],
        declarations: [node("src/a.ts#use"), node("test/util.test.ts#helper")],
        callEdges: [edge("src/a.ts#use", "test/util.test.ts#helper")]
      })
    );
    const hit = f.riskAreas.find((r) => /statically depends on test file/i.test(r.finding));
    expect(hit).toBeDefined();
    expect(hit?.confidence).toBe("candidate");
    expect(hit?.uncertainty.length).toBeGreaterThan(0);

    const reverse = deriveFindings(
      input({
        files: [testFileEntry("src/a.ts"), testFile("test/util.test.ts")],
        declarations: [node("src/a.ts#api"), node("test/util.test.ts#spec")],
        callEdges: [edge("test/util.test.ts#spec", "src/a.ts#api")]
      })
    );
    expect(reverse.riskAreas.some((r) => /statically depends on test file/i.test(r.finding))).toBe(false);
  });
});

describe("rule 4 — scattered ownership (ADR 0017 gap)", () => {
  it("flags an exported name declared across three modules; two stays a duplicate only", () => {
    const three = deriveFindings(
      input({
        modules: [mod("src/m1", ["src/m1/a.ts"]), mod("src/m2", ["src/m2/b.ts"]), mod("src/m3", ["src/m3/c.ts"])],
        declarations: [node("src/m1/a.ts#parse"), node("src/m2/b.ts#parse"), node("src/m3/c.ts#parse")],
        ownershipSignals: [own("src/m1/a.ts", "parse", true), own("src/m2/b.ts", "parse", true), own("src/m3/c.ts", "parse", true)]
      })
    );
    expect(three.riskAreas.some((r) => /scattered ownership/i.test(r.finding))).toBe(true);
    // Intentional overlap: the same name also stays a duplicate candidate — the duplicate entry
    // records the pairwise alias risk; the scatter risk area records the ownership fragmentation.
    expect(three.duplicatePathCandidates).toHaveLength(1);

    const two = deriveFindings(
      input({
        modules: [mod("src/m1", ["src/m1/a.ts"]), mod("src/m2", ["src/m2/b.ts"])],
        declarations: [node("src/m1/a.ts#parse"), node("src/m2/b.ts#parse")],
        ownershipSignals: [own("src/m1/a.ts", "parse", true), own("src/m2/b.ts", "parse", true)]
      })
    );
    expect(two.riskAreas.some((r) => /scattered ownership/i.test(r.finding))).toBe(false);
    expect(two.duplicatePathCandidates).toHaveLength(1);
  });
});

describe("re-export alias handling (Decision 0026)", () => {
  it("a re-export signal never creates a duplicate or scattering finding", () => {
    const f = deriveFindings(
      input({
        modules: [mod("src/m1", ["src/m1/a.ts"]), mod("src/m2", ["src/m2/index.ts"]), mod("src/m3", ["src/m3/index.ts"])],
        declarations: [node("src/m1/a.ts#parse")],
        ownershipSignals: [
          own("src/m1/a.ts", "parse", true),
          own("src/m2/index.ts", "parse", true, true), // barrel alias
          own("src/m3/index.ts", "parse", true, true) // barrel alias
        ]
      })
    );
    expect(f.duplicatePathCandidates).toHaveLength(0);
    expect(f.riskAreas.some((r) => /scattered ownership/i.test(r.finding))).toBe(false);
  });
});

describe("rule 5 — statically untested modules", () => {
  const files = [testFileEntry("src/m1/a.ts"), testFileEntry("src/m2/b.ts"), testFile("test/a.test.ts")];
  const modules = [mod("src/m1", ["src/m1/a.ts"]), mod("src/m2", ["src/m2/b.ts"]), mod("test", ["test/a.test.ts"], "test")];

  it("flags only the source module the test closure never reaches", () => {
    const f = deriveFindings(
      input({
        files,
        modules,
        declarations: [node("src/m1/a.ts#covered"), node("src/m2/b.ts#uncovered"), node("test/a.test.ts#spec")],
        callEdges: [edge("test/a.test.ts#spec", "src/m1/a.ts#covered")]
      })
    );
    const untested = f.riskAreas.filter((r) => /no static test path/i.test(r.finding));
    expect(untested).toHaveLength(1);
    expect(untested[0].finding).toContain("src/m2");
    // Dead code is never asserted (governance Statement 6) — pin the wording.
    expect(untested[0].finding).not.toMatch(/dead|unused|removable/i);
    expect(untested[0].risk).not.toMatch(/dead|unused|removable/i);
    expect(untested[0].recommendation).not.toMatch(/dead|unused|removable/i);
  });

  it("is skipped entirely when the repo has no test declarations", () => {
    const f = deriveFindings(
      input({
        files: [testFileEntry("src/m1/a.ts")],
        modules: [mod("src/m1", ["src/m1/a.ts"])],
        declarations: [node("src/m1/a.ts#x")]
      })
    );
    expect(f.riskAreas.some((r) => /no static test path/i.test(r.finding))).toBe(false);
  });
});

describe("rule 6 — god-functions (fan-out hotspots)", () => {
  it("flags a declaration with >= 20 outgoing calls", () => {
    const targets = Array.from({ length: 21 }, (_, i) => node(`t.ts#t${i}`));
    const f = deriveFindings(
      input({
        declarations: [node("hub.ts#orchestrate"), ...targets],
        callEdges: targets.map((t) => edge("hub.ts#orchestrate", t.id))
      })
    );
    const god = f.riskAreas.find((r) => /fan-out hotspot/i.test(r.finding));
    expect(god).toBeDefined();
    expect(god?.finding).toContain("hub.ts#orchestrate");
    expect(god?.confidence).toBe("candidate");
  });
});

describe("rule 7 — entry-point-orphan modules", () => {
  it("flags the module no entry-point closure reaches, never asserting dead code", () => {
    const f = deriveFindings(
      input({
        files: [testFileEntry("src/index.ts"), testFileEntry("src/core/a.ts"), testFileEntry("src/island/b.ts")],
        modules: [mod("src/core", ["src/core/a.ts"]), mod("src/island", ["src/island/b.ts"]), mod("src", ["src/index.ts"])],
        entryPoints: [{ path: "src/index.ts", kind: "source_entry", confidence: "likely", reason: "conventional entry" }],
        declarations: [node("src/index.ts#main"), node("src/core/a.ts#reached"), node("src/island/b.ts#isolated")],
        callEdges: [edge("src/index.ts#main", "src/core/a.ts#reached")]
      })
    );
    const orphans = f.riskAreas.filter((r) => /no static path from any detected entry point/i.test(r.finding));
    expect(orphans).toHaveLength(1);
    expect(orphans[0].finding).toContain("src/island");
    expect(orphans[0].finding).not.toMatch(/dead|unused/i);
    expect(orphans[0].uncertainty.length).toBeGreaterThan(0);
  });

  it("is skipped when no entry points were detected", () => {
    const f = deriveFindings(
      input({
        files: [testFileEntry("src/island/b.ts")],
        modules: [mod("src/island", ["src/island/b.ts"])],
        declarations: [node("src/island/b.ts#isolated")]
      })
    );
    expect(f.riskAreas.some((r) => /detected entry point/i.test(r.finding))).toBe(false);
  });
});

describe("boundary invariants across all v2 rules", () => {
  it("every emitted risk area is <= candidate and carries uncertainty", () => {
    const targets = Array.from({ length: 21 }, (_, i) => node(`t.ts#t${i}`));
    const f = deriveFindings(
      input({
        files: [testFileEntry("src/a.ts"), testFile("test/t.test.ts"), testFileEntry("src/island/b.ts")],
        modules: [mod("src", ["src/a.ts"]), mod("src/island", ["src/island/b.ts"]), mod("test", ["test/t.test.ts"], "test")],
        entryPoints: [{ path: "src/a.ts", kind: "source_entry", confidence: "likely", reason: "entry" }],
        declarations: [node("src/a.ts#f"), node("src/island/b.ts#g"), node("test/t.test.ts#spec"), node("hub.ts#hub"), ...targets],
        callEdges: [
          edge("src/a.ts#f", "src/island/b.ts#g"),
          edge("src/island/b.ts#g", "src/a.ts#f"),
          edge("src/a.ts#f", "test/t.test.ts#spec"),
          ...targets.map((t) => edge("hub.ts#hub", t.id))
        ]
      })
    );
    const RANK = { confirmed: 5, likely: 4, candidate: 3, unclear: 2, unresolved: 1 } as const;
    for (const r of f.riskAreas) {
      expect(RANK[r.confidence]).toBeLessThanOrEqual(RANK.candidate);
      expect(r.uncertainty.length).toBeGreaterThan(0);
    }
  });
});
