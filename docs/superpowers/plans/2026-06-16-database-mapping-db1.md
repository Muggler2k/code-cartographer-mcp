# Database Mapping — DB-1 (Schema Map) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first slice of database mapping — a static, codebase-only **schema map** (tables, columns, foreign keys, indexes, views) parsed from Postgres `.sql` DDL in the repo, persisted into `context-map.json` as an optional `dbSchema` section, and surfaced by a new `map_database` tool. No code→table edges yet (that is DB-2).

**Architecture:** Approach B from the spec (`docs/superpowers/specs/2026-06-16-database-mapping-design.md`): a behavior-free `DbSchema` vocabulary in `schema.ts`, a dedicated `src/providers/sql.ts` parser that turns DDL into confidence-graded schema records (ceiling `likely`, never `confirmed`), an engine pass in `contextMap.ts` that folds the result into the map, and one new declarative tool row + formatter. The DB layer is **codebase-only**: it parses checked-in DDL, never connects to a database.

**Tech Stack:** TypeScript (strict, NodeNext ESM — `.js` import extensions), `pgsql-ast-parser@12.0.2` (pure-JS Postgres parser, MIT, new runtime dependency), Vitest. Confidence vocabulary (`clampConfidence`) is load-bearing.

**Key corrections to the spec, locked in here:**
1. **`dbSchema` is EXCLUDED from `mapHash`.** Spec §4.4 said "include DB content in mapHash." That is wrong for this codebase: `mapHash` is file-identity-only (Decision 0011), and a `.sql` edit already flips it via that file's `sha256`. `dbSchema` is *derived*, so it joins `callGraph`/`findings` as map content excluded from the hash. Staleness on DDL edits is automatic.
2. **The DB provider is NOT a `LanguageProvider`.** `ProviderExtraction` is a fixed 4-field shape (`declarations`/`ownershipSignals`/`entryPointHints`/`callEdges`). The DB provider emits a different shape, so it gets its own type and its own engine pass — the language-provider registry is untouched.
3. **DB-1 adds ONE tool** (`map_database`): tool count 20 → 21. The other three DB tools land in DB-2/DB-3.

---

## File Structure

- **Create** `src/providers/sql.ts` — the SQL DDL parser + per-repo `extractDbSchema` merge/resolve. Imports only from `schema.js` (no engine import → no cycle). One responsibility: DDL text → `DbSchema`.
- **Modify** `src/schema.ts` — add the `DbSchema` vocabulary + the optional `dbSchema?` field on `StaticContextMap`.
- **Modify** `src/contextMap.ts` — `clampDbSchema` safety-net + run the DB pass in `buildContextMapFromResolution` and fold the result in.
- **Modify** `src/output.ts` — `formatDatabaseMap` (token-bounded digest, cap 8).
- **Modify** `src/tools.ts` — one `map_database` row.
- **Modify** `test/*` — new `test/sqlProvider.test.ts`, plus additions to `test/contextMap.test.ts`, `test/output.test.ts`, `test/tools.test.ts`, `test/robustness.test.ts`.
- **Create** `eval/fixtures/db-postgres-ddl/` + golden + `eval/baselines.json` entry.
- **Create** `../debug_mcp_context_manager/context/07_decisions/0036-database-provider-tier-and-schema-map.md` — the CAS ADR.
- **Modify** docs: `CLAUDE.md`, `docs/architecture.md`, `docs/tools-reference.md`, `docs/STATUS.md`, and the memory store.

---

## Task 1: Author CAS ADR 0036 (decision-first; no code)

Per the ADR-first workflow, the data model + provider tier are ratified in the CAS source-of-truth repo before code lands. The live-oracle decision is **deferred** (it gates DB-4 only).

**Files:**
- Read first: `../debug_mcp_context_manager/context/07_decisions/0035-cpp-provider-tier.md` (copy its exact heading structure/status block).
- Create: `../debug_mcp_context_manager/context/07_decisions/0036-database-provider-tier-and-schema-map.md`

- [ ] **Step 1: Read 0035 for the ADR template**

Run: open `0035-cpp-provider-tier.md` and note its section order (title, status, context, decision, consequences, etc.).

- [ ] **Step 2: Write ADR 0036** mirroring that structure, with this decision content:

- **Status:** Accepted.
- **Context:** The map covers code only; extend it into the data layer the same way (static, codebase-only, confidence-graded). Spec: `code-cartographer-mcp/docs/superpowers/specs/2026-06-16-database-mapping-design.md`.
- **Decision:**
  - Add a `DbSchema` vocabulary (`DbTable`/`DbColumn`/`DbForeignKey`/`DbIndex`/`DbView`) to the shared schema, and an **optional** `dbSchema` section on `StaticContextMap` (additive; schema stays v1; **excluded from `mapHash`** like `callGraph`/`findings`).
  - Add a **DB provider tier** distinct from `LanguageProvider`: it parses DDL (DB-1: Postgres `.sql` via `pgsql-ast-parser`) into schema records with a **`likely` ceiling — never `confirmed`** (static text is not the live catalog; a migration may not have run). FK targets absent from the parsed DDL degrade to `unresolved#name` (mirrors the call-graph convention).
  - DB reachability/"unused" is graded exactly like code reachability: a statically-unreferenced table is at most a `candidate` finding, never "dead".
  - **Eval-first (ADR 0028) applies unchanged:** the new DB provider claims must land with a fixture construct + golden entries (required and forbidden) and a structural bench baseline. No separate eval ADR — this clause states the applicability.
  - **Deferred:** the live drift oracle (connecting to a test instance) is a separate decision (future ADR 0037), gating DB-4 only. DB-1–DB-3 never connect to anything.
- **Consequences:** New runtime dependency `pgsql-ast-parser`; one new tool per DB stage; the codebase-only boundary is preserved because the persisted map is parsed from files only.

- [ ] **Step 3: Commit in the CAS repo**

```bash
cd ../debug_mcp_context_manager
git add context/07_decisions/0036-database-provider-tier-and-schema-map.md
git commit -m "ADR 0036: database provider tier + dbSchema data model (codebase-only, likely ceiling); live oracle deferred"
cd ../code-cartographer-mcp
```

---

## Task 2: `DbSchema` vocabulary in `schema.ts`

