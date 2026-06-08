// Skeleton contract for the FULL planned product. Nothing is implemented yet —
// every function throws "not implemented". The type vocabulary below is the
// compile-time contract the tools, analysis layer, and formatters share. It is
// derived from the CAS source of truth (confidence vocabulary, six-field finding
// shape, output modes, init states). Implement the bodies during the build phase.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { categorizeFile, hashFile } from "./files.js";
import {
  recordedScopeToResolution,
  resolveScope,
  walkFiles,
  type ExclusionConfig,
  type RecordedScope
} from "./scope.js";
import type { CallEdge, CallGraphNode } from "./callGraph.js";
import { groupByProvider } from "./providers/registry.js";
import type { ProviderExtraction } from "./providers/types.js";
import { deriveFindings } from "./findings.js";

// ---- Shared vocabulary (CAS POL-03 / context-governance) ----

/** Load-bearing confidence labels. Never upgrade a static inference to `confirmed` runtime truth. */
export type Confidence = "confirmed" | "likely" | "candidate" | "unclear" | "unresolved";

/** Strength ordering for `Confidence` (higher = stronger). Used by `clampConfidence`. */
const CONFIDENCE_RANK: Record<Confidence, number> = {
  confirmed: 5,
  likely: 4,
  candidate: 3,
  unclear: 2,
  unresolved: 1
};

/**
 * Clamp a confidence to a ceiling — the single enforcement point for provider tiers
 * (Decision 0012/0013) and finding caps (Decision 0016). Returns the weaker of the two.
 */
export function clampConfidence(level: Confidence, ceiling: Confidence): Confidence {
  return CONFIDENCE_RANK[level] <= CONFIDENCE_RANK[ceiling] ? level : ceiling;
}

/** Output renderings (CAS output-mode-policy): `dual` returns both blocks. */
export type OutputMode = "human_readable" | "llm_readable" | "dual";

/** Init lifecycle states (CAS init-and-codebase-mapping-policy). */
export type InitState = "not_initialized" | "initializing" | "initialized" | "stale" | "failed";

/** The six-field finding shape required by CAS context-governance. */
export interface Finding {
  finding: string;
  confidence: Confidence;
  evidence: string[];
  risk: string;
  recommendation: string;
  /** Structured uncertainty, unified with analysis results (Decision 0008). */
  uncertainty: UncertaintyItem[];
}

/** A single explicit unknown: what is unknown, why, and what would confirm it. */
export interface UncertaintyItem {
  item: string;
  reason: string;
  requiredConfirmation: string;
}

export type RecommendationAction = "reuse" | "modify" | "consolidate" | "avoid" | "investigate";

export interface Recommendation {
  action: RecommendationAction;
  target: string;
  rationale: string;
}

export type ImpactLevel = "low" | "medium" | "high";

// ---- Path / finding substructures (CAS output-mode-policy llm_readable shape) ----

export interface CanonicalPath {
  id: string;
  label: string;
  confidence: Confidence;
  evidence: string[];
  risks: string[];
}

export interface DuplicatePath {
  id: string;
  label: string;
  confidence: Confidence;
  evidence: string[];
  risk: string;
  /** In-record caveat (Decision 0016) — e.g. static name/shape match does not prove equivalence. */
  uncertainty: UncertaintyItem[];
}

/** Legacy reachability/risk classes (CAS system foundation). */
export type LegacyReachability =
  | "still_reachable"
  | "possibly_reachable"
  | "apparently_unreachable"
  | "replaced_but_present"
  | "safe_removal_candidate"
  | "requires_human_confirmation";

export interface LegacyPath {
  id: string;
  label: string;
  reachability: LegacyReachability;
  evidence: string[];
  recommendation: string;
  /**
   * In-record caveat (Decision 0016). Mandatory for `safe_removal_candidate` /
   * `apparently_unreachable`: static absence of references never proves dead code.
   */
  uncertainty: UncertaintyItem[];
}

export interface ChangeImpactArea {
  area: string;
  impactLevel: ImpactLevel;
  reason: string;
}

// ---- Map structural types ----

export type FileCategory =
  | "source"
  | "test"
  | "config"
  | "documentation"
  | "context"
  | "generated"
  | "other";

/** How a file's `sha256` was computed (Decision 0010). */
export type HashScope = "content" | "metadata";

