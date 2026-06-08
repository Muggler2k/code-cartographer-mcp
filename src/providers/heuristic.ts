// Generic heuristic provider (Decision 0012/0013/0018): the universal floor. Claims
// any analyzable file no language-specific provider took, and extracts structure from
// TEXT/regex signals only — no parser, no AST, no execution. Per Decision 0013 the
// engine clamps every record to `maxConfidence: "candidate"`; this provider still grades
// honestly (declarations candidate; exports candidate/unclear; call edges
// direct-candidate same-file / unresolved cross-file) so the clamp is a guardrail.

import type { Confidence, FileEntry, OwnershipSignal, OwnershipSignalKind } from "../contextMap.js";
import type { CallEdge, CallEdgeKind, CallGraphNode } from "../callGraph.js";
import type { LanguageProvider, ProviderExtraction, ProviderInput } from "./types.js";

interface DeclPattern {
  kind: OwnershipSignalKind;
  /** First capture group = symbol name; tested per trimmed line. */
  regex: RegExp;
}

interface LanguageSpec {
  extensions: string[];
  declarations: DeclPattern[];
  /** Best-effort export/visibility guess from the raw line + symbol. */
  exported: (line: string, symbol: string) => boolean;
}

const PY: LanguageSpec = {
  extensions: [".py"],
  declarations: [
    { kind: "class", regex: /^class\s+([A-Za-z_]\w*)/ },
    { kind: "function", regex: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ }
  ],
  exported: (_line, symbol) => !symbol.startsWith("_")
};

const GO: LanguageSpec = {
  extensions: [".go"],
  declarations: [
    { kind: "function", regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: "class", regex: /^type\s+([A-Za-z_]\w*)\s+struct\b/ },
    { kind: "interface", regex: /^type\s+([A-Za-z_]\w*)\s+interface\b/ },
    { kind: "type", regex: /^type\s+([A-Za-z_]\w*)\s+/ }
  ],
  exported: (_line, symbol) => /^[A-Z]/.test(symbol)
};

