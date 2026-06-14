// The shared type vocabulary of the product (Decision 0025) — the persisted-map schema
// (Decision 0008, v1) and the confidence/finding/output contracts every module imports.
// Behavior-free by design: importing a type never drags the map engine. The engine
// (build, persistence, staleness) lives in contextMap.ts; capabilities own their own
// result envelopes.

import type { RecordedScope } from "./scope.js";

// ---- Shared vocabulary (CAS POL-03 / context-governance) ----

/** Load-bearing confidence labels. Never upgrade a static inference to `confirmed` runtime truth. */
export type Confidence = "confirmed" | "likely" | "candidate" | "unclear" | "unresolved";

/** Strength ordering for `Confidence` (higher = stronger). Used by `clampConfidence`. */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
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
  | "over size cap"
  | "unreadable";

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

// "property" | "field" (ADR 0032): C# data members. Additive — ownership signals are not
// part of `mapHash` (file-identity only, Decision 0011), so schema stays v1.
export type OwnershipSignalKind = "class" | "const" | "enum" | "field" | "function" | "interface" | "property" | "type";

/**
 * Data-member kinds (ADR 0032): API surface, not behavior. They become ownership signals
 * only — never call-graph nodes — and never feed exported-name collision grouping
 * (duplicates, canonical, scattered ownership). Shared vocabulary so the provider and
 * findings derivation cannot drift.
 */
export const DATA_MEMBER_KINDS: ReadonlySet<OwnershipSignalKind> = new Set(["property", "field"]);

export interface OwnershipSignal {
  symbol: string;
  kind: OwnershipSignalKind;
  path: string;
  exported: boolean;
  confidence: Confidence;
  reason: string;
  /**
   * True when this exported name is an alias re-exported from another module
   * (`export { x } from`, `export * from`, import-then-export) rather than a local
   * declaration (Decision 0026). Additive + optional: absent (older maps / non-TS tiers)
   * means "not a re-export"; excluded from `mapHash` (file-identity only, Decision 0011),
   * so schema stays v1. Findings treat re-exports as aliases, never parallel implementations.
   */
  reExport?: boolean;
}

// ---- Static call graph vocabulary (Decision 0016; persisted in the map) ----

/** How a call edge was resolved from static analysis. */
export type CallEdgeKind = "direct" | "method" | "dynamic" | "framework" | "unresolved";

export interface CallGraphNode {
  /** Stable id, e.g. `${path}#${symbol}`. */
  id: string;
  symbol: string;
  path: string;
  kind: OwnershipSignalKind;
  confidence: Confidence;
}

export interface CallEdge {
  from: string;
  to: string;
  callKind: CallEdgeKind;
  confidence: Confidence;
  evidence: string[];
}

// ---- The persisted map (Decision 0008, schema v1) ----

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
