// Codebase scope / exclusion strategy (Decision 0009). Determines which files
// are in scope via four exclusion modes (auto/gitignore/language/none), with a
// preview→confirm flow. Codebase-only; gitignore semantics are delegated to the
// `ignore` package. Resolver/walk bodies are implemented incrementally (A3a–A3e).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as ignoreModule from "ignore";
import type { Ignore, Options } from "ignore";

// `ignore` is a CJS function/namespace merge; under NodeNext its default export is
// mis-typed as the module namespace, so bind it to the documented call signature.
// At runtime `ignoreModule.default` is the factory function.
const createIgnore = ignoreModule.default as unknown as (options?: Options) => Ignore;

export type ExclusionMode = "auto" | "gitignore" | "language" | "none";

/** Where the resolved exclusions came from. */
export type ExclusionSource = "gitignore" | "language" | "manual" | "none";

export interface ExclusionConfig {
  /** Defaults to "auto". */
  mode?: ExclusionMode;
  /** For mode "language": languages to use instead of auto-detecting. */
  languages?: string[];
  /** Extra directory names / globs to exclude. */
  extraExcludes?: string[];
  /** Extra entries to re-include (negation). */
  extraIncludes?: string[];
}

/** A resolved plan for how the walk decides what to skip. */
export interface ScopeResolution {
  source: ExclusionSource;
  /** Detected/used languages (empty unless language-relevant). */
  languages: string[];
  /** Directory names excluded wholesale. */
  excludeDirs: string[];
  /** gitignore-style patterns applied (gitignore/manual sources). */
  patterns: string[];
  /** Stable hash of the resolved plan — ties a preview to its confirm. */
  scopeHash: string;
}

/**
 * Preview of what a scope resolution would map. Counts are FULLY computed from a real walk
 * (not estimated); the walk simply produces no persisted map — nothing is hashed or written.
 */
export interface ScopePreview {
  analysisBoundary: "codebase_only";
  repositoryRoot: string;
  resolution: ScopeResolution;
  /** Files that would land in `files[]` (the full in-scope set, including large/binary). */
  includedFileCount: number;
  /** Directories excluded wholesale. */
  excludedDirCount: number;
  /** Individual files the walk would skip (gitignore-matched), absent from the mapped set. */
  excludedFileCount: number;
  sampleIncluded: string[];
  sampleExcluded: string[];
}

export interface WalkResult {
  /**
   * Included files as sorted relative POSIX paths — the full in-scope set, INCLUDING
   * large/binary files (those are kept and flagged downstream, not skipped here; Decision 0010).
   */
  files: string[];
  /** Excluded directories as sorted relative POSIX paths (their files are NOT in `files`). */
  excludedDirs: string[];
  /**
   * Count of individual files the walk SKIPPED (matched by a gitignore pattern, or
   * unreadable) — files absent from `files`. This is the walk's own coverage signal;
   * the separate non-analyzable (large/binary) count is derived from `files[]` later (A4).
   */
  excludedFileCount: number;
}

/**
 * The resolved scope as persisted on a built map (`StaticContextMap.summary.excluded`).
 * A deliberate projection of `ScopeResolution` + `WalkResult`: `dirs` comes from the
 * walk's `excludedDirs`, `fileCount` from its `excludedFileCount`. Named (not inline)
 * so the persisted schema-v1 shape and the A3e wiring share one source of truth.
 */
export interface RecordedScope {
  source: ExclusionSource;
  /** Detected/used languages. */
  languages: string[];
  /** Configured exclude-dir names — a re-walk input (Decision 0011). */
  excludeDirs: string[];
  /** gitignore-style patterns applied — a re-walk input (Decision 0011). */
  patterns: string[];
  /**
   * The `ScopeResolution.scopeHash` this map was built under (Decision 0011). Persisted so
   * it can be folded into `mapHash` and compared in the cheap staleness fingerprint — a
   * scope-config change is detected even when the surviving file set looks identical.
   */
  scopeHash: string;
  /** Directories the walk actually excluded (relative POSIX paths). */
  dirs: string[];
  /**
   * Count of individual files the walk skipped (gitignore-matched/unreadable), absent from
   * `files[]` — the "what the walk skipped" signal (Decision 0009). Together with `dirs`
   * (excluded directories) this is everything NOT in the map, so coverage stays explicit.
   */
  fileCount: number;
}

