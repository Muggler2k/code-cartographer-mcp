// TypeScript/JavaScript provider (Decision 0012/0013/0018). High fidelity: builds ONE
// in-memory ts.Program + TypeChecker over its whole owned file set (batch-per-language)
// from a custom CompilerHost backed by ProviderInput.readFile — no disk, no node_modules,
// no lib (noLib), no emit, no execution. Walks each SourceFile once to emit confirmed
// declarations (path#symbol), export-graded ownership signals, entry-point hints, and
// checker-resolved call edges. A DIRECT call to an owned single declaration is confirmed;
// METHOD calls cap at `likely` (virtual dispatch — a subclass/interface/Proxy can intercept
// at runtime, so it is never statically confirmed); computed-member/call-of-call are
// dynamic/candidate; unresolved/external are unresolved. Only TOP-LEVEL declarations are
// emitted as nodes (local variables/functions inside bodies are not module declarations).

import * as ts from "typescript";
import * as path from "node:path";

import type { Confidence, EntryPoint, FileEntry, OwnershipSignal, OwnershipSignalKind } from "../schema.js";
import type { CallEdge, CallEdgeKind, CallGraphNode } from "../schema.js";
import type { LanguageProvider, ProviderExtraction, ProviderInput } from "./types.js";

const TS_JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const norm = (p: string): string => p.replace(/\\/g, "/");

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface Built {
  program: ts.Program;
  checker: ts.TypeChecker;
  absToRel: Map<string, string>;
}

function buildProgram(repositoryRoot: string, files: FileEntry[], textByRel: Map<string, string>): Built {
  // Resolve to consistent ABSOLUTE forward-slash paths so the compiler's internal module
  // resolution matches our in-memory file map (a relative root like "." otherwise mismatches).
  const root = norm(path.resolve(repositoryRoot));
  const absToRel = new Map<string, string>();
  const textByAbs = new Map<string, string>();
  for (const file of files) {
    const abs = norm(path.resolve(repositoryRoot, file.path));
    absToRel.set(abs, file.path);
    textByAbs.set(abs, textByRel.get(file.path) ?? "");
  }
  const rootNames = [...absToRel.keys()].sort();
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
    noEmit: true,
    skipLibCheck: true,
    allowNonTsExtensions: true,
    isolatedModules: false,
    forceConsistentCasingInFileNames: false
  };
  const host: ts.CompilerHost = {
    getSourceFile(fileName, languageVersion) {
      const text = textByAbs.get(norm(fileName));
      if (text === undefined) return undefined;
      return ts.createSourceFile(norm(fileName), text, languageVersion, true, scriptKind(fileName));
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => root,
    getDirectories: () => [],
    fileExists: (fileName) => textByAbs.has(norm(fileName)),
    readFile: (fileName) => textByAbs.get(norm(fileName)),
    getCanonicalFileName: (fileName) => norm(fileName),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n"
  };
  const program = ts.createProgram({ rootNames, options, host });
  return { program, checker: program.getTypeChecker(), absToRel };
}

/** Map a declaration node to (symbol name, OwnershipSignalKind, callable?). */
function declOf(node: ts.Node): { name: string; kind: OwnershipSignalKind; callable: boolean } | null {
  if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name.text, kind: "function", callable: true };
  if (ts.isClassDeclaration(node) && node.name) return { name: node.name.text, kind: "class", callable: false };
  if (ts.isInterfaceDeclaration(node)) return { name: node.name.text, kind: "interface", callable: false };
  if (ts.isTypeAliasDeclaration(node)) return { name: node.name.text, kind: "type", callable: false };
  if (ts.isEnumDeclaration(node)) return { name: node.name.text, kind: "enum", callable: false };
  return null;
}

function symbolOf(checker: ts.TypeChecker, node: ts.Node, nameNode?: ts.Node): ts.Symbol | undefined {
  // Prefer the public checker API; fall back to the binder symbol only when there is no name node.
  return (nameNode ? checker.getSymbolAtLocation(nameNode) : undefined) ?? (node as { symbol?: ts.Symbol }).symbol;
}

/** Kind for a re-exported alias (Decision 0026): resolve the alias and map its symbol flags. */
function reExportKind(checker: ts.TypeChecker, sym: ts.Symbol): OwnershipSignalKind {
  let resolved = sym;
  if (resolved.flags & ts.SymbolFlags.Alias) {
    try {
      resolved = checker.getAliasedSymbol(resolved);
    } catch {
      /* keep the alias symbol — flags below fall through to "const" */
    }
  }
  const flags = resolved.flags;
  if (flags & ts.SymbolFlags.Class) return "class";
  if (flags & ts.SymbolFlags.Interface) return "interface";
  if (flags & ts.SymbolFlags.TypeAlias) return "type";
  if (flags & ts.SymbolFlags.Enum) return "enum";
  if (flags & ts.SymbolFlags.Function) return "function";
  return "const";
}

