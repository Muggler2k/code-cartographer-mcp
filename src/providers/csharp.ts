// C#/VB provider (CAS ADRs 0027/0033): a `confirmed`-ceiling tier backed by a Roslyn
// sidecar (tools/roslyn-analyzer), mirroring the TS provider's compiler-API semantics —
// one ad-hoc compilation PER LANGUAGE over the batch (Roslyn cannot mix C# and VB trees,
// so cross-language calls stay `unresolved#name`, disclosed), semantic-model-resolved
// cross-file edges, virtual/interface dispatch capped at `likely`. STRICTLY OPTIONAL:
// `matches()` only claims .cs/.vb files when the `dotnet` CLI is available, so without a
// .NET SDK the registry falls through (C# → tree-sitter; VB → the heuristic floor — no
// maintained tree-sitter VB grammar exists). Any sidecar failure degrades to an empty
// extraction (the engine treats provider failure as "no extraction", ADR 0017).
// CODEBASE-ONLY: the sidecar parses source TEXTS we pass it; it never builds the target
// into a runnable form, executes target code, or loads target assemblies.

import { spawn, spawnSync } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { CallEdge, CallGraphNode, EntryPoint, OwnershipSignal, OwnershipSignalKind } from "../schema.js";
import { DATA_MEMBER_KINDS } from "../schema.js";
import type { LanguageProvider, ProviderExtraction, ProviderInput } from "./types.js";

const ANALYZER_DIR = fileURLToPath(new URL("../../tools/roslyn-analyzer", import.meta.url));
const BUILD_TIMEOUT_MS = 300_000; // first build includes a NuGet restore
const RUN_TIMEOUT_MS = 120_000;

// ---- Sidecar output shape (camelCase JSON from Program.cs) ----

interface SidecarDecl {
  id: string;
  symbol: string;
  path: string;
  kind: string;
  exported: boolean;
}
interface SidecarEdge {
  from: string;
  to: string;
  callKind: string;
  evidence: string;
}
interface SidecarResponse {
  declarations: SidecarDecl[];
  edges: SidecarEdge[];
  entryPoints: string[];
}

// ---- Optional-dependency probes (memoized per process) ----

let dotnetProbe: boolean | null = null;

/** True when the `dotnet` CLI responds — the gate for claiming .cs files (ADR 0027). */
export function dotnetAvailable(): boolean {
  if (dotnetProbe === null) {
    try {
      dotnetProbe = spawnSync("dotnet", ["--version"], { stdio: "ignore", timeout: 15_000, shell: false }).status === 0;
    } catch {
      dotnetProbe = false;
    }
  }
  return dotnetProbe;
}

let buildPromise: Promise<string | null> | null = null;

/** Newest built `RoslynAnalyzer.dll` under `bin/Release/<tfm>`, with its mtime; null if none. */
async function findAnalyzerDll(): Promise<{ dll: string; mtimeMs: number } | null> {
  const releaseDir = path.join(ANALYZER_DIR, "bin", "Release");
  let best: { dll: string; mtimeMs: number } | null = null;
  try {
    for (const tfm of await fs.readdir(releaseDir)) {
      const dll = path.join(releaseDir, tfm, "RoslynAnalyzer.dll");
      try {
        const st = await fs.stat(dll);
        if (!best || st.mtimeMs > best.mtimeMs) best = { dll, mtimeMs: st.mtimeMs };
      } catch {
        /* try the next target-framework dir */
      }
    }
  } catch {
    /* no Release dir yet */
  }
  return best;
}

/** mtime of the newest sidecar build input (.cs/.csproj/…) under `dir`, excluding bin/obj. */
async function newestSourceMtime(dir: string): Promise<number> {
  let newest = 0;
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.name === "bin" || entry.name === "obj") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestSourceMtime(full));
      // Build inputs: sources + project/MSBuild files + restore config. (A `Directory.Build.*` ABOVE
      // ANALYZER_DIR isn't tracked here; none exists, and the cold `dotnet build` would still pick
      // up such a change once any tracked input also changes.)
    } else if (/\.(cs|csproj|props|targets)$/i.test(entry.name) || /^(global\.json|nuget\.config)$/i.test(entry.name)) {
      try {
        newest = Math.max(newest, (await fs.stat(full)).mtimeMs);
      } catch {
        /* ignore an unreadable source file */
      }
    }
  }
  return newest;
}

