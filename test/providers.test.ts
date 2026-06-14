import { describe, expect, it } from "vitest";

import type { Confidence, FileEntry } from "../src/schema.js";
import { clampExtraction } from "../src/contextMap.js";
import { heuristicProvider } from "../src/providers/heuristic.js";
import { typeScriptProvider } from "../src/providers/typescript.js";
import { treeSitterProvider } from "../src/providers/treeSitter.js";
import { groupByProvider, PROVIDERS, selectProvider } from "../src/providers/registry.js";
import type { ProviderExtraction, ProviderInput } from "../src/providers/types.js";

function file(path: string, analyzable = true): FileEntry {
  return {
    path,
    category: path.includes("test") ? "test" : "source",
    sizeBytes: 10,
    sha256: "x",
    hashScope: "content",
    analyzable,
    analysisReason: analyzable ? "text source" : "binary: null byte",
    mtimeMs: 0
  };
}

/** Build a ProviderInput from a { path: contents } map. */
function providerInput(files: Record<string, string>): ProviderInput {
  return {
    repositoryRoot: "/repo",
    files: Object.keys(files).map((p) => file(p)),
    readFile: async (p: string) => {
      const content = files[p];
      if (content === undefined) {
        throw new Error(`no such file ${p}`);
      }
      return content;
    }
  };
}

const ALLOWED: Confidence[] = ["candidate", "unclear", "unresolved"];