/**
 * Canonical, version-stable justification for a file's `analyzable` verdict (Decisions 0010/0011).
 * A CLOSED set: these exact strings are part of `mapHash`, so they must never be reworded — and
 * they deliberately omit the cap's numeric value (configurable, hence volatile) — to avoid false
 * staleness. When a file is both binary and over the cap, `"over size cap"` takes precedence,
 * mirroring the metadata-hash precedence in Decision 0010.
 */
export type AnalysisReason =
  | "text source"
  | "binary: null byte"
  | "over size cap";

export interface FileEntry {
  path: string;
  category: FileCategory;
  sizeBytes: number;
  /** Content hash, or — for files over `LARGE_FILE_THRESHOLD_BYTES` — a metadata hash (see `hashScope`). */
  sha256: string;
  /**
   * `content` = sha256 of full bytes; `metadata` = sha256 of path+size (Decision 0010).
   * `metadata` is used ONLY for files over the large-file cap, regardless of type. Small
   * binaries (under the cap) get `content` so a binary edit still flips staleness; only
   * size-capped files key staleness off size rather than content.
   */
  hashScope: HashScope;
  /**
   * False for detected binaries (any size) and over-cap files. They remain in `files[]` and
   * count toward coverage and staleness, but the derivation/parse epics (B/F/G) must skip
   * reading their content (Decision 0010).
   */
  analyzable: boolean;
  /**
   * Canonical justification for the `analyzable` verdict (`AnalysisReason`). Part of `mapHash`,
   * so it is a closed, version-stable set rather than free text — keeping coverage decisions
   * auditable without letting a reworded message flip staleness (Decisions 0010/0011).
   */
  analysisReason: AnalysisReason;
  /**
   * Filesystem mtime in epoch ms — the ONLY `FileEntry` field excluded from `mapHash`
   * (Decision 0011). It feeds the cheap staleness fingerprint (size+mtime+count) so a
   * touched-but-unchanged file triggers a rehash that confirms `mapHash` is unchanged.
   */
  mtimeMs: number;
}

export type EntryPointKind = "package_manifest" | "source_entry" | "test_entry";

export interface EntryPoint {
  path: string;
  kind: EntryPointKind;
  confidence: Confidence;
  reason: string;
}

export type ModuleCategory = "source" | "test";

export interface ModuleGroup {
  name: string;
  root: string;
  category: ModuleCategory;
  files: string[];
}

export type OwnershipSignalKind = "class" | "const" | "enum" | "function" | "interface" | "type";

export interface OwnershipSignal {
  symbol: string;
  kind: OwnershipSignalKind;
  path: string;
  exported: boolean;
  confidence: Confidence;
  reason: string;
}

/** Current context-map schema version (Decision 0008). Bump as the shape evolves. */
export const SCHEMA_VERSION = 1 as const;

/**
 * Large-file cap (Decision 0010): files larger than this stay in `files[]` (so they count
 * toward `summary.totalFiles` and staleness) but are recorded with a metadata hash
 * (`hashScope: "metadata"`) and `analyzable: false` rather than read in full. They are NOT
 * counted in `summary.excluded.fileCount` (that tracks files the walk skipped) — their
 * non-analyzable status lives on the `FileEntry`. Default 5 MB; an override can be threaded later.
 */
export const LARGE_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** Provenance for a generated map — kept separate from content. */
export interface MapMeta {
  /** Always equals SCHEMA_VERSION; widen to a version union when migrating past 1. */
  schemaVersion: typeof SCHEMA_VERSION;
  /** Version of the tool that generated the map (package.json version). */
  toolVersion: string;
  generatedAt: string;
  repositoryRoot: string;
  /**
   * Staleness key (Decision 0011): sha256 of `schemaVersion` + `summary.excluded.scopeHash`
   * + the sorted file-identity records (`path, sha256, hashScope, sizeBytes, category,
   * analyzable, analysisReason`). `analysisReason` is safe to include because it is a closed,
   * version-stable `AnalysisReason` set. Excludes volatile fields (`generatedAt`, `toolVersion`,
   * per-file `mtimeMs`) so identical content + scope + schema always yields the same hash.
   */
  mapHash: string;
  /** Codebase-only marker. Formatters must surface this prominently in every output mode. */
  codebaseOnlyBoundary: true;
}

