// Pure seed-selection for the dogfood harness (ADR 0034 S0), extracted from eval/dogfood.ts so
// it can be unit-tested without driving the MCP stdio transport. dogfood.ts owns the disk read
// and the transport; this module owns only the "which node best represents real application code"
// decision. Codebase-only: it reads the persisted static map, executes nothing.

export interface SeedNode {
  id: string;
  path: string;
}
export interface SeedEdge {
  from: string;
  to: string;
}
export interface Seeds {
  symbol: string;
  to: string;
  file: string;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|cs|vb|py|go|java|rs|rb|cpp|cc|c|h)$/i;
// Vendored / generated / static-asset paths: real but not application code. Rooting the
// symbol/path tools at a vendored admin-template JS (e.g. wwwroot/.../jquery.vmap.js) makes
// those tools' measurements unrepresentative, so the seed picker prefers to skip these.
const VENDORED =
  /(^|\/)(node_modules|bower_components|vendor|third_party|wwwroot|dist|build|out|assets|public|packages)\/|[.-]min\.(js|css)$/i;

/**
 * Pick the most representative real-code seeds (a fan-out hub `symbol`, a distinct callee `to`,
 * and a `file`) from a persisted map's call graph.
 *
 * The vendored skip is a *preference*, not a hard filter (Issue #5): in a monorepo that keeps ALL
 * source under a dir the VENDORED pattern matches (e.g. `packages/`, `assets/`, `public/`, or
 * everything under `vendor/`), no node is "app code", so a hard filter would empty the candidate
 * set and the picker would degrade to an arbitrary `nodes[0]` — re-introducing the
 * unrepresentative-seed problem the vendored skip was meant to fix. When no non-vendored code
 * node exists we therefore fall back to any code node, keeping the seed representative.
 */
export function selectSeeds(
  nodes: SeedNode[],
  edges: SeedEdge[],
  files: Array<{ path: string }> = []
): Seeds {
  const pathOf = new Map(nodes.map((n) => [n.id, n.path]));
  const isCodePath = (p: string): boolean => CODE_EXT.test(p);
  const isAppCodePath = (p: string): boolean => CODE_EXT.test(p) && !VENDORED.test(p);

  // The one rule governing every seed (symbol, to, file): prefer non-vendored application code,
  // but fall back to any code when the candidate set has no app code (the monorepo-under-packages/
  // case, Issue #5) so the seed never degrades to an arbitrary non-code node. `prefer` picks the
  // predicate once per candidate set; nodes and files use it identically.
  const prefer = (paths: string[]): ((p: string) => boolean) =>
    paths.some(isAppCodePath) ? isAppCodePath : isCodePath;
  const nodeOk = prefer(nodes.map((n) => n.path));
  const accept = (id: string): boolean => nodeOk(pathOf.get(id) ?? "");

  // Out-degree over accepted, non-self edges → the most connected real hub. Tie-break on node id
  // so the pick is stable across map regenerations (independent of edge ordering).
  const outDegree = new Map<string, number>();
  for (const e of edges) {
    if (e.from !== e.to && accept(e.from)) outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
  }
  const hub = [...outDegree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const symbol = hub ?? nodes.find((n) => accept(n.id))?.id ?? nodes[0]?.id ?? "main";

  // A distinct callee for `to`, preferring an accepted (non-vendored) one but never failing to one.
  const callees = edges.filter((e) => e.from === symbol && e.to !== symbol);
  const to = (callees.find((e) => accept(e.to)) ?? callees[0])?.to ?? symbol;

  const fileOk = prefer(files.map((f) => f.path));
  const file = pathOf.get(symbol) ?? files.find((f) => fileOk(f.path))?.path ?? "src";
  return { symbol, to, file };
}
