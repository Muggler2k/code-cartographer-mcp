// Cold-start latency runner (ADR 0034 S4). Invoked as a FRESH node process by
// test/latencySla.test.ts so the measurement is a true conversational cold-start:
// WASM tree-sitter grammars load from scratch and the TS Program is built from
// scratch (the two cold-start drivers ADR 0034 names — the tree-sitter WASM load
// is the modern analog of "Roslyn warm-up"). Uses `buildContextMap`, the pure
// non-persisting builder, so measuring cold-start writes no artifact and mutates
// nothing (no `.code-cartographer-mcp/` is dropped into the repo or a fixture).
//
// Usage: node --import tsx eval/measureColdStart.ts <target>
//   <target> = "self"        → this repository (a realistic multi-language medium
//                              repo: TS source + cpp/python/… fixtures → WASM),
//                              scoped via gitignore (skips node_modules/dist/.git).
//            = "large"        → a GENERATED synthetic repo of LARGE_FILE_COUNT trivial
//                              TS files in a temp dir (cleaned up after). This gates
//                              cold-start SCALING in file COUNT — an O(n²)-class
//                              regression in the walk / graph build / index. It is NOT
//                              a real-world-complexity test: uniform trivial TS is far
//                              cheaper per file than real interlinked source, so "self"
//                              (real types + multi-language) is the harder COMPLEXITY
//                              cold-start. A faithful large-repo SLA would need a
//                              representative real repo; this is the autonomous proxy.
//            = "<fixtureName>" → eval/fixtures/<fixtureName>, unscoped.
// Prints one JSON line: { target, coldMs, files, nodes, edges }.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildContextMap } from "../src/contextMap.js";
import type { ExclusionConfig } from "../src/scope.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(EVAL_DIR, "..");
// A genuinely large repo on the file-COUNT axis (~5000 files → ~10k nodes, ~2.2s cold start on
// dev). Calibrated against eval/baselines.json → coldStartSla.targets.large (devBaselineMs ~2225 /
// slaMs 16000 at this count). Changing it re-bases the build time — update both together. Count is
// the one axis a synthetic repo tests faithfully; real complexity-at-scale needs a real repo.
const LARGE_FILE_COUNT = 5000;

/**
 * Generate a synthetic repo of LARGE_FILE_COUNT trivial TS files in a temp dir. Each file
 * imports a single shared `hub` and calls it plus a local helper, so the graph is non-trivial
 * (~2N nodes, ~2N edges with a high-in-degree hub) — exercising the count-driven cold-start
 * work (walk + TS Program + graph build + index) without the type complexity of real source.
 *
 * Deliberately a SHALLOW fan-to-hub graph (every import depth 1), NOT a deep mod0→mod1→…→modN
 * chain: a 1000-deep transitive import chain drives the TS compiler's recursive resolver to the
 * stack-overflow cliff, where the provider's never-throw catch returns an EMPTY graph — which
 * would make this gate silently measure nothing (a fast empty build passes the latency budget).
 * Fan-to-hub has O(1) import depth, so the graph stays intact at any N.
 *
 * Self-cleaning: if generation fails after the temp dir is created, the dir is removed before
 * rethrowing, so a partial-generation failure never leaks a temp tree in os.tmpdir.
 */
async function generateLargeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-coldstart-large-"));
  try {
    const srcDir = path.join(dir, "src");
    await fs.mkdir(srcDir);
    const writes: Promise<void>[] = [
      fs.writeFile(path.join(srcDir, "hub.ts"), "export function hub() { return 1; }\n")
    ];
    for (let i = 0; i < LARGE_FILE_COUNT; i++) {
      writes.push(
        fs.writeFile(
          path.join(srcDir, `mod${i}.ts`),
          `import { hub } from "./hub.js";\nexport function f${i}() { return hub() + helper${i}(); }\nfunction helper${i}() { return ${i}; }\n`
        )
      );
    }
    await Promise.all(writes);
    return dir;
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Resolve a target to its build root + scope, plus an optional cleanup for generated targets. */
async function resolveTarget(target: string): Promise<{ root: string; config: ExclusionConfig; cleanup?: () => Promise<void> }> {
  if (target === "self") return { root: REPO_ROOT, config: { mode: "gitignore" } };
  if (target === "large") {
    const root = await generateLargeRepo();
    // Best-effort like generateLargeRepo's own cleanup: swallow an rm failure so a cleanup error
    // can never mask the build error (or a real SLA breach) the gate exists to surface.
    return { root, config: { mode: "none" }, cleanup: () => fs.rm(root, { recursive: true, force: true }).catch(() => {}) };
  }
  return { root: path.join(EVAL_DIR, "fixtures", target), config: { mode: "none" } };
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error("usage: measureColdStart.ts <self|large|fixtureName>");

  const { root, config, cleanup } = await resolveTarget(target);
  try {
    // Time only the build — any generation/setup above is excluded, matching the cold start an
    // agent faces on an already-present repo.
    const start = performance.now();
    const map = await buildContextMap(root, config);
    const coldMs = Math.round(performance.now() - start);

    process.stdout.write(
      JSON.stringify({
        target,
        coldMs,
        files: map.summary.totalFiles,
        nodes: map.callGraph.nodes.length,
        edges: map.callGraph.edges.length
      }) + "\n"
    );
  } finally {
    await cleanup?.();
  }
}

main().catch((err) => {
  process.stderr.write(`measureColdStart failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
