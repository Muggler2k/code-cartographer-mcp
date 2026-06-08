// Derived SQLite graph index (Decision 0023). A disposable PROJECTION of `map.callGraph`
// that backs indexed caller/callee/path queries — it adds no truth the JSON map does not
// already hold. `context-map.json` stays the single source of truth; this index is stamped
// with the map's `mapHash` and rebuilt whenever it is missing, schema-stale, or hash-stale,
// so a stale map can never return fresh-looking results. CODEBASE-ONLY throughout.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getMapPath, readContextMap, type StaticContextMap } from "./contextMap.js";
import type { CallEdge, CallGraphNode } from "./callGraph.js";
import { inMemoryGraphSource, tarjanScc, type GraphSource, type SccResult } from "./pathfinding.js";

const MAP_DIR = ".code-cartographer-mcp";
const INDEX_FILE = "graph-index.sqlite";
/** Bump when the index TABLE shape changes (independent of the map's SCHEMA_VERSION). */
export const GRAPH_INDEX_SCHEMA_VERSION = 2; // v2: added nodes_symbol / nodes_path indexes (ADR 0024)

export function getGraphIndexPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, MAP_DIR, INDEX_FILE);
}

// ---- node:sqlite loader (built-in; experimental warning suppressed at import) ----

type DatabaseSyncCtor = typeof import("node:sqlite").DatabaseSync;
type DatabaseSync = InstanceType<DatabaseSyncCtor>;
let loadPromise: Promise<DatabaseSyncCtor> | null = null;

/**
 * Load `node:sqlite` (Node ≥ 22.5, built-in — no third-party dependency, no native build).
 * It emits one `ExperimentalWarning` at import; we drop that single warning narrowly and
 * restore `emitWarning` immediately (Decision 0023). Everything else still warns normally.
 * Memoized behind ONE in-flight promise, so the `emitWarning` swap happens exactly once even
 * under concurrent first-time callers (no double-patch race).
 */
function loadSqlite(): Promise<DatabaseSyncCtor> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const original = process.emitWarning.bind(process);
      process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
        const message = typeof warning === "string" ? warning : warning?.message;
        if (typeof message === "string" && message.includes("SQLite is an experimental feature")) return;
        return (original as (w: string | Error, ...a: unknown[]) => void)(warning, ...rest);
      }) as typeof process.emitWarning;
      try {
        const mod = await import("node:sqlite");
        return mod.DatabaseSync;
      } finally {
        process.emitWarning = original;
      }
    })();
  }
  return loadPromise;
}

// ---- Row <-> edge mapping --------------------------------------------------

interface EdgeRow {
  from_id: string;
  to_id: string;
  call_kind: string;
  confidence: string;
  evidence: string;
}

function rowToEdge(row: EdgeRow): CallEdge {
  return {
    from: row.from_id,
    to: row.to_id,
    callKind: row.call_kind as CallEdge["callKind"],
    confidence: row.confidence as CallEdge["confidence"],
    evidence: JSON.parse(row.evidence) as string[]
  };
}

interface NodeRow {
  id: string;
  symbol: string;
  path: string;
  kind: string;
  confidence: string;
}

function rowToNode(row: NodeRow): CallGraphNode {
  return {
    id: row.id,
    symbol: row.symbol,
    path: row.path,
    kind: row.kind as CallGraphNode["kind"],
    confidence: row.confidence as CallGraphNode["confidence"]
  };
}

// ---- Build ----------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE nodes (id TEXT PRIMARY KEY, symbol TEXT, path TEXT, kind TEXT, confidence TEXT);
  CREATE TABLE edges (from_id TEXT NOT NULL, to_id TEXT NOT NULL, call_kind TEXT, confidence TEXT, evidence TEXT);
  CREATE INDEX edges_from ON edges(from_id);
  CREATE INDEX edges_to ON edges(to_id);
  CREATE INDEX nodes_symbol ON nodes(symbol);
  CREATE INDEX nodes_path ON nodes(path);