describe("language provider registry (Decision 0012/0013)", () => {
  it("the heuristic floor is last in registry order", () => {
    expect(PROVIDERS[PROVIDERS.length - 1]).toBe(heuristicProvider);
  });

  it("TS provider claims TS/JS extensions and declines others", () => {
    for (const p of ["a.ts", "a.tsx", "a.mts", "b.js", "b.cjs"]) {
      expect(typeScriptProvider.matches(file(p))).toBe(true);
    }
    for (const p of ["a.py", "a.go", "a.cs", "a.txt"]) {
      expect(typeScriptProvider.matches(file(p))).toBe(false);
    }
  });

  it("confidence ceilings encode the tier: TS confirmed, heuristic candidate", () => {
    expect(typeScriptProvider.maxConfidence).toBe("confirmed");
    expect(heuristicProvider.maxConfidence).toBe("candidate");
  });

  it("selectProvider routes by first match, falling through to the heuristic floor", () => {
    expect(selectProvider(file("src/a.ts"))).toBe(typeScriptProvider);
    expect(selectProvider(file("src/a.py"))).toBe(treeSitterProvider); // tree-sitter grammar exists
    expect(selectProvider(file("notes.txt"))).toBe(heuristicProvider); // no grammar → floor
  });

  it("groupByProvider buckets analyzable files and skips non-analyzable ones", () => {
    const files = [file("a.ts"), file("b.ts"), file("c.py"), file("notes.txt"), file("d.png", false)];
    const groups = groupByProvider(files);
    expect(groups.get(typeScriptProvider)?.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(groups.get(treeSitterProvider)?.map((f) => f.path)).toEqual(["c.py"]);
    expect(groups.get(heuristicProvider)?.map((f) => f.path)).toEqual(["notes.txt"]);
    const total = [...groups.values()].reduce((n, b) => n + b.length, 0);
    expect(total).toBe(4); // d.png (non-analyzable) excluded
  });
});

describe("heuristicProvider.analyze (Epic B, ADR 0012/0013/0018)", () => {
  it("extracts Python declarations and grades exports by underscore convention", async () => {
    const ex = await heuristicProvider.analyze(
      providerInput({ "a.py": "class Bar:\n    pass\n\ndef foo():\n    pass\n\ndef _priv():\n    pass\n" })
    );
    const byName = new Map(ex.ownershipSignals.map((s) => [s.symbol, s]));
    expect(byName.get("Bar")?.kind).toBe("class");
    expect(byName.get("foo")?.kind).toBe("function");
    expect(byName.get("foo")?.exported).toBe(true);
    expect(byName.get("_priv")?.exported).toBe(false);
    expect(ex.declarations.every((d) => d.confidence === "candidate")).toBe(true);
  });

  it("grades Go exports by capitalization", async () => {
    const ex = await heuristicProvider.analyze(
      providerInput({ "a.go": "package x\n\nfunc Exported() {}\n\nfunc unexported() {}\n" })
    );
    const byName = new Map(ex.ownershipSignals.map((s) => [s.symbol, s]));
    expect(byName.get("Exported")?.exported).toBe(true);
    expect(byName.get("unexported")?.exported).toBe(false);
  });

  it("resolves same-file calls to direct candidates and unknown names to unresolved", async () => {
    const ex = await heuristicProvider.analyze(
      providerInput({ "a.py": "def helper():\n    pass\n\ndef main():\n    helper()\n    missing()\n" })
    );
    const toHelper = ex.callEdges.find((e) => e.to.endsWith("#helper"));
    expect(toHelper?.callKind).toBe("direct");
    const toMissing = ex.callEdges.find((e) => e.to === "unresolved#missing");
    expect(toMissing?.callKind).toBe("unresolved");
  });

  it("never emits confirmed or likely (the floor caps at candidate)", async () => {
    const ex = await heuristicProvider.analyze(
      providerInput({ "a.go": "package main\nfunc main() { run() }\n", "b.rb": "class C\n  def m; end\nend\n" })
    );
    const all = [
      ...ex.declarations.map((d) => d.confidence),
      ...ex.ownershipSignals.map((s) => s.confidence),
      ...ex.callEdges.map((e) => e.confidence)
    ];
    expect(all.every((c) => ALLOWED.includes(c))).toBe(true);
  });

  it("returns empty arrays for an empty file and never throws", async () => {
    const ex = await heuristicProvider.analyze(providerInput({ "empty.py": "" }));
    expect(ex.declarations).toEqual([]);
    expect(ex.callEdges).toEqual([]);
  });
});

describe("typeScriptProvider.analyze (Epic B, ADR 0018)", () => {
  it("emits confirmed declarations + export-graded ownership signals", async () => {
    const ex = await typeScriptProvider.analyze(
      providerInput({ "x.ts": "export function foo() { return 1; }\nfunction priv() {}\n" })
    );
    const byName = new Map(ex.ownershipSignals.map((s) => [s.symbol, s]));
    expect(byName.get("foo")?.exported).toBe(true);
    expect(byName.get("foo")?.confidence).toBe("confirmed");
    expect(byName.get("priv")?.exported).toBe(false);
    expect(ex.declarations.find((d) => d.symbol === "foo")?.id).toBe("x.ts#foo");
  });

  it("resolves a cross-file import call to a confirmed direct edge", async () => {
    const ex = await typeScriptProvider.analyze(
      providerInput({
        "x.ts": "export function foo() {}\n",
        "a.ts": "import { foo } from './x';\nexport function main() { foo(); }\n"
      })
    );
    const edge = ex.callEdges.find((e) => e.to === "x.ts#foo");
    expect(edge?.from).toBe("a.ts#main");
    expect(edge?.callKind).toBe("direct");
    expect(edge?.confidence).toBe("confirmed");
  });

  it("grades computed-member calls as dynamic and unknown identifiers as unresolved", async () => {
    const ex = await typeScriptProvider.analyze(
      providerInput({ "a.ts": "export function main(o: any) { o['x'](); external(); }\n" })
    );
    const kinds = ex.callEdges.map((e) => e.callKind);
    expect(kinds).toContain("dynamic");
    expect(kinds).toContain("unresolved");
  });

  it("records class methods and grades every record within the confirmed ceiling", async () => {
    const ex = await typeScriptProvider.analyze(
      providerInput({ "c.ts": "export class Svc {\n  run() { this.help(); }\n  help() {}\n}\n" })
    );
    expect(ex.declarations.some((d) => d.symbol === "Svc.run")).toBe(true);
    const rank: Record<string, number> = { confirmed: 5, likely: 4, candidate: 3, unclear: 2, unresolved: 1 };
    expect(ex.declarations.every((d) => rank[d.confidence] <= 5)).toBe(true);
  });

  it("never throws on malformed input", async () => {
    const ex = await typeScriptProvider.analyze(providerInput({ "bad.ts": "export function (" }));
    expect(Array.isArray(ex.declarations)).toBe(true);
    expect(Array.isArray(ex.callEdges)).toBe(true);
  });

  it("caps method-call edges at likely (virtual dispatch is never confirmed)", async () => {
    const ex = await typeScriptProvider.analyze(
      providerInput({ "c.ts": "export class Svc {\n  run() { this.help(); }\n  help() {}\n}\n" })
    );
    const methodEdge = ex.callEdges.find((e) => e.callKind === "method");
    expect(methodEdge?.confidence).toBe("likely");
  });

  it("does not emit local declarations inside function bodies as module nodes", async () => {
    const ex = await typeScriptProvider.analyze(
      providerInput({ "a.ts": "export function main() {\n  const localOnly = 1;\n  return localOnly;\n}\n" })
    );
    expect(ex.declarations.some((d) => d.symbol === "localOnly")).toBe(false);
    expect(ex.declarations.some((d) => d.symbol === "main")).toBe(true);
  });

  // Re-export visibility (Epic K, ADR 0026): a barrel's public surface becomes an ownership
  // signal flagged `reExport`, with NO call-graph node — an alias is not a declaration.
  it("emits a reExport ownership signal (no node) for `export { x } from`", async () => {
    const ex = await typeScriptProvider.analyze(
      providerInput({
        "x.ts": "export function helper() { return 1; }\n",
        "index.ts": "export { helper } from './x';\n"
      })
    );
    const barrel = ex.ownershipSignals.find((s) => s.path === "index.ts" && s.symbol === "helper");
    expect(barrel?.reExport).toBe(true);
    expect(barrel?.exported).toBe(true);
    expect(barrel?.kind).toBe("function");
    expect(ex.declarations.some((d) => d.id === "index.ts#helper")).toBe(false);
    // the real owner is untouched
    const owner = ex.ownershipSignals.find((s) => s.path === "x.ts" && s.symbol === "helper");
    expect(owner?.reExport).toBeUndefined();
  });

  it("covers `export * from` and import-then-export; local declarations are never flagged", async () => {
    const ex = await typeScriptProvider.analyze(
      providerInput({
        "x.ts": "export class Widget {}\nexport const VALUE = 1;\n",
        "star.ts": "export * from './x';\n",
        "relay.ts": "import { VALUE } from './x';\nexport { VALUE };\nexport function local() {}\n"
      })
    );
    const star = ex.ownershipSignals.filter((s) => s.path === "star.ts");
    expect(star.find((s) => s.symbol === "Widget")?.reExport).toBe(true);
    expect(star.find((s) => s.symbol === "Widget")?.kind).toBe("class");
    expect(star.find((s) => s.symbol === "VALUE")?.reExport).toBe(true);
    const relay = ex.ownershipSignals.filter((s) => s.path === "relay.ts");
    expect(relay.find((s) => s.symbol === "VALUE")?.reExport).toBe(true);
    expect(relay.find((s) => s.symbol === "local")?.reExport).toBeUndefined();
    expect(ex.ownershipSignals.some((s) => s.symbol === "default")).toBe(false);
  });
});

describe("treeSitterProvider.analyze (Epic deepen, ADR 0021)", () => {
  it("parses Python declarations + same-file/unresolved call edges", async () => {
    const ex = await treeSitterProvider.analyze(
      providerInput({
        "m.py": "class Foo:\n    def bar(self):\n        helper()\n\ndef helper():\n    missing()\n\ndef _priv():\n    pass\n"
      })
    );
    const byName = new Map(ex.ownershipSignals.map((s) => [s.symbol, s]));
    expect(byName.get("Foo")?.kind).toBe("class");
    expect(byName.get("helper")?.exported).toBe(true);
    expect(byName.get("_priv")?.exported).toBe(false);
    expect(ex.callEdges.find((e) => e.to === "m.py#helper")?.callKind).toBe("direct");
    expect(ex.callEdges.find((e) => e.to === "unresolved#missing")?.callKind).toBe("unresolved");
  });

  it("parses Go exports by capitalization and struct/interface kinds", async () => {
    const ex = await treeSitterProvider.analyze(
      providerInput({
        "m.go": "package m\n\ntype Server struct{}\n\ntype Handler interface{}\n\nfunc Exported() {}\n\nfunc unexported() {}\n"
      })
    );
    const byName = new Map(ex.ownershipSignals.map((s) => [s.symbol, s]));
    expect(byName.get("Server")?.kind).toBe("class");
    expect(byName.get("Handler")?.kind).toBe("interface");
    expect(byName.get("Exported")?.exported).toBe(true);
    expect(byName.get("unexported")?.exported).toBe(false);
  });

  it("parses C# declarations + same-file calls", async () => {
    const ex = await treeSitterProvider.analyze(
      providerInput({ "Svc.cs": "class Svc {\n  public void Run() { Helper(); }\n  void Helper() {}\n}\n" })
    );
    const byName = new Map(ex.ownershipSignals.map((s) => [s.symbol, s]));
    expect(byName.get("Svc")?.kind).toBe("class");
    expect(byName.get("Run")?.exported).toBe(true);
    expect(byName.get("Helper")?.exported).toBe(false);
    expect(ex.callEdges.find((e) => e.to === "Svc.cs#Helper")?.callKind).toBe("direct");
  });

  it("parses C++ declarations + same-file calls; methods are qualified by class (N-S1, ADR 0035)", async () => {
    const ex = await treeSitterProvider.analyze(
      providerInput({ "main.cpp": "class Server {\npublic:\n  void start() { listen(); }\n};\nvoid listen() {}\nint main() { return 0; }\n" })
    );
    const names = ex.declarations.map((d) => d.symbol);
    expect(names).toContain("Server");
    expect(names).toContain("Server::start"); // N-S1: the method is qualified by its class
    expect(names).not.toContain("start"); // the bare short name is no longer a node
    expect(names).toContain("listen"); // a free function stays unqualified
    // The method's call to a free function still resolves (bare-name path, unchanged).
    const edge = ex.callEdges.find((e) => e.to === "main.cpp#listen");
    expect(edge?.callKind).toBe("direct");
    expect(edge?.from).toBe("main.cpp#Server::start"); // qualified `from`, matching the node id
  });

  it("C++ unqualified call inside a method resolves to the member, not a same-named free function (N-S1)", async () => {
    // C++ unqualified name lookup: a class member hides a namespace-scope function of the same name.
    const ex = await treeSitterProvider.analyze(
      providerInput({ "box.cpp": "class Box {\npublic:\n  int run() { return size(); }\n  int size() { return 3; }\n};\nint size() { return 99; }\n" })
    );
    const edge = ex.callEdges.find((e) => e.from === "box.cpp#Box::run");
    expect(edge?.to).toBe("box.cpp#Box::size"); // the member, NOT box.cpp#size (the free function)
    expect(edge?.callKind).toBe("direct");
  });

  it("resolves Rust cross-file calls via use-imports and module paths", async () => {
    const ex = await treeSitterProvider.analyze(
      providerInput({
        "util.rs": "pub fn helper() {}\n",
        "main.rs": "use crate::util::helper;\n\nfn run() {\n    helper();\n    util::helper();\n}\n"
      })
    );
    // both the use-imported bare call and the `util::helper` path call resolve to util.rs#helper
    const edges = ex.callEdges.filter((e) => e.from === "main.rs#run" && e.to === "util.rs#helper");
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.confidence === "likely")).toBe(true);
  });

  it("declares a `likely` ceiling (between TS confirmed and heuristic candidate)", () => {
    expect(treeSitterProvider.maxConfidence).toBe("likely");
  });

  it("never throws on malformed input", async () => {
    const ex = await treeSitterProvider.analyze(providerInput({ "bad.py": "def (((" }));
    expect(Array.isArray(ex.declarations)).toBe(true);
  });

  it("resolves Go intra-package calls across files (package = directory)", async () => {
    const ex = await treeSitterProvider.analyze(
      providerInput({
        "pkg/a.go": "package pkg\n\nfunc helper() {}\n",
        "pkg/b.go": "package pkg\n\nfunc use() {\n\thelper()\n}\n"
      })
    );
    const edge = ex.callEdges.find((e) => e.from === "pkg/b.go#use" && e.to === "pkg/a.go#helper");
    expect(edge?.callKind).toBe("direct");
    expect(edge?.confidence).toBe("likely");
  });

  it("resolves Go cross-package selector calls via import paths", async () => {
    const ex = await treeSitterProvider.analyze(
      providerInput({
        "util/util.go": "package util\n\nfunc Compute() int { return 1 }\n",
        "app/main.go": 'package app\n\nimport "example.com/proj/util"\n\nfunc Run() {\n\tutil.Compute()\n}\n'
      })
    );
    const edge = ex.callEdges.find((e) => e.from === "app/main.go#Run" && e.to === "util/util.go#Compute");
    expect(edge?.callKind).toBe("direct");
    expect(edge?.confidence).toBe("likely");
  });

  it("resolves Python imported names across files (from-import and qualified)", async () => {
    const ex = await treeSitterProvider.analyze(
      providerInput({
        "util.py": "def helper():\n    pass\n",
        "app.py": "from util import helper\n\ndef main():\n    helper()\n",
        "app2.py": "import util\n\ndef run():\n    util.helper()\n"
      })
    );
    expect(ex.callEdges.find((e) => e.from === "app.py#main")?.to).toBe("util.py#helper");
    expect(ex.callEdges.find((e) => e.from === "app2.py#run")?.to).toBe("util.py#helper");
  });
});

