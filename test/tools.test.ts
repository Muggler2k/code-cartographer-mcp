// The declarative tool spec table (Decision 0025): the MCP and CLI surfaces are two
// adapters over TOOLS, so these tests pin the table itself — count, uniqueness, schema
// invariants, CLI arg mapping, and execute end-to-end — without connecting a transport.

import { afterAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TOOLS, cliArgs, cliUsage, findCliSpec, registerTools } from "../src/tools.js";
import { tempRepos } from "./helpers/fixtures.js";

const repos = tempRepos("ccm-tools-");
afterAll(() => repos.cleanup());

const EXPECTED_TOOL_NAMES = [
  "check_init_state",
  "preview_scope",
  "init_codebase",
  "get_context_summary",
  "analyze_reachability",
  "find_callers",
  "find_path",
  "find_duplicate_behavior",
  "classify_legacy_paths",
  "analyze_change_impact",
  "review_preflight",
  "review_change",
  "get_ownership",
  "investigate_failure",
  "analyze_test_paths",
  "detect_architecture_drift",
  "analyze_diff",
  "map_call_stack",
  "visualize_call_stack",
  "visualize_architecture"
];

describe("tool spec table (Decision 0025)", () => {
  it("defines exactly the 20 documented MCP tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(TOOLS).toHaveLength(20);
  });

  it("has unique MCP names and unique CLI commands", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    expect(new Set(TOOLS.map((t) => t.cli.command)).size).toBe(TOOLS.length);
  });

  it("every spec takes repositoryRoot and outputMode, and has a non-empty title/description", () => {
    for (const spec of TOOLS) {
      expect(Object.keys(spec.inputSchema)).toContain("repositoryRoot");
      expect(Object.keys(spec.inputSchema)).toContain("outputMode");
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("every CLI positional names a field that exists in the spec's schema", () => {
    for (const spec of TOOLS) {
      for (const name of spec.cli.positionals) {
        expect(Object.keys(spec.inputSchema)).toContain(name);
      }
    }
  });

  it("registers all specs on an McpServer without conflicts", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(() => registerTools(server)).not.toThrow();
  });

  it("usage lists every CLI command", () => {
    const usage = cliUsage();
    for (const spec of TOOLS) {
      expect(usage).toContain(spec.cli.command);
    }
  });
});

describe("CLI adapter mapping (cliArgs)", () => {
  it("maps subject positionals onto schema field names", () => {
    const spec = findCliSpec("reachability")!;
    const args = cliArgs(spec, ["reachability", "/repo", "mySymbol"], [], "/cwd");
    expect(args).toMatchObject({ repositoryRoot: "/repo", target: "mySymbol", outputMode: "human_readable" });
  });

  it("maps find-path's two positionals to from/to", () => {
    const spec = findCliSpec("find-path")!;
    const args = cliArgs(spec, ["find-path", "/repo", "a", "b"], ["--llm"], "/cwd");
    expect(args).toMatchObject({ from: "a", to: "b", outputMode: "llm_readable" });
  });

  it("throws a usage error when a required positional is missing", () => {
    const spec = findCliSpec("find-path")!;
    expect(() => cliArgs(spec, ["find-path", "/repo", "a"], [], "/cwd")).toThrow(/requires a <to> argument/);
  });

  it("defaults repositoryRoot to cwd and honors --dual", () => {
    const spec = findCliSpec("status")!;
    const args = cliArgs(spec, ["status"], ["--dual"], "/the-cwd");
    expect(args).toMatchObject({ repositoryRoot: "/the-cwd", outputMode: "dual" });
  });

  it("parses scope flags (--mode/--lang) for tools whose schema has them", () => {
    const spec = findCliSpec("init")!;
    const args = cliArgs(spec, ["init", "/repo"], ["--mode=language", "--lang=node", "--lang=python"], "/cwd");
    expect(args).toMatchObject({ exclusionMode: "language", languages: ["node", "python"] });
  });

  it("returns undefined for an unknown command", () => {
    expect(findCliSpec("nope")).toBeUndefined();
    expect(findCliSpec(undefined)).toBeUndefined();
  });
});

describe("execute end-to-end (the one behavior both surfaces render)", () => {
  it("check_init_state reports not_initialized on a bare repo, with the codebase-only envelope in llm mode", async () => {
    const root = await repos.makeRepo({ "a.ts": "export const a = 1;" });
    const human = await findCliSpec("status")!.execute({ repositoryRoot: root });
    expect(human).toContain("not_initialized");
    const llm = JSON.parse(await findCliSpec("status")!.execute({ repositoryRoot: root, outputMode: "llm_readable" }));
    expect(llm.analysisBoundary).toBe("codebase_only");
  });

  it("init then status round-trips to initialized through the table", async () => {
    const root = await repos.makeRepo({ "src/index.ts": "export function main(): number { return helper(); }\nexport function helper(): number { return 1; }\n" });
    const initOut = await findCliSpec("init")!.execute({ repositoryRoot: root, exclusionMode: "none" });
    expect(initOut.toLowerCase()).toContain("codebase-only");
    const status = await findCliSpec("status")!.execute({ repositoryRoot: root });
    expect(status).toContain("initialized");
  });
});
