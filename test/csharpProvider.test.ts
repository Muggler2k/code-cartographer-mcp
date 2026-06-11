// C# Roslyn provider (Epic L, ADR 0027): an optional `confirmed`-ceiling tier behind a
// .NET sidecar. The deep suite runs only where the dotnet CLI exists (describe.runIf —
// the ratified optional-dependency pattern); the availability probe and the .cs gating
// are always tested.

import { beforeAll, describe, expect, it } from "vitest";

import { csharpProvider, dotnetAvailable } from "../src/providers/csharp.js";
import { selectProvider } from "../src/providers/registry.js";
import { treeSitterProvider } from "../src/providers/treeSitter.js";
import type { FileEntry } from "../src/schema.js";
import type { ProviderInput } from "../src/providers/types.js";
import { testFileEntry } from "./helpers/fixtures.js";

function file(p: string): FileEntry {
  return testFileEntry(p);
}

function providerInput(files: Record<string, string>): ProviderInput {
  return {
    repositoryRoot: "/repo",
    files: Object.keys(files).map((p) => file(p)),
    readFile: async (p: string) => {
      const content = files[p];
      if (content === undefined) throw new Error(`no such file ${p}`);
      return content;
    }
  };
}

const available = dotnetAvailable();

describe("csharp provider gating (ADR 0027 — optional .NET sidecar)", () => {
  it("the availability probe returns a boolean and is memoized", () => {
    expect(typeof available).toBe("boolean");
    expect(dotnetAvailable()).toBe(available); // second call hits the memo
  });

  it("never claims non-.cs files; claims .cs only when dotnet is available", () => {
    expect(csharpProvider.matches(file("a.ts"))).toBe(false);
    expect(csharpProvider.matches(file("a.py"))).toBe(false);
    expect(csharpProvider.matches(file("Svc.cs"))).toBe(available);
  });

  it("the registry routes .cs to Roslyn when available, else to the tree-sitter tier", () => {
    const selected = selectProvider(file("Svc.cs"));
    expect(selected).toBe(available ? csharpProvider : treeSitterProvider);
  });

  it("carries the confirmed ceiling of a compiler-API tier", () => {
    expect(csharpProvider.maxConfidence).toBe("confirmed");
  });
});

