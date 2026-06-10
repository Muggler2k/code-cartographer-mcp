// Language provider contract (Decision 0013). A provider turns its owned,
// analyzable files into confidence-graded structure: declarations, ownership
// signals, entry-point hints, and static call edges. The engine clamps every
// emitted record to the provider's `maxConfidence` ceiling (Decision 0012), so
// a heuristic guess can never masquerade as a parsed fact. Codebase-only:
// providers read files statically and never execute the target.

import type { Confidence, EntryPoint, FileEntry, OwnershipSignal } from "../schema.js";
import type { CallEdge, CallGraphNode } from "../schema.js";

/** Everything a provider needs to analyze its slice of the repo. */
export interface ProviderInput {
  repositoryRoot: string;
  /** Only the files this provider matched, and only analyzable ones (Decision 0010). */
  files: FileEntry[];
  /** Read a file's text by repo-relative POSIX path. */
  readFile(path: string): Promise<string>;
}

/** What a provider extracts from its file set. Record shapes reuse the ratified types. */
export interface ProviderExtraction {
  /** Every declared symbol (the call-graph node set for these files). */
  declarations: CallGraphNode[];
  /** The exported subset — "who owns this API". */
  ownershipSignals: OwnershipSignal[];
  /** Candidate entry points discovered in these files. */
  entryPointHints: EntryPoint[];
  /** Static call edges; dynamic/DI/reflection/framework edges are graded down. */
  callEdges: CallEdge[];
}

export interface LanguageProvider {
  /** Stable id, e.g. "typescript" | "heuristic". */
  id: string;
  /** True if this provider claims the file (by extension/predicate). */
  matches(file: FileEntry): boolean;
  /** Confidence ceiling: the engine clamps every record from this provider to ≤ this. */
  maxConfidence: Confidence;
  /** Build a cross-file model from the whole owned set, then extract (Decision 0013). */
  analyze(input: ProviderInput): Promise<ProviderExtraction>;
}