export interface StaticContextMap {
  meta: MapMeta;
  summary: {
    /**
     * Count of every entry in `files[]` — the walked, in-scope set, INCLUDING non-analyzable
     * (large/binary) files. Never the whole repo: files under `excluded.dirs` are absent (see `excluded`).
     */
    totalFiles: number;
    categories: Record<FileCategory, number>;
    /** File count per language/extension. */
    languages: Record<string, number>;
    importantFiles: string[];
    entryPoints: EntryPoint[];
    modules: ModuleGroup[];
    ownershipSignals: OwnershipSignal[];
    /**
     * Resolved scope (Decision 0009): everything the walk left OUT of the map, so it is never
     * mistaken for exhaustive. `dirs` are directories excluded wholesale; `fileCount` is the
     * count of individual files skipped (gitignore-matched). Both are absent from `files[]`.
     * (Large/binary files are IN `files[]` with `analyzable: false`; that count is derived from
     * `files[]`, not recorded here.)
     */
    excluded: RecordedScope;
  };
  files: FileEntry[];
  /**
   * Static call graph (Decision 0016): provider-extracted declarations + confidence-graded
   * call edges, built once at init from the clamped provider aggregate. Excluded from `mapHash`
   * (derived, like `findings`). Read by the analysis, call-stack, and visualization layers.
   */
  callGraph: {
    nodes: CallGraphNode[];
    edges: CallEdge[];
  };
  findings: {
    canonicalPaths: CanonicalPath[];
    duplicatePathCandidates: DuplicatePath[];
    legacyPathCandidates: LegacyPath[];
    riskAreas: Finding[];
    uncertainty: UncertaintyItem[];
  };
}

export interface InitResult {
  /** Envelope-level codebase-only marker, consistent with every other result type. */
  analysisBoundary: "codebase_only";
  status: "initialized";
  mapPath: string;
  map: StaticContextMap;
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
 * file-identity records. Excludes volatile fields (generatedAt, toolVersion, mtimeMs).
 */
function computeMapHash(files: FileEntry[], scopeHash: string): string {
  const records = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => [f.path, f.sha256, f.hashScope, f.sizeBytes, f.category, f.analyzable, f.analysisReason].join(" "))
    .join("\n");
  return createHash("sha256").update(`${SCHEMA_VERSION} ${scopeHash} ${records}`).digest("hex");
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

/** Run every provider over its owned files and aggregate, clamping each record to the provider ceiling. */
async function runProviders(repositoryRoot: string, files: FileEntry[]): Promise<ProviderExtraction> {
  const aggregate: ProviderExtraction = { declarations: [], ownershipSignals: [], entryPointHints: [], callEdges: [] };
  const readFile = (relPath: string): Promise<string> => fs.readFile(path.join(repositoryRoot, relPath), "utf8");
  for (const [provider, providerFiles] of groupByProvider(files)) {
    let extraction: ProviderExtraction;
    try {
      extraction = await provider.analyze({ repositoryRoot, files: providerFiles, readFile });
    } catch {
      continue; // a provider failure degrades to no extraction for its files, never fails the build
    }
    const clamped = clampExtraction(extraction, provider.maxConfidence);
    aggregate.declarations.push(...clamped.declarations);
    aggregate.ownershipSignals.push(...clamped.ownershipSignals);
    aggregate.entryPointHints.push(...clamped.entryPointHints);
    aggregate.callEdges.push(...clamped.callEdges);
  }
  aggregate.declarations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  aggregate.ownershipSignals.sort((a, b) => (`${a.path}#${a.symbol}` < `${b.path}#${b.symbol}` ? -1 : 1));
  return aggregate;
}

export async function buildContextMap(repositoryRoot: string, config?: ExclusionConfig): Promise<StaticContextMap> {
  const resolution = await resolveScope(repositoryRoot, config);
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
  const aggregate = await runProviders(repositoryRoot, files);
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
async function ensureMapDir(repositoryRoot: string): Promise<string> {
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
    const map = await buildContextMap(repositoryRoot, config);
    const mapPath = await writeContextMap(repositoryRoot, map);
    return { analysisBoundary: "codebase_only", status: "initialized", mapPath, map };
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
