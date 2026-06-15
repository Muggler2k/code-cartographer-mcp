// The map ENGINE (Decision 0025): build, persist, and stale-check the context map.
// Interface: buildContextMap / initCodebase / checkInitState / readContextMap (plus the
// derivation helpers the engine tests pin). The shared type vocabulary lives in schema.ts —
// import types from there, behavior from here.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { categorizeFile, hashFile } from "./files.js";
import {
  recordedScopeToResolution,
  resolveScope,
  walkFiles,
  type ExclusionConfig,
  type RecordedScope,
  type ScopeResolution
} from "./scope.js";
import {
  CONFIDENCE_RANK,
  SCHEMA_VERSION,
  clampConfidence,
  type Confidence,
  type EntryPoint,
  type FileCategory,
  type FileEntry,
  type InitState,
  type ModuleCategory,
  type ModuleGroup,
  type StaticContextMap
} from "./schema.js";
import { groupByProvider } from "./providers/registry.js";
import type { ProviderExtraction } from "./providers/types.js";
import { deriveFindings } from "./findings.js";

export interface InitResult {
  /** Envelope-level codebase-only marker, consistent with every other result type. */
  analysisBoundary: "codebase_only";
  status: "initialized";
  mapPath: string;
  map: StaticContextMap;
  /** Init instrumentation (Decision 0030) — additive + optional; never persisted, never in `mapHash`. */
  timings?: InitTimings;
}

export interface InitStatusResult {
  /** Envelope-level codebase-only marker, consistent with every other result type. */
  analysisBoundary: "codebase_only";
  status: InitState;
  mapPath: string;
  message: string;
  previousMapHash?: string;
  currentMapHash?: string;
}

// ---- Core engine ----

const MAP_DIR = ".code-cartographer-mcp";
const MAP_FILE = "context-map.json";
const MARKER_FILE = ".initializing";
/** Keep in sync with package.json `version`. Not part of `mapHash` (volatile). */
const TOOL_VERSION = "0.1.0";

interface InitMarker {
  startedAt: string;
  pid: number;
}

export function getMapPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, MAP_DIR, MAP_FILE);
}

function getMarkerPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, MAP_DIR, MARKER_FILE);
}

function emptyCategoryCounts(): Record<FileCategory, number> {
  return { source: 0, test: 0, config: 0, documentation: 0, context: 0, generated: 0, other: 0 };
}

/** Extension (no dot, lowercased) for the `languages` tally, or null for extensionless files. */
function extensionOf(relPath: string): string | null {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/** Hash + categorize each walked path into a full FileEntry. */
async function toFileEntries(repositoryRoot: string, relPaths: string[]): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  for (const relPath of relPaths) {
    const hash = await hashFile(repositoryRoot, relPath);
    entries.push({ path: relPath, category: categorizeFile(relPath), ...hash });
  }
  return entries;
}

/**
 * Staleness key (Decision 0011): sha256 of schemaVersion + scopeHash + the sorted
 * file-identity records. Excludes volatile fields (generatedAt, toolVersion, mtimeMs)
 * and EVERYTHING derived (callGraph, findings, ownershipSignals — incl. the optional
 * `reExport` flag, Decision 0026): only file identity may move the hash, so adding a
 * derived field can never flip staleness.
 */
function computeMapHash(files: FileEntry[], scopeHash: string): string {
  const records = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => [f.path, f.sha256, f.hashScope, f.sizeBytes, f.category, f.analyzable, f.analysisReason].join("\0"))
    .join("\n");
  return createHash("sha256").update(`${SCHEMA_VERSION}\0${scopeHash}\0${records}`).digest("hex");
}

// ---- Map derivation: entry points (B2) + module grouping (B3), path-only (Decision 0017) ----