describe.runIf(available)("csharpProvider.analyze (ADR 0027 — Roslyn semantics)", () => {
  // Warm the sidecar build once (first build includes a NuGet restore on a fresh machine).
  beforeAll(async () => {
    await csharpProvider.analyze(providerInput({ "Warm.cs": "class Warm {}\n" }));
  }, 300_000);

  it("emits confirmed type + method declarations with public/private export grading", async () => {
    const ex = await csharpProvider.analyze(
      providerInput({
        "Svc.cs": "public class Svc {\n  public void Run() { Helper(); }\n  private void Helper() {}\n}\n"
      })
    );
    const byId = new Map(ex.declarations.map((d) => [d.id, d]));
    expect(byId.get("Svc.cs#Svc")?.kind).toBe("class");
    expect(byId.get("Svc.cs#Svc.Run")?.kind).toBe("function");
    expect(byId.get("Svc.cs#Svc")?.confidence).toBe("confirmed");
    const own = new Map(ex.ownershipSignals.map((s) => [s.symbol, s]));
    expect(own.get("Svc.Run")?.exported).toBe(true);
    expect(own.get("Svc.Helper")?.exported).toBe(false);
  }, 120_000);

  it("resolves a same-class call as a confirmed direct edge and externals as unresolved", async () => {
    const ex = await csharpProvider.analyze(
      providerInput({
        "Svc.cs": "public class Svc {\n  public void Run() { Helper(); System.Console.WriteLine(1); }\n  private void Helper() {}\n}\n"
      })
    );
    const direct = ex.callEdges.find((e) => e.to === "Svc.cs#Svc.Helper");
    expect(direct?.from).toBe("Svc.cs#Svc.Run");
    expect(direct?.callKind).toBe("direct");
    expect(direct?.confidence).toBe("confirmed");
    const external = ex.callEdges.find((e) => e.to === "unresolved#WriteLine");
    expect(external?.callKind).toBe("unresolved");
    expect(external?.confidence).toBe("unresolved");
  }, 120_000);

  it("resolves cross-file calls and grades interface dispatch as method/likely — never confirmed", async () => {
    const ex = await csharpProvider.analyze(
      providerInput({
        "IWorker.cs": "public interface IWorker { void Work(); }\n",
        "Impl.cs": "public class Impl : IWorker {\n  public void Work() {}\n}\n",
        "User.cs": "public class User {\n  public void Use(IWorker w) { w.Work(); var i = new Impl(); }\n}\n"
      })
    );
    const dispatch = ex.callEdges.find((e) => e.to === "IWorker.cs#IWorker.Work");
    expect(dispatch?.from).toBe("User.cs#User.Use");
    expect(dispatch?.callKind).toBe("method");
    expect(dispatch?.confidence).toBe("likely"); // dispatch is runtime-polymorphic (ADR 0016/0018)
    const creation = ex.callEdges.find((e) => e.to === "Impl.cs#Impl");
    expect(creation?.callKind).toBe("direct");
  }, 120_000);

  it("emits a likely source_entry hint for static Main and for top-level statements", async () => {
    const ex = await csharpProvider.analyze(
      providerInput({
        "App.cs": "public class App { public static void Main() {} }\n",
        "Top.cs": "System.Console.WriteLine(1);\n",
        "Lib.cs": "public class Lib { public void NotMain() {} }\n"
      })
    );
    const hinted = ex.entryPointHints.map((h) => h.path).sort();
    expect(hinted).toEqual(["App.cs", "Top.cs"]);
    expect(ex.entryPointHints.every((h) => h.kind === "source_entry" && h.confidence === "likely")).toBe(true);
  }, 120_000);

  it("grades a FAILED binding (candidate symbol) as unresolved — never direct/confirmed (B-1 pin)", async () => {
    // Helper(1) does not bind (arity mismatch): Roslyn returns it as a CANDIDATE symbol.
    // A failed binding must never earn resolved grading (codebase-only contract).
    const ex = await csharpProvider.analyze(
      providerInput({
        "Svc.cs": "public class Svc {\n  public void Run() { Helper(1); }\n  private void Helper() {}\n}\n"
      })
    );
    const edge = ex.callEdges.find((e) => e.from === "Svc.cs#Svc.Run");
    expect(edge?.to).toBe("unresolved#Helper");
    expect(edge?.callKind).toBe("unresolved");
    expect(edge?.confidence).toBe("unresolved");
    expect(ex.callEdges.some((e) => e.to === "Svc.cs#Svc.Helper")).toBe(false);
  }, 120_000);

  it("attributes constructor and accessor calls to the containing TYPE node (S-1)", async () => {
    const ex = await csharpProvider.analyze(
      providerInput({
        "Svc.cs":
          "public class Svc {\n" +
          "  public Svc() { Init(); }\n" +
          "  public int Size { get { return Measure(); } }\n" +
          "  private void Init() {}\n" +
          "  private int Measure() { return 1; }\n" +
          "}\n"
      })
    );
    const fromType = ex.callEdges.filter((e) => e.from === "Svc.cs#Svc").map((e) => e.to).sort();
    expect(fromType).toEqual(["Svc.cs#Svc.Init", "Svc.cs#Svc.Measure"]);
  }, 120_000);

  it("binds repo-internal calls whose receiver type flows through the BCL (ADR 0032 Tier 1)", async () => {
    // Pre-0032 this failed binding: without LINQ references, items.First() has an error
    // type, so .Score() cannot bind and degraded to unresolved#Score. With host-SDK
    // references the INTERNAL edge resolves; the EXTERNAL target (First) must STAY
    // unresolved#First — references improve binding, never the codebase-only boundary.
    const ex = await csharpProvider.analyze(
      providerInput({
        "Models.cs": "public class Item {\n  public int Score() { return 1; }\n}\n",
        "Report.cs":
          "using System.Collections.Generic;\n" +
          "using System.Linq;\n" +
          "public static class Report {\n" +
          "  public static int First(List<Item> items) {\n" +
          "    return items.First().Score();\n" +
          "  }\n" +
          "}\n"
      })
    );
    const internal = ex.callEdges.find((e) => e.to === "Models.cs#Item.Score");
    expect(internal?.from).toBe("Report.cs#Report.First");
    expect(internal?.callKind).toBe("direct");
    expect(internal?.confidence).toBe("confirmed");
    expect(ex.callEdges.some((e) => e.to === "unresolved#Score")).toBe(false);
    const external = ex.callEdges.find((e) => e.to === "unresolved#First");
    expect(external?.callKind).toBe("unresolved");
    expect(external?.confidence).toBe("unresolved");
  }, 120_000);

  it("emits property/field ownership signals with export grading — signals only, never call-graph nodes (ADR 0032)", async () => {
    const ex = await csharpProvider.analyze(
      providerInput({
        "Customer.cs":
          "public class Customer {\n" +
          "  public string Name { get; set; } = \"\";\n" +
          "  public int Limit;\n" +
          "  private int secret;\n" +
          "}\n"
      })
    );
    const own = new Map(ex.ownershipSignals.map((s) => [s.symbol, s]));
    expect(own.get("Customer.Name")?.kind).toBe("property");
    expect(own.get("Customer.Name")?.exported).toBe(true);
    expect(own.get("Customer.Limit")?.kind).toBe("field");
    expect(own.get("Customer.Limit")?.exported).toBe(true);
    expect(own.get("Customer.secret")?.exported).toBe(false);
    // Data members are ownership signals ONLY — the call graph stays behavior (types + methods).
    expect(ex.declarations.some((d) => d.id === "Customer.cs#Customer.Name")).toBe(false);
    expect(ex.declarations.some((d) => d.id === "Customer.cs#Customer.Limit")).toBe(false);
  }, 120_000);

  it("degrades to an empty extraction on unreadable input, never throwing", async () => {
    const ex = await csharpProvider.analyze({
      repositoryRoot: "/repo",
      files: [file("Gone.cs")],
      readFile: async () => {
        throw new Error("unreadable");
      }
    });
    expect(ex.declarations).toEqual([]);
    expect(ex.callEdges).toEqual([]);
  }, 120_000);
});