/** Reconstruct the re-walk inputs (a `ScopeResolution`) from a persisted `RecordedScope`. */
export function recordedScopeToResolution(recorded: RecordedScope): ScopeResolution {
  return {
    source: recorded.source,
    languages: recorded.languages,
    excludeDirs: recorded.excludeDirs,
    patterns: recorded.patterns,
    scopeHash: recorded.scopeHash
  };
}

/**
 * Directories skipped during language detection so dependency/build languages do
 * not leak into the repo's own language set. Detection-only — the full walk uses
 * the configured exclusion strategy (resolveScope/walkFiles), not this set.
 */
const DETECT_SKIP_DIRS = new Set([
  ".git",
  ".code-cartographer-mcp",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  ".vs"
]);

/** File extension → language id. */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php"
};

/** Manifest filename → language id (strong ecosystem signal). */
const MANIFEST_LANGUAGES: Record<string, string> = {
  "package.json": "javascript",
  "tsconfig.json": "typescript",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "setup.py": "python",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "pom.xml": "java",
  "build.gradle": "java",
  Gemfile: "ruby",
  "composer.json": "php"
};

/** Detect the repository's language(s) from manifests + file extensions. */
export async function detectLanguages(repositoryRoot: string): Promise<string[]> {
  const found = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never throw
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!DETECT_SKIP_DIRS.has(entry.name)) {
          await walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        const manifestLang = MANIFEST_LANGUAGES[entry.name];
        if (manifestLang) {
          found.add(manifestLang);
        }
        if (entry.name.endsWith(".csproj")) {
          found.add("csharp");
        }
        const extLang = EXTENSION_LANGUAGES[path.extname(entry.name).toLowerCase()];
        if (extLang) {
          found.add(extLang);
        }
      }
    }
  }

  await walk(repositoryRoot);
  return [...found].sort();
}

/** Conventional build/dependency directories excluded for a language (Decision 0009). */
const LANGUAGE_EXCLUDE_DIRS: Record<string, string[]> = {
  typescript: ["node_modules", "dist", "build", "coverage", "out", ".next"],
  javascript: ["node_modules", "dist", "build", "coverage", "out", ".next"],
  python: ["__pycache__", ".venv", "venv", ".tox", "dist", "build", ".mypy_cache", ".pytest_cache"],
  go: ["bin", "vendor"],
  rust: ["target"],
  java: [".gradle", "build", "target"],
  csharp: ["bin", "obj"],
  ruby: [".bundle", "vendor"],
  php: ["vendor"]
};

