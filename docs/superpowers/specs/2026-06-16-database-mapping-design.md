# Database Mapping — Design Spec

_Date: 2026-06-16 · Status: design ratified, pre-implementation · Topic: extend the static context map into the data layer_

## 1. Summary

Add database mapping to the Code Cartographer MCP, built **the same way the app maps code**: a
static, codebase-only, confidence-graded map produced by a pluggable provider, traversable through
the one `GraphSource` substrate. The result is a **unified graph** where code nodes (functions/files)
connect through to **table/column nodes**, so two bidirectional "killer queries" fall out of the
path-finding the app already has:

- **Forward — "what tables does X touch":** given an endpoint/function/module, the tables+columns it
  reads/writes, directly and transitively through the call graph.
- **Reverse — "what code touches table X":** given a table/column, every function/file that reads,
  writes, or DDLs it.

The schema map is **100% codebase-only** (parsed from checked-in DDL/migrations/ORM/DSL — never the
live catalog). An optional, walled-off **live drift oracle** can grade those repo-derived claims
against a test instance, but it never writes into the persisted map.

## 2. Goals & non-goals

**Goals**
- A standalone schema map (tables, columns, FKs, indexes, views) parsed from the repo.
- Code→table edges that extend the call graph into the data layer, confidence-graded.
- Both killer queries, reusing existing path-finding (no new traversal algorithm).
- DB findings (statically-unreferenced tables/columns, dangling code→table refs, orphan FK targets).
- An opt-in live drift oracle that grades repo claims without violating codebase-only.

**Non-goals**
- Never execute the target app, run its tests, or treat the persisted map as runtime truth.
- No `confirmed`-grade DB records (see §5). No claim that a table is "dead".
- Stage 1 excludes migration replay, ORM-model schemas, Prisma/Drizzle DSL, view-body column
  lineage, triggers, stored procedures, RLS, partitions (later stages / out of scope).

## 3. Chosen approach (B — parallel schema section, federated into the one GraphSource)

Considered three integrations:

- **A — Overload the call graph** (`kind: "table"` on `CallGraphNode`, data edges as `CallEdge`s).
  Maximal reuse but pollutes the call-graph node set and can't carry rich schema attributes. Rejected:
  cheap now, leaky later.
- **B — Parallel schema section, federated GraphSource (chosen).** A behavior-free `dbSchema` section
  plus a `dataEdges` set; the `GraphSource` federates code + table nodes so path-finding crosses the
  boundary, while tables keep their own rich shape and the code call graph stays pure.
- **C — Fully separate DB map + own tools, joined by symbol-id at query time.** Lowest blast radius
  but turns the transitive forward query into a worse hand-rolled two-graph join; violates ADR 0024's
  single-substrate principle. Rejected.

**B** is the only option that delivers the bidirectional queries for free via existing path-finding
while keeping the code graph clean and giving schema objects real structure.

## 4. Component & data model

### 4.1 Shared vocabulary (`src/schema.ts`, behavior-free)

```
DbTable      { id, name, schema?, sourceFile, sourceKind, confidence, reason }
DbColumn     { id, tableId, name, dataType?, nullable?, isPrimaryKey?, sourceFile, confidence }
DbForeignKey { id, fromTableId, fromColumns[], toTableId, toColumns[], confidence, reason }
DbIndex      { id, tableId, columns[], unique?, confidence }
DbSchema     { tables[], columns[], foreignKeys[], indexes[], views[] }
DataEdge     { fromSymbolId, toTableId, toColumnIds?, access: "read"|"write"|"ddl",
               confidence, reason, evidence }
```

`StaticContextMap` gains two **optional** sections: `dbSchema?: DbSchema` and `dataEdges?: DataEdge[]`.
Optional ⇒ repos with no DB content serialize identically (no map-invalidation churn) and all 20
existing tools are untouched.

### 4.2 `DBProvider` (`src/providers/sql.ts`)

Implements the same `LanguageProvider`-style contract, emitting DB extraction. Two codebase-only jobs:

1. **Schema extraction** — parse `.sql` DDL via a tree-sitter SQL WASM grammar (existing tier) into
   `DbTable`/`DbColumn`/`DbForeignKey`/`DbIndex`/views. Parsed DDL ceiling: `likely` (never `confirmed`).
