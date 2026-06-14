// The declarative tool spec table (Decision 0025): ONE definition per tool — MCP name,
// schema, CLI command, and an execute that runs the capability and formats the result.
// Two adapters consume the table and can never drift from each other: `registerTools`
// (the MCP surface) and the CLI dispatch in index.ts (via `findCliSpec`/`cliArgs`).
// Tool #20 is one new entry here, nothing else.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { checkInitState, initCodebase, readContextMap } from "./contextMap.js";
import type { OutputMode } from "./schema.js";
import { recordToolCall } from "./telemetry.js";
import {
  analyzeChangeImpact,
  analyzeReachability,
  analyzeTestPaths,
  classifyLegacyPaths,
  detectArchitectureDrift,
  findDuplicateBehavior,
  getOwnership,
  investigateFailure,
  reviewChange,
  reviewPreflight
} from "./analysis.js";
import { mapCallStack } from "./callGraph.js";
import { analyzeDiff } from "./mapDiff.js";
import { findCallers, findPath } from "./pathQueries.js";
import { visualizeArchitecture, visualizeCallStack } from "./visualize.js";
import { previewScope, type ExclusionConfig, type ExclusionMode } from "./scope.js";
import {
  formatArchitectureDrift,
  formatArchitectureVisualization,
  formatCallStack,
  formatCallStackVisualization,
  formatChangeImpact,
  formatChangeReview,
  formatContextSummary,
  formatDuplicateBehavior,
  formatFailureInvestigation,
  formatFindCallers,
  formatFindPath,
  formatInitResult,
  formatInitStatus,
  formatLegacyClassification,
  formatMapDiff,
  formatOwnership,
  formatPreflightReview,
  formatReachability,
  formatScopePreview,
  formatTestPaths
} from "./output.js";

// ---- Shared input fields ----

const OutputModeSchema = z.enum(["human_readable", "llm_readable", "dual"]);
const repositoryRoot = z.string().describe("Absolute or relative path to the repository root.");
const outputMode = OutputModeSchema.optional().describe("Return human_readable, llm_readable, or dual output.");
const visualizationFormat = z
  .enum(["mermaid", "dot", "ascii"])
  .optional()
  .describe("Diagram spec format to emit (default mermaid). The server returns diagram source for the client to render, not an image.");
const exclusionMode = z
  .enum(["auto", "gitignore", "language", "none"])
  .optional()
  .describe("Scope/exclusion strategy (Decision 0009): auto (gitignore-first, else language defaults), gitignore, language, or none (map everything). Defaults to auto.");
const languages = z
  .array(z.string())
  .optional()
  .describe("For exclusionMode=language: language(s) whose conventional build/dependency directories to exclude, instead of auto-detecting.");

function toExclusionConfig(mode: ExclusionMode | undefined, langs: string[] | undefined): ExclusionConfig | undefined {
  if (mode === undefined && langs === undefined) {
    return undefined;
  }
  return { mode, languages: langs };
}

function mode(m: OutputMode | undefined): OutputMode {
  return m ?? "human_readable";
}

// ---- The spec shape ----

export interface CliSpec {
  /** CLI command name (e.g. `reachability` for the `analyze_reachability` tool). */
  command: string;
  /** Schema field names filled from CLI positionals after `<command> <repositoryRoot>`, in order. */
  positionals: readonly string[];
}

export interface ToolSpec {
  /** MCP tool name. */
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  cli: CliSpec;
  /** Run the capability and format the result — the one behavior both surfaces render. */
  execute(args: Record<string, unknown>): Promise<string>;
}

/** Keep each spec's `execute` typed against its own schema while the table stays homogeneous. */
function defineTool<Shape extends z.ZodRawShape>(spec: {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  cli: CliSpec;
  execute(args: z.objectOutputType<Shape, z.ZodTypeAny>): Promise<string>;
}): ToolSpec {
  return spec as ToolSpec;
}

// ---- The table (20 tools) ----

