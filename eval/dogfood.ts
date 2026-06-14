// ADR 0034 S0 dogfood harness — drive the BUILT server over the REAL MCP stdio transport
// (exactly what Claude Code does) and measure the three things inspection cannot answer:
//   1. Token budget   — how much output each tool pushes into the agent's context (llm_readable).
//   2. Latency        — per-tool wall-clock on a conversational clock; init/cold-start is the big one.
//   3. Never-throw + honesty legibility — does any tool error, and does the text carry its
//                       confidence vocabulary / codebase-only disclosure where it should.
//
// Codebase-only (ADR 0001/0002): this analyzes the target's map. It executes nothing in the
// target — it only reads the static map the server produced. This harness is a diagnostic, not
// a gate: the per-tool budget below is a provisional knob, NOT the ratified SLO (that is S1's job).
//
// Run:  npm run build && npm run dogfood [-- <targetRepo>]   (target defaults to this repo)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectSeeds, type Seeds } from "./seeds.js";

// Provisional flag threshold — surfaces "an agent would feel this in its context budget".
// Not the acceptance SLO; ADR 0034 S1 sets the real per-tool ceilings.
const BUDGET_TOKENS = 2000;
const CONFIDENCE_VOCAB = ["confirmed", "likely", "candidate", "unclear", "unresolved"] as const;

const here = dirname(fileURLToPath(import.meta.url));
const serverRepo = resolve(here, ".."); // the cartographer repo (owns dist/ = the server under test)
const distPath = join(serverRepo, "dist", "index.js");
const target = process.argv[2] ? resolve(process.argv[2]) : serverRepo;
const mapPath = join(target, ".code-cartographer-mcp", "context-map.json");

interface ToolRun {
  name: string;
  ok: boolean;
  ms: number;
  chars: number;
  approxTokens: number;
  vocab: string[]; // confidence words present in the output
  boundary: boolean; // codebase-only / uncertainty disclosure present
  error?: string;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4); // chars/4 — a tokenizer can be swapped in if a hard SLO needs it
}

function scanHonesty(text: string): { vocab: string[]; boundary: boolean } {
  const vocab = CONFIDENCE_VOCAB.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
  // Match ONLY the dedicated boundary markers: the human banner ("Codebase-only") and the
  // structured-output forms the JSON modes emit (`codebase_only`, `codebaseOnlyBoundary`).
  // Every formatter ships one of these (human banner, top-level `analysisBoundary`, or
  // `meta.codebaseOnlyBoundary`), so this stays `true` for honest output AND flips to `false`
  // if a tool ever drops its boundary marker. Confidence/uncertainty VALUES (`unresolved`,
  // `uncertaint`) were deliberately removed: they appear on most outputs regardless of whether
  // a boundary is disclosed, so matching them defeated the guard (a tool could drop its
  // boundary and still read honest on any output containing an `unresolved` edge). The full
  // confidence vocabulary is still tracked independently in `vocab`.
  const boundary = /codebase[-_]only|codebaseonlyboundary/i.test(text);
  return { vocab, boundary };
}