2. **Data-edge extraction** — scan code (stage 1: TS/JS + Python Postgres clients) for SQL string
   literals, parse `FROM`/`JOIN`/`INSERT INTO`/`UPDATE`/`DELETE`/`CREATE` targets, classify access,
   emit `DataEdge`s from the enclosing function symbol to the table node.

### 4.3 Federation seam (`src/graphIndex.ts` + `src/pathfinding.ts`)

The `GraphSource` is extended so a table id is a valid node and `DataEdge`s are valid neighbors:
`neighbors(symbolId)` may return table nodes; `neighbors(tableId)` returns the code symbols that touch
it (reverse); FK edges connect table→table. The existing bidirectional-BFS / `find_callers` /
`find_path` then traverse code↔data with **no new traversal algorithm** — the payoff of approach B.
SQLite index gains two tables (`db_node`, `data_edge`) stamped with the same `mapHash`; the in-memory
fallback federates identically.

### 4.4 Engine (`src/contextMap.ts`)

`buildContextMap` runs the `DBProvider` alongside the language providers, folds its output into the
map, and includes DB content in `mapHash` so a DDL change correctly flips staleness.

## 5. Confidence & boundary model (honesty contract)

Same vocabulary, no new grades in the persisted map:

| Record | Ceiling | Rationale |
|---|---|---|
| DDL-parsed table/column/FK/index | `likely` | The file says so, but it's static text, not the live catalog. Never `confirmed`. |
| Code→table edge, literal SQL with clear `FROM`/`INSERT INTO` | `likely` | Parsed from a string literal; table name unambiguous. |
| Code→table edge, dynamic SQL (concat/builder/interpolated) | `candidate` | Query site visible, target not fully resolvable. |
| Code reference to a table absent from DDL | `unresolved#name` | Mirrors call-graph convention: typo, missing migration, or external schema. |
| Access direction (read/write/ddl) | inherits edge grade | From the SQL verb; verb not statically visible → `unclear`. |

**Boundary invariants (extend existing `BND-01/02`, `POL-03`):**
- Persisted `dbSchema`/`dataEdges` are static inferences from checked-in files only — never the live
  catalog. `meta.codebaseOnlyBoundary` stays `true`.
- DB reachability graded like code reachability: "table appears unreferenced by static code" is a
  `candidate` finding, **never** "this table is dead" (dynamic SQL, ORMs, external consumers,
  reflection defeat static visibility — caveat ships in `reason`).
- No DB record is ever `confirmed`. The live oracle (§7) is the only path to higher certainty, in a
  separate report-only lane that never writes the map.

**DB findings** (into `src/findings.ts`, all ≤ `candidate`, capped, uncertainty-carrying):
- Statically-unreferenced table/column (DDL-defined, no `DataEdge`).
- Dangling code→table reference (code queries a table with no DDL definition → `unresolved#name`).
- Orphan FK target (FK references a table not in the parsed DDL).

## 6. Tool surface

Per ADR 0025, each tool is one declarative row in `src/tools.ts`; MCP + CLI auto-derived. Stage 1
adds **4 tools** (20 → 24), each a thin adapter over the federated `GraphSource`:

| Tool | CLI | Answers | Built on |
|---|---|---|---|
| `map_database` | `db-map` | The schema map: tables/columns/FKs/indexes/views + DB findings, graded. | `dbSchema` |
| `find_table_usage` | `table-usage` | **Reverse:** given a table/`table.column`, every function/file reading/writing/DDLing it. | federated `find_callers` over `dataEdges` |
| `find_data_footprint` | `data-footprint` | **Forward:** given an endpoint/function/module, tables+columns touched directly and transitively. | federated forward reachability |
| `analyze_schema_drift` | `schema-drift` | Stage-1: DB findings report; later absorbs the oracle (§7) + migration-diff. | `findings` (+ later oracle) |

Each gets one `src/output.ts` formatter (human/llm/dual), honoring ADR 0034 S1 token-bounding
(`cappedSample`/`cappedSection`/`digestNote`, sample cap 8, true totals + boundary always preserved).

**Reuse over new surface:** no DB-specific path/visualize tools. The existing `find_path` works
code↔table once federated; `visualize_architecture` later gains a schema/ER lens rather than a new
tool. Four tools is the minimum delivering both killer queries plus the schema view.

## 7. Live drift oracle (separate, opt-in, walled off)

The only piece touching anything outside the repo. Quarantined; ships as its own stage (DB-4).

