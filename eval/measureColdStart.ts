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
//            = "<fixtureName>" → eval/fixtures/<fixtureName>, unscoped.
// Prints one JSON line: { target, coldMs, files, nodes, edges }.

import { performance } from "node:perf_hooks";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildContextMap } from "../src/contextMap.js";
import type { ExclusionConfig } from "../src/scope.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(EVAL_DIR, "..");

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error("usage: measureColdStart.ts <self|fixtureName>");

  const isSelf = target === "self";
  const root = isSelf ? REPO_ROOT : path.join(EVAL_DIR, "fixtures", target);
  const config: ExclusionConfig = isSelf ? { mode: "gitignore" } : { mode: "none" };

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
}

main().catch((err) => {
  process.stderr.write(`measureColdStart failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
