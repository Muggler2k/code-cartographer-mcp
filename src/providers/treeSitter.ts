// Tree-sitter provider (Decision 0012/0013/0018, ADR 0021/0022). A real-parser tier BETWEEN
// the TypeScript provider (confirmed, type-checked) and the heuristic regex floor (candidate):
// it parses Python/Go/Java/Rust/Ruby with tree-sitter grammars (WASM, in-process, no native
// build, no execution of the target). Ceiling `likely`. ADR 0022 adds CROSS-FILE resolution:
// Go resolves intra-package calls (package = directory) and Python resolves imported names, so
// those edges become resolved `direct`/`likely` instead of name-only `unresolved`. Without a
// type checker the cap stays `likely`. web-tree-sitter pinned to 0.20.8 (grammar ABI).

import { createRequire } from "node:module";
import * as path from "node:path";
import Parser from "web-tree-sitter";

import type { Confidence, EntryPoint, FileEntry, OwnershipSignal, OwnershipSignalKind } from "../schema.js";
import type { CallEdge, CallEdgeKind, CallGraphNode } from "../schema.js";
import type { LanguageProvider, ProviderExtraction, ProviderInput } from "./types.js";

const require = createRequire(import.meta.url);
const WASMS_DIR = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");

type SyntaxNode = Parser.SyntaxNode;
type Resolution = "package" | "import" | "module" | "file";

interface DeclSpec {
  nodeType: string;
  kind: OwnershipSignalKind | ((node: SyntaxNode) => OwnershipSignalKind);
  nameField?: string;
  nameFn?: (node: SyntaxNode) => string | undefined;
}

interface LangConfig {
  wasm: string;
  resolution: Resolution;
  decls: DeclSpec[];
  callNodeTypes: string[];
  calleeField: string;
  exported: (name: string, nodeText: string) => boolean;
  /**
   * C++ (ADR 0035 N-S1): qualify a method/type-member declaration by its enclosing class/struct as
   * `Type::name`, so same-named methods on different types get distinct nodes. The intra-file
   * resolver becomes scope-aware in lockstep (a bare call from inside `Type` resolves to
   * `Type::name`). Off (undefined) for every other language, so their bare-name resolution is
   * untouched. Confidence is unaffected — the tree-sitter ceiling stays `likely`.
   */
  qualifyByType?: boolean;
}

const PYTHON: LangConfig = {
  wasm: "tree-sitter-python.wasm",
  resolution: "import",
  decls: [
    { nodeType: "function_definition", kind: "function" },
    { nodeType: "class_definition", kind: "class" }
  ],
  callNodeTypes: ["call"],
  calleeField: "function",
  exported: (name) => !name.startsWith("_")
};

const GO: LangConfig = {
  wasm: "tree-sitter-go.wasm",
  resolution: "package",
  decls: [
    { nodeType: "function_declaration", kind: "function" },
    { nodeType: "method_declaration", kind: "function" },
    {
      nodeType: "type_spec",
      kind: (node) => {
        const t = node.childForFieldName("type")?.type;
        return t === "struct_type" ? "class" : t === "interface_type" ? "interface" : "type";
      }
    }
  ],
  callNodeTypes: ["call_expression"],
  calleeField: "function",
  exported: (name) => /^[A-Z]/.test(name)
};

const JAVA: LangConfig = {
  wasm: "tree-sitter-java.wasm",
  resolution: "file",
  decls: [
    { nodeType: "class_declaration", kind: "class" },
    { nodeType: "interface_declaration", kind: "interface" },
    { nodeType: "enum_declaration", kind: "enum" },
    { nodeType: "method_declaration", kind: "function" }
  ],
  callNodeTypes: ["method_invocation"],
  calleeField: "name",
  exported: (_name, nodeText) => !/\b(private|protected)\b/.test(nodeText)
};