const PACKAGE_MANIFESTS = new Map<string, string>([
  ["package.json", "npm/Node package manifest"],
  ["go.mod", "Go module manifest"],
  ["Cargo.toml", "Cargo (Rust) package manifest"],
  ["pyproject.toml", "Python project manifest"]
]);

function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function isTestFileName(base: string): boolean {
  return /([._-])(test|spec)\.[^/]+$/.test(base) || base.endsWith("_test.go") || /^test_.+\.py$/.test(base);
}

function sourceEntryOf(p: string, base: string): { confidence: Confidence; reason: string } | null {
  if (/^src\/index\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(p)) return { confidence: "likely", reason: "conventional JS/TS package entry (src/index.*)" };
  if (/^cmd\/[^/]+\/main\.go$/.test(p)) return { confidence: "likely", reason: "Go command entry (cmd/*/main.go)" };
  if (base === "__main__.py") return { confidence: "likely", reason: "Python module-execution entry (__main__.py)" };
  if (p === "src/main.rs") return { confidence: "likely", reason: "Rust binary crate entry (src/main.rs)" };
  if (p === "src/lib.rs") return { confidence: "likely", reason: "Rust library crate entry (src/lib.rs)" };
  const stem = base.replace(/\.[^.]+$/, "");
  if (stem === "index" && !p.includes("/")) return { confidence: "candidate", reason: "root index.* — may be a package entry" };
  if (stem === "main") return { confidence: "candidate", reason: "main.* — possible program entry" };
  return null;
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Detect entry points from paths only. Manifests are `confirmed`; source/test entries ≤ `likely`. */
export function detectEntryPoints(files: FileEntry[]): EntryPoint[] {
  const out: EntryPoint[] = [];
  for (const file of files) {
    const base = basenameOf(file.path);
    const manifest = PACKAGE_MANIFESTS.get(base);
    if (manifest) {
      out.push({ path: file.path, kind: "package_manifest", confidence: "confirmed", reason: `filename matches known manifest — ${manifest}` });
      continue;
    }
    if (isTestFileName(base)) {
      out.push({ path: file.path, kind: "test_entry", confidence: "likely", reason: "test file by naming convention" });
      continue;
    }
    if (file.category === "test") {
      out.push({ path: file.path, kind: "test_entry", confidence: "candidate", reason: "file under a test directory" });
      continue;
    }
    const source = sourceEntryOf(file.path, base);
    if (source) {
      out.push({ path: file.path, kind: "source_entry", confidence: source.confidence, reason: source.reason });
    }
  }
  return out.sort(byPath);
}

/** Merge provider entry-point hints over the path-only base; dedupe by path, prefer stronger. */
function mergeEntryPoints(base: EntryPoint[], hints: EntryPoint[]): EntryPoint[] {
  const merged = new Map<string, EntryPoint>();
  for (const ep of [...base, ...hints]) {
    const existing = merged.get(ep.path);
    if (!existing || CONFIDENCE_RANK[ep.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      merged.set(ep.path, ep);
    }
  }
  return [...merged.values()].sort(byPath);
}

const MODULE_SOURCE_ROOTS = new Set(["src", "lib", "pkg", "app"]);
const MODULE_TEST_ROOTS = new Set(["test", "tests"]);

/** Cluster files into coarse modules by directory; every file lands in exactly one group. */
export function groupModules(files: FileEntry[]): ModuleGroup[] {
  const groups = new Map<string, { name: string; root: string; files: FileEntry[] }>();
  for (const file of files) {
    const segs = file.path.split("/");
    let root: string;
    let name: string;
    if (segs.length === 1) {
      root = ".";
      name = "(root)";
    } else if (MODULE_SOURCE_ROOTS.has(segs[0]) || MODULE_TEST_ROOTS.has(segs[0])) {
      if (segs.length >= 3) {
        root = `${segs[0]}/${segs[1]}`;
        name = segs[1];
      } else {
        root = segs[0];
        name = segs[0];
      }
    } else {
      root = segs[0];
      name = segs[0];
    }
    const group = groups.get(root) ?? { name, root, files: [] };
    group.files.push(file);
    groups.set(root, group);
  }
  return [...groups.values()]
    .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0))
    .map((group) => {
      const rootSeg = group.root.split("/")[0];
      const category: ModuleCategory =
        MODULE_TEST_ROOTS.has(rootSeg) || group.files.every((f) => f.category === "test") ? "test" : "source";
      return { name: group.name, root: group.root, category, files: group.files.map((f) => f.path) };
    });
}

