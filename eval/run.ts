// Scorecard runner (Epic M, ADR 0029): `npm run eval`. Scores every checked-in fixture
// against its golden, plus any external subjects from CCM_EVAL_EXTERNAL (path-list,
// `;`-separated) on universal invariants / performance / output shape only. Writes the
// scorecard JSON to eval/results/ (gitignored) and a table to stdout.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGolden, runSubject, type SubjectResult } from "./harness.js";
import { dotnetAvailable } from "../src/providers/csharp.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = ["ts-small", "python-small", "csharp-small", "mixed", "edge-cases"];

async function main(): Promise<void> {
  const results: SubjectResult[] = [];
  const skipped: string[] = [];

  const baselines = JSON.parse(await fs.readFile(path.join(EVAL_DIR, "baselines.json"), "utf8")) as {
    fixtures: Record<string, { pathQuery?: { from: string; to: string } }>;
  };

  for (const name of FIXTURES) {
    if (name === "csharp-small" && !dotnetAvailable()) {
      skipped.push(`${name} (no dotnet CLI — the C# golden encodes the Roslyn tier)`);
      continue;
    }
    const golden = await loadGolden(path.join(EVAL_DIR, "goldens", `${name}.json`));
    const benchQuery = baselines.fixtures[name]?.pathQuery;
    results.push(await runSubject(name, path.join(EVAL_DIR, "fixtures", name), golden, { benchQuery }));
  }

  for (const external of (process.env.CCM_EVAL_EXTERNAL ?? "").split(";").map((p) => p.trim()).filter(Boolean)) {
    try {
      await fs.access(external);
    } catch {
      skipped.push(`${external} (not found)`);
      continue;
    }
    results.push(await runSubject(`external:${path.basename(external)}`, external, {}, { scopeMode: "auto" }));
  }

  // ---- Report ----
  const lines: string[] = [];
  lines.push("subject                         pass  req  found  forbid  invariants  initMs  idxMs  files  nodes  edges  ~tokens  pq(exp/nq/sq)");
  for (const r of results) {
    const req = Object.values(r.scores).reduce((n, s) => n + s.required, 0);
    const found = Object.values(r.scores).reduce((n, s) => n + s.found, 0);
    const forbid = Object.values(r.scores).reduce((n, s) => n + s.forbiddenHits.length, 0);
    const pq = r.bench.pathQuery ? `${r.bench.pathQuery.expandedNodeCount}/${r.bench.pathQuery.neighborQueryCount}/${r.bench.pathQuery.sqliteQueryCount}` : "-";
    lines.push(
      `${r.subject.padEnd(30)}  ${r.pass ? "PASS" : "FAIL"}  ${String(req).padStart(3)}  ${String(found).padStart(5)}  ${String(forbid).padStart(6)}  ${String(r.invariantViolations.length).padStart(10)}  ${String(r.perf.initMs).padStart(6)}  ${String(r.bench.indexBuildMs).padStart(5)}  ${String(r.perf.files).padStart(5)}  ${String(r.perf.nodes).padStart(5)}  ${String(r.perf.edges).padStart(5)}  ${String(r.tokenShape.summaryTokensApprox).padStart(7)}  ${pq.padStart(13)}`
    );
  }
  for (const s of skipped) lines.push(`skipped: ${s}`);
  console.log(lines.join("\n"));

  for (const r of results) {
    const problems: string[] = [...r.invariantViolations.map((v) => `invariant: ${v}`)];
    for (const [cat, s] of Object.entries(r.scores)) {
      for (const m of s.missing) problems.push(`${cat} missing: ${m}`);
      for (const f of s.forbiddenHits) problems.push(`${cat} FORBIDDEN: ${f}`);
    }
    if (problems.length > 0) {
      console.log(`\n--- ${r.subject} ---`);
      for (const p of problems) console.log("  " + p);
    }
  }

  const resultsDir = path.join(EVAL_DIR, "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, "latest.json");
  await fs.writeFile(outPath, JSON.stringify({ results, skipped }, null, 2));
  console.log(`\nscorecard: ${outPath}`);

  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