const RUST: LangConfig = {
  wasm: "tree-sitter-rust.wasm",
  resolution: "module",
  decls: [
    { nodeType: "function_item", kind: "function" },
    { nodeType: "struct_item", kind: "class" },
    { nodeType: "enum_item", kind: "enum" },
    { nodeType: "trait_item", kind: "interface" },
    { nodeType: "type_item", kind: "type" }
  ],
  callNodeTypes: ["call_expression"],
  calleeField: "function",
  exported: (_name, nodeText) => /^\s*pub(\s|\()/.test(nodeText)
};

const RUBY: LangConfig = {
  wasm: "tree-sitter-ruby.wasm",
  resolution: "file",
  decls: [
    { nodeType: "method", kind: "function" },
    { nodeType: "class", kind: "class" },
    { nodeType: "module", kind: "class" }
  ],
  callNodeTypes: ["call"],
  calleeField: "method",
  exported: () => false
};

const CSHARP: LangConfig = {
  wasm: "tree-sitter-c_sharp.wasm",
  resolution: "file",
  decls: [
    { nodeType: "class_declaration", kind: "class" },
    { nodeType: "interface_declaration", kind: "interface" },
    { nodeType: "enum_declaration", kind: "enum" },
    { nodeType: "struct_declaration", kind: "class" },
    { nodeType: "method_declaration", kind: "function" }
  ],
  callNodeTypes: ["invocation_expression"],
  calleeField: "function",
  exported: (_name, nodeText) => /\bpublic\b/.test(nodeText)
};

const CPP: LangConfig = {
  wasm: "tree-sitter-cpp.wasm",
  resolution: "file",
  decls: [
    { nodeType: "class_specifier", kind: "class" },
    { nodeType: "struct_specifier", kind: "class" },
    { nodeType: "enum_specifier", kind: "enum" },
    { nodeType: "function_definition", kind: "function", nameFn: cppFunctionName }
  ],
  callNodeTypes: ["call_expression"],
  calleeField: "function",
  exported: (_name, nodeText) => !/^\s*static\b/.test(nodeText),
  qualifyByType: true
};

const CONFIGS: Record<string, LangConfig> = {
  ".py": PYTHON,
  ".go": GO,
  ".java": JAVA,
  ".rs": RUST,
  ".rb": RUBY,
  ".cs": CSHARP,
  ".cpp": CPP,
  ".cc": CPP,
  ".cxx": CPP,
  ".hpp": CPP,
  ".hh": CPP,
  ".h": CPP,
  ".c": CPP
};

function extensionOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function dirOf(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(0, slash) : "";
}

function posixJoin(dir: string, sub: string): string {
  return dir ? `${dir}/${sub}` : sub;
}

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Parser.Language>();

async function getLanguage(wasm: string): Promise<Parser.Language | null> {
  try {
    if (!initPromise) initPromise = Parser.init();
    await initPromise;
    let lang = languageCache.get(wasm);
    if (!lang) {
      lang = await Parser.Language.load(path.join(WASMS_DIR, wasm));
      languageCache.set(wasm, lang);
    }
    return lang;
  } catch {
    return null;
  }
}

const declKind = (spec: DeclSpec, node: SyntaxNode): OwnershipSignalKind =>
  typeof spec.kind === "function" ? spec.kind(node) : spec.kind;

const declName = (spec: DeclSpec, node: SyntaxNode): string | undefined =>
  spec.nameFn ? spec.nameFn(node) : node.childForFieldName(spec.nameField ?? "name")?.text;

/**
 * The declaration's name, kind, and the enclosing type for its descendants (ADR 0035 N-S1). For a
 * `qualifyByType` language (C++) a method nested in a class/struct is qualified `Type::name`, and a
 * type declaration becomes the enclosing type for the members under it. For every other language
 * this is a pass-through of `declName` (no qualification), so their resolution is unchanged. Used
 * by BOTH the declaration pass and the edge pass so a method's node id and its edge endpoints agree.
 *
 * Known limitations (UNDER-resolve honestly — `unresolved`, never a wrong edge — addressed by later
 * stages): an out-of-line method BODY (`int C::run(){…}` at namespace scope) isn't scope-aware, so
 * its bare member calls stay `unresolved` until N-S2; a class declared INSIDE a namespace qualifies
 * its methods by the class but not the namespace (`ns::C::m` → `C::m`) — one-level, N-S3 covers the
 * function-in-namespace case (`ns::f`) which is the common one.
 */
function declScope(
  config: LangConfig,
  spec: DeclSpec,
  node: SyntaxNode,
  enclosingType: string | null
): { name: string | undefined; kind: OwnershipSignalKind; childType: string | null } {
  const kind = declKind(spec, node);
  let name = declName(spec, node);
  if (name && config.qualifyByType && enclosingType && kind === "function" && !name.includes("::")) {
    name = `${enclosingType}::${name}`;
  }
  // The enclosing scope a declaration's body hands its descendants. A class/struct scopes its members
  // (N-S1). A qualified FUNCTION name (`T::m` — an OUT-OF-LINE member body, or a namespace member)
  // scopes its body to that prefix, so a bare call inside resolves member/enclosing-first instead of
  // over-resolving to a same-named free function (the out-of-line-body scope-loss bug). qualifyByType-gated.
  const childType =
    config.qualifyByType && kind === "class" && name
      ? name
      : config.qualifyByType && kind === "function" && name && name.includes("::")
        ? name.slice(0, name.lastIndexOf("::"))
        : enclosingType;
  return { name, kind, childType };
}

/**
 * C++ N-S3 (ADR 0035): the enclosing scope a node hands to its children. A `namespace ns { … }`
 * prefixes its members like a class does, so a function inside becomes `ns::f` and a bare call from
 * within resolves enclosing-first (C++ unqualified lookup searches the enclosing namespace). Nesting
 * accumulates (`a::b::f`). Anonymous namespaces add no qualifier (treated as the enclosing scope —
 * consistent with the N-S2 anon-namespace note). Non-namespace nodes pass `childType` through
 * unchanged, so class scoping (N-S1) is untouched. qualifyByType-gated → no other language affected.
 */
function cppChildScope(config: LangConfig, node: SyntaxNode, enclosingType: string | null): string | null {
  if (config.qualifyByType && node.type === "namespace_definition") {
    const nsName = node.childForFieldName("name")?.text;
    if (nsName) return enclosingType ? `${enclosingType}::${nsName}` : nsName;
  }
  return enclosingType;
}

/** C++: the function name is nested in function_definition → (ptr/ref) → function_declarator → declarator. */
function cppFunctionName(node: SyntaxNode): string | undefined {
  let decl = node.childForFieldName("declarator");
  while (decl && (decl.type === "pointer_declarator" || decl.type === "reference_declarator")) {
    decl = decl.childForFieldName("declarator");
  }
  if (decl?.type === "function_declarator") {
    const inner = decl.childForFieldName("declarator");
    // Out-of-line definition `Type::method` → keep the qualifier (ADR 0035 N-S1), so it matches the
    // in-class form `Type::method` that visitDecls produces. Whitespace is stripped for stability.
    if (inner?.type === "qualified_identifier") return inner.text.replace(/\s+/g, "");
    return inner?.text;
  }
  return undefined;
}

/** C++ (ADR 0035): the method name of an in-class member *declaration* (`void tick();`) — a
 * `field_declaration` whose declarator is a `function_declarator`. Returns undefined for a data
 * member (no function_declarator). Used to track DECLARED-but-not-defined members so a bare call
 * inside that class's body resolves to the member (or stays `unresolved`), never to a free function. */
function cppFieldMethodName(node: SyntaxNode): string | undefined {
  // Strip pointer/reference wrappers. A `reference_declarator` (`int& ref()`) wraps its inner
  // declarator WITHOUT a `declarator` field name in this grammar, so fall back to the wrapped
  // declarator/identifier child — otherwise `&`-returning members would be missed and could
  // over-resolve to a same-named free function.
  const unwrap = (d: SyntaxNode | null): SyntaxNode | null => {
    while (d && (d.type === "pointer_declarator" || d.type === "reference_declarator")) {
      d = d.childForFieldName("declarator") ?? d.namedChildren.find((c) => /declarator|identifier/.test(c.type)) ?? null;
    }
    return d;
  };
  const decl = unwrap(node.childForFieldName("declarator"));
  if (decl?.type !== "function_declarator") return undefined;
  const inner = unwrap(decl.childForFieldName("declarator"));
  // Only a plain method name (`identifier`/`field_identifier`). Reject a function-POINTER data member
  // (`void(*cb)();` → a `parenthesized_declarator`), an operator, a destructor, or a qualified id —
  // none are callable by a bare identifier, so they need no member-decl suppression.
  return inner && (inner.type === "identifier" || inner.type === "field_identifier") ? inner.text : undefined;
}

const DECLARATOR_WRAPPERS = /^(function_declarator|parenthesized_declarator|pointer_declarator|reference_declarator|init_declarator|array_declarator)$/;

/** C++ (ADR 0035): descend a declarator node (`int n`, `void(*cb)()`, `const Foo& f`,
 * `std::function<…> g = …`, `Adder a;`) to the innermost plain identifier, or undefined (abstract/unnamed). */
function declaratorId(d: SyntaxNode | null): string | undefined {
  for (let guard = 0; d && DECLARATOR_WRAPPERS.test(d.type) && guard < 24; guard++) {
    d = d.childForFieldName("declarator") ?? d.namedChildren.find((c) => DECLARATOR_WRAPPERS.test(c.type) || c.type === "identifier" || c.type === "field_identifier") ?? null;
  }
  return d && (d.type === "identifier" || d.type === "field_identifier") ? d.text : undefined;
}

/** C++ (ADR 0035): the names a `function_definition` introduces into its own scope — parameters plus
 * local variable declarations in its body (NOT descending into nested functions/lambdas, which own
 * their scope). A bare call to one of these is a call THROUGH that local (a function-pointer param, a
 * `std::function`, a functor) — an indirect/dynamic dispatch, not a free function — so the resolver
 * leaves it `unresolved` rather than over-resolving to a same-named global. All declarators of a
 * multi-declarator statement (`std::function f, g;`) are captured. The set is whole-function (not
 * declaration-order scoped) — a call before its shadowing local is still suppressed, which errs toward
 * honest `unresolved`, never a false edge. A local function PROTOTYPE (`void helper();` — an `extern`
 * ref to the free function, not a callable variable) is NOT a shadow. Two grammar-level under-captures
 * remain (rare; they leave the pre-existing behavior, not a new false edge from this change): a bare
 * function-pointer LOCAL (`void(*cb)();`) is parsed as an expression (most-vexing-parse), and a
 * structured binding (`auto [a,b] = …`) uses a declarator shape we don't unwrap. */
function cppCollectShadows(funcDef: SyntaxNode): Set<string> {
  const shadows = new Set<string>();
  let fd: SyntaxNode | null = funcDef.childForFieldName("declarator");
  while (fd && (fd.type === "pointer_declarator" || fd.type === "reference_declarator")) fd = fd.childForFieldName("declarator");
  const params = fd?.type === "function_declarator" ? fd.namedChildren.find((c) => c.type === "parameter_list") : null;
  if (params) for (const c of params.namedChildren) if (c.type === "parameter_declaration") {
    const nm = declaratorId(c.childForFieldName("declarator"));
    if (nm) shadows.add(nm);
  }
  const body = funcDef.childForFieldName("body");
  const walk = (n: SyntaxNode): void => {
    if (n.type === "function_definition" || n.type === "lambda_expression") return; // own scope
    if (n.type === "declaration") {
      // Each declarator of the statement (`int a, b;` → a AND b). The type specifier is a
      // `type_identifier`/`primitive_type`/`qualified_identifier`, never a declarator/identifier. A
      // top-level `function_declarator` is a local function PROTOTYPE (`void helper();`), not a
      // callable variable — skip it so the call still resolves to the free function.
      for (const d of n.namedChildren) {
        if (d.type === "function_declarator") continue;
        if (DECLARATOR_WRAPPERS.test(d.type) || d.type === "identifier" || d.type === "field_identifier") {
          const nm = declaratorId(d);
          if (nm) shadows.add(nm);
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  if (body) walk(body);
  return shadows;
}

/** Split a callee text into name/qualifier, noting whether a `::` path (scoped) was used.
 * "pm.run" → {name:"run", qualifier:"pm", scoped:false}; "util::other" → {..., scoped:true}.
 * `scopedPath` is the FULL `::`-joined identifier path for a scoped call ("a::b::f" for `a::b::f()`,
 * template args/whitespace stripped), else null — C++ N-S3 matches it against `declNames` so a deep
 * `a::b::f()` binds to its `a::b::f` node and never collides with an unrelated 2-segment `b::f`. */
function splitCallee(text: string): { name: string; qualifier: string | null; scoped: boolean; scopedPath: string | null; globalScoped: boolean } | null {
  // `member` access (`.` / `->`) is NOT `::` scope: a member/pointer call `obj.f()` / `ptr->f()`
  // carries a qualifier (the object) and stays unresolved at this tier — splitting on `->` too keeps
  // `ptr->f` from collapsing to the pointer variable `ptr` (which could collide with a free function).
  const scoped = text.includes("::");
  const globalScoped = /^\s*::/.test(text); // explicit global-scope operator `::f()` — bind only to a global
  const parts = text.split(/::|\.|->/);
  const name = parts[parts.length - 1].match(/[A-Za-z_]\w*/)?.[0];
  if (!name) return null;
  const qualifier = parts.length >= 2 ? (parts[parts.length - 2].match(/[A-Za-z_]\w*/)?.[0] ?? null) : null;
  let scopedPath: string | null = null;
  if (scoped && !text.includes(".") && !text.includes("->")) {
    const idents = text.split("::").map((p) => p.match(/[A-Za-z_]\w*/)?.[0]);
    if (idents.length >= 2 && idents.every((id): id is string => Boolean(id))) scopedPath = idents.join("::");
  }
  return { name, qualifier, scoped, scopedPath, globalScoped };
}

interface ImportRef {
  file: string;
  orig: string;
}

interface FileParse {
  file: FileEntry;
  config: LangConfig;
  root: SyntaxNode;
  declNames: Set<string>;
  funcNames: Set<string>; // C++: the function-kind subset of declNames — a call edge must target a callable, never a class/enum node
  memberDecls: Set<string>; // C++: `Type::method` for in-class method DECLARATIONS — a member-body call to a declared (maybe undefined) member stays a member, never over-resolves to a free function
  importMap: Map<string, ImportRef>; // Python: localName -> {moduleFile, origName}
  qualifierMap: Map<string, string>; // Python: alias -> moduleFile
  cppUsingAliases: Map<string, string | null>; // C++ N-S3: `using ns::f;` → bare f -> ns::f (null = ambiguous)
  cppUsingNamespaces: string[]; // C++ N-S3: `using namespace ns;`
  cppIncludes: Set<string>; // C++: quoted `#include` targets, repo-relative (cross-dir resolution)
}

/** Resolve a Python module spec to a file in the owned set, or null. */
function resolvePyModule(spec: string, fileDir: string, fileSet: Set<string>): string | null {
  if (!spec) return null;
  if (spec.startsWith(".")) {
    let dots = 0;
    while (spec[dots] === ".") dots++;
    let dir = fileDir;
    for (let k = 1; k < dots; k++) dir = dirOf(dir);
    const rest = spec.slice(dots).replace(/\./g, "/");
    const candidate = posixJoin(dir, rest ? `${rest}.py` : "__init__.py");
    return fileSet.has(candidate) ? candidate : null;
  }
  const sub = `${spec.replace(/\./g, "/")}.py`;
  for (const base of ["", fileDir]) {
    const candidate = base ? posixJoin(base, sub) : sub;
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function lastSegment(dotted: string): string {
  return dotted.slice(dotted.lastIndexOf(".") + 1);
}

/** Match a Go import path to the owned directory it refers to (longest path-suffix match). */
function matchImportToDir(importPath: string, ownedDirs: string[]): string | null {
  const ip = importPath.split("/").filter(Boolean);
  let best: string | null = null;
  let bestLen = 0;
  for (const dir of ownedDirs) {
    const segs = dir ? dir.split("/") : [];
    if (segs.length === 0 || segs.length > ip.length || segs.length <= bestLen) continue;
    const offset = ip.length - segs.length;
    if (segs.every((s, i) => s === ip[offset + i])) {
      best = dir;
      bestLen = segs.length;
    }
  }
  return best;
}

/** Parse Go imports → qualifier (alias or path tail) → owned directory (package). */
function parseGoImports(root: SyntaxNode, ownedDirs: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: SyntaxNode): void => {
    if (node.type === "import_spec") {
      const raw = node.childForFieldName("path")?.text ?? "";
      const importPath = raw.replace(/"/g, "");
      const alias = node.childForFieldName("name")?.text;
      const qualifier = alias && alias !== "_" && alias !== "." ? alias : importPath.slice(importPath.lastIndexOf("/") + 1);
      const dir = matchImportToDir(importPath, ownedDirs);
      if (dir !== null && qualifier) map.set(qualifier, dir);
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return map;
}

/** Parse Python import statements into name→target and alias→module maps. */
function parsePyImports(root: SyntaxNode, fileDir: string, fileSet: Set<string>): Pick<FileParse, "importMap" | "qualifierMap"> {
  const importMap = new Map<string, ImportRef>();
  const qualifierMap = new Map<string, string>();
  const walk = (node: SyntaxNode): void => {
    if (node.type === "import_from_statement") {
      const modNode = node.childForFieldName("module_name");
      const moduleFile = modNode ? resolvePyModule(modNode.text, fileDir, fileSet) : null;
      if (moduleFile) {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (!child || child === modNode) continue;
          if (child.type === "aliased_import") {
            const orig = lastSegment(child.childForFieldName("name")?.text ?? "");
            const local = child.childForFieldName("alias")?.text;
            if (orig && local) importMap.set(local, { file: moduleFile, orig });
          } else if (child.type === "dotted_name") {
            const nm = lastSegment(child.text);
            if (nm) importMap.set(nm, { file: moduleFile, orig: nm });
          }
        }
      }
    } else if (node.type === "import_statement") {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === "aliased_import") {
          const mod = child.childForFieldName("name")?.text ?? "";
          const alias = child.childForFieldName("alias")?.text;
          const moduleFile = resolvePyModule(mod, fileDir, fileSet);
          if (alias && moduleFile) qualifierMap.set(alias, moduleFile);
        } else if (child.type === "dotted_name") {
          const moduleFile = resolvePyModule(child.text, fileDir, fileSet);
          if (moduleFile) qualifierMap.set(lastSegment(child.text), moduleFile);
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return { importMap, qualifierMap };
}

function lastColonSegment(s: string): string {
  const parts = s.split("::");
  return parts[parts.length - 1];
}

/** Parse Rust `use` declarations → local name → {moduleFile, origName}, resolving the module
 * name against the owned crate's module→file map. Handles single, braced-list, and aliased uses. */
function parseRustUses(root: SyntaxNode, rustModules: Map<string, string>, declsByFile: Map<string, Set<string>>): Map<string, ImportRef> {
  const importMap = new Map<string, ImportRef>();
  const record = (moduleName: string, orig: string, local: string): void => {
    const file = rustModules.get(moduleName);
    if (file && declsByFile.get(file)?.has(orig)) importMap.set(local, { file, orig });
  };
  const findUseList = (node: SyntaxNode): SyntaxNode | null => {
    if (node.type === "use_list") return node;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      const found = child ? findUseList(child) : null;
      if (found) return found;
    }
    return null;
  };
  const walk = (node: SyntaxNode): void => {
    if (node.type === "use_declaration") {
      for (let i = 0; i < node.childCount; i++) {
        const clause = node.child(i);
        if (!clause) continue;
        if (clause.type === "scoped_identifier") {
          const pathNode = clause.childForFieldName("path");
          const nameNode = clause.childForFieldName("name");
          if (pathNode && nameNode) record(lastColonSegment(pathNode.text), nameNode.text, nameNode.text);
        } else if (clause.type === "scoped_use_list") {
          const pathNode = clause.childForFieldName("path");
          const list = findUseList(clause);
          if (pathNode && list) {
            const moduleName = lastColonSegment(pathNode.text);
            for (let j = 0; j < list.childCount; j++) {
              const id = list.child(j);
              if (id?.type === "identifier") record(moduleName, id.text, id.text);
            }
          }
        } else if (clause.type === "use_as_clause") {
          const pathNode = clause.childForFieldName("path");
          const alias = clause.childForFieldName("alias")?.text;
          if (pathNode && alias) {
            const segs = pathNode.text.split("::");
            const orig = segs[segs.length - 1];
            const moduleName = segs[segs.length - 2];
            if (moduleName) record(moduleName, orig, alias);
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return importMap;
}

/** C++ source-file extensions a header's definition lives in (header/source sibling, ADR 0035). */
const CPP_SOURCE_EXTS = [".cpp", ".cc", ".cxx", ".c"];

/**
 * C++ (ADR 0035): the set of QUOTED `#include "..."` targets in a file, each resolved to a
 * repo-relative POSIX path against the including file's directory. Angle-bracket/system includes
 * (`<vector>`) are skipped — they never name a repo file. Used for cross-DIRECTORY resolution: a
 * call binds to a definition in the sibling source of an included header (`x.h` -> `x.cpp`).
 */
function parseCppIncludes(root: SyntaxNode, fileDir: string): Set<string> {
  const includes = new Set<string>();
  const walk = (node: SyntaxNode): void => {
    if (node.type === "preproc_include") {
      const pathNode = node.childForFieldName("path");
      if (pathNode?.type === "string_literal") {
        const rel = pathNode.text.replace(/^"+|"+$/g, ""); // strip surrounding quotes
        if (rel) includes.add(path.posix.normalize(path.posix.join(fileDir, rel)));
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return includes;
}

/**
 * C++ N-S3 (ADR 0035): parse `using` declarations into two file-scoped maps.
 *   `using ns::f;`        (using-declaration) → aliases: bare `f` -> the full path `ns::f`.
 *   `using namespace ns;` (using-directive)   → namespaces: a bare name may bind to `ns::name`.
 * A file-scoped approximation (no per-block scope tracking) — the common case for a tree-sitter
 * tier; the resolver clamps to `likely` and only binds when the target is declared in this file, so
 * an over-broad `using` never fabricates a cross-file edge. Whitespace is stripped to match node ids.
 */
function parseCppUsings(root: SyntaxNode): { aliases: Map<string, string | null>; namespaces: string[] } {
  // alias value `null` = AMBIGUOUS: two `using`s bind the same bare name to different paths (C++ would
  // be ill-formed) → the resolver must NOT guess, mirroring the using-directive `length === 1` guard.
  const aliases = new Map<string, string | null>();
  const namespaces: string[] = [];
  const walk = (node: SyntaxNode): void => {
    if (node.type === "using_declaration") {
      const isDirective = node.children.some((c) => c.type === "namespace");
      const ref = node.children.find((c) => c.type === "qualified_identifier" || c.type === "identifier");
      const text = ref?.text.replace(/\s+/g, "");
      if (text) {
        if (isDirective) {
          if (!namespaces.includes(text)) namespaces.push(text);
        } else if (text.includes("::")) {
          const key = lastColonSegment(text);
          const prior = aliases.get(key);
          if (prior === undefined) aliases.set(key, text);
          else if (prior !== text) aliases.set(key, null); // conflicting `using`s → ambiguous
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return { aliases, namespaces };
}

export const treeSitterProvider: LanguageProvider = {
  id: "tree-sitter",
  maxConfidence: "likely",
  matches(file: FileEntry): boolean {
    return extensionOf(file.path) in CONFIGS;
  },
  async analyze(input: ProviderInput): Promise<ProviderExtraction> {
    const declarations: CallGraphNode[] = [];
    const ownershipSignals: OwnershipSignal[] = [];
    const entryPointHints: EntryPoint[] = [];
    const callEdges: CallEdge[] = [];
    const seenNodeIds = new Set<string>();
    const seenEdgeKeys = new Set<string>();
    const fileSet = new Set(input.files.map((f) => f.path));

    // ---- Phase 1: parse every owned file; emit declarations/ownership; collect resolution data ----
    // web-tree-sitter `Parser`/`Tree` own WASM-heap memory freed only by explicit `.delete()` (JS GC
    // never reclaims it). Reuse ONE parser and retain every tree, then free both at the end of analyze
    // — otherwise each `analyze()` leaks its parse trees and a long-running server's heap grows unbounded.
    let parser: Parser | null = null;
    const trees: Parser.Tree[] = [];
    try {
    const parses: FileParse[] = [];
    const declsByFile = new Map<string, Set<string>>(); // file -> declared top-level names
    const goPackages = new Map<string, Map<string, string>>(); // dir -> name -> declaring file
    // C++ N-S2/N-S3 (ADR 0035): the SINGLE index of cross-file-resolvable functions — `<name>` ->
    // file(s) DEFINING it. A function is indexed iff its qualified name comes from its enclosing scope:
    // a global free function (`shared_util`, N-S2) OR a namespace member (`geometry::side`, N-S3). CLASS
    // members (`Type::m`, incl. an out-of-line `int Type::m(){}`), static functions, and anonymous-
    // namespace (internal-linkage) functions are excluded. Two views are DERIVED from this one map at
    // read time (so they can never desync): SAME-DIRECTORY resolution — the dir-as-module proxy,
    // mirroring `goPackages` — groups the defining files by directory (`resolveSameDir`); cross-
    // DIRECTORY resolution is gated by the `#include` graph (`resolveViaIncludes`). A call binds only to
    // a UNIQUE definition in the relevant set; ambiguous (>1) or cross-dir-without-include stays
    // `unresolved`, never a false edge; everything emits `likely` (never `confirmed`).
    // Bounded over-resolutions (same-dir, unique non-static name; deferred to a fuller #include/scope
    // stage): an inline-in-header def + sibling counts as 2 → `unresolved`; a bare call in an OUT-OF-
    // LINE member body to a private member name colliding with a same-dir free function binds the free.
    const cppDefsByName = new Map<string, Set<string>>();

    for (const file of input.files) {
      const config = CONFIGS[extensionOf(file.path)];
      if (!config) continue;
      let text: string;
      try {
        text = await input.readFile(file.path);
      } catch {
        continue;
      }
      const language = await getLanguage(config.wasm);
      if (!language) continue;
      let root: SyntaxNode;
      try {
        if (!parser) parser = new Parser(); // one reused parser per analyze (Parser.init ran via getLanguage)
        parser.setLanguage(language);
        const tree = parser.parse(text);
        trees.push(tree); // retain to free its WASM heap at the end — a `SyntaxNode` is only valid while its tree lives
        root = tree.rootNode;
      } catch {
        continue;
      }

      const declNames = new Set<string>();
      const funcNames = new Set<string>(); // function-kind names only — a call may bind to these, never to a class/enum node
      const memberDecls = new Set<string>(); // C++: `Type::method` for in-class method declarations (declared, maybe not defined)
      const declSpecFor = (node: SyntaxNode): DeclSpec | undefined => config.decls.find((d) => d.nodeType === node.type);
      // `enclosingIsType` (C++): are we inside a class/struct body? A namespace resets it to false.
      // Used to index namespace members + global functions into cppDefsByName but NOT class members.
      // `enclosingInternal` (C++): are we inside an ANONYMOUS namespace? Its members have INTERNAL
      // linkage (TU-local, invisible to other files), so they must never enter the cross-file index —
      // the same reason `static` is excluded (`exported`). Once internal, always internal (nested).
      const visitDecls = (node: SyntaxNode, enclosingType: string | null, enclosingIsType: boolean, enclosingInternal: boolean): void => {
        const spec = declSpecFor(node);
        let childType = cppChildScope(config, node, enclosingType); // C++ N-S3: namespace scope
        let childIsType = node.type === "namespace_definition" ? false : enclosingIsType;
        const childInternal =
          enclosingInternal || (!!config.qualifyByType && node.type === "namespace_definition" && !node.childForFieldName("name"));
        // C++: record an in-class method DECLARATION (`void tick();`, or a templated one, which the
        // grammar wraps as a `declaration` inside a `template_declaration`) so a bare call from the
        // class body binds to the member (or stays `unresolved` when undefined), never a free function.
        // A `friend` declaration (`friend void f();`) is NOT a member — exclude it (its parent node is
        // a `friend_declaration`) so a friend-function call still resolves to the free function.
        if (
          config.qualifyByType &&
          enclosingIsType &&
          enclosingType &&
          (node.type === "field_declaration" ||
            (node.type === "declaration" && node.parent?.type !== "friend_declaration"))
        ) {
          const m = cppFieldMethodName(node);
          if (m) memberDecls.add(`${enclosingType}::${m}`);
        }
        if (spec) {
          const { name, kind, childType: ct } = declScope(config, spec, node, enclosingType);
          childType = ct;
          if (kind === "class") childIsType = true; // a class/struct body scopes its members
          if (name) {
            const id = `${file.path}#${name}`;
            declNames.add(name);
            if (kind === "function") funcNames.add(name);
            if (!seenNodeIds.has(id)) {
              seenNodeIds.add(id);
              declarations.push({ id, symbol: name, path: file.path, kind, confidence: "confirmed" });
              const exported = config.exported(name, node.text.slice(0, 120));
              ownershipSignals.push({
                symbol: name,
                kind,
                path: file.path,
                exported,
                confidence: exported ? "candidate" : "unclear",
                reason: `tree-sitter ${extensionOf(file.path)} declaration`
              });
              // C++ N-S2/N-S3: index a non-static function whose qualified name comes from its
              // ENCLOSING scope — a global free function (`shared_util`) or a namespace member
              // (`geometry::side`) — for cross-file resolution. Excluded: class members
              // (`enclosingIsType`), an out-of-line definition (`int Type::m(){}` at file scope) whose
              // declarator carries a `::` the enclosing scope didn't provide (would over-resolve member
              // calls), and anonymous-namespace (internal-linkage) functions.
              const scopeQualified =
                enclosingType === null ? !name.includes("::") : name.startsWith(`${enclosingType}::`);
              if (config.qualifyByType && kind === "function" && exported && !enclosingIsType && !enclosingInternal && scopeQualified) {
                (cppDefsByName.get(name) ?? cppDefsByName.set(name, new Set()).get(name)!).add(file.path);
              }
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visitDecls(child, childType, childIsType, childInternal);
        }
      };
      visitDecls(root, null, false, false);

      declsByFile.set(file.path, declNames);
      if (config.resolution === "package") {
        const dir = dirOf(file.path);
        const pkg = goPackages.get(dir) ?? new Map<string, string>();
        for (const name of declNames) if (!pkg.has(name)) pkg.set(name, file.path);
        goPackages.set(dir, pkg);
      }

      const imports = config.resolution === "import" ? parsePyImports(root, dirOf(file.path), fileSet) : { importMap: new Map(), qualifierMap: new Map() };
      parses.push({ file, config, root, declNames, funcNames, memberDecls, ...imports, cppUsingAliases: new Map(), cppUsingNamespaces: [], cppIncludes: new Set() });

      if (file.category === "test") {
        entryPointHints.push({ path: file.path, kind: "test_entry", confidence: "candidate", reason: "test-category source file" });
      }
    }

    // Go cross-package: now that all package dirs are known, resolve each file's imports to dirs.
    const ownedGoDirs = [...goPackages.keys()];
    // Rust: map each module name to its file (foo.rs → "foo", foo/mod.rs → dir name, lib/main.rs → "crate").
    const rustModules = new Map<string, string>();
    for (const parse of parses) {
      if (parse.config.resolution !== "module") continue;
      const p = parse.file.path;
      const base = p.slice(p.lastIndexOf("/") + 1);
      const mod = base === "mod.rs" ? (dirOf(p).split("/").pop() ?? "") : base === "lib.rs" || base === "main.rs" ? "crate" : base.replace(/\.rs$/, "");
      if (mod && !rustModules.has(mod)) rustModules.set(mod, p);
    }
    for (const parse of parses) {
      if (parse.config.resolution === "package") {
        parse.qualifierMap = parseGoImports(parse.root, ownedGoDirs);
      } else if (parse.config.resolution === "module") {
        parse.importMap = parseRustUses(parse.root, rustModules, declsByFile);
      } else if (parse.config.qualifyByType) {
        const u = parseCppUsings(parse.root); // C++ N-S3: `using` declarations/directives
        parse.cppUsingAliases = u.aliases;
        parse.cppUsingNamespaces = u.namespaces;
        parse.cppIncludes = parseCppIncludes(parse.root, dirOf(parse.file.path)); // C++: cross-dir #include graph
      }
    }

    // ---- Phase 2: resolve and emit call edges ----
    // C++ cross-DIRECTORY resolution (ADR 0035): a same-dir miss may still bind if the definition
    // lives in a file the caller is connected to via `#include` — the sibling source of an included
    // header (`#include "x.h"` -> `x.cpp` defines it), or a directly-included source. Resolves only
    // when EXACTLY ONE include-connected file defines the name (the `#include` graph disambiguates,
    // so unrelated same-named definitions elsewhere in the repo never over-resolve). `likely`.
    // Honest UNDER-resolutions (stay `unresolved`, never a wrong edge): an `inline` def in the
    // included header AND a sibling-source def both count → 2 hits → unresolved; a multi-dot header
    // name (`x.api.h`) only sheds its last extension, so its source sibling is sought as `x.api.cpp`.
    const resolveViaIncludes = (parse: FileParse, key: string): { to: string; kind: CallEdgeKind; conf: Confidence } | null => {
      const defFiles = cppDefsByName.get(key);
      if (!defFiles) return null;
      const hits = new Set<string>();
      for (const hdr of parse.cppIncludes) {
        if (defFiles.has(hdr)) hits.add(hdr); // a directly-included source defines it
        const base = hdr.replace(/\.[^./]+$/, "");
        for (const ext of CPP_SOURCE_EXTS) if (defFiles.has(base + ext)) hits.add(base + ext);
      }
      if (hits.size !== 1) return null;
      const [defFile] = hits;
      return { to: `${defFile}#${key}`, kind: "direct", conf: "likely" };
    };
    // SAME-DIRECTORY resolution (the dir-as-module proxy) DERIVED from the single `cppDefsByName` index:
    // bind to the UNIQUE definition of `key` whose directory matches `dir`. >1 (or 0) same-dir defs →
    // null (`unresolved`). One source of truth, so the same-dir and cross-dir views can never desync.
    const resolveSameDir = (dir: string, key: string): { to: string; kind: CallEdgeKind; conf: Confidence } | null => {
      const defFiles = cppDefsByName.get(key);
      if (!defFiles) return null;
      let hit: string | null = null;
      let n = 0;
      for (const f of defFiles) if (dirOf(f) === dir) {
        hit = f;
        if (++n > 1) return null;
      }
      return n === 1 && hit ? { to: `${hit}#${key}`, kind: "direct", conf: "likely" } : null;
    };
    const resolveCallee = (
      parse: FileParse,
      parsed: { name: string; qualifier: string | null; scoped: boolean; scopedPath: string | null; globalScoped: boolean },
      callingType: string | null,
      shadows: Set<string>
    ): { to: string; kind: CallEdgeKind; conf: Confidence } => {
      const { name, qualifier, scoped, scopedPath, globalScoped } = parsed;
      const self = parse.file.path;
      // C++ (ADR 0035): a bare `name()` where `name` is a PARAMETER or LOCAL of the enclosing function
      // (a function-pointer param, a `std::function`, a functor) is an INDIRECT/dynamic dispatch through
      // that local — NOT a call to a same-named free function. Grade it `dynamic`/`unclear` and leave it
      // `unresolved`, never over-resolving to a global. (A local hides an outer name — C++ name lookup.)
      if (parse.config.qualifyByType && !qualifier && !scoped && shadows.has(name)) {
        return { to: `unresolved#${name}`, kind: "dynamic", conf: "unclear" };
      }
      // C++: a call edge must target a CALLABLE — a function-kind node, never a class/enum (a
      // constructor call `Widget()` is not an edge to the `Widget` type node). For other languages the
      // intra-file check below keeps using `declNames` unchanged.
      const cppHas = (n: string): boolean => parse.funcNames.has(n);
      // C++ N-S1 (ADR 0035): an unqualified call from inside `Type` resolves to that type's
      // `Type::name` member FIRST — a class member hides a namespace-scope function of the same name
      // (C++ unqualified name lookup). Additive + qualifyByType-gated, so every other language's
      // bare-name resolution below is untouched (their `callingType` machinery never qualifies).
      // Skipped for an explicit-global `::name()` call (which can never name a member).
      if (parse.config.qualifyByType && !qualifier && callingType && !globalScoped) {
        const qualified = `${callingType}::${name}`;
        if (cppHas(qualified)) {
          return { to: `${self}#${qualified}`, kind: "direct", conf: "likely" };
        }
        // The name is a DECLARED member of the calling class but has no definition node here (defined
        // out-of-line elsewhere / pure virtual / in an unanalyzed TU): it is still the MEMBER, so it
        // stays `unresolved` rather than over-resolving to a same-named free function or same-dir global.
        if (parse.memberDecls.has(qualified)) {
          return { to: `unresolved#${name}`, kind: "method", conf: "unclear" };
        }
      }
      if (!qualifier && (parse.config.qualifyByType ? cppHas(name) : parse.declNames.has(name))) {
        return { to: `${self}#${name}`, kind: "direct", conf: "likely" };
      }
      // C++ N-S3 (ADR 0035): `using`-imported names. An explicit `using ns::f;` makes a bare `f()`
      // resolve to its `ns::f` declaration (most specific); a `using namespace ns;` makes a bare
      // `name()` resolve to `ns::name` when that member is declared in THIS file. Intra-file,
      // file-scoped approximation; if >1 used namespace declares `name` it stays `unresolved` (C++
      // would be an ambiguity error) — never a guess. `likely`. qualifyByType-gated. Skipped for an
      // explicit-global `::name()` (a using-directive name is not in the global scope).
      if (parse.config.qualifyByType && !qualifier && !globalScoped) {
        const alias = parse.cppUsingAliases.get(name);
        if (alias && cppHas(alias)) {
          return { to: `${self}#${alias}`, kind: "direct", conf: "likely" };
        }
        // Exactly one used namespace declaring `name` resolves; ≥2 stays `unresolved` (ambiguity).
        // Single-pass with an early-exit on the 2nd hit — avoids the per-call `.map()`+`.filter()`
        // double-array (+ K-string) allocation on this hot edge-resolution path.
        let viaNs: string | null = null;
        for (const ns of parse.cppUsingNamespaces) {
          const q = `${ns}::${name}`;
          if (cppHas(q)) {
            if (viaNs !== null) {
              viaNs = null; // a 2nd match → ambiguous → fall through to `unresolved`
              break;
            }
            viaNs = q;
          }
        }
        if (viaNs !== null) {
          return { to: `${self}#${viaNs}`, kind: "direct", conf: "likely" };
        }
      }
      // C++ N-S2 (ADR 0035): a BARE call the intra-file pass didn't resolve binds to the UNIQUE
      // global (non-static, free) definition of that name in another file — the header-declares /
      // .cpp-defines / called-elsewhere edge, captured via C++'s global linkage. (Namespace-member
      // cross-file resolution uses the same `cppDefsByName` index but routes through the SCOPED branch
      // below.) Ambiguous (>1 definition, e.g. overloads) or undefined → stays `unresolved`.
      // qualifyByType-gated. Reached only when `name` is absent from the caller's own `declNames` (the
      // intra-file check above returns first), so a same-file definition never routes through here.
      if (parse.config.qualifyByType && !qualifier) {
        const sameDir = resolveSameDir(dirOf(self), name); // unique same-directory definition
        if (sameDir) return sameDir;
        const viaInc = resolveViaIncludes(parse, name); // cross-DIRECTORY via the #include graph
        if (viaInc) return viaInc;
      }
      // C++ N-S3 (ADR 0035): a SCOPED call `Scope::name` — namespace-qualified (`geometry::area()`,
      // nested `outer::inner::deep()`) or class-qualified (`Calculator::value()`, a static/explicit
      // member call) — binds to the declaration whose node id is the call's FULL `::`-path (the decl
      // pass qualifies namespace/class members the same way). Matching the full path, not a truncated
      // `qualifier::name`, means a deep call never collides with an unrelated 2-segment `b::f`.
      // `::`-scoped only, so `obj.method()` / `ptr->m()` (unscoped) never route here.
      // ceiling `likely` (no type system); an unknown scope/name stays `unresolved`. qualifyByType-gated.
      if (parse.config.qualifyByType && scopedPath) {
        if (cppHas(scopedPath)) {
          return { to: `${self}#${scopedPath}`, kind: "direct", conf: "likely" };
        }
        // Cross-FILE same-dir: the qualified name (a namespace member like `remote::fetch`) is defined
        // in another file in the SAME directory — the unique same-dir definition, the N-S2 dir-as-module
        // proxy extended to namespace members. Ambiguous → `unresolved`.
        const sameDir = resolveSameDir(dirOf(self), scopedPath);
        if (sameDir) return sameDir;
        const viaInc = resolveViaIncludes(parse, scopedPath); // cross-DIRECTORY via the #include graph
        if (viaInc) return viaInc;
      }
      if (parse.config.resolution === "module") {
        // Rust: `mod::name` (scoped) → the module's file; bare `name` → a `use`-imported name.
        if (scoped && qualifier) {
          const file = rustModules.get(qualifier);
          if (file && declsByFile.get(file)?.has(name)) return { to: `${file}#${name}`, kind: "direct", conf: "likely" };
          return { to: `unresolved#${name}`, kind: "unresolved", conf: "unresolved" };
        }
        if (!qualifier) {
          const imp = parse.importMap.get(name);
          if (imp && declsByFile.get(imp.file)?.has(imp.orig)) {
            return { to: `${imp.file}#${imp.orig}`, kind: "direct", conf: "likely" };
          }
        }
      } else if (parse.config.resolution === "import") {
        if (qualifier) {
          const moduleFile = parse.qualifierMap.get(qualifier);
          if (moduleFile && declsByFile.get(moduleFile)?.has(name)) {
            return { to: `${moduleFile}#${name}`, kind: "direct", conf: "likely" };
          }
          return { to: `unresolved#${name}`, kind: "method", conf: "unclear" };
        }
        const imp = parse.importMap.get(name);
        if (imp && declsByFile.get(imp.file)?.has(imp.orig)) {
          return { to: `${imp.file}#${imp.orig}`, kind: "direct", conf: "likely" };
        }
      } else if (parse.config.resolution === "package") {
        if (!qualifier) {
          const declFile = goPackages.get(dirOf(self))?.get(name);
          if (declFile) return { to: `${declFile}#${name}`, kind: "direct", conf: "likely" };
        } else {
          // qualified pkg.Func() → the imported package's directory.
          const dir = parse.qualifierMap.get(qualifier);
          const declFile = dir !== undefined ? goPackages.get(dir)?.get(name) : undefined;
          if (declFile) return { to: `${declFile}#${name}`, kind: "direct", conf: "likely" };
          return { to: `unresolved#${name}`, kind: "unresolved", conf: "unresolved" };
        }
      }
      if (qualifier) {
        return { to: `unresolved#${name}`, kind: "method", conf: "unclear" };
      }
      return { to: `unresolved#${name}`, kind: "unresolved", conf: "unresolved" };
    };

    for (const parse of parses) {
      const { config, file } = parse;
      const declSpecFor = (node: SyntaxNode): DeclSpec | undefined => config.decls.find((d) => d.nodeType === node.type);
      const visitEdges = (node: SyntaxNode, enclosing: string | null, enclosingType: string | null, shadows: Set<string>): void => {
        let nextEnclosing = enclosing;
        let childType = cppChildScope(config, node, enclosingType); // C++ N-S3: namespace scope
        const spec = declSpecFor(node);
        if (spec) {
          // Same qualification as the declaration pass, so a method's edge endpoints match its node.
          const { name, childType: ct } = declScope(config, spec, node, enclosingType);
          childType = ct;
          if (name) nextEnclosing = `${file.path}#${name}`;
        }
        // C++: a function definition introduces its params + locals — names a bare call binds to as an
        // indirect dispatch (fn-pointer / `std::function` / functor), not a free function. Union with
        // any inherited shadows (nested functions/lambdas own their scope, so they extend it).
        let childShadows = shadows;
        if (config.qualifyByType && node.type === "function_definition") {
          const own = cppCollectShadows(node);
          if (own.size) childShadows = shadows.size ? new Set([...shadows, ...own]) : own;
        }
        if (config.callNodeTypes.includes(node.type) && nextEnclosing) {
          const callee = node.childForFieldName(config.calleeField);
          const parsed = callee ? splitCallee(callee.text) : null;
          if (parsed) {
            // The call's enclosing TYPE (C++ scope-aware resolution); null outside a class.
            const { to, kind, conf } = resolveCallee(parse, parsed, enclosingType, childShadows);
            const key = `${nextEnclosing}|${to}|${kind}`;
            if (!seenEdgeKeys.has(key)) {
              seenEdgeKeys.add(key);
              const pos = node.startPosition;
              const resolved = !to.startsWith("unresolved#");
              callEdges.push({
                from: nextEnclosing,
                to,
                callKind: kind,
                confidence: conf,
                evidence: [
                  `${file.path}:${pos.row + 1}:${pos.column + 1} ${parsed.name}(...)`,
                  resolved ? "tree-sitter scope/import resolution (no type check → likely)" : "tree-sitter name-based call; not resolved to a declaration"
                ]
              });
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visitEdges(child, nextEnclosing, childType, childShadows);
        }
      };
      visitEdges(parse.root, null, null, new Set());
    }

    return { declarations, ownershipSignals, entryPointHints, callEdges };
    } finally {
      // Free the WASM heap unconditionally: the return value holds only plain data (no `SyntaxNode`),
      // so every parse tree and the parser can be released — and `finally` covers the throw path too,
      // so a mid-extraction error leaks nothing. Best-effort — never let a `.delete()` throw escape.
      for (const t of trees) try { t.delete(); } catch { /* already freed / detached */ }
      try { parser?.delete(); } catch { /* idempotent */ }
    }
  }
};
