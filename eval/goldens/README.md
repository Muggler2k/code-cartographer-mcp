# Goldens — human-authored STATIC ground truth (ADR 0029)

A golden encodes what is **statically true** of its fixture — never current product output
(goldens are never regenerated from output) and never runtime behavior. On disagreement,
either the golden is wrong (fix it, with reasoning) or the product is (file the bug).

Semantics that matter when authoring or reading these files:

- **`reachability.mustReach`** asserts *a static path exists in the call graph* (traversal is
  seeded and clamped at `likely`) — it is NEVER a claim that the code executes at runtime.
  `mustNotReach` asserts the static closure does not contain the node, which is exactly as
  strong as static analysis gets: it never means "dead".
- **`edges[].confidence`** is the expected *static* grade per the provider tier rules
  (ADR 0013/0016/0018/0027): compiler-resolved direct calls are `confirmed` *as a parse/
  type-resolution fact*; `method` dispatch is capped `likely` because dispatch is
  runtime-polymorphic; `dynamic`/`framework` cap at `candidate`; failed bindings are
  `unresolved`.
- **`csharp-small`'s `mustNotReach: ["Greeter.cs#Greeter.Format"]` is deliberate**, not a
  bug record: `Program.Main` calls through the `IGreeter` interface (a `method`/`likely`
  edge to `IGreeter.Greet`); the static graph does NOT resolve interface→implementation
  dispatch, so `Greeter.Greet` → `Format` is outside Main's static closure. The golden pins
  the product's honest static-dispatch limitation.
- **`symbols.forbidden`** pins non-extraction (e.g. a re-export barrel must NOT mint a node);
  **`duplicates.forbiddenIds`** pins known false-positive shapes (aliases, shadowed
  non-exported names) staying negative.
- The `csharp-small` golden encodes the **Roslyn tier** (ADR 0027) and is only evaluated
  where the `dotnet` CLI exists; the other goldens are tier-stable.
- A fixture without golden entries for a category passes that category trivially —
  **every new fixture must ship with a populated golden** (only external real repos are
  invariant-only by design).
