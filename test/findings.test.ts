import { describe, expect, it } from "vitest";

import type { CallGraphNode } from "../src/callGraph.js";
import type { FileEntry, OwnershipSignal } from "../src/contextMap.js";
import { deriveFindings, type FindingsInput } from "../src/findings.js";

function decl(id: string, kind: CallGraphNode["kind"] = "function"): CallGraphNode {
  const [path, symbol] = id.split("#");
  return { id, symbol, path, kind, confidence: "confirmed" };
}
function own(path: string, symbol: string, exported: boolean): OwnershipSignal {
  return { symbol, kind: "function", path, exported, confidence: "confirmed", reason: "x" };
}
function srcFile(path: string): FileEntry {
  return { path, category: "source", sizeBytes: 1, sha256: "h", hashScope: "content", analyzable: true, analysisReason: "text source", mtimeMs: 0 };
}
function input(partial: Partial<FindingsInput>): FindingsInput {
  return {
    files: [],
    languages: {},
    modules: [],
    entryPoints: [],
    ownershipSignals: [],
    declarations: [],
    callEdges: [],
    ...partial
  };
}

describe("deriveFindings (D4, ADR 0017)", () => {
  it("flags an exported-name collision as a candidate duplicate with in-record uncertainty", () => {
    const f = deriveFindings(
      input({
        declarations: [decl("a.ts#foo"), decl("b.ts#foo")],
        ownershipSignals: [own("a.ts", "foo", true), own("b.ts", "foo", true)]
      })
    );
    expect(f.duplicatePathCandidates).toHaveLength(1);
    expect(f.duplicatePathCandidates[0].confidence).toBe("candidate");
    expect(f.duplicatePathCandidates[0].uncertainty.length).toBeGreaterThan(0);
  });

  it("names a sole exported owner with a resolved inbound edge as a canonical candidate", () => {
    const f = deriveFindings(
      input({
        declarations: [decl("x.ts#bar"), decl("a.ts#main")],
        ownershipSignals: [own("x.ts", "bar", true), own("a.ts", "main", true)],
        callEdges: [{ from: "a.ts#main", to: "x.ts#bar", callKind: "direct", confidence: "confirmed", evidence: [] }]
      })
    );
    expect(f.canonicalPaths.map((c) => c.id)).toContain("x.ts#bar");
    expect(f.canonicalPaths.every((c) => c.confidence === "candidate")).toBe(true);
  });

  it("classifies a legacy-named, zero-inbound, non-exported symbol as apparently_unreachable (never dead)", () => {
    const f = deriveFindings(
      input({ declarations: [decl("legacy/old.ts#dead")], ownershipSignals: [own("legacy/old.ts", "dead", false)] })
    );
    const lp = f.legacyPathCandidates.find((l) => l.id === "legacy/old.ts#dead");
    expect(lp?.reachability).toBe("apparently_unreachable");
    expect(lp?.uncertainty.length).toBeGreaterThan(0); // mandatory no-dead caveat
  });

  it("classifies a still-referenced legacy symbol as still_reachable; heuristic tier as requires_human_confirmation", () => {
    const reachable = deriveFindings(
      input({
        declarations: [decl("old/api.ts#legacyFn"), decl("a.ts#use")],
        ownershipSignals: [own("old/api.ts", "legacyFn", true)],
        callEdges: [{ from: "a.ts#use", to: "old/api.ts#legacyFn", callKind: "direct", confidence: "confirmed", evidence: [] }]
      })
    );
    expect(reachable.legacyPathCandidates.find((l) => l.id === "old/api.ts#legacyFn")?.reachability).toBe("still_reachable");

    const heuristic = deriveFindings(input({ declarations: [decl("legacy_old.py#thing")] }));
    expect(heuristic.legacyPathCandidates[0].reachability).toBe("requires_human_confirmation");
  });

  it("never emits safe_removal_candidate from zero-inbound alone", () => {
    const f = deriveFindings(input({ declarations: [decl("legacy/x.ts#a"), decl("legacy/y.ts#b")] }));
    expect(f.legacyPathCandidates.every((l) => l.reachability !== "safe_removal_candidate")).toBe(true);
  });

  it("flags parallel module structures as a candidate duplicate (D3)", () => {
    const f = deriveFindings(
      input({
        modules: [
          { name: "v1", root: "src/v1", category: "source", files: ["src/v1/api.ts", "src/v1/util.ts"] },
          { name: "v2", root: "src/v2", category: "source", files: ["src/v2/api.ts", "src/v2/util.ts"] }
        ]
      })
    );
    const parallel = f.duplicatePathCandidates.find((d) => d.id.startsWith("dup:mod:"));
    expect(parallel).toBeDefined();
    expect(parallel?.confidence).toBe("unclear");
  });

  it("flags a bypassed abstraction when a caller reaches an internal symbol across files (R3)", () => {
    const f = deriveFindings(
      input({
        declarations: [decl("svc.ts#publicApi"), decl("svc.ts#internalHelper"), decl("caller.ts#use")],
        ownershipSignals: [own("svc.ts", "publicApi", true), own("svc.ts", "internalHelper", false), own("caller.ts", "use", true)],
        callEdges: [{ from: "caller.ts#use", to: "svc.ts#internalHelper", callKind: "direct", confidence: "confirmed", evidence: [] }]
      })
    );
    expect(f.riskAreas.some((r) => /bypass/i.test(r.finding))).toBe(true);
  });

  it("flags a god-file when declaration count crosses the threshold", () => {
    const decls = Array.from({ length: 30 }, (_, i) => decl(`big.ts#s${i}`));
    const f = deriveFindings(input({ declarations: decls, ownershipSignals: decls.map((d) => own("big.ts", d.symbol, true)) }));
    expect(f.riskAreas.some((r) => r.finding.includes("big.ts") && r.confidence === "candidate")).toBe(true);
  });

  it("always records the reachability caveat and adds tier/dynamic caveats when warranted", () => {
    const f = deriveFindings(
      input({
        files: [srcFile("a.ts"), srcFile("b.py")],
        declarations: [decl("a.ts#main")],
        callEdges: [{ from: "a.ts#main", to: "unresolved#x", callKind: "unresolved", confidence: "unresolved", evidence: [] }]
      })
    );
    expect(f.uncertainty[0].item).toMatch(/not runtime-proven/i);
    expect(f.uncertainty.some((u) => /heuristic/i.test(u.item))).toBe(true); // b.py
    expect(f.uncertainty.some((u) => /unresolved/i.test(u.item))).toBe(true); // unresolved edge
  });
});
