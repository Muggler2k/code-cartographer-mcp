// Findings derivation (D4, Decision 0017). Computes the five `findings` arrays from the
// in-memory provider aggregate (declarations + ownership + call edges) plus files/modules/
// entry points, with conservative, evidence-graded heuristics. Codebase-only: nothing
// executes the target; everything ≤ `candidate` for the inference itself; legacy code is
// never asserted dead (ADR 0001/0002, governance Statement 6).

import type {
  CanonicalPath,
  Confidence,
  DuplicatePath,
  EntryPoint,
  FileEntry,
  Finding,
  LegacyPath,
  LegacyReachability,
  ModuleGroup,
  OwnershipSignal,
  UncertaintyItem
} from "./schema.js";
import type { CallEdge, CallGraphNode } from "./schema.js";

export interface FindingsInput {
  files: FileEntry[];
  languages: Record<string, number>;
  modules: ModuleGroup[];
  entryPoints: EntryPoint[];
  ownershipSignals: OwnershipSignal[];
  declarations: CallGraphNode[];
  callEdges: CallEdge[];
}

export interface DerivedFindings {
  canonicalPaths: CanonicalPath[];
  duplicatePathCandidates: DuplicatePath[];
  legacyPathCandidates: LegacyPath[];
  riskAreas: Finding[];
  uncertainty: UncertaintyItem[];
}

const RANK: Record<Confidence, number> = { confirmed: 5, likely: 4, candidate: 3, unclear: 2, unresolved: 1 };
const TS_JS_RE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;
const LEGACY_NAME_RE = /(^|[/_.\-])(legacy|deprecated|old|obsolete|v\d+|_bak|backup)([/_.\-]|$)/i;
const RESOLVED_KINDS = new Set(["direct", "method"]);
const GOD_FILE_DECL_THRESHOLD = 25;

/** Weakest confidence in a set, capped at `candidate` (the build-time inference ceiling). */
function inferenceConfidence(levels: Confidence[]): Confidence {
  const weakest = levels.reduce<Confidence>((w, l) => (RANK[l] < RANK[w] ? l : w), "candidate");
  return RANK[weakest] <= RANK.candidate ? weakest : "candidate";
}

