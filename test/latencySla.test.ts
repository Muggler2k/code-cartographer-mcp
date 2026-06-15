// Cold-start latency SLA gate (ADR 0034 S4). The churn half of S4 (ADR 0011 staleness +
// incremental re-analysis) lives in churn.test.ts; this is the latency half: gate the
// conversational COLD-START an agent faces on its first deep tool call. Each target is
// built in a FRESH node process via eval/measureColdStart.ts, so the measurement includes
// the real one-time cold costs — WASM tree-sitter grammar load + TS Program build from
// scratch — that a warm within-process init (benchGates.test.ts) does not capture.
//
// Per ADR 0030's anti-flakiness mandate, the SLAs (eval/baselines.json → coldStartSla) keep
// generous headroom over the dev baseline: a breach means a gross / O(n²)-class cold-start
// regression (or a CI runner that genuinely needs a conscious ceiling bump), never machine
// noise. Budgets are data — edit baselines.json with reasoning, never auto-regenerate.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { analyzerBuilt, dotnetAvailable } from "../src/providers/csharp.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO_ROOT, "eval", "measureColdStart.ts");
const BASELINES = path.join(REPO_ROOT, "eval", "baselines.json");

// vitest per-test timeout > the child timeout below, so a runaway build is killed (and
// diagnosed) by execFileSync's own timeout rather than by an opaque vitest hang.
const CHILD_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 90_000;

interface Budget {
  slaMs: number;
  devBaselineMs: number;
}

interface ColdStartMeasurement {
  target: string;
  coldMs: number;
  files: number;
  nodes: number;
  edges: number;
}

// Read the budgets synchronously at COLLECTION time and derive one gated `it` per target.
// Iterating the baseline keys (not a hardcoded list) means a target added to baselines.json
// is automatically gated — it can never be silently left out — and there is no duplicated
// target list to drift.
const ALL_TARGETS = (
  JSON.parse(readFileSync(BASELINES, "utf8")) as { coldStartSla: { targets: Record<string, Budget> } }
).coldStartSla.targets;

// 'large' is a 1000-file synthetic SCALING probe (generates + builds a temp repo in a fresh
// subprocess) — opt-in via CCM_COLDSTART_LARGE so it never taxes the local edit-test loop. CI
// sets the flag (ci.yml) so the count-scaling / O(n²) guard still runs on every PR.
// 'csharp-small' measures the ROSLYN sidecar warm-up — the heaviest cold-start driver ADR 0034
// names alongside the TS Program. It gates the PER-SESSION cold start (sidecar process spawn + JIT
// + first compilation), which is only well-defined once the sidecar dll is already built — so it
// runs only where the .NET SDK exists AND the sidecar is pre-built (CI pre-builds it in ci.yml; a
// dev builds it once). On a pristine machine it SKIPS rather than triggering a minutes-long NuGet
// build inside a latency gate (which would mis-measure the one-time build, not the cold start).
// The always-on targets (cpp-namespaces = WASM grammar load, self = real multi-language) need no
// precondition.
const RUN_LARGE = Boolean(process.env.CCM_COLDSTART_LARGE);
const ROSLYN_READY = dotnetAvailable() && analyzerBuilt();
const TARGETS = Object.fromEntries(
  Object.entries(ALL_TARGETS).filter(([name]) => {
    if (name === "large") return RUN_LARGE;
    if (name === "csharp-small") return ROSLYN_READY;
    return true;
  })
);

/** Build `target` in a fresh node process (true cold start) and return its measurement. */
function measureColdStart(target: string): ColdStartMeasurement {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, ["--import", "tsx", RUNNER, target], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS
    });
  } catch (err) {
    // execFileSync throws on a non-zero exit OR on timeout. Surface the child's stderr/stdout so
    // a catastrophic cold-start regression (the runner threw, or the build outran the timeout —
    // exactly what this gate exists to catch) fails LOUDLY with the runner's own diagnostics,
    // not an opaque ETIMEDOUT / exit-code error.
    const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const detail = [e.stderr, e.stdout]
      .map((s) => (s ? s.toString().trim() : ""))
      .filter(Boolean)
      .join("\n");
    throw new Error(`measureColdStart(${target}) failed: ${e.message ?? "child process error"}\n${detail}`);
  }
  const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
  if (!lastLine) throw new Error(`measureColdStart(${target}) produced no output`);
  return JSON.parse(lastLine) as ColdStartMeasurement;
}

describe("cold-start latency SLA (ADR 0034 S4)", () => {
  // One gated `it` per budgeted target. cpp-namespaces exercises the WASM tree-sitter grammar
  // load; self (this repo) the realistic multi-language TS-Program + WASM + walk cost; csharp-small
  // (dotnet-gated) the Roslyn sidecar warm-up; large (CI-only, see RUN_LARGE) count-scaling.
  for (const [target, budget] of Object.entries(TARGETS)) {
    it(`${target}: fresh-process cold start stays under the SLA`, () => {
      const measured = measureColdStart(target);
      expect(measured.nodes, `${target} produced an empty graph — cold start did no work`).toBeGreaterThan(0);
      expect(
        measured.coldMs,
        `${target} cold start ${measured.coldMs}ms breached the SLA ${budget.slaMs}ms (dev baseline ~${budget.devBaselineMs}ms). ` +
          `If a slow CI runner is the cause, bump slaMs in eval/baselines.json with reasoning; otherwise this is a real cold-start regression.`
      ).toBeLessThan(budget.slaMs);
    }, TEST_TIMEOUT_MS);
  }
});