/**
 * Clamp EVERY record kind in an extraction to the provider's confidence ceiling (Decision 0012):
 * the engine-level safety net that enforces the codebase-only contract even if a provider
 * over-grades. One generic mapper covers all kinds, so a newly-added record kind cannot silently
 * skip the clamp (the failure mode a per-kind loop invites).
 */
export function clampExtraction(extraction: ProviderExtraction, ceiling: Confidence): ProviderExtraction {
  const clamp = <T extends { confidence: Confidence }>(record: T): T => ({
    ...record,
    confidence: clampConfidence(record.confidence, ceiling)
  });
  return {
    declarations: extraction.declarations.map(clamp),
    ownershipSignals: extraction.ownershipSignals.map(clamp),
    entryPointHints: extraction.entryPointHints.map(clamp),
    callEdges: extraction.callEdges.map(clamp)
  };
}

/** Wall-clock spent in one provider's `analyze` over its owned files (Decision 0030 — never persisted). */
export interface ProviderTiming {
  id: string;
  files: number;
  ms: number;
}

/** Init instrumentation (Decision 0030): returned on `InitResult`, NEVER part of the map or `mapHash`. */
export interface InitTimings {
  totalMs: number;
  providers: ProviderTiming[];
}

/**
 * Append every element of `source` onto `target` in place. NOT `target.push(...source)`: a spread
 * call passes each element as a separate ARGUMENT, and V8 caps the argument count (engine-dependent,
 * measured ~125k here), so `push(...bigArray)` throws `RangeError: Maximum call stack size exceeded`
 * on a large repo (e.g. VS Code's 211,706 call edges). A loop has no such ceiling — this keeps the
 * build degrade-never-throw at scale (ADR 0034 S1; the regression guard is in test/robustness.test.ts).
 */
export function appendAll<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
}

/** Run every provider over its owned files and aggregate, clamping each record to the provider ceiling. */
async function runProviders(repositoryRoot: string, files: FileEntry[], timings?: ProviderTiming[]): Promise<ProviderExtraction> {
  const aggregate: ProviderExtraction = { declarations: [], ownershipSignals: [], entryPointHints: [], callEdges: [] };
  const readFile = (relPath: string): Promise<string> => fs.readFile(path.join(repositoryRoot, relPath), "utf8");
  for (const [provider, providerFiles] of groupByProvider(files)) {
    const started = Date.now();
    let extraction: ProviderExtraction;
    try {
      extraction = await provider.analyze({ repositoryRoot, files: providerFiles, readFile });
    } catch {
      timings?.push({ id: provider.id, files: providerFiles.length, ms: Date.now() - started });
      continue; // a provider failure degrades to no extraction for its files, never fails the build
    }
    timings?.push({ id: provider.id, files: providerFiles.length, ms: Date.now() - started });
    const clamped = clampExtraction(extraction, provider.maxConfidence);
    appendAll(aggregate.declarations, clamped.declarations);
    appendAll(aggregate.ownershipSignals, clamped.ownershipSignals);
    appendAll(aggregate.entryPointHints, clamped.entryPointHints);
    appendAll(aggregate.callEdges, clamped.callEdges);
  }
  aggregate.declarations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  aggregate.ownershipSignals.sort((a, b) => (`${a.path}#${a.symbol}` < `${b.path}#${b.symbol}` ? -1 : 1));
  return aggregate;
}

