// File-level building blocks for the map engine (C3 Hashing). Codebase-only:
// reads file bytes statically, never executes anything. Implements the hashing /
// large-file / binary policy (Decision 0010) and the per-file fingerprint fields
// that feed mapHash + staleness (Decision 0011).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { LARGE_FILE_THRESHOLD_BYTES, type AnalysisReason, type FileCategory, type HashScope } from "./schema.js";

/** The hash/size/fingerprint fields of a `FileEntry` (everything except `path`/`category`). */
export interface FileHash {
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  hashScope: HashScope;
  analyzable: boolean;
  analysisReason: AnalysisReason;
}

/** Bytes sniffed for a NUL when classifying a file as binary. */
const BINARY_SNIFF_BYTES = 8192;

// ---- Categorizer (C2) ----

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)(\/|$)/;
const TEST_FILE_RE = /([._-])(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/;
const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".adoc"]);
const DOC_STEMS = new Set(["readme", "license", "licence", "changelog", "contributing", "authors", "notice"]);
const CONFIG_EXTS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".xml"]);
const CONFIG_NAMES = new Set([
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".dockerignore",
  "dockerfile",
  "makefile"
]);
const GENERATED_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "go.sum",
  "composer.lock",
  "poetry.lock"
]);
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".cs", ".vb", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".kt", ".swift", ".scala", ".sh"
]);

/** Classify a file by its relative POSIX path (C2). Heuristic, order-sensitive. */
export function categorizeFile(relPath: string): FileCategory {
  const lower = relPath.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : ""; // leading-dot files (".gitignore") have no ext
  const stem = dot > 0 ? base.slice(0, dot) : base;

  if (lower.startsWith("context/") || lower.startsWith(".claude/") || lower.includes("/.claude/")) {
    return "context";
  }
  if (GENERATED_NAMES.has(base) || base.endsWith(".min.js") || base.endsWith(".map")) {
    return "generated";
  }
  if (TEST_PATH_RE.test(lower) || TEST_FILE_RE.test(base)) {
    return "test";
  }
  if (DOC_EXTS.has(ext) || DOC_STEMS.has(stem)) {
    return "documentation";
  }
  if (CONFIG_NAMES.has(base) || CONFIG_EXTS.has(ext) || base.endsWith(".config.js") || base.endsWith(".config.ts")) {
    return "config";
  }
  if (SOURCE_EXTS.has(ext)) {
    return "source";
  }
  return "other";
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Hash a single file under the large-file/binary policy (Decision 0010):
 * - over `maxBytes` → metadata hash of `path+size`, `analyzable: false`, "over size cap"
 *   (size precedence: a large binary is still "over size cap", never read).
 * - binary (NUL in the sniff window) → full content hash, `analyzable: false`, "binary: null byte".
 * - otherwise → full content hash, `analyzable: true`, "text source".
 */
export async function hashFile(
  repositoryRoot: string,
  relPath: string,
  maxBytes: number = LARGE_FILE_THRESHOLD_BYTES
): Promise<FileHash> {
  const absolute = path.join(repositoryRoot, relPath);
  const stat = await fs.stat(absolute);
  const sizeBytes = stat.size;
  const mtimeMs = stat.mtimeMs;

  if (sizeBytes > maxBytes) {
    return {
      sizeBytes,
      mtimeMs,
      sha256: sha256Hex(`${relPath}\0${sizeBytes}`),
      hashScope: "metadata",
      analyzable: false,
      analysisReason: "over size cap" satisfies AnalysisReason
    };
  }

  const content = await fs.readFile(absolute);
  const isBinary = content.subarray(0, BINARY_SNIFF_BYTES).includes(0x00);
  return {
    sizeBytes,
    mtimeMs,
    sha256: sha256Hex(content),
    hashScope: "content" satisfies HashScope,
    analyzable: !isBinary,
    analysisReason: (isBinary ? "binary: null byte" : "text source") satisfies AnalysisReason
  };
}