async function callTool(
  client: Client,
  name: string,
  extra: Record<string, unknown>
): Promise<ToolRun> {
  const args = { repositoryRoot: target, outputMode: "llm_readable", ...extra };
  const t0 = performance.now();
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const ms = performance.now() - t0;
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
      .join("");
    const { vocab, boundary } = scanHonesty(text);
    return {
      name,
      ok: result.isError !== true,
      ms,
      chars: text.length,
      approxTokens: approxTokens(text),
      vocab,
      boundary,
      error: result.isError ? text.slice(0, 200) : undefined
    };
  } catch (err) {
    // A thrown error here means the failure escaped the server's error envelope entirely —
    // the strongest never-throw violation.
    return {
      name,
      ok: false,
      ms: performance.now() - t0,
      chars: 0,
      approxTokens: 0,
      vocab: [],
      boundary: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * After init, derive real seeds from the persisted map so the symbol/path tools exercise
 * actual code. The selection itself (hub picking, vendored preference) lives in the pure,
 * unit-tested `selectSeeds` (eval/seeds.ts); this wrapper only reads the persisted map.
 */
function deriveSeeds(): Seeds {
  if (!existsSync(mapPath)) {
    return { symbol: "main", to: "main", file: "src" };
  }
  const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
    callGraph?: { nodes?: Array<{ id: string; path: string }>; edges?: Array<{ from: string; to: string }> };
    files?: Array<{ path: string }>;
  };
  return selectSeeds(map.callGraph?.nodes ?? [], map.callGraph?.edges ?? [], map.files ?? []);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

/** Pad to width, but truncate (with an ellipsis) so a long cell can't bleed into the next column. */
function fit(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : pad(s, n);
}

async function main(): Promise<void> {
  if (!existsSync(distPath)) {
    console.error(`Server build not found at ${distPath}.\nRun \`npm run build\` first — the harness drives the BUILT server, exactly as an MCP client would.`);
    process.exitCode = 1;
    return;
  }

  console.log(`# Dogfood harness (ADR 0034 S0)`);
  console.log(`  server : ${distPath}`);
  console.log(`  target : ${target}`);
  console.log(`  mode   : llm_readable | budget flag : ~${BUDGET_TOKENS} tok/tool\n`);

  // Forward the parent env to the server (the SDK's default env is a sanitized subset) so a real
  // client's `env` config is faithfully reproduced — e.g. CCM_TELEMETRY to exercise S2 telemetry.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [distPath], cwd: serverRepo, env: childEnv });
  const client = new Client({ name: "dogfood-harness", version: "0.1.0" }, { capabilities: {} });

  const tStart = performance.now();
  await client.connect(transport);
  const startupMs = performance.now() - tStart;

  const listed = await client.listTools();
  const registered = listed.tools.length;

  const runs: ToolRun[] = [];

  // Core map tools, in order — init_codebase must run before the analysis tools (it writes the map).
  runs.push(await callTool(client, "check_init_state", {}));
  runs.push(await callTool(client, "preview_scope", {}));
  runs.push(await callTool(client, "init_codebase", {})); // the heavy/cold-start call
  runs.push(await callTool(client, "get_context_summary", {}));

  const seeds = deriveSeeds();
  console.log(`  seeds  : symbol=${seeds.symbol}  to=${seeds.to}  file=${seeds.file}\n`);

  const seeded: Array<[string, Record<string, unknown>]> = [
    ["analyze_reachability", { target: seeds.symbol }],
    ["find_callers", { symbol: seeds.symbol }],
    ["find_path", { from: seeds.symbol, to: seeds.to }],
    ["find_duplicate_behavior", { subject: seeds.symbol }],
    ["classify_legacy_paths", {}],
    ["analyze_change_impact", { target: seeds.file }],
    ["review_preflight", { requestedChange: `add a second variant of ${seeds.symbol}` }],
    ["review_change", { changeDescription: `modified ${seeds.file}` }],
    ["get_ownership", { symbol: seeds.symbol }],
    ["investigate_failure", { failureReference: seeds.symbol }],
    ["analyze_test_paths", { target: seeds.symbol }],
    ["detect_architecture_drift", {}],
    ["analyze_diff", {}],
    ["map_call_stack", { entryPoint: seeds.symbol }],
    ["visualize_call_stack", { entryPoint: seeds.symbol }],
    ["visualize_architecture", {}]
  ];
  for (const [name, extra] of seeded) {
    runs.push(await callTool(client, name, extra));
  }

  await client.close();

  // ---- Report ----
  const w = { name: 26, ok: 4, ms: 8, tok: 7, vocab: 22, bnd: 4 };
  console.log(
    pad("tool", w.name) + pad("ok", w.ok) + padLeft("ms", w.ms) + "  " + padLeft("~tok", w.tok) + "  " + pad("confidence", w.vocab) + pad("bnd", w.bnd)
  );
  console.log("-".repeat(w.name + w.ok + w.ms + w.tok + w.vocab + w.bnd + 4));
  for (const r of runs) {
    const flag = r.approxTokens > BUDGET_TOKENS ? " *" : "";
    console.log(
      pad(r.name, w.name) +
        pad(r.ok ? "ok" : "ERR", w.ok) +
        padLeft(r.ms.toFixed(0), w.ms) +
        "  " +
        padLeft(String(r.approxTokens) + flag, w.tok) +
        "  " +
        fit(r.vocab.length ? r.vocab.join(",") : "—", w.vocab) +
        pad(r.boundary ? "y" : "-", w.bnd)
    );
  }

  const throws = runs.filter((r) => !r.ok);
  const overBudget = runs.filter((r) => r.approxTokens > BUDGET_TOKENS);
  const totalTokens = runs.reduce((s, r) => s + r.approxTokens, 0);
  const slowest = [...runs].sort((a, b) => b.ms - a.ms)[0];

  console.log("\n## Summary");
  console.log(`  tools registered : ${registered}/20 ${registered === 20 ? "✓" : "✗ MISMATCH"}`);
  console.log(`  server startup   : ${startupMs.toFixed(0)} ms`);
  console.log(`  slowest tool     : ${slowest.name} (${slowest.ms.toFixed(0)} ms)`);
  console.log(`  total ~tokens    : ${totalTokens} (an agent running the whole suite)`);
  console.log(`  over budget (>${BUDGET_TOKENS}) : ${overBudget.length ? overBudget.map((r) => `${r.name}(${r.approxTokens})`).join(", ") : "none"}`);
  console.log(`  never-throw      : ${throws.length === 0 ? "✓ all tools returned" : `✗ ${throws.map((r) => `${r.name}: ${r.error}`).join(" | ")}`}`);

  const resultsDir = join(serverRepo, "eval", "results");
  mkdirSync(resultsDir, { recursive: true });
  const artifact = {
    generatedAt: new Date().toISOString(),
    target,
    serverDist: distPath,
    budgetTokens: BUDGET_TOKENS,
    registered,
    startupMs: Math.round(startupMs),
    seeds,
    runs
  };
  const outPath = join(resultsDir, "dogfood-latest.json");
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\n  artifact → ${outPath}`);

  const verdict = registered === 20 && throws.length === 0;
  console.log(`\n${verdict ? "GREEN" : "RED"} — ${verdict ? "all tools registered and returned over the real transport." : "see mismatches above."}`);
  if (!verdict) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