/** Read `.gitignore` into trimmed, non-empty, non-comment pattern lines; null if absent. */
async function readGitignorePatterns(repositoryRoot: string): Promise<string[] | null> {
  try {
    const content = await fs.readFile(path.join(repositoryRoot, ".gitignore"), "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return null; // no .gitignore present
  }
}

/** Union of conventional exclude dirs for the given languages, sorted + deduped. */
function languageExcludeDirs(languages: string[]): string[] {
  const dirs = new Set<string>();
  for (const language of languages) {
    for (const dir of LANGUAGE_EXCLUDE_DIRS[language] ?? []) {
      dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

/** extraExcludes + negated extraIncludes, as gitignore-style pattern lines. */
function extraPatternsOf(config: ExclusionConfig): string[] {
  return [...(config.extraExcludes ?? []), ...(config.extraIncludes ?? []).map((p) => `!${p}`)];
}

/** Stable hash of a resolved plan — ties a preview to its confirm (Decision 0011). */
function computeScopeHash(source: ExclusionSource, languages: string[], excludeDirs: string[], patterns: string[]): string {
  const canonical = JSON.stringify({
    source,
    languages: [...languages].sort(),
    excludeDirs: [...excludeDirs].sort(),
    patterns // order-significant for gitignore semantics
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Resolve the exclusion plan for a repo + config (mode → source/dirs/patterns). */
export async function resolveScope(repositoryRoot: string, config: ExclusionConfig = {}): Promise<ScopeResolution> {
  const mode = config.mode ?? "auto";
  const extras = extraPatternsOf(config);

  type Plan = Pick<ScopeResolution, "source" | "languages" | "excludeDirs" | "patterns">;

  const asLanguage = async (): Promise<Plan> => {
    const languages = config.languages ?? (await detectLanguages(repositoryRoot));
    return { source: "language", languages, excludeDirs: languageExcludeDirs(languages), patterns: [...extras] };
  };
  const asGitignore = (gitignore: string[]): Plan => ({
    source: "gitignore",
    languages: [],
    excludeDirs: [],
    patterns: [...gitignore, ...extras]
  });

  let plan: Plan;
  if (mode === "none") {
    plan = { source: "none", languages: [], excludeDirs: [], patterns: [] }; // map everything; extras ignored
  } else if (mode === "language") {
    plan = await asLanguage();
  } else if (mode === "gitignore") {
    plan = asGitignore((await readGitignorePatterns(repositoryRoot)) ?? []);
  } else {
    // auto: honor .gitignore if present, else fall back to language detection
    const gitignore = await readGitignorePatterns(repositoryRoot);
    plan = gitignore !== null ? asGitignore(gitignore) : await asLanguage();
  }

  const scopeHash = computeScopeHash(plan.source, plan.languages, plan.excludeDirs, plan.patterns);
  return { ...plan, scopeHash };
}

/** Max sample paths surfaced in a preview (just enough to sanity-check the scope). */
const PREVIEW_SAMPLE_LIMIT = 10;

/** Step 1 of init: preview the resolved scope without writing the map. */
export async function previewScope(repositoryRoot: string, config?: ExclusionConfig): Promise<ScopePreview> {
  const resolution = await resolveScope(repositoryRoot, config);
  const walk = await walkFiles(repositoryRoot, resolution);
  return {
    analysisBoundary: "codebase_only",
    repositoryRoot,
    resolution,
    includedFileCount: walk.files.length,
    excludedDirCount: walk.excludedDirs.length,
    excludedFileCount: walk.excludedFileCount,
    sampleIncluded: walk.files.slice(0, PREVIEW_SAMPLE_LIMIT),
    sampleExcluded: walk.excludedDirs.slice(0, PREVIEW_SAMPLE_LIMIT)
  };
}

/**
 * Directories excluded in EVERY mode — VCS internals and the tool's own artifact
 * directory are never codebase content, so even `none` skips them (Decision 0009/0011).
 */
const ALWAYS_EXCLUDE_DIRS = new Set([".git", ".code-cartographer-mcp"]);

/** Walk files under a resolved scope → sorted relative POSIX paths + excluded info. */
export async function walkFiles(repositoryRoot: string, resolution: ScopeResolution): Promise<WalkResult> {
  const matcher = resolution.patterns.length > 0 ? createIgnore().add(resolution.patterns) : null;
  const excludeDirNames = new Set(resolution.excludeDirs);

  const files: string[] = [];
  const excludedDirs: string[] = [];
  let excludedFileCount = 0;

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never throw
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const excludedByName = ALWAYS_EXCLUDE_DIRS.has(entry.name) || excludeDirNames.has(entry.name);
        // gitignore dir patterns are tested with a trailing slash.
        if (excludedByName || matcher?.ignores(`${relPath}/`)) {
          excludedDirs.push(relPath);
          continue;
        }
        await walk(path.join(absDir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (matcher?.ignores(relPath)) {
          excludedFileCount++; // an individual file the walk skipped (pattern-matched)
          continue;
        }
        files.push(relPath);
      }
      // symlinks / sockets / FIFOs are ignored — codebase-only, regular files only.
    }
  }

  await walk(repositoryRoot, "");
  files.sort();
  excludedDirs.sort();
  return { files, excludedDirs, excludedFileCount };
}