export async function buildContextMap(repositoryRoot: string, config?: ExclusionConfig, timings?: ProviderTiming[]): Promise<StaticContextMap> {
  const resolution = await resolveScope(repositoryRoot, config);
  return buildContextMapFromResolution(repositoryRoot, resolution, timings);
}

/**
 * Build under an ALREADY-RESOLVED scope (Decision 0031): the diff capability rebuilds the
 * current tree with the baseline map's recorded scope so a delta is never scope noise.
 * Same parse-only pipeline as `buildContextMap`; nothing is persisted here.
 */
export async function buildContextMapFromResolution(
  repositoryRoot: string,
  resolution: ScopeResolution,
  timings?: ProviderTiming[]
): Promise<StaticContextMap> {
  const walk = await walkFiles(repositoryRoot, resolution);
  const files = await toFileEntries(repositoryRoot, walk.files);

  const categories = emptyCategoryCounts();
  const languages: Record<string, number> = {};
  for (const file of files) {
    categories[file.category]++;
    const ext = extensionOf(file.path);
    if (ext) {
      languages[ext] = (languages[ext] ?? 0) + 1;
    }
  }

  const excluded: RecordedScope = {
    source: resolution.source,
    languages: resolution.languages,
    excludeDirs: resolution.excludeDirs,
    patterns: resolution.patterns,
    scopeHash: resolution.scopeHash,
    dirs: walk.excludedDirs,
    fileCount: walk.excludedFileCount
  };

  // Run the language providers once: ownership signals, entry hints, and the call graph (Decision 0017).
  const aggregate = await runProviders(repositoryRoot, files, timings);
  const entryPoints = mergeEntryPoints(detectEntryPoints(files), aggregate.entryPointHints);
  const modules = groupModules(files);

  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      toolVersion: TOOL_VERSION,
      generatedAt: new Date().toISOString(),
      repositoryRoot,
      mapHash: computeMapHash(files, resolution.scopeHash),
      codebaseOnlyBoundary: true
    },
    summary: {
      totalFiles: files.length,
      categories,
      languages,
      importantFiles: aggregate.ownershipSignals.filter((s) => s.exported).map((s) => s.path).filter((p, i, a) => a.indexOf(p) === i).slice(0, 20),
      entryPoints,
      modules,
      ownershipSignals: aggregate.ownershipSignals,
      excluded
    },
    files,
    callGraph: { nodes: aggregate.declarations, edges: aggregate.callEdges },
    findings: deriveFindings({
      files,
      languages,
      modules,
      entryPoints,
      ownershipSignals: aggregate.ownershipSignals,
      declarations: aggregate.declarations,
      callEdges: aggregate.callEdges
    })
  };
}

/** Create the artifact dir and gitignore it so generated state is never committed (Decision 0011). */
export async function ensureMapDir(repositoryRoot: string): Promise<string> {
  const dir = path.join(repositoryRoot, MAP_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".gitignore"), "*\n");
  return dir;
}

