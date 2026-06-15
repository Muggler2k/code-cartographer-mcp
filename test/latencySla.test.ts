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
import { existsSync, readFileSync } from "node:fs";
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
  /** Override the child-process timeout for a target whose build exceeds the 60s default (a large repo). */
  childTimeoutMs?: number;
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

// 'large' is a ~5000-file synthetic SCALING probe (generates + builds a temp repo in a fresh
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
    // A path-keyed target measures a REAL repo at that path (e.g. node_modules/typescript/lib, or a
    // user-provided large repo). Gate on the path existing — skip (not fail) if absent, so the gate
    // is portable: a checkout without that repo simply doesn't run it. Resolved like the runner (cwd
    // = REPO_ROOT).
    if (name.includes("/") || name.includes("\\")) return existsSync(path.resolve(REPO_ROOT, name));
    return true;
  })
);

// S4 large-real-SOURCE SLA (turnkey, ADR 0034): point CCM_COLDSTART_LARGE_REAL at a representative
// LARGE real source repo and its cold start is gated here — gitignore-scoped, with a generous SLA +
// child timeout (a large repo's cold start is tens of seconds: a VS Code checkout is ~15.7k files /
// ~88k nodes / ~212k edges / ~50s). No machine-specific path is committed (it SKIPS when the env is
// unset or the path is missing). Set CCM_COLDSTART_LARGE_REAL_SLA to tune the ceiling (default
// 180000ms — generous; it catches the never-throw / scaling-blowup regression class on a real repo,
// e.g. the spread-push arg-cap overflow that PR #52 fixed).
const LARGE_REAL = process.env.CCM_COLDSTART_LARGE_REAL?.trim();
if (LARGE_REAL && existsSync(LARGE_REAL)) {
  TARGETS[LARGE_REAL] = {
    slaMs: Number(process.env.CCM_COLDSTART_LARGE_REAL_SLA) || 180_000,
    devBaselineMs: 0, // no committed baseline for a user-supplied path (shown only in the failure message)
    childTimeoutMs: 300_000
  };
}

/** Build `target` in a fresh node process (true cold start) and return its measurement. */
function measureColdStart(target: string, childTimeoutMs: number = CHILD_TIMEOUT_MS): ColdStartMeasurement {
  let stdout: string;
  try {
    // --max-old-space-size raises the heap ceiling so a genuinely large repo (e.g. a VS Code checkout:
    // ~88k nodes / ~212k edges) doesn't OOM; harmless for the small targets (they never approach it).
    stdout = execFileSync(process.execPath, ["--max-old-space-size=8192", "--import", "tsx", RUNNER, target], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: childTimeoutMs
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
    const childTimeout = budget.childTimeoutMs ?? CHILD_TIMEOUT_MS;
    it(`${target}: fresh-process cold start stays under the SLA`, () => {
      const measured = measureColdStart(target, childTimeout);
      expect(measured.nodes, `${target} produced an empty graph — cold start did no work`).toBeGreaterThan(0);
      expect(
        measured.coldMs,
        `${target} cold start ${measured.coldMs}ms breached the SLA ${budget.slaMs}ms (dev baseline ~${budget.devBaselineMs}ms). ` +
          `If a slow CI runner is the cause, bump slaMs in eval/baselines.json with reasoning; otherwise this is a real cold-start regression.`
      ).toBeLessThan(budget.slaMs);
    }, Math.max(TEST_TIMEOUT_MS, childTimeout + 30_000));
  }
});