/** Build the sidecar once per process; resolve to the dll path, or null when unusable. */
function ensureAnalyzerBuilt(): Promise<string | null> {
  if (!buildPromise) {
    buildPromise = (async () => {
      // Reuse an already-built dll only when it is STRICTLY newer than every build input. A CI
      // pre-build step (whose dll is newer than the freshly-checked-out sources) then lets every
      // parallel vitest worker SKIP the build, so they never race `dotnet build` on shared bin/obj
      // MSBuild locks — the cause of intermittent C#/VB sidecar test failures. Strict `>` biases
      // toward a rebuild on an mtime tie (a stale dll is never served); the conservative cost is a
      // rare extra build, never a wrong result. A cold local run with no pre-build still has each
      // worker build (with the retry below) — that race predates this and is unaffected.
      const cached = await findAnalyzerDll();
      if (cached && cached.mtimeMs > (await newestSourceMtime(ANALYZER_DIR))) {
        return cached.dll;
      }
      // No fresh dll: build, with one delayed retry for the cold-start race that remains when
      // several workers reach this point at once (MSBuild file locks can transiently fail one).
      let build = await run("dotnet", ["build", "-c", "Release", "--nologo", "-v", "q"], ANALYZER_DIR, BUILD_TIMEOUT_MS);
      if (build.code !== 0) {
        await new Promise((r) => setTimeout(r, 2_000));
        build = await run("dotnet", ["build", "-c", "Release", "--nologo", "-v", "q"], ANALYZER_DIR, BUILD_TIMEOUT_MS);
      }
      if (build.code !== 0) return null;
      return (await findAnalyzerDll())?.dll ?? null;
    })();
  }
  return buildPromise;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

// ---- Mapping sidecar output to the provider extraction ----

const SIGNAL_KINDS: ReadonlySet<string> = new Set(["class", "const", "enum", "field", "function", "interface", "property", "type"]);

// The sidecar contract emits class|interface|enum|type|function|property|field; the fallback
// only guards a future sidecar kind we have not mapped yet (it must never throw mid-build).
function toKind(kind: string): OwnershipSignalKind {
  return (SIGNAL_KINDS.has(kind) ? kind : "const") as OwnershipSignalKind;
}

function toEdge(edge: SidecarEdge): CallEdge {
  // Mirror ADR 0018: resolved non-virtual → confirmed; virtual/interface dispatch is
  // runtime-polymorphic → likely; everything else stays unresolved.
  const callKind = edge.callKind === "direct" || edge.callKind === "method" ? edge.callKind : "unresolved";
  return {
    from: edge.from,
    to: edge.to,
    callKind,
    confidence: callKind === "direct" ? "confirmed" : callKind === "method" ? "likely" : "unresolved",
    evidence: [edge.evidence]
  };
}

const EMPTY: ProviderExtraction = { declarations: [], ownershipSignals: [], entryPointHints: [], callEdges: [] };

export const csharpProvider: LanguageProvider = {
  id: "csharp-roslyn",
  maxConfidence: "confirmed",
  matches(file): boolean {
    // .vb joins the same sidecar (ADR 0033) — separate compilations inside, so a
    // mixed batch is fine; without the SDK, C# falls to tree-sitter and VB to the
    // heuristic floor (no maintained tree-sitter VB grammar).
    return (file.path.endsWith(".cs") || file.path.endsWith(".vb")) && dotnetAvailable();
  },
  async analyze(input: ProviderInput): Promise<ProviderExtraction> {
    const dll = await ensureAnalyzerBuilt();
    if (!dll) return { declarations: [], ownershipSignals: [], entryPointHints: [], callEdges: [] };

    // Pass file TEXTS (not paths) so the sidecar never touches the target filesystem
    // and the provider honors the `readFile` contract (Decision 0013).
    const files: { path: string; text: string }[] = [];
    for (const file of input.files) {
      try {
        files.push({ path: file.path, text: await input.readFile(file.path) });
      } catch {
        /* unreadable file → not in the batch */
      }
    }
    if (files.length === 0) return { ...EMPTY };

    const requestPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ccm-roslyn-")), "request.json");
    let response: SidecarResponse;
    try {
      await fs.writeFile(requestPath, JSON.stringify({ files }));
      const result = await run("dotnet", [dll, requestPath], ANALYZER_DIR, RUN_TIMEOUT_MS);
      if (result.code !== 0) return { ...EMPTY };
      response = JSON.parse(result.stdout) as SidecarResponse;
    } catch {
      return { ...EMPTY }; // sidecar crash / malformed output → empty extraction, never throw
    } finally {
      await fs.rm(path.dirname(requestPath), { recursive: true, force: true });
    }

    const declarations: CallGraphNode[] = [];
    const ownershipSignals: OwnershipSignal[] = [];
    for (const decl of response.declarations ?? []) {
      const kind = toKind(decl.kind);
      if (!DATA_MEMBER_KINDS.has(kind)) {
        declarations.push({ id: decl.id, symbol: decl.symbol, path: decl.path, kind, confidence: "confirmed" });
      }
      ownershipSignals.push({
        symbol: decl.symbol,
        kind,
        path: decl.path,
        exported: decl.exported,
        confidence: "confirmed",
        reason: decl.exported ? "public declaration (Roslyn)" : "non-public declaration (Roslyn)"
      });
    }
    const entryPointHints: EntryPoint[] = (response.entryPoints ?? []).map((p) => ({
      path: p,
      kind: "source_entry",
      confidence: "likely",
      reason: p.endsWith(".vb")
        ? "VB entry point (shared Sub Main)"
        : "C# entry point (static Main or top-level statements)"
    }));

    return {
      declarations,
      ownershipSignals,
      entryPointHints,
      callEdges: (response.edges ?? []).map(toEdge)
    };
  }
};