/** Atomic write: temp file + fsync + rename, so a crash never leaves a torn map (Decision 0011). */
async function writeContextMap(repositoryRoot: string, map: StaticContextMap): Promise<string> {
  const dir = await ensureMapDir(repositoryRoot);
  const mapPath = path.join(dir, MAP_FILE);
  const tmpPath = path.join(dir, `${MAP_FILE}.tmp`);
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(JSON.stringify(map, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, mapPath);
  return mapPath;
}

export async function readContextMap(repositoryRoot: string): Promise<StaticContextMap | null> {
  try {
    return JSON.parse(await fs.readFile(getMapPath(repositoryRoot), "utf8")) as StaticContextMap;
  } catch {
    return null;
  }
}

async function readMarker(repositoryRoot: string): Promise<InitMarker | null> {
  try {
    return JSON.parse(await fs.readFile(getMarkerPath(repositoryRoot), "utf8")) as InitMarker;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks existence
    return true;
  } catch {
    return false;
  }
}

export async function initCodebase(repositoryRoot: string, config?: ExclusionConfig): Promise<InitResult> {
  await ensureMapDir(repositoryRoot);
  const marker: InitMarker = { startedAt: new Date().toISOString(), pid: process.pid };
  await fs.writeFile(getMarkerPath(repositoryRoot), JSON.stringify(marker));
  try {
    const started = Date.now();
    const providerTimings: ProviderTiming[] = [];
    const map = await buildContextMap(repositoryRoot, config, providerTimings);
    const mapPath = await writeContextMap(repositoryRoot, map);
    return {
      analysisBoundary: "codebase_only",
      status: "initialized",
      mapPath,
      map,
      timings: { totalMs: Date.now() - started, providers: providerTimings }
    };
  } finally {
    await fs.rm(getMarkerPath(repositoryRoot), { force: true });
  }
}

/** Cheap fingerprint: same count + per-file size/mtime as the saved map (Decision 0011). */
async function fingerprintUnchanged(
  repositoryRoot: string,
  saved: StaticContextMap,
  currentPaths: string[]
): Promise<boolean> {
  if (currentPaths.length !== saved.files.length) {
    return false;
  }
  const savedByPath = new Map(saved.files.map((file) => [file.path, file]));
  for (const relPath of currentPaths) {
    const savedEntry = savedByPath.get(relPath);
    if (!savedEntry) {
      return false;
    }
    const stat = await fs.stat(path.join(repositoryRoot, relPath)).catch(() => null);
    if (!stat || stat.size !== savedEntry.sizeBytes || stat.mtimeMs !== savedEntry.mtimeMs) {
      return false;
    }
  }
  return true;
}

export async function checkInitState(repositoryRoot: string): Promise<InitStatusResult> {
  const mapPath = getMapPath(repositoryRoot);
  const boundary = "codebase_only" as const;

  // 1. In-progress or crashed init (Decision 0014).
  const marker = await readMarker(repositoryRoot);
  if (marker) {
    return pidAlive(marker.pid)
      ? { analysisBoundary: boundary, status: "initializing", mapPath, message: "Initialization is in progress." }
      : { analysisBoundary: boundary, status: "failed", mapPath, message: "A previous initialization did not complete; re-run init." };
  }

  // 2. No map yet.
  const saved = await readContextMap(repositoryRoot);
  if (!saved) {
    return { analysisBoundary: boundary, status: "not_initialized", mapPath, message: "No context map. Run init_codebase first." };
  }

  // 3. Re-walk with the saved scope, fingerprint, then rehash + compare mapHash if needed.
  const resolution = recordedScopeToResolution(saved.summary.excluded);
  const walk = await walkFiles(repositoryRoot, resolution);
  const schemaOk = saved.meta.schemaVersion === SCHEMA_VERSION;

  if (schemaOk && (await fingerprintUnchanged(repositoryRoot, saved, walk.files))) {
    return {
      analysisBoundary: boundary,
      status: "initialized",
      mapPath,
      message: "Context map is current.",
      previousMapHash: saved.meta.mapHash,
      currentMapHash: saved.meta.mapHash
    };
  }

  const files = await toFileEntries(repositoryRoot, walk.files);
  const currentMapHash = computeMapHash(files, saved.summary.excluded.scopeHash);
  if (schemaOk && currentMapHash === saved.meta.mapHash) {
    return {
      analysisBoundary: boundary,
      status: "initialized",
      mapPath,
      message: "Context map is current (re-hash confirmed).",
      previousMapHash: saved.meta.mapHash,
      currentMapHash
    };
  }

  return {
    analysisBoundary: boundary,
    status: "stale",
    mapPath,
    message: "The codebase changed since the map was built; re-run init.",
    previousMapHash: saved.meta.mapHash,
    currentMapHash
  };
}
