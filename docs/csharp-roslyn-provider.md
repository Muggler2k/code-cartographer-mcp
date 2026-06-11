# C# Roslyn Provider — Implementation Note (ADR 0027, Epic L; references + data members: ADR 0032)

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
            │                                  syntax trees — no MSBuild, `.Emit()` never called;
            │                                  references = the HOST SDK's Trusted Platform
            │                                  Assemblies (ADR 0032 Tier 1): metadata-only, no
            │                                  network, nothing from the TARGET repo loaded
            └─ stdout JSON → ProviderExtraction (then the engine clamp, ADR 0017)
```

The sidecar receives source **texts** in the request (honoring the `readFile` contract,
ADR 0013) and never touches the target filesystem; the Node side spawns `dotnet` only to
probe the SDK, build *our* tool, and run *our* tool.

## Extraction semantics

| Output | Rule |
|---|---|
| Declarations | Namespace types (class/struct/record → `class`, interface, enum, delegate → `type`) and their methods. Ids `path#Type` / `path#Type.Method` (TS-provider convention); `exported` = public accessibility of both the type and the member. Overloads and partials share one node (first wins). **Properties and fields** (ADR 0032): emitted as `path#Type.Member` with kinds `property`/`field` — ownership signals ONLY, never call-graph nodes (the graph stays behavior), never in `symbolToId`, and excluded from exported-name collision findings (`DATA_MEMBER_KINDS` in `schema.ts`). |
| Call edges | **Clean bindings only** (`SymbolInfo.Symbol`): non-virtual resolved → `direct`/`confirmed`; virtual/abstract/override/interface dispatch → `method`/`likely` (runtime-polymorphic, ADR 0016/0018). A candidate symbol (failed binding — ambiguity, arity mismatch, missing reference) is **never** graded resolved: it contributes only a name to `unresolved#name`. Object creations edge to the created **type** node. Constructor and property-accessor calls attribute to the containing type node. Evidence carries `path:line`. |
| Entry hints | Static `Main` or top-level statements → `source_entry` / `likely`. |

## Failure ladder (every rung degrades, none throws)

1. No `dotnet` CLI → `matches()` declines `.cs`; tree-sitter keeps C# exactly as pre-0027.
2. Sidecar build fails → empty extraction for the batch.
3. Sidecar crashes / emits malformed JSON / files unreadable → empty extraction.
4. The engine additionally treats any provider throw as "no extraction" (ADR 0017).

## References (ADR 0032 Tier 1)

The compilation references the **host SDK's Trusted Platform Assemblies**
(`AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")`) — the runtime already running our
tool supplies the BCL analysis surface, so repo-internal bindings that flow through
framework types (LINQ chains, extension methods, `Task`) now resolve. Metadata-only,
no network, nothing from the target repo referenced or loaded; any unloadable assembly
is skipped, and an empty list degrades to the corelib floor. **The boundary is
unchanged:** a call whose *target* is external (e.g. `First`, `WriteLine`) binds cleanly
but still maps to `unresolved#name` — references improve binding, never upgrade external
claims. Results are analysis-time binding against the host SDK's surface, not the
target's exact TFM (disclosed, like SDK presence itself).

## Known limits (disclosed; deferred in ADRs 0027/0032)

- Calls inside top-level statements and field initializers emit **no edges** (the file still
  gets its entry hint). Absence of an edge is never evidence of absence of a call.
- NuGet **package** types are not referenced (Tier 2 — read-only `project.assets.json` use —
  is deferred by ADR 0032; running restore is permanently out). Bindings that need package
  metadata still degrade to `unresolved#name`.
- C# events are not ownership signals (deferred, ADR 0032); types, methods, properties, and
  fields are.
- One compilation per batch: no multi-batch resolution; external targets (BCL, NuGet) are
  `unresolved` by policy.
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
