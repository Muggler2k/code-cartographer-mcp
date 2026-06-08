#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  checkInitState,
  initCodebase,
  readContextMap,
  type OutputMode
} from "./contextMap.js";
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
  formatInitResult,
  formatInitStatus,
  formatLegacyClassification,
  formatOwnership,
  formatPreflightReview,
  formatReachability,
  formatScopePreview,
  formatTestPaths
} from "./output.js";

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

const server = new McpServer(
  {
    name: "code-cartographer-mcp",
    version: "0.1.0"
  },
  {
    instructions:
      "Use this server for codebase-only static context. Do not treat results as runtime truth: reachability, change-impact, and failure investigation return evidence-graded hypotheses with explicit uncertainty, never runtime proof. Run init_codebase before any deep analysis."
  }
);

// ---- Core map tools ----

server.registerTool(
  "check_init_state",
  {
    title: "Check init state",
    description: "Check whether a repository has a saved baseline context map and whether it appears stale.",
    inputSchema: { repositoryRoot, outputMode }
  },
  async ({ repositoryRoot, outputMode }) => {
    const result = await checkInitState(repositoryRoot);
    return textResult(formatInitStatus(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "preview_scope",
  {
    title: "Preview scope/exclusions",
    description: "Step 1 of init (Decision 0009): resolve which files would be in scope under an exclusion strategy and return a resolved plan (source, excluded directories, detected languages, included/excluded file counts, sample paths). No map is written and no target code is executed — this is static file-system resolution only.",
    inputSchema: { repositoryRoot, exclusionMode, languages, outputMode }
  },
  async ({ repositoryRoot, exclusionMode, languages, outputMode }) => {
    const result = await previewScope(repositoryRoot, toExclusionConfig(exclusionMode, languages));
    return textResult(formatScopePreview(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "init_codebase",
  {
    title: "Initialize codebase context",
    description: "Step 2 of init (Decision 0009): map a repository from codebase files under the chosen exclusion strategy and write .code-cartographer-mcp/context-map.json. Run preview_scope first to confirm what will be excluded.",
    inputSchema: { repositoryRoot, exclusionMode, languages, outputMode }
  },
  async ({ repositoryRoot, exclusionMode, languages, outputMode }) => {
    const result = await initCodebase(repositoryRoot, toExclusionConfig(exclusionMode, languages));
    return textResult(formatInitResult(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "get_context_summary",
  {
    title: "Get context summary",
    description: "Read the saved baseline context map for a repository and return a compact summary.",
    inputSchema: { repositoryRoot, outputMode }
  },
  async ({ repositoryRoot, outputMode }) => {
    const map = await readContextMap(repositoryRoot);
    return textResult(formatContextSummary(map, normalizeOutputMode(outputMode)));
  }
);

// ---- Analytical tools (require an initialized map; codebase-only) ----

server.registerTool(
  "analyze_reachability",
  {
    title: "Analyze reachability",
    description: "Return codebase-only structural reachability hypotheses for a target (symbol, file, or workflow) with confidence labels and explicit uncertainty. Never claims runtime-proven reachability.",
    inputSchema: { repositoryRoot, target: z.string().describe("Symbol, file, or workflow to analyze."), outputMode }
  },
  async ({ repositoryRoot, target, outputMode }) => {
    const result = await analyzeReachability(repositoryRoot, target);
    return textResult(formatReachability(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "find_duplicate_behavior",
  {
    title: "Find duplicate behavior",
    description: "Find candidate code paths that perform the same behavior as a subject, to prevent parallel/duplicate workflows.",
    inputSchema: { repositoryRoot, subject: z.string().describe("Behavior, workflow, or symbol to compare against."), outputMode }
  },
  async ({ repositoryRoot, subject, outputMode }) => {
    const result = await findDuplicateBehavior(repositoryRoot, subject);
    return textResult(formatDuplicateBehavior(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "classify_legacy_paths",
  {
    title: "Classify legacy paths",
    description: "Classify legacy paths by reachability/risk (still_reachable, possibly_reachable, apparently_unreachable, replaced_but_present, requires_human_confirmation). The most aggressive class emitted is apparently_unreachable, always with a human-confirmation caveat; the tool never asserts a symbol is safe to delete and never assumes code is dead without classification.",
    inputSchema: { repositoryRoot, outputMode }
  },
  async ({ repositoryRoot, outputMode }) => {
    const result = await classifyLegacyPaths(repositoryRoot);
    return textResult(formatLegacyClassification(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "analyze_change_impact",
  {
    title: "Analyze change impact",
    description: "Return codebase-only change-impact (blast-radius) hypotheses for a target with impact levels and explicit uncertainty. Not a runtime proof.",
    inputSchema: { repositoryRoot, target: z.string().describe("Symbol, file, or area to assess for impact."), outputMode }
  },
  async ({ repositoryRoot, target, outputMode }) => {
    const result = await analyzeChangeImpact(repositoryRoot, target);
    return textResult(formatChangeImpact(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "review_preflight",
  {
    title: "Agent preflight review",
    description: "Pre-coding orientation for a requested change: canonical paths to reuse, duplicate/legacy risks to avoid, likely impact, and a recommendation.",
    inputSchema: { repositoryRoot, requestedChange: z.string().describe("The change the agent is about to make."), outputMode }
  },
  async ({ repositoryRoot, requestedChange, outputMode }) => {
    const result = await reviewPreflight(repositoryRoot, requestedChange);
    return textResult(formatPreflightReview(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "review_change",
  {
    title: "Review a change",
    description: "Review an agent-generated change for duplication, bypassed abstractions, reachable legacy, and unexpected impact; returns evidence-based findings.",
    inputSchema: { repositoryRoot, changeDescription: z.string().describe("Description or diff of the change to review."), outputMode }
  },
  async ({ repositoryRoot, changeDescription, outputMode }) => {
    const result = await reviewChange(repositoryRoot, changeDescription);
    return textResult(formatChangeReview(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "get_ownership",
  {
    title: "Get canonical ownership",
    description: "Identify which path canonically owns a behavior/symbol and what an agent should reuse instead of recreating.",
    inputSchema: { repositoryRoot, symbol: z.string().describe("Symbol, behavior, or path to resolve ownership for."), outputMode }
  },
  async ({ repositoryRoot, symbol, outputMode }) => {
    const result = await getOwnership(repositoryRoot, symbol);
    return textResult(formatOwnership(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "investigate_failure",
  {
    title: "Investigate failure",
    description: "Form codebase-only hypotheses around a failure (stack trace, method, test) and state what runtime confirmation would still be required. Not a debugger.",
    inputSchema: { repositoryRoot, failureReference: z.string().describe("Stack trace, method name, test name, or failure area."), outputMode }
  },
  async ({ repositoryRoot, failureReference, outputMode }) => {
    const result = await investigateFailure(repositoryRoot, failureReference);
    return textResult(formatFailureInvestigation(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "analyze_test_paths",
  {
    title: "Analyze test paths",
    description: "Identify which tests can reach a target (helper, workflow, setup/teardown path) from codebase-only signals.",
    inputSchema: { repositoryRoot, target: z.string().describe("Symbol, helper, or workflow to trace tests for."), outputMode }
  },
  async ({ repositoryRoot, target, outputMode }) => {
    const result = await analyzeTestPaths(repositoryRoot, target);
    return textResult(formatTestPaths(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "detect_architecture_drift",
  {
    title: "Detect architecture drift",
    description: "Identify where implementation has diverged from intended design: scattered ownership, accidental parallel systems, bypassed abstractions.",
    inputSchema: { repositoryRoot, outputMode }
  },
  async ({ repositoryRoot, outputMode }) => {
    const result = await detectArchitectureDrift(repositoryRoot);
    return textResult(formatArchitectureDrift(result, normalizeOutputMode(outputMode)));
  }
);

// ---- Call-stack + visualization tools ----

server.registerTool(
  "map_call_stack",
  {
    title: "Map call stack",
    description: "Map the static call stack/graph rooted at an entry point (symbol, function, or file). Codebase-only and confidence-graded: dynamic dispatch, DI, reflection, and framework-invoked calls are labeled candidate/unresolved. Not a runtime trace. Requires an initialized map.",
    inputSchema: {
      repositoryRoot,
      entryPoint: z.string().describe("Entry point to root the call stack at (symbol, function, or file)."),
      maxDepth: z.number().int().positive().optional().describe("Maximum traversal depth."),
      outputMode
    }
  },
  async ({ repositoryRoot, entryPoint, maxDepth, outputMode }) => {
    const result = await mapCallStack(repositoryRoot, entryPoint, maxDepth);
    return textResult(formatCallStack(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "visualize_call_stack",
  {
    title: "Visualize call stack",
    description: "Render the static call stack rooted at an entry point as a diagram spec (Mermaid/DOT/ASCII text the client renders). Carries a confidence/edge-kind legend. Requires an initialized map.",
    inputSchema: {
      repositoryRoot,
      entryPoint: z.string().describe("Entry point to root the call stack at."),
      format: visualizationFormat,
      maxDepth: z.number().int().positive().optional().describe("Maximum traversal depth."),
      outputMode
    }
  },
  async ({ repositoryRoot, entryPoint, format, maxDepth, outputMode }) => {
    const result = await visualizeCallStack(repositoryRoot, entryPoint, format, maxDepth);
    return textResult(formatCallStackVisualization(result, normalizeOutputMode(outputMode)));
  }
);

server.registerTool(
  "visualize_architecture",
  {
    title: "Visualize architecture",
    description: "Render the repository architecture (modules, ownership, drift) as a diagram spec (Mermaid/DOT/ASCII text the client renders). Requires an initialized map.",
    inputSchema: { repositoryRoot, format: visualizationFormat, outputMode }
  },
  async ({ repositoryRoot, format, outputMode }) => {
    const result = await visualizeArchitecture(repositoryRoot, format);
    return textResult(formatArchitectureVisualization(result, normalizeOutputMode(outputMode)));
  }
);

function normalizeOutputMode(mode: OutputMode | undefined): OutputMode {
  return mode ?? "human_readable";
}

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text
      }
    ]
  };
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    await runCli(process.argv.slice(2));
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const CLI_USAGE =
  "Usage: code-cartographer-mcp <command> <repositoryRoot> [subject] [--llm|--dual]\n" +
  "  commands: preview | init | status | summary | reachability | duplicates | legacy |\n" +
  "            impact | preflight | review | ownership | failure | test-paths | drift |\n" +
  "            callstack | viz-callstack | viz-arch\n" +
  "  scope flags (preview|init): --mode=<auto|gitignore|language|none> --lang=<name> (repeatable)";

async function runCli(args: string[]): Promise<void> {
  const positionals = args.filter((arg) => !arg.startsWith("--"));
  const flags = args.filter((arg) => arg.startsWith("--"));
  const command = positionals[0];
  const root = positionals[1] ?? process.cwd();
  const subject = positionals[2];
  const mode: OutputMode = flags.includes("--dual") ? "dual" : flags.includes("--llm") ? "llm_readable" : "human_readable";

  const flagValue = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const match = flags.find((flag) => flag.startsWith(prefix));
    return match?.slice(prefix.length);
  };
  const exclusionConfig = (): ExclusionConfig | undefined => {
    const rawMode = flagValue("mode") as ExclusionMode | undefined;
    const langs = flags
      .filter((flag) => flag.startsWith("--lang="))
      .map((flag) => flag.slice("--lang=".length));
    return toExclusionConfig(rawMode, langs.length > 0 ? langs : undefined);
  };

  const needsSubject = (name: string): string => {
    if (!subject) {
      throw new Error(`Command "${name}" requires a subject argument. ${CLI_USAGE}`);
    }
    return subject;
  };

  switch (command) {
    case "preview":
      console.log(formatScopePreview(await previewScope(root, exclusionConfig()), mode));
      return;
    case "init":
      console.log(formatInitResult(await initCodebase(root, exclusionConfig()), mode));
      return;
    case "status":
      console.log(formatInitStatus(await checkInitState(root), mode));
      return;
    case "summary":
      console.log(formatContextSummary(await readContextMap(root), mode));
      return;
    case "reachability":
      console.log(formatReachability(await analyzeReachability(root, needsSubject("reachability")), mode));
      return;
    case "duplicates":
      console.log(formatDuplicateBehavior(await findDuplicateBehavior(root, needsSubject("duplicates")), mode));
      return;
    case "legacy":
      console.log(formatLegacyClassification(await classifyLegacyPaths(root), mode));
      return;
    case "impact":
      console.log(formatChangeImpact(await analyzeChangeImpact(root, needsSubject("impact")), mode));
      return;
    case "preflight":
      console.log(formatPreflightReview(await reviewPreflight(root, needsSubject("preflight")), mode));
      return;
    case "review":
      console.log(formatChangeReview(await reviewChange(root, needsSubject("review")), mode));
      return;
    case "ownership":
      console.log(formatOwnership(await getOwnership(root, needsSubject("ownership")), mode));
      return;
    case "failure":
      console.log(formatFailureInvestigation(await investigateFailure(root, needsSubject("failure")), mode));
      return;
    case "test-paths":
      console.log(formatTestPaths(await analyzeTestPaths(root, needsSubject("test-paths")), mode));
      return;
    case "drift":
      console.log(formatArchitectureDrift(await detectArchitectureDrift(root), mode));
      return;
    case "callstack":
      console.log(formatCallStack(await mapCallStack(root, needsSubject("callstack")), mode));
      return;
    case "viz-callstack":
      console.log(formatCallStackVisualization(await visualizeCallStack(root, needsSubject("viz-callstack")), mode));
      return;
    case "viz-arch":
      console.log(formatArchitectureVisualization(await visualizeArchitecture(root), mode));
      return;
    default:
      console.error(CLI_USAGE);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
