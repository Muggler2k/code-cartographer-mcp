// Capability evaluation gate (Epic M, ADR 0029): every synthetic fixture must score
// 100% on required golden items, hit nothing forbidden, and violate no universal
// confidence invariant. The C# fixture's golden encodes the Roslyn tier, so it gates
// on dotnet availability (ADR 0027 pattern). External real repos are scored by
// `npm run eval`, not here.

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGolden, runSubject } from "../eval/harness.js";
import { dotnetAvailable } from "../src/providers/csharp.js";

const EVAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "eval");

async function score(name: string) {
  const golden = await loadGolden(path.join(EVAL_DIR, "goldens", `${name}.json`));
  return runSubject(name, path.join(EVAL_DIR, "fixtures", name), golden);
}

function expectClean(result: Awaited<ReturnType<typeof score>>): void {
  const problems: string[] = [...result.invariantViolations];
  for (const [cat, s] of Object.entries(result.scores)) {
    problems.push(...s.missing.map((m) => `${cat} missing: ${m}`));
    problems.push(...s.forbiddenHits.map((f) => `${cat} forbidden: ${f}`));
  }
  expect(problems).toEqual([]);
  expect(result.pass).toBe(true);
}

describe("capability evaluation gate (ADR 0029)", () => {
  it("ts-small: symbols, exports, edges, entries, duplicates, legacy classes, findings v2, reachability", async () => {
    expectClean(await score("ts-small"));
  }, 120_000);

  it("python-small: tree-sitter tier cross-file resolution + legacy tier capping", async () => {
    expectClean(await score("python-small"));
  }, 120_000);

  it("cpp-small: C++ tree-sitter tier — likely nodes, intra-file edges, cross-file disclosed unresolved (Epic N baseline)", async () => {
    expectClean(await score("cpp-small"));
  }, 120_000);

  it("cpp-namespaces: C++ N-S3 — namespace-qualified declarations, enclosing-first + scoped-call resolution", async () => {
    expectClean(await score("cpp-namespaces"));
  }, 120_000);

  it("mixed: per-language routing + binary handling", async () => {
    expectClean(await score("mixed"));
  }, 120_000);

  it("edge-cases: barrels and shadowed names are not duplicates; cycles flagged; depth cap honored", async () => {
    expectClean(await score("edge-cases"));
  }, 120_000);

  it("a synthetic fixture inits well under the sanity ceiling", async () => {
    const result = await score("ts-small");
    expect(result.perf.initMs).toBeLessThan(60_000); // perf GATES are Epic Q; this is a sanity floor
  }, 120_000);
});

describe.runIf(dotnetAvailable())("capability evaluation gate — C# Roslyn tier (ADR 0027/0029)", () => {
  it("csharp-small: Roslyn declarations, dispatch grading, entry hint, reachability", async () => {
    expectClean(await score("csharp-small"));
  }, 300_000);
});

describe.runIf(dotnetAvailable())("capability evaluation gate — VB Roslyn tier (ADR 0033)", () => {
  it("vb-small: VB declarations, dispatch grading, data-member exclusion, NameOf silence, entry hint, reachability", async () => {
    expectClean(await score("vb-small"));
  }, 300_000);
});
