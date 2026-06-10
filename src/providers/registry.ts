// Provider registry + selection (Decision 0013). First-match-wins in registry
// order; the generic heuristic provider is LAST so it only claims files no
// language-specific provider took. Non-analyzable files (binary/over-cap,
// Decision 0010) are never handed to a provider.

import type { FileEntry } from "../schema.js";
import type { LanguageProvider } from "./types.js";
import { typeScriptProvider } from "./typescript.js";
import { csharpProvider } from "./csharp.js";
import { treeSitterProvider } from "./treeSitter.js";
import { heuristicProvider } from "./heuristic.js";

/**
 * Ordered registry. Language-specific providers first; the heuristic floor LAST.
 * The C# Roslyn tier sits ahead of tree-sitter and only claims .cs files when the
 * `dotnet` CLI is available (ADR 0027) — otherwise tree-sitter keeps them.
 */
export const PROVIDERS: readonly LanguageProvider[] = [typeScriptProvider, csharpProvider, treeSitterProvider, heuristicProvider];

/** The provider that claims a file: first in registry order whose `matches()` is true. */
export function selectProvider(file: FileEntry): LanguageProvider {
  // The heuristic floor matches everything, so a provider is always found; guard for safety.
  return PROVIDERS.find((provider) => provider.matches(file)) ?? heuristicProvider;
}

/** Group analyzable files by selected provider. Non-analyzable files are skipped entirely. */
export function groupByProvider(files: FileEntry[]): Map<LanguageProvider, FileEntry[]> {
  const groups = new Map<LanguageProvider, FileEntry[]>();
  for (const file of files) {
    if (!file.analyzable) continue;
    const provider = selectProvider(file);
    const bucket = groups.get(provider);
    if (bucket) {
      bucket.push(file);
    } else {
      groups.set(provider, [file]);
    }
  }
  return groups;
}