**Shape — comparator, not source.** Modeled on `analyze_diff`: takes the persisted codebase-only
`dbSchema` (the claims) + a read-only connection to a **test** instance, reads `information_schema`
once, emits a **drift report** — writing nothing into `context-map.json`.

**Hard walls:**
- **Opt-in, never default.** Connection string supplied per-invocation (env/CLI flag); no connection
  attempted otherwise. Absent config ⇒ findings-only mode, stated.
- **Read-only + catalog-only.** Only `information_schema`/`pg_catalog` reads — no app tables, no data
  rows, no DDL, no execution of repo code. It is a *schema oracle*.
- **Separate confidence lane.** Oracle results labeled `observed` in the **report only** — a word
  absent from the persisted map; never upgrades a map record.
- **Ephemeral report.** Output is a capped, graded drift document (added/removed/changed
  tables & columns, type mismatches, FKs live-vs-DDL). Not persisted as a map artifact.

**Framing:** "Repo DDL says `users.email` is `text NOT NULL`; live test catalog observed
`varchar(255) NULL`." Repo stays the source of claims; live DB is external evidence grading them.

**Gating prerequisite: a CAS ADR.** Connecting to anything extends `BND-01/BND-02`, even quarantined.
The ADR records: comparison-only, opt-in, catalog-read-only, never persisted, `observed` lane
report-scoped. Per the ADR-first workflow it lands in the CAS source-of-truth repo before DB-4 code.

## 8. Staging roadmap

| Stage | Content | Gates on |
|---|---|---|
| **DB-1** | Schema vocab in `schema.ts`, `DBProvider` (SQL DDL parse), `dbSchema` section, persistence + `mapHash`, `map_database`. Schema map only — no edges. | — |
| **DB-2** | `DataEdge` extraction (TS/JS + Python Postgres clients), GraphSource federation, `find_table_usage` + `find_data_footprint`, DB findings. **Unified-graph payoff lands here.** | DB-1 |
| **DB-3** | `analyze_schema_drift` findings-mode; extend `find_path`/`visualize_architecture` with schema lens. | DB-2 |
| **DB-4** | Live drift oracle. **Gated on the CAS ADR (§7).** | DB-3 + ADR |
| **DB-5+** | Additional sources: migration replay, ORM-in-code, Prisma/Drizzle DSL — each a provider increment behind the stable `DbSchema` shape. | DB-1 |

DB-1 + DB-2 are the MVP proving the thesis; everything after is additive behind stable types.

## 9. Error handling (extends ADR 0034 S1 never-throw)

- Unparseable/dialect-exotic DDL → disclosed non-analyzable record with `analysisReason`, never aborts
  the build (mirrors `hashFile`).
- Partial parse (one bad `CREATE TABLE` in a good file) → emit what parsed, rest `unresolved`.
- SQL string tree-sitter-SQL can't parse → **no false edge**; emit an `unclear`/`unresolved` data-edge
  site so the query is disclosed, not silently dropped.
- Oracle connection failure/timeout → fire-and-forget degrade to findings-only with stated reason;
  never blocks or throws.

## 10. Testing & eval (ADR 0028 eval-first — mandatory)

- New `eval/fixtures/` constructs: a Postgres DDL fixture (tables, FKs, a deliberately-unreferenced
  column) + TS and Python query sites, with **golden entries** asserting required edges and
  **forbidden** over-resolution (a dynamic-SQL site must NOT produce a false `likely` edge).
- Structural **bench baselines** (`eval/baselines.json`) for the fixture's table/edge/finding counts —
  deterministic, gated hard.
- A `provider-over-resolution-reviewer` pass is the explicit acceptance gate for DB-2 (the false-edge
  failure class the C++ tier hit 16×).
- Vitest: DDL parser, the federation seam (code↔table neighbor queries both directions), and the
  never-throw corpus extended with malformed SQL.

## 11. Open items / prerequisites

- **CAS ADR for the live oracle** (§7) — gates DB-4 only; DB-1..DB-3 do not need it.
- **CAS ADR(s) for the DB provider tier** — per the ADR-first workflow, the `dbSchema` data model and
  the `DBProvider` tier should be ratified in the CAS source-of-truth repo before DB-1 implementation,
  alongside the eval-first fixture requirement.
- Tree-sitter SQL grammar selection/pin (Postgres dialect coverage) — confirm in DB-1 planning.