**Files:**
- Modify: `src/schema.ts` (add a new section before the persisted-map section, and one field on `StaticContextMap`)
- Test: `test/contextMap.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/contextMap.test.ts` (top-level `describe` or a new one):

```ts
import type { DbSchema, StaticContextMap } from "../src/schema.js";

describe("DbSchema vocabulary (ADR 0036)", () => {
  it("composes a schema fragment with confidence-graded records", () => {
    const schema: DbSchema = {
      tables: [{ id: "public.users", name: "users", sourceFile: "db/schema.sql", sourceKind: "sql_ddl", confidence: "likely", reason: "CREATE TABLE users" }],
      columns: [{ id: "public.users.email", tableId: "public.users", name: "email", dataType: "text", nullable: false, isPrimaryKey: undefined, sourceFile: "db/schema.sql", confidence: "likely" }],
      foreignKeys: [],
      indexes: [],
      views: []
    };
    expect(schema.tables[0].confidence).toBe("likely");
    // dbSchema is an OPTIONAL section on the map
    const map = {} as StaticContextMap;
    expect(map.dbSchema).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/contextMap.test.ts -t "DbSchema vocabulary"`
Expected: FAIL — `Cannot find ... DbSchema` / type errors (the types don't exist yet).

- [ ] **Step 3: Add the vocabulary to `src/schema.ts`**

Insert immediately before the `// ---- The persisted map (Decision 0008, schema v1) ----` comment:

```ts
// ---- Database schema vocabulary (ADR 0036) — behavior-free, codebase-only ----
// Parsed STATICALLY from checked-in DDL/migrations/ORM, never the live catalog. The DB
// provider tier (src/providers/sql.ts) emits these with a `likely` ceiling — never
// `confirmed`: static text is not runtime truth. `dbSchema` is DERIVED, so (like
// callGraph/findings) it is EXCLUDED from `mapHash`; a `.sql` edit already flips staleness
// via that file's content hash.

/** How a schema object was discovered. DB-1 ships only "sql_ddl"; later stages add more. */
export type DbSourceKind = "sql_ddl" | "migration" | "orm_model" | "schema_dsl";

export interface DbTable {
  /** Stable id: `${schema ?? "public"}.${name}`. */
  id: string;
  name: string;
  /** SQL schema/namespace (e.g. "public"); absent when the DDL gave none. */
  schema?: string;
  sourceFile: string;
  sourceKind: DbSourceKind;
  confidence: Confidence;
  reason: string;
}

export interface DbColumn {
  /** Stable id: `${tableId}.${name}`. */
  id: string;
  tableId: string;
  name: string;
  /** Verbatim declared type, lowercased; absent when unresolved. */
  dataType?: string;
  /** False for NOT NULL / PRIMARY KEY columns; undefined when unknown. */
  nullable?: boolean;
  isPrimaryKey?: boolean;
  sourceFile: string;
  confidence: Confidence;
}

export interface DbForeignKey {
  /** Stable id: `${fromTableId}(${fromColumns})->${toTableId}`. */
  id: string;
  fromTableId: string;
  fromColumns: string[];
  /** Target table id, or `unresolved#name` when absent from the parsed DDL. */
  toTableId: string;
  toColumns: string[];
  confidence: Confidence;
  reason: string;
}

export interface DbIndex {
  /** Stable id: `${tableId}#idx:${columns.join("+")}`. */
  id: string;
  tableId: string;
  columns: string[];
  unique?: boolean;
  confidence: Confidence;
}

export interface DbView {
  /** Stable id: `${schema ?? "public"}.${name}`. */
  id: string;
  name: string;
  schema?: string;
  /** Best-effort referenced table ids (or `unresolved#name`); may be empty in DB-1. */
  referencedTables: string[];
  sourceFile: string;
  confidence: Confidence;
}

export interface DbSchema {
  tables: DbTable[];
  columns: DbColumn[];
  foreignKeys: DbForeignKey[];
  indexes: DbIndex[];
  views: DbView[];
}
```

Then add the optional field to `StaticContextMap`, immediately after the `callGraph: { ... };` block and before `findings:`:

```ts
  /**
   * Database schema map (ADR 0036): provider-parsed tables/columns/FKs/indexes/views from
   * checked-in DDL. OPTIONAL + additive — repos with no DB content serialize identically.
   * DERIVED, so EXCLUDED from `mapHash` (Decision 0011 — only file identity moves the hash).
   * Codebase-only: parsed from files, never the live catalog.
   */
  dbSchema?: DbSchema;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/contextMap.test.ts -t "DbSchema vocabulary"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts test/contextMap.test.ts
git commit -m "feat(db): DbSchema vocabulary + optional dbSchema map section (ADR 0036)"
```

---

## Task 3: SQL DDL parser — tables, columns, foreign keys

**Files:**
- Create: `src/providers/sql.ts`
- Test: `test/sqlProvider.test.ts`
- Modify: `package.json` (add the dependency)

- [ ] **Step 1: Add the dependency**

Run: `npm install pgsql-ast-parser@12.0.2`
Expected: `package.json` gains `"pgsql-ast-parser": "12.0.2"` under `dependencies` (pin exact, like the other runtime deps).

- [ ] **Step 2: Write the failing test**

Create `test/sqlProvider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSqlDdl } from "../src/providers/sql.js";