export const typeScriptProvider: LanguageProvider = {
  id: "typescript",
  maxConfidence: "confirmed",
  matches(file: FileEntry): boolean {
    return TS_JS_EXTENSIONS.some((ext) => file.path.endsWith(ext));
  },
  async analyze(input: ProviderInput): Promise<ProviderExtraction> {
    const declarations: CallGraphNode[] = [];
    const ownershipSignals: OwnershipSignal[] = [];
    const entryPointHints: EntryPoint[] = [];
    const callEdges: CallEdge[] = [];

    let built: Built;
    try {
      const textByRel = new Map<string, string>();
      await Promise.all(
        input.files.map(async (file) => {
          try {
            textByRel.set(file.path, await input.readFile(file.path));
          } catch {
            textByRel.set(file.path, "");
          }
        })
      );
      built = buildProgram(input.repositoryRoot, input.files, textByRel);
    } catch {
      return { declarations, ownershipSignals, entryPointHints, callEdges }; // never throw out of analyze
    }
    const { program, checker, absToRel } = built;

    const symbolToNodeId = new Map<ts.Symbol, string>();
    const seenNodeIds = new Set<string>();
    const seenEdges = new Set<string>();

    const indexSymbol = (sym: ts.Symbol | undefined, id: string): void => {
      if (sym && !symbolToNodeId.has(sym)) symbolToNodeId.set(sym, id);
    };

    const fileCategory = new Map(input.files.map((f) => [f.path, f.category]));

    for (const sourceFile of program.getSourceFiles()) {
      const rel = absToRel.get(norm(sourceFile.fileName));
      if (rel === undefined) continue; // skip synthetic/lib files

      // Exported-symbol set for this module (covers `export {}` / default).
      const exportedNames = new Set<string>();
      const exportSymbols: ts.Symbol[] = [];
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (moduleSymbol) {
        for (const exp of checker.getExportsOfModule(moduleSymbol)) {
          exportedNames.add(exp.name);
          exportSymbols.push(exp);
        }
      }
      const isExported = (node: ts.Node, name: string): boolean => {
        const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
        if (flags & ts.ModifierFlags.Export || flags & ts.ModifierFlags.Default) return true;
        return exportedNames.has(name);
      };

      const emitDecl = (name: string, kind: OwnershipSignalKind, node: ts.Node, nameNode: ts.Node | undefined, exported: boolean): string => {
        const id = `${rel}#${name}`;
        if (!seenNodeIds.has(id)) {
          seenNodeIds.add(id);
          declarations.push({ id, symbol: name, path: rel, kind, confidence: "confirmed" });
          ownershipSignals.push({
            symbol: name,
            kind,
            path: rel,
            exported,
            confidence: "confirmed",
            reason: exported ? "exported declaration" : "module-private declaration"
          });
        }
        indexSymbol(symbolOf(checker, node, nameNode), id);
        return id;
      };

      // First pass: emit TOP-LEVEL declarations (+ class members) and index their symbols.
      // Local declarations inside function/method bodies are NOT module declarations, so they
      // are not emitted as nodes (avoids polluting the graph + symbol index with locals).
      const visitDecl = (node: ts.Node, depth: number): void => {
        const topLevel = depth === 1; // direct children of the SourceFile (or namespace body)
        const info = declOf(node);
        if (info && topLevel) {
          const nameNode = (node as ts.NamedDeclaration).name;
          emitDecl(info.name, info.kind, node, nameNode, isExported(node, info.name));
          if (ts.isClassDeclaration(node)) {
            for (const member of node.members) {
              if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name && ts.isIdentifier(member.name)) {
                const memberName = `${info.name}.${member.name.text}`;
                const exported = isExported(node, info.name) && !(ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
                emitDecl(memberName, "function", member, member.name, exported);
              }
            }
          }
        }
        if (ts.isVariableStatement(node) && topLevel) {
          for (const d of node.declarationList.declarations) {
            if (ts.isIdentifier(d.name)) {
              emitDecl(d.name.text, "const", d, d.name, isExported(node, d.name.text));
            }
          }
        }
        ts.forEachChild(node, (child) => visitDecl(child, depth + 1));
      };
      visitDecl(sourceFile, 0);

      // Re-export visibility (Decision 0026): an exported name with NO local declaration is an
      // alias re-exported from another module (`export { x } from`, `export * from`,
      // import-then-export). Emit an ownership signal so the file's public surface is visible to
      // ownership analysis, but NO call-graph node — an alias is not a declaration. `default`
      // is skipped (a re-exported default carries no usable symbol name).
      for (const exp of exportSymbols) {
        if (exp.name === "default") continue;
        if (seenNodeIds.has(`${rel}#${exp.name}`)) continue;
        ownershipSignals.push({
          symbol: exp.name,
          kind: reExportKind(checker, exp),
          path: rel,
          exported: true,
          confidence: "confirmed",
          reason: "re-export",
          reExport: true
        });
      }

      // Entry-point hints.
      if (fileCategory.get(rel) === "test") {
        entryPointHints.push({ path: rel, kind: "test_entry", confidence: "likely", reason: "test-category source file" });
      }
    }

    // Second pass (all symbols now indexed): emit call edges with enclosing-function `from`.
    for (const sourceFile of program.getSourceFiles()) {
      const rel = absToRel.get(norm(sourceFile.fileName));
      if (rel === undefined) continue;

      const enclosingId = (node: ts.Node): string | null => {
        // nearest enclosing function-like declaration -> its node id
        let cur: ts.Node | undefined = node;
        while (cur) {
          if (ts.isFunctionDeclaration(cur) && cur.name) return `${rel}#${cur.name.text}`;
          if ((ts.isMethodDeclaration(cur) || ts.isGetAccessorDeclaration(cur) || ts.isSetAccessorDeclaration(cur)) && cur.name && ts.isIdentifier(cur.name)) {
            const cls = cur.parent;
            if ((ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name) return `${rel}#${cls.name.text}.${cur.name.text}`;
            return null; // anonymous-class method has no stable id — drop the edge, never misattribute
          }
          if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && cur.initializer && (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))) {
            return `${rel}#${cur.name.text}`;
          }
          cur = cur.parent;
        }
        return null;
      };

      const visitCall = (node: ts.Node): void => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const from = enclosingId(node);
          if (from) emitEdgeFor(sourceFile, rel, from, node);
        }
        ts.forEachChild(node, visitCall);
      };

      // Bind emitEdge to this source file (gradeCall closure was per-file in pass 1; rebuild here).
      const emitEdgeFor = (sf: ts.SourceFile, relPath: string, from: string, call: ts.CallExpression | ts.NewExpression): void => {
        const callee = call.expression;
        let to: string;
        let callKind: CallEdgeKind;
        let confidence: Confidence;
        if (ts.isElementAccessExpression(callee)) {
          to = "unresolved#<computed>";
          callKind = "dynamic";
          confidence = "candidate";
        } else {
          const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : undefined;
          const isMethod = ts.isPropertyAccessExpression(callee);
          if (!nameNode) {
            to = "unresolved#<expr>";
            callKind = "dynamic";
            confidence = "candidate";
          } else {
            let sym = checker.getSymbolAtLocation(nameNode);
            if (sym && sym.flags & ts.SymbolFlags.Alias) {
              try {
                sym = checker.getAliasedSymbol(sym);
              } catch {
                /* keep alias */
              }
            }
            const targetId = sym ? symbolToNodeId.get(sym) : undefined;
            if (targetId) {
              const multi = (sym?.declarations?.length ?? 1) > 1;
              to = targetId;
              callKind = isMethod ? "method" : "direct";
              // Method dispatch is virtual (subclass/interface/Proxy can intercept at runtime),
              // so a method edge is never statically `confirmed` — cap at `likely` (ADR 0016).
              confidence = isMethod || multi ? "likely" : "confirmed";
            } else {
              to = `unresolved#${nameNode.getText(sf)}`;
              callKind = "unresolved";
              confidence = "unresolved";
            }
          }
        }
        const key = `${from}|${to}|${callKind}`;
        if (seenEdges.has(key)) return;
        seenEdges.add(key);
        const pos = sf.getLineAndCharacterOfPosition(call.getStart(sf));
        callEdges.push({
          from,
          to,
          callKind,
          confidence,
          evidence: [`${relPath}:${pos.line + 1}:${pos.character + 1} ${callee.getText(sf).slice(0, 60)}(...)`]
        });
      };

      visitCall(sourceFile);
    }

    return { declarations, ownershipSignals, entryPointHints, callEdges };
  }
};