`;

/**
 * Build (or rebuild) `graph-index.sqlite` from the map's call graph. Written to a temp file
 * then renamed into place (best-effort: not a hard atomic guarantee on every platform, but a
 * crash mid-rebuild only forces a rebuild on the next open — never data loss, since the index
 * is derived). Stamped in `meta` with the index schema version + the map's `mapHash`. Reads
 * `context-map.json` ONCE (when `map` is not supplied); never again per query.
 */
export async function buildGraphIndex(repositoryRoot: string, map?: StaticContextMap): Promise<string | null> {
  const resolved = map ?? (await readContextMap(repositoryRoot));
  if (!resolved) return null;
  // Degrade gracefully if a partial/older map lacks a call graph rather than throwing.
  const callGraph = resolved.callGraph ?? { nodes: [], edges: [] };

  const dir = path.join(repositoryRoot, MAP_DIR);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, INDEX_FILE);
  const tmp = path.join(dir, `${INDEX_FILE}.tmp`);
  await fs.rm(tmp, { force: true });

  const DatabaseSync = await loadSqlite();
  const db = new DatabaseSync(tmp);
  try {
    db.exec(SCHEMA_SQL);
    db.exec("BEGIN");
    const insMeta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    insMeta.run("indexSchemaVersion", String(GRAPH_INDEX_SCHEMA_VERSION));
    insMeta.run("mapHash", resolved.meta.mapHash);

    const insNode = db.prepare("INSERT OR REPLACE INTO nodes(id, symbol, path, kind, confidence) VALUES (?, ?, ?, ?, ?)");
    for (const n of callGraph.nodes as CallGraphNode[]) {
      insNode.run(n.id, n.symbol, n.path, n.kind, n.confidence);
    }
    const insEdge = db.prepare("INSERT INTO edges(from_id, to_id, call_kind, confidence, evidence) VALUES (?, ?, ?, ?, ?)");
    for (const e of callGraph.edges as CallEdge[]) {
      insEdge.run(e.from, e.to, e.callKind, e.confidence, JSON.stringify(e.evidence ?? []));
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }

  await fs.rm(target, { force: true });
  await fs.rename(tmp, target);
  return target;
}

// ---- Staleness check ------------------------------------------------------

async function readIndexMeta(target: string): Promise<{ mapHash: string; indexSchemaVersion: number } | null> {
  try {
    await fs.access(target);
  } catch {
    return null;
  }
  const DatabaseSync = await loadSqlite();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    const rows = db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>;
    const meta = new Map(rows.map((r) => [r.key, r.value]));
    const mapHash = meta.get("mapHash");
    const indexSchemaVersion = Number(meta.get("indexSchemaVersion"));
    if (mapHash === undefined || Number.isNaN(indexSchemaVersion)) return null;
    return { mapHash, indexSchemaVersion };
  } catch {
    return null; // missing/corrupt → force a rebuild
  } finally {
    db?.close();
  }
}

/**
 * True when the index is missing, schema-stale, or built from a different `mapHash`.
 * `expectedSchemaVersion` defaults to the current `GRAPH_INDEX_SCHEMA_VERSION`; it is a
 * parameter only so the schema-bump branch is testable without rebuilding the module.
 */
export async function indexNeedsRebuild(
  target: string,
  currentMapHash: string,
  expectedSchemaVersion: number = GRAPH_INDEX_SCHEMA_VERSION
): Promise<boolean> {
  const meta = await readIndexMeta(target);
  if (!meta) return true;
  return meta.indexSchemaVersion !== expectedSchemaVersion || meta.mapHash !== currentMapHash;
}

// ---- Query engine ---------------------------------------------------------

/**
 * Indexed, read-only view of the call graph. Implements `NeighborSource`, so the
 * path-finding algorithms run directly over it. `findCallers`/`findCallees` are single
 * indexed lookups (not scans). SCC condensation is built ONCE per snapshot and cached
 * (`sccBuildCount` proves it). Holds NO reference to the JSON map — queries cannot scan it.
 */
export class GraphIndex implements GraphSource {
  private readonly db: DatabaseSync;
  private readonly calleeStmt: ReturnType<DatabaseSync["prepare"]>;
  private readonly callerStmt: ReturnType<DatabaseSync["prepare"]>;
  private readonly hasNodeStmt: ReturnType<DatabaseSync["prepare"]>;
  private readonly nodeByIdStmt: ReturnType<DatabaseSync["prepare"]>;
  private readonly nodesBySymbolStmt: ReturnType<DatabaseSync["prepare"]>;
  private readonly nodesByPathStmt: ReturnType<DatabaseSync["prepare"]>;
  private readonly allNodesStmt: ReturnType<DatabaseSync["prepare"]>;
  /** Total SQLite statements executed for neighbor lookups (== pathfinding neighborQueryCount). */
  sqliteQueryCount = 0;
  /** Times the SCC condensation was built — must stay 1 across many queries on one snapshot. */
  sccBuildCount = 0;
  readonly builtFromMapHash: string;
  private scc: SccResult | null = null;

  constructor(db: DatabaseSync, builtFromMapHash: string) {
    this.db = db;
    this.builtFromMapHash = builtFromMapHash;
    // ORDER BY rowid returns rows in insertion order, matching `inMemoryGraphSource` so the two
    // substrates are byte-for-byte interchangeable in traversal order (Decision 0024).
    this.calleeStmt = db.prepare("SELECT from_id, to_id, call_kind, confidence, evidence FROM edges WHERE from_id = ? ORDER BY rowid");
    this.callerStmt = db.prepare("SELECT from_id, to_id, call_kind, confidence, evidence FROM edges WHERE to_id = ? ORDER BY rowid");
    this.hasNodeStmt = db.prepare("SELECT 1 FROM nodes WHERE id = ? LIMIT 1");
    this.nodeByIdStmt = db.prepare("SELECT id, symbol, path, kind, confidence FROM nodes WHERE id = ?");
    this.nodesBySymbolStmt = db.prepare("SELECT id, symbol, path, kind, confidence FROM nodes WHERE symbol = ? ORDER BY rowid"); // indexed on nodes_symbol
    this.nodesByPathStmt = db.prepare("SELECT id, symbol, path, kind, confidence FROM nodes WHERE path = ? ORDER BY rowid"); // indexed on nodes_path
    this.allNodesStmt = db.prepare("SELECT id, symbol, path, kind, confidence FROM nodes ORDER BY rowid");
  }

  /** Node metadata by id (one indexed lookup on the `nodes` primary key). */
  getNode(id: string): CallGraphNode | undefined {
    this.sqliteQueryCount++;
    const row = this.nodeByIdStmt.get(id) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  /** Nodes whose symbol matches (one indexed lookup on `nodes_symbol`, not a scan). */
  findNodesBySymbol(symbol: string): CallGraphNode[] {
    this.sqliteQueryCount++;
    return (this.nodesBySymbolStmt.all(symbol) as unknown as NodeRow[]).map(rowToNode);
  }

  /** Nodes whose path matches (one indexed lookup on `nodes_path`, not a scan). */
  findNodesByPath(path: string): CallGraphNode[] {
    this.sqliteQueryCount++;
    return (this.nodesByPathStmt.all(path) as unknown as NodeRow[]).map(rowToNode);
  }

  /** Every node — only for the substring-match fallback in subject resolution (a full scan). */
  allNodes(): CallGraphNode[] {
    this.sqliteQueryCount++;
    return (this.allNodesStmt.all() as unknown as NodeRow[]).map(rowToNode);
  }

  /** Outgoing edges (one indexed lookup on `edges_from`). */
  callees(id: string): CallEdge[] {
    this.sqliteQueryCount++;
    return (this.calleeStmt.all(id) as unknown as EdgeRow[]).map(rowToEdge);
  }

  /** Incoming edges (one indexed lookup on `edges_to`). */
  callers(id: string): CallEdge[] {
    this.sqliteQueryCount++;
    return (this.callerStmt.all(id) as unknown as EdgeRow[]).map(rowToEdge);
  }

  /** CAP-style alias: direct callees of a symbol. */
  findCallees(id: string): CallEdge[] {
    return this.callees(id);
  }

  /** CAP-style alias: direct callers of a symbol. */
  findCallers(id: string): CallEdge[] {
    return this.callers(id);
  }

  /** Whether a node exists in the index. */
  hasNode(id: string): boolean {
    this.sqliteQueryCount++;
    return (this.hasNodeStmt.get(id) as unknown) !== undefined;
  }

  private allNodeIds(): string[] {
    return (this.db.prepare("SELECT id FROM nodes").all() as Array<{ id: string }>).map((r) => r.id);
  }

  private allEdges(): CallEdge[] {
    return (this.db.prepare("SELECT from_id, to_id, call_kind, confidence, evidence FROM edges").all() as unknown as EdgeRow[]).map(rowToEdge);
  }

  /** SCC condensation, built once per snapshot then cached (full edge scan only here). */
  getScc(): SccResult {
    if (!this.scc) {
      this.scc = tarjanScc(this.allNodeIds(), this.allEdges());
      this.sccBuildCount++;
    }
    return this.scc;
  }

  /**
   * Static structural co-membership: true when `a` and `b` are in the same strongly-connected
   * component of the STATIC call graph. This is a necessary, NOT sufficient, condition for
   * runtime reachability — never runtime-proven (Decisions 0001/0002).
   */
  sameComponent(a: string, b: string): boolean {
    const scc = this.getScc();
    return scc.componentOf.has(a) && scc.componentOf.has(b) && scc.componentOf.get(a) === scc.componentOf.get(b);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open the graph index for `repositoryRoot`, rebuilding it first if missing/stale (Decision
 * 0023). Returns null when no map is initialized. Reads `context-map.json` ONCE to obtain the
 * current `mapHash`; thereafter all queries hit SQLite only.
 */
export async function openGraphIndex(repositoryRoot: string, map?: StaticContextMap): Promise<GraphIndex | null> {
  const resolved = map ?? (await readContextMap(repositoryRoot));
  if (!resolved) return null;
  const target = getGraphIndexPath(repositoryRoot);
  if (await indexNeedsRebuild(target, resolved.meta.mapHash)) {
    await buildGraphIndex(repositoryRoot, resolved);
  }
  const DatabaseSync = await loadSqlite();
  const db = new DatabaseSync(target, { readOnly: true });
  return new GraphIndex(db, resolved.meta.mapHash);
}

// ---- Unified traversal substrate (Decision 0024) --------------------------

export interface GraphContext {
  map: StaticContextMap;
  /** The one traversal substrate: SQLite-backed `GraphIndex` or the in-memory fallback. */
  source: GraphSource;
}

/** Edge count at/above which opening the SQLite index is worth it (Decision 0024 — tunable heuristic). */
export const GRAPH_INDEX_MIN_EDGES = 2000;

/**
 * Load the persisted map ONCE and return it with a `GraphSource` for all traversal (Decision 0024).
 * Picks the SQLite-backed `GraphIndex` when the graph is large enough AND `node:sqlite` opens cleanly;
 * otherwise the always-available in-memory source built from the JSON map. **SQLite is optional** —
 * any open/build failure falls back, so analysis never hard-requires Node ≥ 22.5. The caller MUST call
 * `ctx.source.close()` when done (a no-op for the in-memory source; releases the DB handle for the index).
 */
export async function loadGraphContext(repositoryRoot: string, opts?: { minIndexEdges?: number }): Promise<GraphContext | null> {
  const map = await readContextMap(repositoryRoot);
  if (!map) return null;
  const callGraph = map.callGraph ?? { nodes: [], edges: [] };
  const minEdges = opts?.minIndexEdges ?? GRAPH_INDEX_MIN_EDGES;
  if (callGraph.edges.length >= minEdges) {
    try {
      const index = await openGraphIndex(repositoryRoot, map);
      if (index) return { map, source: index };
    } catch {
      // node:sqlite unavailable or a DB error — fall through to the in-memory source.
    }
  }
  return { map, source: inMemoryGraphSource(callGraph.nodes, callGraph.edges) };
}

export { getMapPath };