describe("parseSqlDdl — tables, columns, FKs (ADR 0036)", () => {
  const sql = `
    CREATE TABLE users (
      id integer PRIMARY KEY,
      email text NOT NULL
    );
    CREATE TABLE orders (
      id integer PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id),
      total numeric
    );
  `;

  it("extracts tables with a likely ceiling, never confirmed", () => {
    const schema = parseSqlDdl(sql, "db/schema.sql");
    const names = schema.tables.map((t) => t.name).sort();
    expect(names).toEqual(["orders", "users"]);
    expect(schema.tables.every((t) => t.confidence === "likely")).toBe(true);
    expect(schema.tables.some((t) => t.confidence === "confirmed")).toBe(false);
  });

  it("extracts columns with types, NOT NULL, and primary keys", () => {
    const schema = parseSqlDdl(sql, "db/schema.sql");
    const email = schema.columns.find((c) => c.id === "public.users.email");
    expect(email?.dataType).toBe("text");
    expect(email?.nullable).toBe(false);
    const pk = schema.columns.find((c) => c.id === "public.users.id");
    expect(pk?.isPrimaryKey).toBe(true);
  });

  it("extracts a column-level foreign key", () => {
    const schema = parseSqlDdl(sql, "db/schema.sql");
    const fk = schema.foreignKeys.find((f) => f.fromTableId === "public.orders");
    expect(fk?.fromColumns).toEqual(["user_id"]);
    expect(fk?.toTableId).toBe("public.users");
    expect(fk?.confidence).toBe("likely");
  });

  it("never throws on malformed DDL — returns an empty fragment", () => {
    const schema = parseSqlDdl("CREATE TABLE (((( totally broken", "bad.sql");
    expect(schema.tables).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/sqlProvider.test.ts`
Expected: FAIL — `Cannot find module ../src/providers/sql.js`.

- [ ] **Step 4: Implement `src/providers/sql.ts`**

> **Note on the AST shape:** `pgsql-ast-parser` v12 names fields like `name.name`, `columns[].kind === "column"`, column `constraints[].type` (`"not null"`, `"primary key"`, `"reference"`), and table constraints `type === "foreign key"`. The tests pin the resulting `DbSchema`, not the AST — if a field name differs in the installed build, the failing test tells you exactly which accessor to adjust. Keep all access defensive (`?.` + `?? []`).

```ts
// Database provider tier (ADR 0036) — a SQL DDL parser, NOT a LanguageProvider (the
// ProviderExtraction shape is fixed). Parses checked-in Postgres DDL into confidence-graded
// schema records. Codebase-only: it reads files, never connects to a database. Ceiling is
// `likely` — static DDL is not the live catalog, so it is never `confirmed`. Degrade-never-throw
// (ADR 0034 S1): malformed DDL yields an empty fragment, never an exception.

import { parse, type Statement } from "pgsql-ast-parser";

import {
  clampConfidence,
  type Confidence,
  type DbForeignKey,
  type DbSchema
} from "../schema.js";

/** The DB provider's confidence ceiling (ADR 0036): parsed DDL is `likely`, never `confirmed`. */
const DB_CEILING: Confidence = "likely";

interface QName {
  name: string;
  schema?: string;
}

function tableIdOf(q: QName): string {
  return `${q.schema ?? "public"}.${q.name}`;
}

function dataTypeName(dt: unknown): string | undefined {
  const name = (dt as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name.toLowerCase() : undefined;
}

export function emptyDbSchema(): DbSchema {
  return { tables: [], columns: [], foreignKeys: [], indexes: [], views: [] };
}

export function isEmptyDbSchema(s: DbSchema): boolean {
  return (
    s.tables.length === 0 &&
    s.views.length === 0 &&
    s.foreignKeys.length === 0 &&
    s.indexes.length === 0 &&
    s.columns.length === 0
  );
}

function makeForeignKey(
  fromTableId: string,
  fromColumns: string[],
  foreignTable: QName,
  toColumns: string[],
  sourceFile: string
): DbForeignKey {
  const toTableId = tableIdOf(foreignTable);
  return {
    id: `${fromTableId}(${fromColumns.join("+")})->${toTableId}`,
    fromTableId,
    fromColumns,
    toTableId,
    toColumns,
    confidence: DB_CEILING,
    reason: `FOREIGN KEY (${fromColumns.join(", ")}) REFERENCES ${foreignTable.name} parsed from ${sourceFile}`
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function collectTable(stmt: any, sourceFile: string, out: DbSchema): void {
  const q: QName = { name: stmt.name.name, schema: stmt.name.schema };
  const tid = tableIdOf(q);
  out.tables.push({
    id: tid,
    name: q.name,
    schema: q.schema,
    sourceFile,
    sourceKind: "sql_ddl",
    confidence: DB_CEILING,
    reason: `CREATE TABLE ${q.name} parsed from ${sourceFile}`
  });

  for (const entry of stmt.columns ?? []) {
    if (entry.kind !== "column") {
      // Table-level constraint (PRIMARY KEY (...), FOREIGN KEY (...) REFERENCES ...).
      if (entry.type === "foreign key") {
        out.foreignKeys.push(
          makeForeignKey(
            tid,
            (entry.localColumns ?? []).map((c: any) => c.name),
            { name: entry.foreignTable.name, schema: entry.foreignTable.schema },
            (entry.foreignColumns ?? []).map((c: any) => c.name),
            sourceFile
          )
        );
      } else if (entry.type === "primary key") {
        const pkCols: string[] = (entry.columns ?? []).map((c: any) => c.name);
        for (const col of out.columns) {
          if (col.tableId === tid && pkCols.includes(col.name)) {
            col.isPrimaryKey = true;
            col.nullable = false;
          }
        }
      }
      continue;
    }

    const name: string = entry.name.name;
    const constraints: any[] = entry.constraints ?? [];
    const notNull = constraints.some((c) => c.type === "not null");
    const pk = constraints.some((c) => c.type === "primary key");
    out.columns.push({
      id: `${tid}.${name}`,
      tableId: tid,
      name,
      dataType: dataTypeName(entry.dataType),
      nullable: pk || notNull ? false : undefined,
      isPrimaryKey: pk ? true : undefined,
      sourceFile,
      confidence: DB_CEILING
    });
    for (const c of constraints) {
      if (c.type === "reference") {
        out.foreignKeys.push(
          makeForeignKey(
            tid,
            [name],
            { name: c.foreignTable.name, schema: c.foreignTable.schema },
            (c.foreignColumns ?? []).map((x: any) => x.name),
            sourceFile
          )
        );
      }
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Parse one .sql file's DDL into a schema fragment. Never throws (ADR 0034 S1). */
export function parseSqlDdl(sql: string, sourceFile: string): DbSchema {
  const out = emptyDbSchema();
  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch {
    return out; // malformed file → no false schema, disclosed by absence
  }
  for (const stmt of statements) {
    try {
      if (stmt.type === "create table") {
        collectTable(stmt, sourceFile, out);
      }
    } catch {
      continue; // one bad statement never drops the rest of the file
    }
  }
  return out;
}

/** Re-export so the engine can clamp FK targets to candidate when unresolved. */
export { clampConfidence };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/sqlProvider.test.ts`
Expected: PASS (4 tests). If a column/constraint accessor mismatches the installed AST, adjust the accessor per the failing assertion and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/providers/sql.ts test/sqlProvider.test.ts package.json package-lock.json
git commit -m "feat(db): SQL DDL parser — tables, columns, foreign keys (likely ceiling, never-throw)"
```

---

## Task 4: SQL DDL parser — indexes and views

**Files:**
- Modify: `src/providers/sql.ts`
- Test: `test/sqlProvider.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/sqlProvider.test.ts`:

```ts
describe("parseSqlDdl — indexes and views (ADR 0036)", () => {
  const sql = `
    CREATE TABLE users (id integer PRIMARY KEY, email text);
    CREATE UNIQUE INDEX users_email_idx ON users (email);
    CREATE VIEW active_users AS SELECT id, email FROM users;
  `;

  it("extracts a unique index over its columns", () => {
    const schema = parseSqlDdl(sql, "db/schema.sql");
    const idx = schema.indexes.find((i) => i.tableId === "public.users");
    expect(idx?.columns).toEqual(["email"]);
    expect(idx?.unique).toBe(true);
    expect(idx?.confidence).toBe("likely");
  });

  it("extracts a view by name with a referencedTables array", () => {
    const schema = parseSqlDdl(sql, "db/schema.sql");
    const view = schema.views.find((v) => v.name === "active_users");
    expect(view).toBeDefined();
    expect(Array.isArray(view?.referencedTables)).toBe(true);
  });
});
```

> **Why the view test only asserts the array shape:** DB-1 treats view→table reference extraction as best-effort (spec §2). Pinning exact referenced ids would couple the test to the AST's from-clause node naming; the contract for DB-1 is "the view exists and carries a `referencedTables` array."

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sqlProvider.test.ts -t "indexes and views"`
Expected: FAIL — `indexes`/`views` are empty (no collectors yet).

- [ ] **Step 3: Add the collectors to `src/providers/sql.ts`**

Add `astVisitor` to the import and two collectors, then dispatch them in `parseSqlDdl`:

```ts
import { astVisitor, parse, type Statement } from "pgsql-ast-parser";
```

```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
function collectIndex(stmt: any, _sourceFile: string, out: DbSchema): void {
  const q: QName = { name: stmt.table.name, schema: stmt.table.schema };
  const tid = tableIdOf(q);
  const cols: string[] = (stmt.expressions ?? [])
    .map((e: any) => e?.expression?.name)
    .filter((n: any): n is string => typeof n === "string");
  if (cols.length === 0) return; // expression indexes (non-column) are out of DB-1 scope
  out.indexes.push({
    id: `${tid}#idx:${cols.join("+")}`,
    tableId: tid,
    columns: cols,
    unique: stmt.unique ? true : undefined,
    confidence: DB_CEILING
  });
}

function collectView(stmt: any, sourceFile: string, out: DbSchema): void {
  const q: QName = { name: stmt.name.name, schema: stmt.name.schema };
  const refs = new Set<string>();
  try {
    const visitor = astVisitor(() => ({
      tableRef: (t: any) => {
        if (typeof t?.name === "string") refs.add(tableIdOf({ name: t.name, schema: t.schema }));
      }
    }));
    if (stmt.query) visitor.statement(stmt.query);
  } catch {
    // best-effort; a from-clause we can't walk degrades to no refs, never a throw
  }
  out.views.push({
    id: tableIdOf(q),
    name: q.name,
    schema: q.schema,
    referencedTables: [...refs],
    sourceFile,
    confidence: DB_CEILING
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
```

In `parseSqlDdl`, extend the dispatch inside the `for` loop:

```ts
      if (stmt.type === "create table") {
        collectTable(stmt, sourceFile, out);
      } else if (stmt.type === "create index") {
        collectIndex(stmt, sourceFile, out);
      } else if (stmt.type === "create view") {
        collectView(stmt, sourceFile, out);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sqlProvider.test.ts`
Expected: PASS (all 6 tests). If `tableRef` is not the from-clause node name in the installed build, the view test still passes (referencedTables is an array); leave it best-effort.

- [ ] **Step 5: Commit**

```bash
git add src/providers/sql.ts test/sqlProvider.test.ts
git commit -m "feat(db): SQL DDL parser — indexes + views (best-effort referenced tables)"
```

---

## Task 5: `extractDbSchema` — merge across files + resolve FK targets

**Files:**
- Modify: `src/providers/sql.ts`
- Test: `test/sqlProvider.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/sqlProvider.test.ts`:

```ts
import { extractDbSchema } from "../src/providers/sql.js";
import type { FileEntry } from "../src/schema.js";

function sqlFile(path: string): FileEntry {
  return { path, category: "other", sizeBytes: 1, sha256: "x", hashScope: "content", analyzable: true, analysisReason: "text source", mtimeMs: 0 };
}

describe("extractDbSchema — merge + FK resolution (ADR 0036)", () => {
  it("merges multiple .sql files and resolves cross-file FK targets", async () => {
    const files: Record<string, string> = {
      "db/users.sql": "CREATE TABLE users (id integer PRIMARY KEY);",
      "db/orders.sql": "CREATE TABLE orders (id integer PRIMARY KEY, user_id integer REFERENCES users(id));"
    };
    const schema = await extractDbSchema("/repo", [sqlFile("db/users.sql"), sqlFile("db/orders.sql")], async (p) => files[p]);
    expect(schema.tables.map((t) => t.id).sort()).toEqual(["public.orders", "public.users"]);
    const fk = schema.foreignKeys[0];
    expect(fk.toTableId).toBe("public.users"); // resolved across files
    expect(fk.confidence).toBe("likely");
  });

  it("marks an FK whose target table is absent as unresolved#name and downgrades it", async () => {
    const files: Record<string, string> = {
      "db/orders.sql": "CREATE TABLE orders (id integer PRIMARY KEY, customer_id integer REFERENCES customers(id));"
    };
    const schema = await extractDbSchema("/repo", [sqlFile("db/orders.sql")], async (p) => files[p]);
    const fk = schema.foreignKeys[0];
    expect(fk.toTableId).toBe("unresolved#customers");
    expect(fk.confidence).toBe("candidate");
  });

  it("skips non-.sql and non-analyzable files", async () => {
    const notSql = sqlFile("src/index.ts");
    const binary = { ...sqlFile("db/dump.sql"), analyzable: false };
    const schema = await extractDbSchema("/repo", [notSql, binary], async () => "CREATE TABLE x (id int);");
    expect(schema.tables).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sqlProvider.test.ts -t "merge + FK resolution"`
Expected: FAIL — `extractDbSchema` is not exported.

- [ ] **Step 3: Implement `extractDbSchema` in `src/providers/sql.ts`**

Add the `FileEntry` import and the function:

```ts
import {
  clampConfidence,
  type Confidence,
  type DbForeignKey,
  type DbSchema,
  type FileEntry
} from "../schema.js";
```

```ts
function pushAll<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]); // no spread — V8 arg cap (ADR 0034 S1)
}

/**
 * Parse every analyzable `.sql` file in the repo and merge into one schema. After merging,
 * FK targets not defined by any parsed table become `unresolved#name` and drop to `candidate`
 * (a missing migration / external schema — mirrors the call-graph `unresolved#` convention).
 * Never throws: a file that fails to read or parse is skipped.
 */
export async function extractDbSchema(
  repositoryRoot: string,
  files: FileEntry[],
  readFile: (relPath: string) => Promise<string>
): Promise<DbSchema> {
  const merged = emptyDbSchema();
  for (const file of files) {
    if (!file.analyzable || !file.path.toLowerCase().endsWith(".sql")) continue;
    let text: string;
    try {
      text = await readFile(file.path);
    } catch {
      continue;
    }
    const frag = parseSqlDdl(text, file.path);
    pushAll(merged.tables, frag.tables);
    pushAll(merged.columns, frag.columns);
    pushAll(merged.foreignKeys, frag.foreignKeys);
    pushAll(merged.indexes, frag.indexes);
    pushAll(merged.views, frag.views);
  }

  const tableIds = new Set(merged.tables.map((t) => t.id));
  for (const fk of merged.foreignKeys) {
    if (!tableIds.has(fk.toTableId)) {
      const name = fk.toTableId.includes(".") ? fk.toTableId.slice(fk.toTableId.lastIndexOf(".") + 1) : fk.toTableId;
      fk.toTableId = `unresolved#${name}`;
      fk.confidence = clampConfidence(fk.confidence, "candidate");
      fk.reason += " — target table absent from parsed DDL";
    }
  }

  merged.tables.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  merged.columns.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  merged.foreignKeys.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return merged;
}
```

`repositoryRoot` is unused inside (the caller's `readFile` closes over it) but kept in the signature to match the engine's other extractors and to leave room for path diagnostics. Mark it with a leading underscore if the linter complains: `_repositoryRoot`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sqlProvider.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/sql.ts test/sqlProvider.test.ts
git commit -m "feat(db): extractDbSchema — cross-file merge + unresolved FK target downgrade"
```

---

## Task 6: Engine integration — fold `dbSchema` into the map, excluded from `mapHash`

**Files:**
- Modify: `src/contextMap.ts`
- Test: `test/contextMap.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/contextMap.test.ts`. This test builds a map over a temp repo with a `.sql` file and asserts (a) `dbSchema` is populated, (b) `mapHash` is unaffected by `dbSchema` but flips when the `.sql` content changes.

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContextMap } from "../src/contextMap.js";

describe("engine: dbSchema integration (ADR 0036)", () => {
  async function tmpRepo(sql: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-db-"));
    await fs.mkdir(path.join(dir, "db"), { recursive: true });
    await fs.writeFile(path.join(dir, "db", "schema.sql"), sql);
    return dir;
  }

  it("populates dbSchema from .sql DDL, clamped to likely", async () => {
    const repo = await tmpRepo("CREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL);");
    const map = await buildContextMap(repo);
    expect(map.dbSchema?.tables.map((t) => t.name)).toEqual(["users"]);
    expect(map.dbSchema?.tables.every((t) => t.confidence === "likely")).toBe(true);
  });

  it("omits dbSchema entirely when the repo has no DB content", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-nodb-"));
    await fs.writeFile(path.join(repo, "index.js"), "export const x = 1;");
    const map = await buildContextMap(repo);
    expect(map.dbSchema).toBeUndefined();
  });

  it("excludes dbSchema from mapHash but flips the hash when the .sql content changes", async () => {
    const repo = await tmpRepo("CREATE TABLE a (id int);");
    const first = (await buildContextMap(repo)).meta.mapHash;
    // Re-build identical → same hash (dbSchema is derived, deterministic).
    const same = (await buildContextMap(repo)).meta.mapHash;
    expect(same).toBe(first);
    // Edit the DDL → file identity changes → hash flips.
    await fs.writeFile(path.join(repo, "db", "schema.sql"), "CREATE TABLE a (id int, name text);");
    const changed = (await buildContextMap(repo)).meta.mapHash;
    expect(changed).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/contextMap.test.ts -t "dbSchema integration"`
Expected: FAIL — `map.dbSchema` is `undefined` (engine doesn't build it yet).

- [ ] **Step 3: Wire the DB pass into `src/contextMap.ts`**

Add imports near the other provider imports:

```ts
import { extractDbSchema, isEmptyDbSchema } from "./providers/sql.js";
import type { DbSchema } from "./schema.js";
```

Add `Confidence`-clamped safety-net helper next to `clampExtraction`:

```ts
/**
 * Engine-level safety net (mirrors `clampExtraction`): clamp every DB record to the provider
 * ceiling so a parser bug can never emit a `confirmed` DB fact. ADR 0036 ceiling is `likely`.
 */
export function clampDbSchema(schema: DbSchema, ceiling: Confidence): DbSchema {
  const clamp = <T extends { confidence: Confidence }>(r: T): T => ({ ...r, confidence: clampConfidence(r.confidence, ceiling) });
  return {
    tables: schema.tables.map(clamp),
    columns: schema.columns.map(clamp),
    foreignKeys: schema.foreignKeys.map(clamp),
    indexes: schema.indexes.map(clamp),
    views: schema.views.map(clamp)
  };
}
```

In `buildContextMapFromResolution`, after `const aggregate = await runProviders(...)` and before the `return`, add:

```ts
  // DB provider pass (ADR 0036): parse checked-in DDL into the schema map. Codebase-only;
  // DERIVED, so it is NOT part of `mapHash` (a .sql edit already flips the hash via file identity).
  const dbReadFile = (relPath: string): Promise<string> => fs.readFile(path.join(repositoryRoot, relPath), "utf8");
  const dbSchema = clampDbSchema(await extractDbSchema(repositoryRoot, files, dbReadFile), "likely");
```

In the returned object, add the optional `dbSchema` after `callGraph` and before `findings`:

```ts
    callGraph: { nodes: aggregate.declarations, edges: aggregate.callEdges },
    ...(isEmptyDbSchema(dbSchema) ? {} : { dbSchema }),
    findings: deriveFindings({
```

> `computeMapHash` is untouched — it hashes file-identity records only, so `dbSchema` is excluded automatically. Do **not** add `dbSchema` to it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/contextMap.test.ts -t "dbSchema integration"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full engine + provider suites for regressions**

Run: `npx vitest run test/contextMap.test.ts test/sqlProvider.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/contextMap.ts test/contextMap.test.ts
git commit -m "feat(db): fold dbSchema into the map (clamped to likely, excluded from mapHash)"
```

---

## Task 7: `formatDatabaseMap` formatter (token-bounded digest)

**Files:**
- Modify: `src/output.ts`
- Test: `test/output.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/output.test.ts` (import `formatDatabaseMap` at the top with the other formatters):

```ts
it("formatDatabaseMap renders a bounded, codebase-only schema digest", () => {
  const map = minimalMap();
  (map as any).dbSchema = {
    tables: Array.from({ length: 20 }, (_v, i) => ({ id: `public.t${i}`, name: `t${i}`, sourceFile: "db/s.sql", sourceKind: "sql_ddl", confidence: "likely", reason: "CREATE TABLE" })),
    columns: [{ id: "public.t0.id", tableId: "public.t0", name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, sourceFile: "db/s.sql", confidence: "likely" }],
    foreignKeys: [{ id: "fk", fromTableId: "public.t1", fromColumns: ["t0_id"], toTableId: "unresolved#missing", toColumns: ["id"], confidence: "candidate", reason: "FK" }],
    indexes: [],
    views: []
  };
  const human = formatDatabaseMap(map, "human_readable");
  expect(human).toContain("Codebase-only");
  expect(human).toContain("t0");
  const parsed = JSON.parse(formatDatabaseMap(map, "llm_readable"));
  expect(parsed.analysisBoundary).toBe("codebase_only");
  expect(parsed.counts.tables).toBe(20);          // true total
  expect(parsed.tables).toHaveLength(DIGEST_SAMPLE_CAP); // capped at 8
  expect(parsed.counts.unresolvedForeignKeys).toBe(1);
});

it("formatDatabaseMap handles a map with no dbSchema", () => {
  const parsed = JSON.parse(formatDatabaseMap(minimalMap(), "llm_readable"));
  expect(parsed.status).toBe("no_database_schema");
});

it("formatDatabaseMap handles a null (not-initialized) map", () => {
  const parsed = JSON.parse(formatDatabaseMap(null, "llm_readable"));
  expect(parsed.status).toBe("not_initialized");
});
```

(`DIGEST_SAMPLE_CAP` is already imported in `test/output.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/output.test.ts -t "formatDatabaseMap"`
Expected: FAIL — `formatDatabaseMap is not a function`.

- [ ] **Step 3: Implement `formatDatabaseMap` in `src/output.ts`**

Add `DbSchema` to the `schema.js` type import, then add the formatter (place it just after `formatContextSummary`):

```ts
/**
 * Database schema map (ADR 0036). Mirrors `formatContextSummary`: null → not-initialized,
 * a map with no `dbSchema` → an honest "no database schema detected", else a token-bounded
 * digest (ADR 0034 S1 — samples capped at DIGEST_SAMPLE_CAP, true totals in `counts`). The
 * codebase-only boundary and `likely`/`candidate` confidence labels stay visible in every mode.
 */
export function formatDatabaseMap(map: StaticContextMap | null, mode: OutputMode): string {
  if (map === null) {
    const human = ["# Database: not initialized", "", "Run `init_codebase` first.", "", CODEBASE_ONLY_BANNER].join("\n");
    return byMode(human, { analysisBoundary: "codebase_only", status: "not_initialized" }, mode);
  }
  const db = map.dbSchema;
  if (!db || (db.tables.length === 0 && db.views.length === 0)) {
    const human = ["# Database schema", "", "No database schema detected in checked-in DDL.", "", CODEBASE_ONLY_BANNER].join("\n");
    return byMode(human, { analysisBoundary: "codebase_only", status: "no_database_schema", meta: { codebaseOnlyBoundary: map.meta.codebaseOnlyBoundary } }, mode);
  }

  const cap = DIGEST_SAMPLE_CAP;
  const colsByTable = new Map<string, number>();
  for (const c of db.columns) colsByTable.set(c.tableId, (colsByTable.get(c.tableId) ?? 0) + 1);
  const unresolvedFks = db.foreignKeys.filter((f) => f.toTableId.startsWith("unresolved#"));

  const tables = cappedSample(db.tables, cap);
  const foreignKeys = cappedSample(db.foreignKeys, cap);

  const human = [
    "# Database schema",
    CODEBASE_ONLY_BANNER,
    "",
    `Tables: ${db.tables.length} · Columns: ${db.columns.length} · Foreign keys: ${db.foreignKeys.length} (unresolved: ${unresolvedFks.length}) · Indexes: ${db.indexes.length} · Views: ${db.views.length}`,
    ...cappedSection("Tables", db.tables, (t) => `- \`${t.name}\` \`${t.confidence}\` — ${colsByTable.get(t.id) ?? 0} column(s), from \`${t.sourceFile}\``, cap),
    ...cappedSection("Foreign keys", db.foreignKeys, (f) => `- \`${f.fromTableId}\`(${f.fromColumns.join(", ")}) → \`${f.toTableId}\` \`${f.confidence}\``, cap)
  ].join("\n");

  const llm = {
    analysisBoundary: "codebase_only" as const,
    status: "ok" as const,
    meta: { codebaseOnlyBoundary: map.meta.codebaseOnlyBoundary },
    counts: {
      tables: db.tables.length,
      columns: db.columns.length,
      foreignKeys: db.foreignKeys.length,
      unresolvedForeignKeys: unresolvedFks.length,
      indexes: db.indexes.length,
      views: db.views.length
    },
    tables: tables.sample.map((t) => ({ id: t.id, name: t.name, schema: t.schema, columns: colsByTable.get(t.id) ?? 0, sourceFile: t.sourceFile, confidence: t.confidence })),
    foreignKeys: foreignKeys.sample.map((f) => ({ from: f.fromTableId, fromColumns: f.fromColumns, to: f.toTableId, confidence: f.confidence })),
    truncated: tables.truncated || foreignKeys.truncated,
    digestNote: digestNote(`samples capped at ${cap}; counts carry true totals; full schema in .code-cartographer-mcp/context-map.json`)
  };
  return byMode(human, llm, mode);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/output.test.ts -t "formatDatabaseMap"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/output.ts test/output.test.ts
git commit -m "feat(db): formatDatabaseMap — token-bounded, codebase-only schema digest"
```

---

## Task 8: `map_database` tool row + registration

**Files:**
- Modify: `src/tools.ts`
- Test: `test/tools.test.ts`

- [ ] **Step 1: Write the failing test**

`test/tools.test.ts` has a hardcoded ordered name list (it starts `["check_init_state", "preview_scope", "init_codebase", "get_context_summary", ...]`). Add `"map_database"` immediately after `"get_context_summary"` in that array, and add a behavior test:

```ts
it("map_database returns a codebase-only schema status on an uninitialized repo", async () => {
  const spec = TOOLS.find((t) => t.name === "map_database");
  expect(spec).toBeDefined();
  expect(spec?.cli.command).toBe("db-map");
  const out = await spec!.execute({ repositoryRoot: os.tmpdir(), outputMode: "llm_readable" });
  const parsed = JSON.parse(out);
  expect(parsed.analysisBoundary).toBe("codebase_only");
  // tmpdir has no map → not_initialized
  expect(parsed.status).toBe("not_initialized");
});
```

(If `os` isn't imported in `test/tools.test.ts`, add `import * as os from "node:os";`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools.test.ts -t "map_database"`
Expected: FAIL — no `map_database` spec / name-list mismatch.

- [ ] **Step 3: Add the tool row to `src/tools.ts`**

Add `formatDatabaseMap` to the `./output.js` import block. Then add this row immediately after the `get_context_summary` `defineTool({...})` block:

```ts
  defineTool({
    name: "map_database",
    title: "Map database schema",
    description:
      "Read the saved baseline context map and return the static database schema (tables, columns, foreign keys, indexes, views) parsed from checked-in DDL. Codebase-only: parsed from files, never the live catalog — confidence is `likely` at most, never runtime-confirmed.",
    inputSchema: { repositoryRoot, outputMode },
    cli: { command: "db-map", positionals: [] },
    execute: async ({ repositoryRoot, outputMode }) => formatDatabaseMap(await readContextMap(repositoryRoot), mode(outputMode))
  }),
```

Update the table's count comment at the top of `TOOLS` (`// ---- The table (20 tools) ----` → `21 tools`), and the `Tool #20 is one new entry here` comment if you touch it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools.test.ts`
Expected: PASS — including the existing "MCP and CLI surfaces stay in sync" / count assertions now reflecting 21 tools. If a test asserts a literal `20`, update it to `21` (this is a conscious, expected change).

- [ ] **Step 5: Smoke-test the CLI end-to-end**

```bash
npm run build && node dist/index.js init test/fixtures-tmp >/dev/null 2>&1 || true
npx tsx src/index.ts db-map . --llm | head -c 400
```
Expected: JSON with `"analysisBoundary": "codebase_only"` and either a schema or `no_database_schema`/`not_initialized` status (this repo has no `.sql`, so `no_database_schema` after an init, or `not_initialized` before one).

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat(db): map_database tool (db-map CLI) — 21 tools total"
```

---

## Task 9: Eval-first fixture, golden, and bench baseline (ADR 0028)

New provider claims must land with a fixture + golden + a structural baseline. The forbidden-assertions guard against the over-resolution failure class.

**Files:**
- Read first: `eval/harness.ts` and one existing `eval/fixtures/<name>/` (its source files + golden JSON) to copy the exact golden shape.
- Create: `eval/fixtures/db-postgres-ddl/db/schema.sql`, `eval/fixtures/db-postgres-ddl/app/queries.ts`, and the fixture's golden file (match the existing golden filename/shape).
- Modify: `eval/baselines.json` (add a `db-postgres-ddl` structural entry).

- [ ] **Step 1: Read the existing fixture/golden format**

Run: inspect `eval/harness.ts` for how fixtures + goldens are loaded and what fields a golden entry has (required vs forbidden constructs, confidence assertions). Mirror that exact shape — do not invent a new format.

- [ ] **Step 2: Create the fixture DDL** `eval/fixtures/db-postgres-ddl/db/schema.sql`:

```sql
CREATE TABLE users (
  id integer PRIMARY KEY,
  email text NOT NULL
);

CREATE TABLE orders (
  id integer PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  total numeric
);

-- An intentionally-unreferenced column to exercise DB findings in DB-2.
ALTER TABLE users ADD COLUMN legacy_token text;

-- An FK whose target is NOT defined here → must resolve to unresolved#audit_log.
CREATE TABLE order_events (
  id integer PRIMARY KEY,
  order_id integer REFERENCES orders(id),
  audit_id integer REFERENCES audit_log(id)
);
```

- [ ] **Step 3: Add the golden entries** (in the existing golden format) asserting:
  - **Required:** table `public.users`, table `public.orders`; column `public.users.email` with `nullable: false`; FK `public.orders.user_id → public.users` at `likely`; FK target `audit_log` resolves to `unresolved#audit_log` at `candidate`.
  - **Forbidden (over-resolution guard):** NO `dbSchema` record at `confirmed`; NO FK with a resolved `toTableId` for `audit_log`.

- [ ] **Step 4: Add the bench baseline** to `eval/baselines.json` — a `db-postgres-ddl` entry pinning deterministic structural counts (e.g. `tables: 3`, `foreignKeys: 3`, `unresolvedForeignKeys: 1`). Match the surrounding entries' shape.

- [ ] **Step 5: Run the eval + bench gates**

Run: `npm run eval && npx vitest run test/benchGates.test.ts test/evalHarness.test.ts`
Expected: PASS — the new fixture is scored, the baseline matches. If counts differ, update the baseline **consciously** to the observed-correct values and note why in the commit.

- [ ] **Step 6: Commit**

```bash
git add eval/fixtures/db-postgres-ddl eval/baselines.json
git commit -m "test(db): eval fixture + golden + bench baseline for the SQL DDL provider (ADR 0028)"
```

---

## Task 10: Never-throw robustness for malformed SQL

**Files:**
- Modify: `test/robustness.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/robustness.test.ts` a case that builds a map over a repo containing a malformed `.sql` file and asserts the build completes without throwing and the rest of the map is intact:

```ts
it("a malformed .sql file degrades to no schema, never aborts the build (ADR 0034 S1 + 0036)", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-badsql-"));
  await fs.writeFile(path.join(repo, "good.js"), "export const x = 1;");
  await fs.writeFile(path.join(repo, "broken.sql"), "CREATE TABLE (((( not valid sql ;;;");
  const map = await buildContextMap(repo); // must not throw
  expect(map.summary.totalFiles).toBeGreaterThanOrEqual(2);
  expect(map.dbSchema).toBeUndefined(); // nothing parsed → section omitted
});
```

(Reuse the file's existing imports for `buildContextMap`, `fs`, `os`, `path`; add any that are missing.)

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `npx vitest run test/robustness.test.ts -t "malformed .sql"`
Expected: PASS — the parser already degrades-never-throws (Task 3). This test is a **regression gate** locking that behavior in. If it fails, the never-throw contract regressed — fix `parseSqlDdl`/`extractDbSchema`, don't weaken the test.

- [ ] **Step 3: Run the full suite + all gates**

Run: `npm test && npm run typecheck && npm run slop`
Expected: PASS — full Vitest suite green (was 371; now higher), no type errors, slop gate clean (no `.skip`/`.only`/`@ts-ignore`/`expect(true)`).

- [ ] **Step 4: Commit**

```bash
git add test/robustness.test.ts
git commit -m "test(db): regression-gate malformed-SQL never-throw (ADR 0034 S1)"
```

---

## Task 11: Docs + context sync, and the over-resolution review gate

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/tools-reference.md`, `docs/STATUS.md`, `README.md`, memory store.

- [ ] **Step 1: Run the provider-over-resolution reviewer**

Dispatch the `provider-over-resolution-reviewer` agent against the diff (it audits `src/providers/**` for false edges / confidence above the tier ceiling — the exact failure class this slice risks). Address any BLOCKER/SHOULD-FIX before documenting.

- [ ] **Step 2: Update the docs** to reflect 21 tools and the DB provider tier:
  - `CLAUDE.md`: tool count `20 → 21`; add `src/providers/sql.ts` to the source layout; add `map_database` to the tool list; note `dbSchema` is optional + excluded from `mapHash`; reference ADR 0036.
  - `docs/architecture.md`: add a component row for the DB provider tier (C17) and `dbSchema` to the data model (§3), referencing ADR 0036.
  - `docs/tools-reference.md`: add a `map_database` entry mirroring `get_context_summary`'s format.
  - `docs/STATUS.md` + `README.md`: mention DB schema mapping (DB-1) and the new tool.
  - Memory: update `project-state-and-persistence-model.md` (and add a pointer line in `MEMORY.md`) noting DB-1 landed: SQL DDL schema map, `pgsql-ast-parser`, 21 tools, ADR 0036, live oracle deferred.

- [ ] **Step 3: Final verification**

Run: `npm run build && npm test && npm run typecheck && npm run slop`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs README.md
git commit -m "docs(db): context-sync for DB-1 schema mapping (21 tools, ADR 0036)"
```

---

## Self-Review (completed against the spec)

**Spec coverage:**
- Spec §3 Approach B (parallel schema section, no `LanguageProvider` overload) → Tasks 2–6. ✓
- Spec §4 data model (`DbTable/DbColumn/DbForeignKey/DbIndex/DbView/DbSchema`, optional sections) → Task 2. ✓ (`DataEdge` is correctly **deferred to DB-2** — not in this plan.)
- Spec §4.2 DB provider (DDL parse, `likely` ceiling) → Tasks 3–4. ✓
- Spec §5 confidence/boundary (DDL `likely`, FK-absent → `unresolved#name` → `candidate`, never `confirmed`) → Tasks 3, 5, engine clamp Task 6. ✓
- Spec §6 tool surface — `map_database` only for DB-1 → Tasks 7–8. ✓ (`find_table_usage`/`find_data_footprint`/`analyze_schema_drift` are DB-2/DB-3, out of this plan.)
- Spec §9 never-throw → Tasks 3, 5, 10. ✓
- Spec §10 eval-first (fixture + golden required/forbidden + bench baseline) → Task 9. ✓
- Spec §11 CAS ADR prerequisite → Task 1. ✓ (Live-oracle ADR correctly deferred.)
- Spec §4.4 correction (dbSchema excluded from `mapHash`) → Task 6 + explicit test. ✓

**Placeholder scan:** Task 9 steps 1/3/4 say "match the existing golden format" — this is a deliberate read-then-mirror instruction (the harness format must not be guessed), with the concrete required/forbidden assertions fully specified. Not a vague placeholder. No `TBD`/`implement later` elsewhere.

**Type consistency:** `DbSchema`/`DbTable`/`DbColumn`/`DbForeignKey`/`DbIndex`/`DbView` field names are identical across Tasks 2 (definition), 3–5 (parser), 6 (engine `clampDbSchema`), 7 (formatter). `extractDbSchema(repositoryRoot, files, readFile)` signature matches between Task 5 (def) and Task 6 (call). `formatDatabaseMap(map, mode)` matches between Task 7 (def) and Task 8 (call). Tool name `map_database` / CLI `db-map` consistent across Tasks 8 and 11. `DIGEST_SAMPLE_CAP` reused, not redefined.
