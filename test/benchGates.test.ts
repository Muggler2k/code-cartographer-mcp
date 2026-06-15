// Benchmark / performance gates (Epic Q, ADR 0030). Structural metrics gate HARD —
// they are deterministic for a fixed fixture + query, so red always means a real
// product change (acknowledge it by editing eval/baselines.json with reasoning).
// Wall-clock gates only at generous sanity ceilings; heap/external numbers are
// record-only in the scorecard, never gated here.

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGolden, runSubject, type SubjectResult } from "../eval/harness.js";
import { dotnetAvailable } from "../src/providers/csharp.js";

const EVAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "eval");

interface FixtureBaseline {
  structural: { files: number; nodes: number; edges: number; summaryChars: number; summaryCharsTolerancePct: number };
  pathQuery?: {
    from: string;
    to: string;
    hops: number;
    expandedNodeCount: number;
    visitedNodeCount: number;
    neighborQueryCount: number;
    sqliteQueryCount: number;
  };
  softCeilingsMs: { init: number; indexBuild: number };
}

async function baselines(): Promise<Record<string, FixtureBaseline>> {
  const raw = JSON.parse(await fs.readFile(path.join(EVAL_DIR, "baselines.json"), "utf8")) as { fixtures: Record<string, FixtureBaseline> };
  return raw.fixtures;
}

async function runAgainstBaseline(name: string, base: FixtureBaseline): Promise<SubjectResult> {
  const golden = await loadGolden(path.join(EVAL_DIR, "goldens", `${name}.json`));
  return runSubject(name, path.join(EVAL_DIR, "fixtures", name), golden, {
    benchQuery: base.pathQuery ? { from: base.pathQuery.from, to: base.pathQuery.to } : undefined
  });
}

function expectGates(name: string, base: FixtureBaseline, result: SubjectResult): void {
  const failures: string[] = [];
  const hard = (label: string, actual: number | null, expected: number): void => {
    if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
  };

  // Structural — exact.
  hard("files", result.perf.files, base.structural.files);
  hard("nodes", result.perf.nodes, base.structural.nodes);
  hard("edges", result.perf.edges, base.structural.edges);

  // Output size — bounded (formatting-only churn allowance).
  const tolerance = (base.structural.summaryChars * base.structural.summaryCharsTolerancePct) / 100;
  if (Math.abs(result.tokenShape.summaryChars - base.structural.summaryChars) > tolerance) {
    failures.push(`summaryChars: expected ${base.structural.summaryChars} ±${base.structural.summaryCharsTolerancePct}%, got ${result.tokenShape.summaryChars}`);
  }

  // Fixed path query over the SQLite index — exact structural numbers.
  if (base.pathQuery) {
    const pq = result.bench.pathQuery;
    if (!pq) {
      failures.push("pathQuery: bench produced no result (index unavailable?)");
    } else {
      hard("pathQuery.hops", pq.hops, base.pathQuery.hops);
      hard("pathQuery.expandedNodeCount", pq.expandedNodeCount, base.pathQuery.expandedNodeCount);
      hard("pathQuery.visitedNodeCount", pq.visitedNodeCount, base.pathQuery.visitedNodeCount);
      hard("pathQuery.neighborQueryCount", pq.neighborQueryCount, base.pathQuery.neighborQueryCount);
      hard("pathQuery.sqliteQueryCount", pq.sqliteQueryCount, base.pathQuery.sqliteQueryCount);
      hard("pathQuery.sccBuildCount (once per snapshot)", pq.sccBuildCount, 1);
    }
  }

  // Wall-clock — generous sanity ceilings only (ADR 0030: never gate machine noise).
  if (result.perf.initMs >= base.softCeilingsMs.init) {
    failures.push(`initMs ${result.perf.initMs} breached the sanity ceiling ${base.softCeilingsMs.init}`);
  }
  if (result.bench.indexBuildMs >= base.softCeilingsMs.indexBuild) {
    failures.push(`indexBuildMs ${result.bench.indexBuildMs} breached the sanity ceiling ${base.softCeilingsMs.indexBuild}`);
  }

  expect(failures, `${name} gate failures`).toEqual([]);
}

describe("benchmark gates — tier-stable fixtures (ADR 0030)", () => {
  for (const name of ["ts-small", "python-small", "cpp-small", "cpp-namespaces", "edge-cases"]) {
    it(`${name}: structural metrics match the baseline; wall-clock under sanity ceilings`, async () => {
      const base = (await baselines())[name];
      expectGates(name, base, await runAgainstBaseline(name, base));
    }, 120_000);
  }
});

describe.runIf(dotnetAvailable())("benchmark gates — Roslyn-tier fixtures (ADR 0027/0030)", () => {
  for (const name of ["csharp-small", "vb-small", "mixed"]) {
    it(`${name}: structural metrics match the Roslyn-tier baseline`, async () => {
      const base = (await baselines())[name];
      expectGates(name, base, await runAgainstBaseline(name, base));
    }, 300_000);
  }
});