export const TOOLS: readonly ToolSpec[] = [
  // -- Core map tools --
  defineTool({
    name: "check_init_state",
    title: "Check init state",
    description: "Check whether a repository has a saved baseline context map and whether it appears stale.",
    inputSchema: { repositoryRoot, outputMode },
    cli: { command: "status", positionals: [] },
    execute: async ({ repositoryRoot, outputMode }) => formatInitStatus(await checkInitState(repositoryRoot), mode(outputMode))
  }),
  defineTool({
    name: "preview_scope",
    title: "Preview scope/exclusions",
    description:
      "Step 1 of init (Decision 0009): resolve which files would be in scope under an exclusion strategy and return a resolved plan (source, excluded directories, detected languages, included/excluded file counts, sample paths). No map is written and no target code is executed — this is static file-system resolution only.",
    inputSchema: { repositoryRoot, exclusionMode, languages, outputMode },
    cli: { command: "preview", positionals: [] },
    execute: async ({ repositoryRoot, exclusionMode, languages, outputMode }) =>
      formatScopePreview(await previewScope(repositoryRoot, toExclusionConfig(exclusionMode, languages)), mode(outputMode))
  }),
  defineTool({
    name: "init_codebase",
    title: "Initialize codebase context",
    description:
      "Step 2 of init (Decision 0009): map a repository from codebase files under the chosen exclusion strategy and write .code-cartographer-mcp/context-map.json. Run preview_scope first to confirm what will be excluded.",
    inputSchema: { repositoryRoot, exclusionMode, languages, outputMode },
    cli: { command: "init", positionals: [] },
    execute: async ({ repositoryRoot, exclusionMode, languages, outputMode }) =>
      formatInitResult(await initCodebase(repositoryRoot, toExclusionConfig(exclusionMode, languages)), mode(outputMode))
  }),
  defineTool({
    name: "get_context_summary",
    title: "Get context summary",
    description: "Read the saved baseline context map for a repository and return a compact summary.",
    inputSchema: { repositoryRoot, outputMode },
    cli: { command: "summary", positionals: [] },
    execute: async ({ repositoryRoot, outputMode }) => formatContextSummary(await readContextMap(repositoryRoot), mode(outputMode))
  }),

  // -- Analytical tools (require an initialized map; codebase-only) --
  defineTool({
    name: "analyze_reachability",
    title: "Analyze reachability",
    description:
      "Return codebase-only structural reachability hypotheses for a target (symbol, file, or workflow) with confidence labels and explicit uncertainty. Never claims runtime-proven reachability.",
    inputSchema: { repositoryRoot, target: z.string().describe("Symbol, file, or workflow to analyze."), outputMode },
    cli: { command: "reachability", positionals: ["target"] },
    execute: async ({ repositoryRoot, target, outputMode }) => formatReachability(await analyzeReachability(repositoryRoot, target), mode(outputMode))
  }),
  defineTool({
    name: "find_callers",
    title: "Find callers",
    description:
      "Return the direct static callers of a symbol over the call graph, confidence-graded and codebase-only. Dynamic/DI/framework/reflection callers are graded down; never a runtime-proven caller set.",
    inputSchema: { repositoryRoot, symbol: z.string().describe("Symbol, function, or file whose callers to list."), outputMode },
    cli: { command: "find-callers", positionals: ["symbol"] },
    execute: async ({ repositoryRoot, symbol, outputMode }) => formatFindCallers(await findCallers(repositoryRoot, symbol), mode(outputMode))
  }),
  defineTool({
    name: "find_path",
    title: "Find static path",
    description:
      "Return static call paths between two symbols — the fewest-hop path and the best-confidence (widest-path) path. Codebase-only and confidence-graded (clamped to `likely`); a static path, never a runtime stack/trace.",
    inputSchema: { repositoryRoot, from: z.string().describe("Source symbol/file."), to: z.string().describe("Target symbol/file."), outputMode },
    cli: { command: "find-path", positionals: ["from", "to"] },
    execute: async ({ repositoryRoot, from, to, outputMode }) => formatFindPath(await findPath(repositoryRoot, from, to), mode(outputMode))
  }),
  defineTool({
    name: "find_duplicate_behavior",
    title: "Find duplicate behavior",
    description: "Find candidate code paths that perform the same behavior as a subject, to prevent parallel/duplicate workflows.",
    inputSchema: { repositoryRoot, subject: z.string().describe("Behavior, workflow, or symbol to compare against."), outputMode },
    cli: { command: "duplicates", positionals: ["subject"] },
    execute: async ({ repositoryRoot, subject, outputMode }) => formatDuplicateBehavior(await findDuplicateBehavior(repositoryRoot, subject), mode(outputMode))
  }),
  defineTool({
    name: "classify_legacy_paths",
    title: "Classify legacy paths",
    description:
      "Classify legacy paths by reachability/risk (still_reachable, possibly_reachable, apparently_unreachable, replaced_but_present, requires_human_confirmation). The most aggressive class emitted is apparently_unreachable, always with a human-confirmation caveat; the tool never asserts a symbol is safe to delete and never assumes code is dead without classification.",
    inputSchema: { repositoryRoot, outputMode },
    cli: { command: "legacy", positionals: [] },
    execute: async ({ repositoryRoot, outputMode }) => formatLegacyClassification(await classifyLegacyPaths(repositoryRoot), mode(outputMode))
  }),
  defineTool({
    name: "analyze_change_impact",
    title: "Analyze change impact",
    description: "Return codebase-only change-impact (blast-radius) hypotheses for a target with impact levels and explicit uncertainty. Not a runtime proof.",
    inputSchema: { repositoryRoot, target: z.string().describe("Symbol, file, or area to assess for impact."), outputMode },
    cli: { command: "impact", positionals: ["target"] },
    execute: async ({ repositoryRoot, target, outputMode }) => formatChangeImpact(await analyzeChangeImpact(repositoryRoot, target), mode(outputMode))
  }),
  defineTool({
    name: "review_preflight",
    title: "Agent preflight review",
    description: "Pre-coding orientation for a requested change: canonical paths to reuse, duplicate/legacy risks to avoid, likely impact, and a recommendation.",
    inputSchema: { repositoryRoot, requestedChange: z.string().describe("The change the agent is about to make."), outputMode },
    cli: { command: "preflight", positionals: ["requestedChange"] },
    execute: async ({ repositoryRoot, requestedChange, outputMode }) => formatPreflightReview(await reviewPreflight(repositoryRoot, requestedChange), mode(outputMode))
  }),
  defineTool({
    name: "review_change",
    title: "Review a change",
    description: "Review an agent-generated change for duplication, bypassed abstractions, reachable legacy, and unexpected impact; returns evidence-based findings.",
    inputSchema: { repositoryRoot, changeDescription: z.string().describe("Description or diff of the change to review."), outputMode },
    cli: { command: "review", positionals: ["changeDescription"] },
    execute: async ({ repositoryRoot, changeDescription, outputMode }) => formatChangeReview(await reviewChange(repositoryRoot, changeDescription), mode(outputMode))
  }),
  defineTool({
    name: "get_ownership",
    title: "Get canonical ownership",
    description: "Identify which path canonically owns a behavior/symbol and what an agent should reuse instead of recreating.",
    inputSchema: { repositoryRoot, symbol: z.string().describe("Symbol, behavior, or path to resolve ownership for."), outputMode },
    cli: { command: "ownership", positionals: ["symbol"] },
    execute: async ({ repositoryRoot, symbol, outputMode }) => formatOwnership(await getOwnership(repositoryRoot, symbol), mode(outputMode))
  }),
  defineTool({
    name: "investigate_failure",
    title: "Investigate failure",
    description:
      "Form codebase-only hypotheses around a failure (stack trace, method, test) and state what runtime confirmation would still be required. Not a debugger.",
    inputSchema: { repositoryRoot, failureReference: z.string().describe("Stack trace, method name, test name, or failure area."), outputMode },
    cli: { command: "failure", positionals: ["failureReference"] },
    execute: async ({ repositoryRoot, failureReference, outputMode }) => formatFailureInvestigation(await investigateFailure(repositoryRoot, failureReference), mode(outputMode))
  }),
  defineTool({
    name: "analyze_test_paths",
    title: "Analyze test paths",
    description: "Identify which tests can reach a target (helper, workflow, setup/teardown path) from codebase-only signals.",
    inputSchema: { repositoryRoot, target: z.string().describe("Symbol, helper, or workflow to trace tests for."), outputMode },
    cli: { command: "test-paths", positionals: ["target"] },
    execute: async ({ repositoryRoot, target, outputMode }) => formatTestPaths(await analyzeTestPaths(repositoryRoot, target), mode(outputMode))
  }),
  defineTool({
    name: "detect_architecture_drift",
    title: "Detect architecture drift",
    description: "Identify where implementation has diverged from intended design: scattered ownership, accidental parallel systems, bypassed abstractions.",
    inputSchema: { repositoryRoot, outputMode },
    cli: { command: "drift", positionals: [] },
    execute: async ({ repositoryRoot, outputMode }) => formatArchitectureDrift(await detectArchitectureDrift(repositoryRoot), mode(outputMode))
  }),

  defineTool({
    name: "analyze_diff",
    title: "Analyze diff (changed files only)",
    description:
      "Compare the persisted baseline map against the CURRENT working tree (rebuilt in memory under the baseline's recorded scope; nothing persisted) — or against an explicit baseline snapshot via baselineMapPath. Returns the capped static delta: changed files, call-graph adds/removes, NEW duplicate paths, legacy reachability transitions, new risk areas, and confidence regressions (static evidence weakening — never a runtime claim), plus the agent verdict: did this change add a second path, bypass a public surface, revive legacy, or increase uncertainty?",
    inputSchema: {
      repositoryRoot,
      baselineMapPath: z.string().optional().describe("Optional explicit baseline context-map.json to compare against the repository's persisted map (CI: map@main vs map@head). Omit to diff the persisted baseline against the current tree."),
      outputMode
    },
    cli: { command: "diff", positionals: [] },
    execute: async ({ repositoryRoot, baselineMapPath, outputMode }) => formatMapDiff(await analyzeDiff(repositoryRoot, { baselineMapPath }), mode(outputMode))
  }),

  // -- Call-stack + visualization tools --
  defineTool({
    name: "map_call_stack",
    title: "Map call stack",
    description:
      "Map the static call stack/graph rooted at an entry point (symbol, function, or file). Codebase-only and confidence-graded: dynamic dispatch, DI, reflection, and framework-invoked calls are labeled candidate/unresolved. Not a runtime trace. Requires an initialized map.",
    inputSchema: {
      repositoryRoot,
      entryPoint: z.string().describe("Entry point to root the call stack at (symbol, function, or file)."),
      maxDepth: z.number().int().positive().optional().describe("Maximum traversal depth."),
      outputMode
    },
    cli: { command: "callstack", positionals: ["entryPoint"] },
    execute: async ({ repositoryRoot, entryPoint, maxDepth, outputMode }) => formatCallStack(await mapCallStack(repositoryRoot, entryPoint, maxDepth), mode(outputMode))
  }),
  defineTool({
    name: "visualize_call_stack",
    title: "Visualize call stack",
    description:
      "Render the static call stack rooted at an entry point as a diagram spec (Mermaid/DOT/ASCII text the client renders). Carries a confidence/edge-kind legend. Requires an initialized map.",
    inputSchema: {
      repositoryRoot,
      entryPoint: z.string().describe("Entry point to root the call stack at."),
      format: visualizationFormat,
      maxDepth: z.number().int().positive().optional().describe("Maximum traversal depth."),
      outputMode
    },
    cli: { command: "viz-callstack", positionals: ["entryPoint"] },
    execute: async ({ repositoryRoot, entryPoint, format, maxDepth, outputMode }) =>
      formatCallStackVisualization(await visualizeCallStack(repositoryRoot, entryPoint, format, maxDepth), mode(outputMode))
  }),
  defineTool({
    name: "visualize_architecture",
    title: "Visualize architecture",
    description:
      "Render the repository architecture (modules, ownership, drift) as a diagram spec (Mermaid/DOT/ASCII text the client renders). Requires an initialized map.",
    inputSchema: { repositoryRoot, format: visualizationFormat, outputMode },
    cli: { command: "viz-arch", positionals: [] },
    execute: async ({ repositoryRoot, format, outputMode }) => formatArchitectureVisualization(await visualizeArchitecture(repositoryRoot, format), mode(outputMode))
  })
];

