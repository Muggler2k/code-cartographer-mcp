// Shared test fixtures (Decision 0025): the temp-repo factory and a minimal
// StaticContextMap builder, so fixture knowledge lives in one module. Integration
// tests that genuinely exercise the filesystem/init pipeline use `tempRepos`;
// map-shaped tests construct maps directly with `testContextMap` and run
// capabilities over an injected context (the ADR 0024/0025 GraphSource seam).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CallEdge, CallGraphNode, FileEntry, StaticContextMap } from "../../src/schema.js";

// ---- Temp repositories ------------------------------------------------------

export interface TempRepos {
  /** Create a temp directory containing `files` (relative path → content). */
  makeRepo(files?: Record<string, string>): Promise<string>;
  /** Remove every directory this factory created. Call from afterAll/afterEach. */
  cleanup(): Promise<void>;
}

/** Per-test-file factory for throwaway repos; register `cleanup` with afterAll/afterEach. */
export function tempRepos(prefix = "ccm-"): TempRepos {
  const dirs: string[] = [];
  return {
    async makeRepo(files: Record<string, string> = {}): Promise<string> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      dirs.push(root);
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content);
      }
      return root;
    },
    async cleanup(): Promise<void> {
      while (dirs.length > 0) {
        await fs.rm(dirs.pop()!, { recursive: true, force: true });
      }
    }
  };
}

// ---- Minimal map construction ------------------------------------------------

export function testFileEntry(p: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: p,
    category: "source",
    sizeBytes: 10,
    sha256: "0".repeat(64),
    hashScope: "content",
    analyzable: true,
    analysisReason: "text source",
    mtimeMs: 0,
    ...overrides
  };
}

export function testNode(id: string, overrides: Partial<CallGraphNode> = {}): CallGraphNode {
  return { id, symbol: id, path: `src/${id}.ts`, kind: "function", confidence: "likely", ...overrides };
}

export function testEdge(from: string, to: string, overrides: Partial<CallEdge> = {}): CallEdge {
  return { from, to, callKind: "direct", confidence: "confirmed", evidence: [`${from}->${to}`], ...overrides };
}

export interface TestMapOptions {
  nodes?: CallGraphNode[];
  edges?: CallEdge[];
  files?: FileEntry[];
  /** Shallow per-top-level-key overrides applied last. */
  overrides?: Partial<StaticContextMap>;
}

/**
 * A minimal, schema-v1-valid StaticContextMap. Defaults are empty; pass nodes/edges
 * for graph-shaped tests and files for category-sensitive capabilities (test paths).
 */
export function testContextMap(opts: TestMapOptions = {}): StaticContextMap {
  const files = opts.files ?? [];
  return {
    meta: {
      schemaVersion: 1,
      toolVersion: "0.1.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      repositoryRoot: "/test-repo",
      mapHash: "test-map-hash",
      codebaseOnlyBoundary: true
    },
    summary: {
      totalFiles: files.length,
      categories: { source: 0, test: 0, config: 0, documentation: 0, context: 0, generated: 0, other: 0 },
      languages: {},
      importantFiles: [],
      entryPoints: [],
      modules: [],
      ownershipSignals: [],
      excluded: { source: "none", languages: [], excludeDirs: [], patterns: [], scopeHash: "test-scope", dirs: [], fileCount: 0 }
    },
    files,
    callGraph: { nodes: opts.nodes ?? [], edges: opts.edges ?? [] },
    findings: {
      canonicalPaths: [],
      duplicatePathCandidates: [],
      legacyPathCandidates: [],
      riskAreas: [],
      uncertainty: []
    },
    ...opts.overrides
  };
}