function bySymbol(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

const MODULE_OVERLAP_RATIO = 0.6;
const MAX_BYPASS_FINDINGS = 12;

const DUP_UNCERTAINTY: UncertaintyItem[] = [
  {
    item: "Behavioral equivalence of the duplicate candidates",
    reason: "Static name/shape match does not prove the implementations behave identically",
    requiredConfirmation: "Human/behavioral comparison or test execution"
  }
];

/** Per-class legacy recommendation + the mandatory in-record uncertainty. */
function legacyClass(reachability: LegacyReachability): { recommendation: string; uncertainty: UncertaintyItem[] } {
  const noDead: UncertaintyItem = {
    item: "Static absence of references does not prove dead code",
    reason: "Reflection, DI, framework dispatch, config, or out-of-scope callers are invisible to static analysis",
    requiredConfirmation: "Human confirmation / runtime usage check before removal"
  };
  switch (reachability) {
    case "still_reachable":
      return { recommendation: "Do not remove; still statically reachable. Migrate callers before deprecating.", uncertainty: [] };
    case "possibly_reachable":
      return { recommendation: "May be reached via dynamic dispatch, framework, DI, or an external consumer; confirm before changing.", uncertainty: [noDead] };
    case "replaced_but_present":
      return { recommendation: "A non-legacy implementation appears to own this behavior; verify full replacement, then retire.", uncertainty: [noDead] };
    case "apparently_unreachable":
      return { recommendation: "No static references found; cannot prove dead. Requires human confirmation before removal.", uncertainty: [noDead] };
    case "safe_removal_candidate":
      return { recommendation: "Strongest static removal candidate, but static analysis cannot prove no runtime/reflective use — requires human confirmation.", uncertainty: [noDead] };
    default:
      return { recommendation: "Insufficient static certainty to classify; human confirmation required.", uncertainty: [noDead] };
  }
}

export function deriveFindings(input: FindingsInput): DerivedFindings {
  const resolvedInbound = new Map<string, number>();
  const anyInbound = new Map<string, number>();
  for (const edge of input.callEdges) {
    anyInbound.set(edge.to, (anyInbound.get(edge.to) ?? 0) + 1);
    if (RESOLVED_KINDS.has(edge.callKind)) {
      resolvedInbound.set(edge.to, (resolvedInbound.get(edge.to) ?? 0) + 1);
    }
  }

  const ownByNodeId = new Map<string, OwnershipSignal>();
  for (const sig of input.ownershipSignals) {
    ownByNodeId.set(`${sig.path}#${sig.symbol}`, sig);
  }

  // Exported signals grouped by symbol name.
  const exportedByName = new Map<string, OwnershipSignal[]>();
  for (const sig of input.ownershipSignals) {
    if (!sig.exported) continue;
    const bucket = exportedByName.get(sig.symbol) ?? [];
    bucket.push(sig);
    exportedByName.set(sig.symbol, bucket);
  }

  const duplicatePathCandidates: DuplicatePath[] = [];
  const canonicalPaths: CanonicalPath[] = [];
  for (const [name, sigs] of exportedByName) {
    const paths = [...new Set(sigs.map((s) => s.path))];
    if (paths.length >= 2) {
      duplicatePathCandidates.push({
        id: `dup:name:${name}`,
        label: `Exported '${name}' declared in ${paths.length} locations`,
        confidence: inferenceConfidence(sigs.map((s) => s.confidence)),
        evidence: sigs.map((s) => `${s.symbol} (${s.kind}) exported from ${s.path} — ${resolvedInbound.get(`${s.path}#${s.symbol}`) ?? 0} resolved inbound`),
        risk: `Two or more exported symbols share the name '${name}'; callers may bind to different implementations and the two can diverge.`,
        uncertainty: DUP_UNCERTAINTY
      });
    } else {
      const sig = sigs[0];
      const id = `${sig.path}#${sig.symbol}`;
      const inbound = resolvedInbound.get(id) ?? 0;
      if (inbound > 0) {
        canonicalPaths.push({
          id,
          label: `${sig.symbol} (${sig.path})`,
          confidence: "candidate", // canonical ownership is a judgment, not a parsed fact (Decision 0016)
          evidence: [`sole exported declaration of '${name}'`, `${inbound} resolved inbound reference(s)`],
          risks: []
        });
      }
    }
  }

  // D3: parallel module structures — two source modules with heavily-overlapping file basenames
  // under different roots (e.g. an old/v1 area mirrored by a new/v2 one). Always `unclear`.
  const sourceModules = input.modules.filter((m) => m.category === "source");
  for (let i = 0; i < sourceModules.length; i++) {
    for (let j = i + 1; j < sourceModules.length; j++) {
      const a = sourceModules[i];
      const b = sourceModules[j];
      const baseA = new Set(a.files.map(basenameOf));
      const baseB = b.files.map(basenameOf);
      const overlap = baseB.filter((x) => baseA.has(x));
      const ratio = overlap.length / Math.max(1, Math.min(baseA.size, baseB.length));
      const legacyPair = LEGACY_NAME_RE.test(a.root) !== LEGACY_NAME_RE.test(b.root);
      if (overlap.length >= 2 && (ratio >= MODULE_OVERLAP_RATIO || legacyPair)) {
        duplicatePathCandidates.push({
          id: `dup:mod:${a.root}~${b.root}`,
          label: `Parallel module structure: ${a.root} ~ ${b.root}`,
          confidence: "unclear", // structural mirroring is a weak, lexical signal
          evidence: [`${overlap.length} shared basenames: ${overlap.slice(0, 8).join(", ")}`, `roots: ${a.root}, ${b.root}`],
          risk: "Two module trees share structure; a change to one may need mirroring in the other, and they can drift.",
          uncertainty: DUP_UNCERTAINTY
        });
      }
    }
  }

  // Legacy candidates: only declarations carrying a legacy naming signal (conservative — never
  // floods on bare zero-inbound). Classified into the six-class taxonomy; never claims dead code.
  // Index declarations by symbol name to detect a non-legacy "replacement" sibling.
  const declsBySymbol = new Map<string, CallGraphNode[]>();
  for (const decl of input.declarations) {
    (declsBySymbol.get(decl.symbol) ?? declsBySymbol.set(decl.symbol, []).get(decl.symbol)!).push(decl);
  }
  const isLegacyNamed = (d: { path: string; symbol: string }): boolean => LEGACY_NAME_RE.test(d.path) || LEGACY_NAME_RE.test(d.symbol);

  const legacyPathCandidates: LegacyPath[] = [];
  for (const decl of input.declarations) {
    if (!isLegacyNamed(decl)) continue;
    const resolved = resolvedInbound.get(decl.id) ?? 0;
    const any = anyInbound.get(decl.id) ?? 0;
    const exported = ownByNodeId.get(decl.id)?.exported ?? false;
    const isHeuristic = !TS_JS_RE.test(decl.path);
    // A live, non-legacy sibling of the same name suggests this legacy decl was replaced.
    const replacedBySibling =
      resolved === 0 &&
      (declsBySymbol.get(decl.symbol) ?? []).some((s) => s.id !== decl.id && !isLegacyNamed(s) && (resolvedInbound.get(s.id) ?? 0) > 0);

    // NOTE: `safe_removal_candidate` is deliberately never produced — the product never asserts a
    // symbol is safe to delete from static absence of references (governance Statement 6). The most
    // aggressive class we emit is `apparently_unreachable`, always with a human-confirmation caveat.
    let reachability: LegacyReachability;
    if (isHeuristic) {
      reachability = "requires_human_confirmation"; // heuristic tier never reaches the aggressive classes
    } else if (resolved > 0) {
      reachability = "still_reachable";
    } else if (replacedBySibling) {
      reachability = "replaced_but_present"; // a non-legacy same-named impl has live callers
    } else if (any > 0 || exported) {
      reachability = "possibly_reachable"; // only dynamic/framework inbound, or exported (external/dynamic consumer)
    } else {
      reachability = "apparently_unreachable"; // zero inbound, not exported — still NOT dead, just unreferenced
    }
    const { recommendation, uncertainty } = legacyClass(reachability);
    legacyPathCandidates.push({
      id: decl.id,
      label: `${decl.symbol} (${decl.path})`,
      reachability,
      evidence: [
        "legacy naming signal in path/symbol",
        `${resolved} resolved inbound, ${any} total inbound`,
        exported ? "exported" : "not exported",
        isHeuristic ? "heuristic-provider tier" : "TS/JS-provider tier"
      ],
      recommendation,
      uncertainty
    });
  }

  // Risk areas: god-files (declaration-count hotspots).
  const declCountByPath = new Map<string, number>();
  for (const decl of input.declarations) {
    declCountByPath.set(decl.path, (declCountByPath.get(decl.path) ?? 0) + 1);
  }
  const riskAreas: Finding[] = [];
  for (const [path, count] of declCountByPath) {
    if (count < GOD_FILE_DECL_THRESHOLD) continue;
    const exportedCount = input.ownershipSignals.filter((s) => s.path === path && s.exported).length;
    riskAreas.push({
      finding: `${path} declares ${count} symbols (${exportedCount} exported) — a concentration hotspot.`,
      confidence: "candidate",
      evidence: [`${count} declarations`, `${exportedCount} exported`],
      risk: "High-fan-in/out file; small edits have a wide blast radius and many reviewers.",
      recommendation: "Consider splitting by responsibility; treat as high-impact in change review.",
      uncertainty: [
        {
          item: "Whether the concentration is a deliberate facade/barrel file",
          reason: "A re-export barrel can look like a god-file statically",
          requiredConfirmation: "Human review of the file's role"
        }
      ]
    });
  }

  // R3: bypassed abstraction — a cross-file resolved call reaches an INTERNAL (non-exported)
  // symbol in a file that DOES expose a public API; the caller skipped the intended surface.
  const exportedNodeIds = new Set(input.ownershipSignals.filter((s) => s.exported).map((s) => `${s.path}#${s.symbol}`));
  const filesWithExports = new Set(input.ownershipSignals.filter((s) => s.exported).map((s) => s.path));
  const seenBypass = new Set<string>();
  for (const edge of input.callEdges) {
    if (seenBypass.size >= MAX_BYPASS_FINDINGS) break; // bound noise from a single dense repo
    if (edge.callKind !== "direct" && edge.callKind !== "method") continue;
    if (exportedNodeIds.has(edge.to)) continue; // target is the public API, not an internal
    const fromPath = edge.from.slice(0, edge.from.lastIndexOf("#"));
    const toPath = edge.to.slice(0, edge.to.lastIndexOf("#"));
    if (!toPath || fromPath === toPath) continue; // same-file internal use is fine
    if (!filesWithExports.has(toPath)) continue; // the target file exposes a public surface
    const key = `${fromPath}|${edge.to}`;
    if (seenBypass.has(key)) continue;
    seenBypass.add(key);
    riskAreas.push({
      finding: `${fromPath} calls internal ${edge.to.slice(edge.to.lastIndexOf("#") + 1)} in ${toPath}, which exposes a public API — possible bypassed abstraction.`,
      confidence: inferenceConfidence([edge.confidence]),
      evidence: [`${edge.from} → ${edge.to} (${edge.callKind})`, `${toPath} exports a public surface the caller could have used`],
      risk: "Bypassing the public surface couples callers to internals and defeats the module boundary.",
      recommendation: "Route the call through the exported API, or promote the internal symbol intentionally.",
      uncertainty: [
        {
          item: "Whether the bypass is sanctioned (e.g. perf or intra-package use)",
          reason: "Static structure cannot read intent or visibility conventions across the language",
          requiredConfirmation: "Human / architecture confirmation"
        }
      ]
    });
  }

  // Map-wide uncertainty register.
  const uncertainty: UncertaintyItem[] = [
    {
      item: "Reachability and change-impact are not runtime-proven",
      reason: "All findings are static inferences (ADR 0001/0002)",
      requiredConfirmation: "Test execution / runtime tracing"
    }
  ];
  if (input.files.some((f) => f.analyzable && !TS_JS_RE.test(f.path))) {
    uncertainty.push({
      item: "Some files were analyzed by the heuristic (text-only) provider",
      reason: "Their call edges and exports are suggested, not parsed (Decision 0012/0013)",
      requiredConfirmation: "Add a language-specific provider or human review"
    });
  }
  if (input.callEdges.some((e) => e.callKind === "dynamic" || e.callKind === "framework" || e.callKind === "unresolved")) {
    uncertainty.push({
      item: "Dynamic / framework / unresolved call edges are present",
      reason: "These cannot be statically resolved to a target",
      requiredConfirmation: "Runtime confirmation of the actual call target"
    });
  }

  return {
    canonicalPaths: canonicalPaths.sort(bySymbol),
    duplicatePathCandidates: duplicatePathCandidates.sort(bySymbol),
    legacyPathCandidates: legacyPathCandidates.sort(bySymbol),
    riskAreas,
    uncertainty
  };
}