// ---- Adapter: MCP registration ----

/** Register every spec on an MCP server — the entire MCP surface is this loop. */
export function registerTools(server: McpServer): void {
  for (const spec of TOOLS) {
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema: spec.inputSchema },
      async (args: Record<string, unknown>) => {
        const repositoryRoot = typeof args.repositoryRoot === "string" ? args.repositoryRoot : process.cwd();
        const started = performance.now();
        let ok = false;
        let text = "";
        try {
          text = await spec.execute(args);
          ok = true;
          return { content: [{ type: "text" as const, text }] };
        } finally {
          // Code-content-free, dev-only telemetry (ADR 0034 S2). No-op unless CCM_TELEMETRY is set;
          // deferred to a microtask + self-swallowing, so neither an async NOR a synchronous fault
          // in telemetry can escape this `finally` and mask the tool's real result/error.
          void Promise.resolve()
            .then(() =>
              recordToolCall(repositoryRoot, {
                ts: new Date().toISOString(),
                tool: spec.name,
                ms: Math.round(performance.now() - started),
                ok,
                outputChars: text.length,
                argKeys: Object.keys(args).sort()
              })
            )
            .catch(() => undefined);
        }
      }
    );
  }
}

// ---- Adapter: CLI argument mapping ----

export function cliUsage(): string {
  const commands = TOOLS.map((t) => t.cli.command);
  return (
    "Usage: code-cartographer-mcp <command> <repositoryRoot> [subject...] [--llm|--dual]\n" +
    `  commands: ${commands.join(" | ")}\n` +
    "  scope flags (preview|init): --mode=<auto|gitignore|language|none> --lang=<name> (repeatable)"
  );
}

