// ADR 0034 S2 — code-content-free, local-file/dev-only telemetry. The production consumer is an
// LLM agent (Claude Code) calling the 20 tools mid-conversation; S2 needs timing + failure +
// repo-shape signal from real sessions to drive the later trust/latency gates. This records ONLY
// metadata — never source, file paths, symbol names, argument VALUES, or output content:
//   - per tool call: timestamp, tool name, duration, ok/failed, output SIZE (chars), the arg
//     KEY names present (not their values), and an anonymized repo id (sha256 of the root path).
//   - once per repo: a shape record (file/node/edge counts + a file-EXTENSION histogram, whose
//     keys are sanitized to bare-extension tokens so nothing path-like can slip in).
//
// Off by default. Enabled only when `CCM_TELEMETRY` is set: `1`/`on`/`true` writes to
// `<repo>/.code-cartographer-mcp/telemetry.jsonl` (gitignored artifact dir); any other value is
// treated as the output file path. Local-file only — it opens no network connection, and a UNC
// path (`\\share`) is refused so records can't be routed over SMB. Every write is best-effort and
// swallows its own errors, so telemetry can never change a tool's result or break a call
// (consistent with the never-throw contract, ADR 0034 S1).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { ensureMapDir, getMapPath } from "./contextMap.js";

/** The gitignored artifact dir (`<repo>/.code-cartographer-mcp`) — derived, never hardcoded. */
function artifactDir(repositoryRoot: string): string {
  return path.dirname(getMapPath(repositoryRoot));
}

/** A single tool-call telemetry record — metadata only, code-content-free by construction. */
export interface ToolCallRecord {
  ts: string;
  tool: string;
  ms: number;
  ok: boolean;
  /** Output size in characters (a token-budget signal) — NOT the output content. */
  outputChars: number;
  /** The argument field NAMES that were present — never their values. */
  argKeys: string[];
}

/** True when `CCM_TELEMETRY` is set to a non-empty value. */
export function telemetryEnabled(): boolean {
  return !!(process.env.CCM_TELEMETRY && process.env.CCM_TELEMETRY.trim());
}

/** Anonymized, stable per-repo id — the sha256 of the root path, truncated. Never the path itself. */
export function repoId(repositoryRoot: string): string {
  return createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 12);
}

/** Resolve the telemetry output from `CCM_TELEMETRY`. `isArtifact` marks the gitignored default. */
function telemetryTarget(repositoryRoot: string): { file: string; isArtifact: boolean } {
  const v = (process.env.CCM_TELEMETRY ?? "").trim();
  const lower = v.toLowerCase();
  if (v === "1" || lower === "on" || lower === "true") {
    return { file: path.join(artifactDir(repositoryRoot), "telemetry.jsonl"), isArtifact: true };
  }
  return { file: path.isAbsolute(v) ? v : path.join(repositoryRoot, v), isArtifact: false };
}

/** A UNC path (`\\share`, or `//share` on Windows) — refused so records can't be routed over SMB. */
function isUncPath(file: string): boolean {
  return file.startsWith("\\\\") || (process.platform === "win32" && file.startsWith("//"));
}

/** Append one JSONL record, best-effort (ensure the dir; swallow every error). */
async function append(repositoryRoot: string, record: Record<string, unknown>): Promise<void> {
  try {
    const { file, isArtifact } = telemetryTarget(repositoryRoot);
    if (isUncPath(file)) {
      return; // local-file only
    }
    if (isArtifact) {
      // Route the default dir through ensureMapDir so the artifact dir keeps its `.gitignore`
      // even when a tool call (with telemetry on) precedes init (ADR 0011 invariant).
      await ensureMapDir(repositoryRoot);
    } else {
      await fs.mkdir(path.dirname(file), { recursive: true });
    }
    await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Telemetry must never affect a tool call — drop the record on any I/O error.
  }
}

const shapeSeen = new Set<string>();

/** Once per repo, emit a shape record (counts + language histogram) from the persisted map. */
async function maybeRecordShape(repositoryRoot: string, repo: string): Promise<void> {
  if (shapeSeen.has(repo)) {
    return;
  }
  shapeSeen.add(repo);
  try {
    const raw = await fs.readFile(getMapPath(repositoryRoot), "utf8");
    const map = JSON.parse(raw) as {
      summary?: { totalFiles?: number; languages?: Record<string, number> };
      callGraph?: { nodes?: unknown[]; edges?: unknown[] };
    };
    // Keep only bare-extension keys (e.g. "ts", "py", "csproj") — self-enforces code-content-free
    // even if the map's `languages` ever carried something path-like.
    const languages: Record<string, number> = {};
    for (const [ext, count] of Object.entries(map.summary?.languages ?? {})) {
      if (/^[a-z0-9_+#-]{1,16}$/.test(ext)) {
        languages[ext] = count;
      }
    }
    await append(repositoryRoot, {
      type: "repo_shape",
      ts: new Date().toISOString(),
      repo,
      totalFiles: map.summary?.totalFiles ?? 0,
      languages,
      nodes: map.callGraph?.nodes?.length ?? 0,
      edges: map.callGraph?.edges?.length ?? 0
    });
  } catch {
    // No persisted map yet (e.g. before init) — skip the shape record.
  }
}

/**
 * Record one tool call (best-effort). No-op unless telemetry is enabled. Resolves once the record
 * (and, on first sight of a repo, the shape record) has been written or dropped.
 */
export async function recordToolCall(repositoryRoot: string, record: ToolCallRecord): Promise<void> {
  if (!telemetryEnabled()) {
    return;
  }
  const repo = repoId(repositoryRoot);
  await maybeRecordShape(repositoryRoot, repo);
  await append(repositoryRoot, { type: "tool_call", repo, ...record });
}

/** Test seam: forget which repos have emitted a shape record. */
export function resetTelemetryShapeCache(): void {
  shapeSeen.clear();
}
