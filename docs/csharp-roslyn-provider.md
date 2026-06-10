# C# Roslyn Provider — Implementation Note (ADR 0027, Epic L)

The C# tier (`src/providers/csharp.ts` + the `tools/roslyn-analyzer` sidecar) upgrades C#
from the tree-sitter tier (`likely`, no cross-file resolution) to a compiler-API tier
(`confirmed` ceiling) — the same role the TypeScript compiler API plays for TS/JS (ADR 0018).
It is **strictly optional**: availability chooses the tier, never correctness.

## Shape

```
init_codebase
  └─ groupByProvider          registry: [typescript, csharp, treeSitter, heuristic]
       └─ csharpProvider.analyze(batch)        only when `dotnet --version` succeeds (memoized)
            ├─ ensureAnalyzerBuilt()           dotnet build -c Release (memoized per process;
            │                                  first build does the NuGet restore)
            ├─ request.json (temp dir)         { files: [{ path, text }] }  ← file TEXTS, not paths
            ├─ dotnet RoslynAnalyzer.dll req   ONE ad-hoc CSharpCompilation over the batch's
            │                                  syntax trees — no MSBuild, `.Emit()` never called
            └─ stdout JSON → ProviderExtraction (then the engine clamp, ADR 0017)
```

The sidecar receives source **texts** in the request (honoring the `readFile` contract,
ADR 0013) and never touches the target filesystem; the Node side spawns `dotnet` only to
probe the SDK, build *our* tool, and run *our* tool.

## Extraction semantics

| Output | Rule |
|---|---|
| Declarations | Namespace types (class/struct/record → `class`, interface, enum, delegate → `type`) and their methods. Ids `path#Type` / `path#Type.Method` (TS-provider convention); `exported` = public accessibility of both the type and the member. Overloads and partials share one node (first wins). |
| Call edges | **Clean bindings only** (`SymbolInfo.Symbol`): non-virtual resolved → `direct`/`confirmed`; virtual/abstract/override/interface dispatch → `method`/`likely` (runtime-polymorphic, ADR 0016/0018). A candidate symbol (failed binding — ambiguity, arity mismatch, missing reference) is **never** graded resolved: it contributes only a name to `unresolved#name`. Object creations edge to the created **type** node. Constructor and property-accessor calls attribute to the containing type node. Evidence carries `path:line`. |
| Entry hints | Static `Main` or top-level statements → `source_entry` / `likely`. |

## Failure ladder (every rung degrades, none throws)

1. No `dotnet` CLI → `matches()` declines `.cs`; tree-sitter keeps C# exactly as pre-0027.
2. Sidecar build fails → empty extraction for the batch.
3. Sidecar crashes / emits malformed JSON / files unreadable → empty extraction.
4. The engine additionally treats any provider throw as "no extraction" (ADR 0017).

## Known limits (disclosed, deferred in ADR 0027)

- Calls inside top-level statements and field initializers emit **no edges** (the file still
  gets its entry hint). Absence of an edge is never evidence of absence of a call.
- Fields/properties are not ownership signals; only types + methods are.
- One compilation per batch: no multi-batch/cross-project resolution; external targets
  (BCL, NuGet) are `unresolved` by policy.
- Results vary by machine capability (SDK present or not) — the same disclosed property as
  the optional SQLite graph index (ADR 0024).

## Testing

`test/csharpProvider.test.ts`: the gating tests (probe, `.cs` claim, registry routing,
ceiling) always run; the Roslyn suite runs via `describe.runIf(dotnetAvailable)` — the
ratified optional-dependency pattern (no `.skip` markers; the anti-slop gate stays
meaningful). The failed-binding pin (candidate symbol → `unresolved`) is load-bearing for
the codebase-only contract. First run on a fresh machine pays the build/restore (long
timeouts on the warm-up `beforeAll`).

## Boundary

The sidecar **parses and semantically analyzes** checked-in source text — analysis tooling
over the codebase, like the TS compiler API. It never compiles the target to a runnable
artifact, executes target code, runs its tests, or loads its assemblies (ADR 0001/0002/0027).