/** Resolve a CLI command to its spec, or undefined for an unknown command. */
export function findCliSpec(command: string | undefined): ToolSpec | undefined {
  return TOOLS.find((t) => t.cli.command === command);
}

/**
 * Build the args object a spec's `execute` expects from CLI positionals/flags —
 * the same shape the MCP adapter receives, so the two surfaces cannot diverge.
 */
export function cliArgs(spec: ToolSpec, positionals: string[], flags: string[], cwd: string): Record<string, unknown> {
  const args: Record<string, unknown> = {
    repositoryRoot: positionals[1] ?? cwd,
    outputMode: flags.includes("--dual") ? "dual" : flags.includes("--llm") ? "llm_readable" : "human_readable"
  };
  spec.cli.positionals.forEach((name, i) => {
    const value = positionals[2 + i];
    if (value === undefined) {
      throw new Error(`Command "${spec.cli.command}" requires a <${name}> argument. ${cliUsage()}`);
    }
    args[name] = value;
  });
  if ("exclusionMode" in spec.inputSchema) {
    const prefix = "--mode=";
    const match = flags.find((flag) => flag.startsWith(prefix));
    const rawMode = match?.slice(prefix.length) as ExclusionMode | undefined;
    const langs = flags.filter((flag) => flag.startsWith("--lang=")).map((flag) => flag.slice("--lang=".length));
    args.exclusionMode = rawMode;
    args.languages = langs.length > 0 ? langs : undefined;
  }
  return args;
}
