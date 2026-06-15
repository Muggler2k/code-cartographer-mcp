#!/usr/bin/env node
// Entry point: two thin adapters over the declarative tool spec table (Decision 0025).
// The MCP surface is `registerTools(server)`; the CLI surface resolves the command in
// the same table and renders the same `execute`. Tool definitions live in tools.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { cliArgs, cliUsage, findCliSpec, registerTools } from "./tools.js";

const server = new McpServer(
  {
    name: "code-cartographer-mcp",
    version: "1.0.0"
  },
  {
    instructions:
      "Use this server for codebase-only static context. Do not treat results as runtime truth: reachability, change-impact, and failure investigation return evidence-graded hypotheses with explicit uncertainty, never runtime proof. Run init_codebase before any deep analysis."
  }
);

registerTools(server);

async function runCli(args: string[]): Promise<void> {
  const positionals = args.filter((arg) => !arg.startsWith("--"));
  const flags = args.filter((arg) => arg.startsWith("--"));
  const spec = findCliSpec(positionals[0]);
  if (!spec) {
    console.error(cliUsage());
    process.exitCode = 1;
    return;
  }
  console.log(await spec.execute(cliArgs(spec, positionals, flags, process.cwd())));
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    await runCli(process.argv.slice(2));
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