const RUST: LanguageSpec = {
  extensions: [".rs"],
  declarations: [
    { kind: "function", regex: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: "class", regex: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: "enum", regex: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: "interface", regex: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/ },
    { kind: "type", regex: /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/ }
  ],
  exported: (line) => /^\s*pub(\s|\()/.test(line)
};

const JAVA_CS: LanguageSpec = {
  extensions: [".java", ".cs"],
  declarations: [
    { kind: "class", regex: /\bclass\s+([A-Za-z_]\w*)/ },
    { kind: "interface", regex: /\binterface\s+([A-Za-z_]\w*)/ },
    { kind: "enum", regex: /\benum\s+([A-Za-z_]\w*)/ },
    { kind: "function", regex: /^(?:public|private|protected|static|final|abstract|synchronized|virtual|override|\s)*[\w<>\[\].]+\s+([A-Za-z_]\w*)\s*\(/ }
  ],
  exported: (line) => /\bpublic\b/.test(line)
};

const RUBY: LanguageSpec = {
  extensions: [".rb"],
  declarations: [
    { kind: "class", regex: /^class\s+([A-Za-z_]\w*)/ },
    { kind: "class", regex: /^module\s+([A-Za-z_]\w*)/ },
    { kind: "function", regex: /^def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/ }
  ],
  exported: () => false
};

const PHP: LanguageSpec = {
  extensions: [".php"],
  declarations: [
    { kind: "class", regex: /^(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/ },
    { kind: "interface", regex: /^(?:interface|trait)\s+([A-Za-z_]\w*)/ },
    { kind: "function", regex: /^(?:public\s+|private\s+|protected\s+|static\s+)*function\s+&?\s*([A-Za-z_]\w*)/ }
  ],
  exported: (line) => !/\b(private|protected)\b/.test(line)
};

const GENERIC: LanguageSpec = {
  extensions: [],
  declarations: [
    { kind: "function", regex: /^(?:export\s+|pub\s+|public\s+)?(?:async\s+)?(?:def|fn|func|function)\s+([A-Za-z_]\w*)/ },
    { kind: "class", regex: /^(?:export\s+|pub\s+|public\s+)?(?:class|struct|module|record)\s+([A-Za-z_]\w*)/ },
    { kind: "interface", regex: /^(?:export\s+|pub\s+|public\s+)?(?:interface|trait|protocol)\s+([A-Za-z_]\w*)/ },
    { kind: "type", regex: /^(?:export\s+|pub\s+|public\s+)?type\s+([A-Za-z_]\w*)/ },
    { kind: "enum", regex: /^(?:export\s+|pub\s+|public\s+)?enum\s+([A-Za-z_]\w*)/ }
  ],
  exported: (line) => /^\s*(export|pub|public)\b/.test(line)
};

const SPECS: LanguageSpec[] = [PY, GO, RUST, JAVA_CS, RUBY, PHP];

/** Keywords that look like calls (`if (...)`) but are control flow, not invocations. */
const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "return", "catch", "with", "match", "foreach",
  "function", "def", "func", "fn", "class", "elif", "else", "when", "case", "do", "try"
]);

const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const METHOD_CALL_RE = /\.([A-Za-z_]\w*)\s*\(/g;

function specForExtension(extension: string): LanguageSpec {
  return SPECS.find((spec) => spec.extensions.includes(extension)) ?? GENERIC;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Strip a trailing line comment (best-effort; this is a heuristic, not a lexer). */
function stripComment(line: string): string {
  const hashOrSlash = line.search(/(#|\/\/)/);
  return hashOrSlash >= 0 ? line.slice(0, hashOrSlash) : line;
}

export const heuristicProvider: LanguageProvider = {
  id: "heuristic",
  maxConfidence: "candidate",
  matches(_file: FileEntry): boolean {
    return true; // the floor; reached only after specific providers decline (registry order)
  },
  async analyze(input: ProviderInput): Promise<ProviderExtraction> {
    const declarations: CallGraphNode[] = [];
    const ownershipSignals: OwnershipSignal[] = [];
    const callEdges: CallEdge[] = [];
    const entryPointHints: ProviderExtraction["entryPointHints"] = [];
    const seenNodeIds = new Set<string>();
    const seenEdgeKeys = new Set<string>();

    for (const file of input.files) {
      let text: string;
      try {
        text = await input.readFile(file.path);
      } catch {
        continue; // unreadable — degrade, never fail the whole map
      }
      const spec = specForExtension(extensionOf(file.path));
      const lines = text.replace(/\r\n?/g, "\n").split("\n");
      const localNames = new Set<string>(); // symbol names declared in THIS file

      // Pass 1: declarations + ownership.
      lines.forEach((raw, index) => {
        const line = stripComment(raw);
        const trimmed = line.trimStart();
        for (const pattern of spec.declarations) {
          const match = pattern.regex.exec(trimmed);
          if (match && match[1]) {
            const symbol = match[1];
            const id = `${file.path}#${symbol}`;
            if (seenNodeIds.has(id)) {
              break;
            }
            seenNodeIds.add(id);
            localNames.add(symbol);
            declarations.push({ id, symbol, path: file.path, kind: pattern.kind, confidence: "candidate" });
            const exported = spec.exported(line, symbol);
            ownershipSignals.push({
              symbol,
              kind: pattern.kind,
              path: file.path,
              exported,
              confidence: exported ? "candidate" : "unclear",
              reason: `heuristic ${spec === GENERIC ? "generic" : extensionOf(file.path)} declaration (line ${index + 1})`
            });
            break; // one declaration per line
          }
        }
      });

      // Pass 2: call edges. Enclosing decl = the most recent declaration above the line.
      let enclosing: string | null = null;
      lines.forEach((raw) => {
        const line = stripComment(raw);
        const trimmed = line.trimStart();
        for (const pattern of spec.declarations) {
          const match = pattern.regex.exec(trimmed);
          if (match && match[1]) {
            enclosing = `${file.path}#${match[1]}`;
            return; // declaration line is not also a call site
          }
        }
        if (enclosing === null) {
          return; // calls before any declaration are skipped (no real `from`)
        }
        const methodNames = new Set<string>();
        let m: RegExpExecArray | null;
        METHOD_CALL_RE.lastIndex = 0;
        while ((m = METHOD_CALL_RE.exec(line)) !== null) {
          methodNames.add(m[1]);
        }
        CALL_RE.lastIndex = 0;
        while ((m = CALL_RE.exec(line)) !== null) {
          const name = m[1];
          if (CALL_KEYWORDS.has(name)) {
            continue;
          }
          const isMethod = methodNames.has(name);
          const inFile = localNames.has(name);
          let to: string;
          let callKind: CallEdgeKind;
          let confidence: Confidence;
          if (isMethod) {
            to = `unresolved#${name}`;
            callKind = "method";
            confidence = "unclear";
          } else if (inFile) {
            to = `${file.path}#${name}`;
            callKind = "direct";
            confidence = "candidate";
          } else {
            to = `unresolved#${name}`;
            callKind = "unresolved";
            confidence = "unresolved";
          }
          const edgeKey = `${enclosing}|${to}|${callKind}`;
          if (seenEdgeKeys.has(edgeKey)) {
            continue;
          }
          seenEdgeKeys.add(edgeKey);
          callEdges.push({
            from: enclosing,
            to,
            callKind,
            confidence,
            evidence: [
              `${file.path}: ${name}(...)`,
              inFile ? "same-file name match (heuristic, not scope-resolved)" : "name-based call candidate; cross-file resolution not attempted by the heuristic provider"
            ]
          });
        }
      });

      // Entry-point hints (content + category signals).
      if (file.category === "test") {
        entryPointHints.push({ path: file.path, kind: "test_entry", confidence: "candidate", reason: "test-category file" });
      }
      if (/^\s*func\s+main\s*\(/m.test(text) || /if\s+__name__\s*==\s*["']__main__["']/.test(text) || /^\s*fn\s+main\s*\(/m.test(text)) {
        entryPointHints.push({ path: file.path, kind: "source_entry", confidence: "candidate", reason: "program entry signal (main)" });
      }
    }

    return { declarations, ownershipSignals, entryPointHints, callEdges };
  }
};
