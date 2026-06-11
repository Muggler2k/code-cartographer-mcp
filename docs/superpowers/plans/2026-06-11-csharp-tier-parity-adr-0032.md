# C# Tier Parity (ADR 0032) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two ADR 0027 deferred gaps in the C# Roslyn tier — external-reference resolution (so repo-internal call bindings stop failing when receiver types flow through the BCL) and field/property ownership signals.

**Architecture:** The Roslyn sidecar (`tools/roslyn-analyzer/Program.cs`) gains the host SDK's Trusted Platform Assemblies as metadata references (Tier 1 — no network, no target interaction, no new dependencies) and emits property/field declarations. The Node provider (`src/providers/csharp.ts`) maps data members to ownership signals **only** (never call-graph nodes), and `src/findings.ts` excludes data-member kinds from name-collision grouping. External call **targets** keep mapping to `unresolved#name` — references improve *binding*, never the codebase-only boundary.

**Tech Stack:** TypeScript (strict, NodeNext ESM — relative imports use `.js`), Vitest, .NET/Roslyn sidecar (C#), the eval harness (`npm run eval`) + bench gates.

---

## Context an executor must know (read this first)

- **Two repos.** Implementation lives here; requirements/decisions live in the CAS repo at `../debug_mcp_context_manager`. Architecture changes are ratified there as ADRs first (Task 1).
- **Codebase-only contract (load-bearing).** Confidence vocabulary is `confirmed | likely | candidate | unclear | unresolved`. A clean Roslyn binding to a repo-internal method → `direct`/`confirmed`; virtual/interface dispatch → `method`/`likely`; a failed binding is NEVER graded resolved; external targets (BCL/NuGet) are `unresolved#name` **by policy and must stay that way after this change**.
- **Eval-first (ADR 0028).** New provider claims must land with fixture constructs + golden entries. Goldens are human-authored from reading the fixture source — never regenerated from analyzer output. Bench baselines (`eval/baselines.json`) gate hard; updating them requires written reasoning, never a silent regen.
- **A PostToolUse hook runs typecheck + the test suite after every file edit** in this repo. A red hook message after an intermediate edit in a multi-edit step is expected; it must be green by the end of each task.
- **Anti-slop gate:** `npm run slop` forbids `.skip`/`.only`/`.todo`, `@ts-ignore`/`@ts-expect-error`, and `expect(true)`. The C#-dependent suites use `describe.runIf(dotnetAvailable)` — the ratified optional-dependency pattern.
- **Conventions:** two-space indent, `camelCase` functions, `PascalCase` types, `UPPER_SNAKE_CASE` module constants.
- **Current state (verified 2026-06-11):** 307 tests across 21 files; 20 MCP tools; decisions 0001–0031; `main` is the working branch base. Work on a feature branch `feat/csharp-parity-adr-0032`.

## Model routing (Fable-optimized)

| Task | Model | Why |
|---|---|---|
| 1 (ADR), 6 (baselines), 7 (boundary review + sync) | **Fable / orchestrator session** | Contract-sensitive: boundary wording, golden authorship sign-off, conscious baseline updates |
| 2 (sidecar references), 3 (schema + findings guard), 4 (property/field extraction) | **Sonnet subagents** | Well-specified implementation with exact code below |
| 5 (fixture + golden scaffolding) | **Haiku subagent**, goldens verified by Fable before commit | Mechanical file authoring from exact content below |

Tasks 2 and 3 are independent — dispatch in parallel. Task 4 depends on Task 3 (schema union). Task 5 depends on 2 + 4. Tasks 6–7 are sequential at the end.

## File structure

| File | Change |
|---|---|
| `../debug_mcp_context_manager/context/07_decisions/0032-csharp-tier-parity.md` | Create — the ADR |
| `../debug_mcp_context_manager/context/00_index/index.md`, `code-cartographer-mcp-manifest.md` | Modify — register ADR 0032 |
| `tools/roslyn-analyzer/Program.cs` | Modify — TPA references; property/field declaration pass |
| `src/schema.ts` | Modify — extend `OwnershipSignalKind` with `"property" \| "field"` |
| `src/findings.ts` | Modify — data-member kinds excluded from `exportedByName` |
| `src/providers/csharp.ts` | Modify — accept new kinds; data members → signals only, not nodes |
| `test/csharpProvider.test.ts` | Modify — new `runIf` tests (binding-through-BCL, data members, external-target pin) |
| `test/findings.test.ts` | Modify — data-member guard tests |
| `eval/fixtures/csharp-small/Models.cs`, `Report.cs` | Create — fixture constructs |
| `eval/goldens/csharp-small.json` | Modify — golden entries (Fable-verified) |
| `eval/baselines.json` | Modify — conscious structural-count update with reasoning |

---

### Task 1: ADR 0032 in the CAS repo

**Model: Fable.** Files:
- Create: `../debug_mcp_context_manager/context/07_decisions/0032-csharp-tier-parity.md`
- Modify: `../debug_mcp_context_manager/context/00_index/index.md` (Latest-decision cell, the `0001`–`{N}` inline decision list, the two "decisions 0001–0031" prose spots → 0032)
- Modify: `../debug_mcp_context_manager/context/00_index/code-cartographer-mcp-manifest.md` (append to the decisions file list)

- [ ] **Step 1: Write the ADR**

```markdown
---
title: "Decision 0032: C# Tier Parity — Host-SDK References and Data-Member Ownership"
type: "decision-record"
status: "accepted"
domain: "architecture"
created: "2026-06-11"
updated: "2026-06-11"
owner: "Drew Gall"
amends: ["0027"]
---

# Decision 0032: C# Tier Parity — Host-SDK References and Data-Member Ownership

## Context

ADR 0027 shipped the C# Roslyn tier with two disclosed deferrals: the ad-hoc compilation
references only corelib (`typeof(object).Assembly.Location`), so any repo-internal call
whose binding requires BCL surface (LINQ/extension methods, `Task`, receiver types flowing
through framework generics) fails binding and degrades to `unresolved#name`; and
fields/properties are not ownership signals. On framework-heavy C# code the call graph is
materially thinner than the TS tier's.

## Decision

### Reference tiering

- **Tier 1 (this decision):** the sidecar references the HOST SDK's own Trusted Platform
  Assemblies (`AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")`) — the runtime that
  already runs our tool supplies the BCL analysis surface. No network, no new dependency,
  nothing from the TARGET repo referenced or loaded. Failure to load any individual
  assembly degrades silently to the corelib floor (the ADR 0027 failure ladder holds).
- **Tier 2 (deferred, separate decision):** opportunistic read-only use of an existing
  `obj/project.assets.json` + the NuGet global cache for package references — never
  running restore. Deferred until Tier 1's measured gain is recorded.
- **Tier 3 (never):** MSBuild design-time builds or restoring the target's packages.

### Boundary is unchanged

References improve BINDING, not the boundary: a call whose TARGET is external still maps
to `unresolved#name` (mirroring the TS provider's node_modules policy). The win is
repo-internal edges that previously failed binding now grading `direct`/`confirmed` or
`method`/`likely`. Results remain analysis-time binding against the host SDK's surface,
not the target's exact TFM — disclosed, like SDK presence already is (ADR 0027).

### Data-member ownership

The sidecar emits public/non-public property and field declarations
(`path#Type.Member`); `OwnershipSignalKind` gains `"property" | "field"` (additive —
signals are not in `mapHash`, schema stays v1, the `reExport` precedent). Data members
become ownership signals ONLY, never call-graph nodes (the graph stays behavior:
types + methods), and findings derivation EXCLUDES data-member kinds from exported-name
collision grouping (duplicates, canonical, scattered ownership): two types each exposing
`.Name` is API surface, not a parallel implementation.

### Verification (eval-first, ADR 0028)

Fixture constructs + goldens: a repo-internal call whose receiver type flows through LINQ
(must grade `confirmed` and must NOT appear as `unresolved#<name>`), an external-target
pin (stays `unresolved#<name>`), and property/field export grading. Structural bench
baselines updated consciously with reasoning (counts grow by design).

## Consequences

- Repo-internal C# call-graph coverage rises on framework-using code; `csharp-small`
  gains fixture files; `eval/baselines.json` counts change (reasoned update).
- Deferred: Tier 2 assets.json references; edges from field initializers / top-level
  statement bodies (ADR 0027 disclosure stands); C# events as signals.

## Boundary

Unchanged (0001/0002/0027): the sidecar parses and semantically analyzes source texts;
referencing the host runtime's reference assemblies loads METADATA for binding, never
target code; `.Emit()` is never called; nothing executes.
```

- [ ] **Step 2: Register the ADR** in `index.md` (three spots: the "Latest decision" cell, the inline `0001…0031` list gains `· 0032 C# tier parity — host-SDK references + data-member ownership`, and both "decisions 0001–0031" prose ranges become 0032) and append `- context/07_decisions/0032-csharp-tier-parity.md` to the manifest's decisions list.

- [ ] **Step 3: Commit the CAS repo**

```bash
git -C ../debug_mcp_context_manager add -A
git -C ../debug_mcp_context_manager commit -m "ADR 0032 (C# tier parity) + index/manifest registration"
```

---

### Task 2: Sidecar Tier-1 references (binding through the BCL)

**Model: Sonnet.** Files:
- Modify: `tools/roslyn-analyzer/Program.cs:59-63` (the `CSharpCompilation.Create` call)
- Test: `test/csharpProvider.test.ts` (inside the existing `describe.runIf(available)` block)

- [ ] **Step 1: Write the failing test** — append inside `describe.runIf(available)("csharpProvider.analyze …")`, after the "attributes constructor and accessor calls" test:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/csharpProvider.test.ts -t "binds repo-internal calls"`
Expected: FAIL — `internal` is `undefined` (the edge today is `unresolved#Score`).

- [ ] **Step 3: Implement host references in `Program.cs`** — replace lines 56–63 (the comment + `CSharpCompilation.Create` call) with:

```csharp
// References: the HOST SDK's own Trusted Platform Assemblies (ADR 0032 Tier 1) — the
// runtime already running this tool supplies the BCL surface so repo-internal bindings
// that flow through framework types resolve. METADATA only, analysis-time binding;
// nothing from the TARGET repo is referenced or loaded, and external TARGETS still map
// to unresolved#name below. Any unloadable assembly is skipped; if everything fails we
// fall back to the corelib floor (the ADR 0027 failure ladder: degrade, never throw).
var references = new List<MetadataReference>();
if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string tpa)
{
    foreach (var assemblyPath in tpa.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
    {
        try { references.Add(MetadataReference.CreateFromFile(assemblyPath)); }
        catch { /* unreadable/non-assembly entry — skip */ }
    }
}
if (references.Count == 0)
{
    references.Add(MetadataReference.CreateFromFile(typeof(object).Assembly.Location));
}

// OutputKind only shapes semantic checks (e.g. top-level statements need an exe kind on
// some paths; DLL is the neutral choice). `.Emit()` is NEVER called — nothing is compiled
// to a runnable artifact, loaded, or executed (codebase-only, ADR 0001/0027).
var compilation = CSharpCompilation.Create(
    "codebase",
    trees,
    references,
    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
```

- [ ] **Step 4: Run the new test and the full C# suite**

Run: `npx vitest run test/csharpProvider.test.ts`
Expected: ALL PASS — including the pre-existing pins: "externals as unresolved" (`System.Console.WriteLine` now binds cleanly but its target is not in `symbolToId`, so it still emits `unresolved#WriteLine` — the existing code path handles this with no change) and the B-1 failed-binding pin (arity mismatch is reference-independent).

- [ ] **Step 5: Run the whole suite** (`npm test`) — expected: all tests pass (the hook will have run it too).

- [ ] **Step 6: Commit**

```bash
git add tools/roslyn-analyzer/Program.cs test/csharpProvider.test.ts
git commit -m "C# Tier 1 references (ADR 0032): bind through the host SDK's BCL surface

Repo-internal calls whose receiver types flow through LINQ/framework generics
now resolve (direct/confirmed); external TARGETS still map to unresolved#name
(boundary unchanged). Per-assembly load failures degrade to the corelib floor."
```

---

### Task 3: Schema kinds + findings data-member guard

**Model: Sonnet.** Independent of Task 2. Files:
- Modify: `src/schema.ts:190` (the `OwnershipSignalKind` union)
- Modify: `src/findings.ts:134-140` (the `exportedByName` construction)
- Test: `test/findings.test.ts`

- [ ] **Step 1: Write the failing tests** — append inside `describe("deriveFindings (D4, ADR 0017)")` in `test/findings.test.ts`. Note the existing `own()` helper hard-codes `kind: "function"`; add a kind parameter to it (update its signature in place — no call sites break because the parameter defaults):

```ts
function own(path: string, symbol: string, exported: boolean, kind: OwnershipSignal["kind"] = "function"): OwnershipSignal {
  return { symbol, kind, path, exported, confidence: "confirmed", reason: "x" };
}
```

```ts
  it("data-member kinds never enter name-collision grouping — no duplicate from two same-named properties (ADR 0032)", () => {
    const f = deriveFindings(
      input({
        ownershipSignals: [own("Customer.cs", "Customer.Name", true, "property"), own("Vendor.cs", "Customer.Name", true, "property")]
      })
    );
    expect(f.duplicatePathCandidates).toHaveLength(0);
  });

  it("data-member kinds are not canonical-path candidates and do not scatter ownership (ADR 0032)", () => {
    const f = deriveFindings(
      input({
        declarations: [decl("a.ts#main")],
        ownershipSignals: [
          own("a.cs", "Cfg.Limit", true, "field"),
          own("b.cs", "Cfg.Limit", true, "field"),
          own("c.cs", "Cfg.Limit", true, "field"),
          own("a.ts", "main", true)
        ],
        callEdges: [{ from: "a.ts#main", to: "a.cs#Cfg.Limit", callKind: "direct", confidence: "confirmed", evidence: [] }]
      })
    );
    expect(f.canonicalPaths.some((c) => c.id.endsWith("Cfg.Limit"))).toBe(false);
    expect(f.riskAreas.some((r) => r.finding.includes("Cfg.Limit"))).toBe(false);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/findings.test.ts -t "ADR 0032"`
Expected: FAIL — first test compile-errors on the `"property"` kind (not in the union yet); after the schema edit alone it would fail with 1 duplicate found.

- [ ] **Step 3: Extend the schema union** — in `src/schema.ts` replace:

```ts
export type OwnershipSignalKind = "class" | "const" | "enum" | "function" | "interface" | "type";
```

with:

```ts
// "property" | "field" (ADR 0032): C# data members. Additive — ownership signals are not
// part of `mapHash` (file-identity only, Decision 0011), so schema stays v1.
export type OwnershipSignalKind = "class" | "const" | "enum" | "field" | "function" | "interface" | "property" | "type";
```

- [ ] **Step 4: Add the findings guard** — in `src/findings.ts`, above `deriveFindings`, add a module constant next to the other `UPPER_SNAKE_CASE` constants:

```ts
// Data members (ADR 0032) name API surface, not behavior: two types each exposing `.Name`
// is not a parallel implementation. Excluded from exported-name grouping, which feeds the
// duplicate, canonical, and scattered-ownership rules.
const DATA_MEMBER_KINDS: ReadonlySet<OwnershipSignal["kind"]> = new Set(["property", "field"]);
```

and change the `exportedByName` loop body from:

```ts
  for (const sig of input.ownershipSignals) {
    if (!sig.exported || sig.reExport) continue;
```

to:

```ts
  for (const sig of input.ownershipSignals) {
    if (!sig.exported || sig.reExport || DATA_MEMBER_KINDS.has(sig.kind)) continue;
```

- [ ] **Step 5: Run the findings suite, then the whole suite**

Run: `npx vitest run test/findings.test.ts` then `npm test`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schema.ts src/findings.ts test/findings.test.ts
git commit -m "Schema + findings (ADR 0032): property/field signal kinds, excluded from name-collision grouping

Additive union extension (signals are outside mapHash; schema stays v1). Data
members are API surface, not behavior - they never feed the duplicate,
canonical, or scattered-ownership rules."
```

---

### Task 4: Sidecar + provider data-member extraction

**Model: Sonnet.** Depends on Task 3. Files:
- Modify: `tools/roslyn-analyzer/Program.cs` (pass 1, after the method branch at lines 110–124)
- Modify: `src/providers/csharp.ts:115-121` (`SIGNAL_KINDS`/`toKind`) and `:173-186` (the mapping loop)
- Test: `test/csharpProvider.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the `describe.runIf(available)` block:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/csharpProvider.test.ts -t "property/field ownership"`
Expected: FAIL — `own.get("Customer.Name")` is `undefined`.

- [ ] **Step 3: Extend the sidecar's pass 1** — in `Program.cs`, inside the `foreach (var node in tree.GetRoot().DescendantNodes())` of pass 1, add two branches after the `MethodDeclarationSyntax` branch (before the `GlobalStatementSyntax` branch):

```csharp
        else if (node is PropertyDeclarationSyntax propDecl && propDecl.Parent is TypeDeclarationSyntax propOwner)
        {
            // Data members (ADR 0032): ownership signals on the Node side, never graph nodes.
            var propSymbol = model.GetDeclaredSymbol(propDecl);
            if (propSymbol is null) continue;
            var compound = $"{propOwner.Identifier.Text}.{propDecl.Identifier.Text}";
            var propId = $"{rel}#{compound}";
            if (seenIds.Add(propId))
            {
                var exported = IsPublic(propSymbol) && IsPublic(propSymbol.ContainingType);
                declarations.Add(new DeclOut(propId, compound, rel, "property", exported));
            }
        }
        else if (node is FieldDeclarationSyntax fieldDecl && fieldDecl.Parent is TypeDeclarationSyntax fieldOwner)
        {
            foreach (var variable in fieldDecl.Declaration.Variables)
            {
                var fieldSymbol = model.GetDeclaredSymbol(variable);
                if (fieldSymbol is null) continue;
                var compound = $"{fieldOwner.Identifier.Text}.{variable.Identifier.Text}";
                var fieldId = $"{rel}#{compound}";
                if (seenIds.Add(fieldId))
                {
                    var exported = IsPublic(fieldSymbol) && IsPublic(fieldSymbol.ContainingType);
                    declarations.Add(new DeclOut(fieldId, compound, rel, "field", exported));
                }
            }
        }
```

- [ ] **Step 4: Map the new kinds on the Node side** — in `src/providers/csharp.ts`, replace the `SIGNAL_KINDS` block (lines 115–121) with:

```ts
const SIGNAL_KINDS: ReadonlySet<string> = new Set(["class", "const", "enum", "field", "function", "interface", "property", "type"]);

// Data members (ADR 0032) are ownership signals only — the call graph stays behavior
// (types + methods), so these kinds never become CallGraphNodes below.
const DATA_MEMBER_KINDS: ReadonlySet<string> = new Set(["property", "field"]);

// The sidecar contract emits class|interface|enum|type|function|property|field; the fallback
// only guards a future sidecar kind we have not mapped yet (it must never throw mid-build).
function toKind(kind: string): OwnershipSignalKind {
  return (SIGNAL_KINDS.has(kind) ? kind : "const") as OwnershipSignalKind;
}
```

and in the mapping loop (lines 175–186), wrap the node push:

```ts
    for (const decl of response.declarations ?? []) {
      const kind = toKind(decl.kind);
      if (!DATA_MEMBER_KINDS.has(kind)) {
        declarations.push({ id: decl.id, symbol: decl.symbol, path: decl.path, kind, confidence: "confirmed" });
      }
      ownershipSignals.push({
        symbol: decl.symbol,
        kind,
        path: decl.path,
        exported: decl.exported,
        confidence: "confirmed",
        reason: decl.exported ? "public declaration (Roslyn)" : "non-public declaration (Roslyn)"
      });
    }
```

- [ ] **Step 5: Run the C# suite, then the whole suite**

Run: `npx vitest run test/csharpProvider.test.ts` then `npm test`
Expected: ALL PASS (the existing "Size" property in the accessor-attribution test now also yields a `Svc.Size` ownership signal — that test asserts edges only, so it is unaffected).

- [ ] **Step 6: Commit**

```bash
git add tools/roslyn-analyzer/Program.cs src/providers/csharp.ts test/csharpProvider.test.ts
git commit -m "C# data-member ownership (ADR 0032): property/field signals, never graph nodes

Sidecar emits path#Type.Member declarations with public/public export grading;
the provider maps them to ownership signals only - the call graph stays
behavior (types + methods)."
```

---

### Task 5: Eval fixture constructs + goldens

**Model: Haiku for the fixture/golden file edits exactly as written below; Fable verifies the golden entries against the fixture source before the commit** (goldens are human-authored ground truth — ADR 0029). Depends on Tasks 2 + 4. Files:
- Create: `eval/fixtures/csharp-small/Models.cs`, `eval/fixtures/csharp-small/Report.cs`
- Modify: `eval/goldens/csharp-small.json`

- [ ] **Step 1: Create `eval/fixtures/csharp-small/Models.cs`**

```csharp
public class Item
{
    public string Tag { get; set; } = "";

    public int Score()
    {
        return 1;
    }
}
```

- [ ] **Step 2: Create `eval/fixtures/csharp-small/Report.cs`**

```csharp
using System.Collections.Generic;
using System.Linq;

public static class Report
{
    public static int FirstScore(List<Item> items)
    {
        return items.First().Score();
    }
}
```

- [ ] **Step 3: Extend `eval/goldens/csharp-small.json`** — merge these entries into the existing arrays/objects (do not remove any existing entry):

```json
{
  "symbols": {
    "required": [
      "Models.cs#Item",
      "Models.cs#Item.Score",
      "Report.cs#Report",
      "Report.cs#Report.FirstScore"
    ],
    "forbidden": ["Models.cs#Item.Tag"]
  },
  "exported": {
    "Models.cs#Item.Tag": true,
    "Report.cs#Report.FirstScore": true
  },
  "edges": {
    "required": [
      { "from": "Report.cs#Report.FirstScore", "to": "Models.cs#Item.Score", "callKind": "direct", "confidence": "confirmed" }
    ],
    "forbidden": []
  }
}
```

Why each entry: the required edge is the ADR 0032 Tier-1 claim (binding through `First()`); `Models.cs#Item.Tag` is **forbidden as a node** (data members never enter the call graph) but **required as an exported ownership signal** (the harness checks `exported` against `summary.ownershipSignals`, not nodes); existing `duplicates.forbiddenIds` stays as-is.

- [ ] **Step 4: Run the eval and the gate**

Run: `npm run eval` then `npx vitest run test/evalHarness.test.ts`
Expected: `csharp-small PASS` with required found = 100%, 0 forbidden, 0 invariant violations. `test/benchGates.test.ts` will now FAIL on csharp-small structural counts — expected and intentional.

- [ ] **Step 5: Do NOT commit yet.** The bench gate is red until the baseline update; Task 6 lands in the SAME commit so the suite is green at every commit. Proceed directly to Task 6.

---

### Task 6: Conscious bench-baseline update

**Model: Fable** (policy: baselines update with written reasoning, never silently). Files:
- Modify: `eval/baselines.json` (the `csharp-small` entry)

- [ ] **Step 1: Run `npm run eval`** and read the new csharp-small structural numbers from the scorecard / `eval/results/latest.json` (files 2→4; nodes/edges grow by the Task 5 fixture; initMs may grow from reference loading — wall-clock is soft-gated, structural counts are hard-gated).
- [ ] **Step 2: Edit `eval/baselines.json`** — update only the csharp-small structural counts to the verified-run numbers.
- [ ] **Step 3: Run `npx vitest run test/benchGates.test.ts`** — expected: PASS. Then `npm test` — all green.
- [ ] **Step 4: Commit fixtures + goldens + baselines together, with the reasoning in the message**

```bash
git add eval/fixtures/csharp-small/ eval/goldens/csharp-small.json eval/baselines.json
git commit -m "Eval (ADR 0032): csharp-small constructs, goldens, and reasoned baseline update

Goldens pin the Tier-1 claim (BCL-bound internal edge grades confirmed; the
external target stays unresolved#First) and data-member semantics (Item.Tag is
a required exported signal and a FORBIDDEN node). Baseline update is reasoned,
not a regen: +2 fixture files add their types/methods as nodes and the new
internal edge; data members add ownership signals but no nodes. Verified
against a green eval run."
```

---

### Task 7: Boundary review, full verification, context sync

**Model: Fable + the `boundary-reviewer` agent.**

- [ ] **Step 1:** Dispatch the `boundary-reviewer` agent over the branch diff (`git diff main...HEAD`) with explicit attention to: external targets still `unresolved#name` after references; no wording anywhere implying the sidecar builds/loads/executes the target; data members absent from the call graph; goldens not derived from output.
- [ ] **Step 2:** Fix anything it flags (each fix is its own small TDD loop + commit, as in Tasks 2–4).
- [ ] **Step 3:** Full gates: `npm run typecheck`, `npm test`, `npm run slop`, `npm run eval` — all green.
- [ ] **Step 4:** Run the `cartographer-context-sync` skill (docs counts: test total, "Known limits" in `docs/csharp-roslyn-provider.md` — the references limit moves from "deferred" to "Tier 1 done, Tier 2 deferred"; CAS session log; memory). Commit both repos; merge to `main` after review.

---

## Deferred (out of this plan, recorded in ADR 0032)

- **Tier 2:** read-only `project.assets.json` + NuGet global cache references (needs its own boundary sign-off and a Node→sidecar request extension).
- Edges from field initializers / top-level statement bodies.
- C# events as ownership signals.

## Self-review notes

- Spec coverage: G1 Tier 1 → Tasks 1, 2, 5, 6; G2 → Tasks 1, 3, 4, 5; boundary pins → Tasks 2 (external stays unresolved), 5 (forbidden node), 7 (reviewer).
- Type consistency: `OwnershipSignalKind` extension (Task 3) precedes its use in `csharp.ts` (Task 4) and tests; `CallGraphNode.kind` reuses the same union so no second change is needed; fixture/test ids all use the sidecar's `path#Type.Member` convention.
- The existing test at `test/csharpProvider.test.ts:76-89` ("externals as unresolved") doubles as the regression pin that Tier 1 references do not change external-target policy — Task 2 Step 4 calls it out explicitly.