describe("engine confidence clamp (Decision 0012 safety net)", () => {
  // A buggy provider that over-grades EVERY record kind to `confirmed`. The engine clamp
  // must pull all four kinds down to the ceiling — this guards the "forgot one record kind"
  // omission that per-kind clamp loops invite (and that provider self-grading tests miss).
  const overGraded: ProviderExtraction = {
    declarations: [{ id: "x.ts#f", symbol: "f", path: "x.ts", kind: "function", confidence: "confirmed" }],
    ownershipSignals: [{ symbol: "f", kind: "function", path: "x.ts", exported: true, confidence: "confirmed", reason: "exported" }],
    entryPointHints: [{ path: "x.ts", kind: "source_entry", confidence: "confirmed", reason: "conventional" }],
    callEdges: [{ from: "x.ts#f", to: "y.ts#g", callKind: "direct", confidence: "confirmed", evidence: ["call expr"] }]
  };

  it("clamps every record kind to the provider ceiling (not just the ones a provider happens to emit)", () => {
    const clamped = clampExtraction(overGraded, "candidate");
    expect(clamped.declarations[0].confidence).toBe("candidate");
    expect(clamped.ownershipSignals[0].confidence).toBe("candidate");
    expect(clamped.entryPointHints[0].confidence).toBe("candidate");
    expect(clamped.callEdges[0].confidence).toBe("candidate"); // the kind nothing else currently guards
  });

  it("leaves records already at or below the ceiling unchanged", () => {
    const clamped = clampExtraction(overGraded, "confirmed");
    expect(clamped.declarations[0].confidence).toBe("confirmed");
    expect(clamped.callEdges[0].confidence).toBe("confirmed");
    // A `likely` ceiling weakens confirmed but never strengthens a weaker grade.
    const mixed = clampExtraction(
      { ...overGraded, callEdges: [{ from: "a", to: "b", callKind: "direct", confidence: "unclear", evidence: [] }] },
      "likely"
    );
    expect(mixed.declarations[0].confidence).toBe("likely"); // confirmed -> likely
    expect(mixed.callEdges[0].confidence).toBe("unclear"); // already weaker, untouched
  });
});
