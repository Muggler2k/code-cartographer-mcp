// Roslyn sidecar for the C#/VB provider (CAS ADRs 0027/0033). CODEBASE-ONLY: parses
// and semantically analyzes the SOURCE TEXTS handed to it — one ad-hoc compilation per
// language over the batch's syntax trees (C# here; VB in VbAnalyzer.cs — Roslyn cannot
// mix the two tree kinds, so cross-language calls stay `unresolved#name`, disclosed),
// no MSBuild evaluation, no execution of target code, no assembly loading from the
// target. Reads a request JSON file (argv[0]) carrying the file texts; writes the
// extraction JSON to stdout.
//
// Output semantics mirror the TS provider (ADR 0018):
//   - declarations: namespace types + their methods; ids `path#Type` / `path#Type.Method`.
//   - edges: CLEANLY semantic-model-resolved targets only (SymbolInfo.Symbol — a
//     candidate/failed binding is NEVER graded as resolved); virtual/abstract/override/
//     interface dispatch is "method" (runtime-polymorphic — the Node side caps it at
//     `likely`); non-virtual resolved is "direct"; everything else is `unresolved#name`.
//     Edges from constructors and property accessors attribute to the containing TYPE
//     node. Known limitation (disclosed, ADR 0027): calls inside top-level statements
//     and field initializers are not emitted as edges — the file still gets its entry
//     hint, and absence of an edge is never evidence of absence of a call.
//   - entry hints: a static Main or top-level statements.

using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: RoslynAnalyzer <request.json>");
    return 2;
}

Request? request;
try
{
    request = JsonSerializer.Deserialize<Request>(File.ReadAllText(args[0]), jsonOptions);
}
catch (Exception e)
{
    Console.Error.WriteLine($"bad request: {e.Message}");
    return 2;
}
if (request?.Files is null)
{
    Console.Error.WriteLine("bad request: missing files");
    return 2;
}

// Split the batch by language (ADR 0033): .vb files get their own VisualBasicCompilation
// in VbAnalyzer; everything else stays on the C# path exactly as before.
var vbFiles = request.Files.Where(f => f.Path.EndsWith(".vb", StringComparison.OrdinalIgnoreCase)).ToList();
var csFiles = request.Files.Where(f => !f.Path.EndsWith(".vb", StringComparison.OrdinalIgnoreCase)).ToList();

var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
var trees = new List<SyntaxTree>();
foreach (var file in csFiles)
{
    // tree.FilePath carries the repo-relative path so every emitted id maps straight back.
    trees.Add(CSharpSyntaxTree.ParseText(file.Text ?? "", parseOptions, path: file.Path));
}

// References: the HOST SDK's own Trusted Platform Assemblies (ADR 0032 Tier 1) — the
// runtime already running this tool supplies the BCL surface so repo-internal bindings
// that flow through framework types resolve. METADATA only, analysis-time binding;
// nothing from the TARGET repo is referenced or loaded, and external TARGETS still map
// to unresolved#name below. Any unloadable assembly is skipped; if everything fails we
// fall back to the corelib floor (the ADR 0027 failure ladder: degrade, never throw).
var references = new List<MetadataReference>();
if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string tpa)
{
    foreach (var assemblyPath in tpa.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
    {
        try { references.Add(MetadataReference.CreateFromFile(assemblyPath)); }
        catch { /* unreadable/non-assembly entry — skip */ }
    }
}
if (references.Count == 0)
{
    references.Add(MetadataReference.CreateFromFile(typeof(object).Assembly.Location));
}

// OutputKind only shapes semantic checks (e.g. top-level statements need an exe kind on
// some paths; DLL is the neutral choice). `.Emit()` is NEVER called — nothing is compiled
// to a runnable artifact, loaded, or executed (codebase-only, ADR 0001/0027).
var compilation = CSharpCompilation.Create(
    "codebase",
    trees,
    references,
    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

var declarations = new List<DeclOut>();
var entryPaths = new HashSet<string>();
var symbolToId = new Dictionary<ISymbol, string>(SymbolEqualityComparer.Default);
var seenIds = new HashSet<string>();

static string TypeKindOf(SyntaxNode node) => node switch
{
    InterfaceDeclarationSyntax => "interface",
    EnumDeclarationSyntax => "enum",
    DelegateDeclarationSyntax => "type",
    _ => "class" // class / struct / record / record struct
};

static bool IsPublic(ISymbol? symbol) => symbol?.DeclaredAccessibility == Accessibility.Public;

// Pass 1 — declarations (namespace types + their methods).
foreach (var tree in trees)
{
    var model = compilation.GetSemanticModel(tree);
    var rel = tree.FilePath;

    foreach (var node in tree.GetRoot().DescendantNodes())
    {
        if (node is BaseTypeDeclarationSyntax typeDecl)
        {
            var typeSymbol = model.GetDeclaredSymbol(typeDecl);
            if (typeSymbol is null) continue;
            var typeId = $"{rel}#{typeDecl.Identifier.Text}";
            if (seenIds.Add(typeId))
            {
                declarations.Add(new DeclOut(typeId, typeDecl.Identifier.Text, rel, TypeKindOf(typeDecl), IsPublic(typeSymbol)));
            }
            if (!symbolToId.ContainsKey(typeSymbol.OriginalDefinition)) symbolToId[typeSymbol.OriginalDefinition] = typeId;
        }
        else if (node is DelegateDeclarationSyntax delDecl)
        {
            var delSymbol = model.GetDeclaredSymbol(delDecl);
            if (delSymbol is null) continue;
            var delId = $"{rel}#{delDecl.Identifier.Text}";
            if (seenIds.Add(delId))
            {
                declarations.Add(new DeclOut(delId, delDecl.Identifier.Text, rel, "type", IsPublic(delSymbol)));
            }
            if (!symbolToId.ContainsKey(delSymbol.OriginalDefinition)) symbolToId[delSymbol.OriginalDefinition] = delId;
        }
        else if (node is MethodDeclarationSyntax methodDecl && methodDecl.Parent is TypeDeclarationSyntax owner)
        {
            var methodSymbol = model.GetDeclaredSymbol(methodDecl);
            if (methodSymbol is null) continue;
            var compound = $"{owner.Identifier.Text}.{methodDecl.Identifier.Text}";
            var methodId = $"{rel}#{compound}";
            if (seenIds.Add(methodId)) // overloads share one node, like the TS provider
            {
                var exported = IsPublic(methodSymbol) && IsPublic(methodSymbol.ContainingType);
                declarations.Add(new DeclOut(methodId, compound, rel, "function", exported));
            }
            if (!symbolToId.ContainsKey(methodSymbol.OriginalDefinition)) symbolToId[methodSymbol.OriginalDefinition] = methodId;

            if (methodDecl.Identifier.Text == "Main" && methodSymbol.IsStatic) entryPaths.Add(rel);
        }
        else if (node is PropertyDeclarationSyntax propDecl && propDecl.Parent is TypeDeclarationSyntax propOwner)
        {
            // Data members (ADR 0032): ownership signals on the Node side, never graph nodes.
            var propSymbol = model.GetDeclaredSymbol(propDecl);
            if (propSymbol is null) continue;
            var compound = $"{propOwner.Identifier.Text}.{propDecl.Identifier.Text}";
            var propId = $"{rel}#{compound}";
            if (seenIds.Add(propId))
            {
                var exported = IsPublic(propSymbol) && IsPublic(propSymbol.ContainingType);
                declarations.Add(new DeclOut(propId, compound, rel, "property", exported));
            }
        }
        else if (node is FieldDeclarationSyntax fieldDecl && fieldDecl.Parent is TypeDeclarationSyntax fieldOwner)
        {
            foreach (var variable in fieldDecl.Declaration.Variables)
            {
                var fieldSymbol = model.GetDeclaredSymbol(variable);
                if (fieldSymbol is null) continue;
                var compound = $"{fieldOwner.Identifier.Text}.{variable.Identifier.Text}";
                var fieldId = $"{rel}#{compound}";
                if (seenIds.Add(fieldId))
                {
                    var exported = IsPublic(fieldSymbol) && IsPublic(fieldSymbol.ContainingType);
                    declarations.Add(new DeclOut(fieldId, compound, rel, "field", exported));
                }
            }
        }
        else if (node is GlobalStatementSyntax)
        {
            entryPaths.Add(rel); // top-level statements — the compiler's synthesized entry
        }
    }
}

// Pass 2 — call edges from method bodies.
var edges = new List<EdgeOut>();
var seenEdges = new HashSet<string>();

foreach (var tree in trees)
{
    var model = compilation.GetSemanticModel(tree);
    var rel = tree.FilePath;

    string? EnclosingId(SyntaxNode node)
    {
        for (var cur = node.Parent; cur is not null; cur = cur.Parent)
        {
            if (cur is MethodDeclarationSyntax m)
            {
                var sym = model.GetDeclaredSymbol(m);
                return sym is not null && symbolToId.TryGetValue(sym.OriginalDefinition, out var id) ? id : null;
            }
            // Constructors and property accessors have no method node of their own (ADR 0027
            // scopes declarations to types + methods) — attribute their calls to the TYPE node
            // rather than dropping the edge silently.
            if (cur is ConstructorDeclarationSyntax or AccessorDeclarationSyntax)
            {
                for (var owner = cur.Parent; owner is not null; owner = owner.Parent)
                {
                    if (owner is BaseTypeDeclarationSyntax ownerType)
                    {
                        var typeSym = model.GetDeclaredSymbol(ownerType);
                        return typeSym is not null && symbolToId.TryGetValue(typeSym.OriginalDefinition, out var typeId) ? typeId : null;
                    }
                }
                return null;
            }
        }
        return null;
    }

    void Emit(string from, string to, string callKind, SyntaxNode site, string label)
    {
        var key = $"{from}|{to}|{callKind}";
        if (!seenEdges.Add(key)) return;
        var line = site.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
        edges.Add(new EdgeOut(from, to, callKind, $"{rel}:{line} {label}"));
    }

    foreach (var node in tree.GetRoot().DescendantNodes())
    {
        if (node is InvocationExpressionSyntax invocation)
        {
            var from = EnclosingId(invocation);
            if (from is null) continue;
            // ONLY a clean binding (SymbolInfo.Symbol) can earn direct/method grading. A
            // candidate symbol means the binder FAILED (ambiguity, arity mismatch, missing
            // reference) — grading it as resolved would inflate a failed static inference
            // toward `confirmed` (codebase-only contract, ADR 0001/0016/0027). Candidates
            // contribute only a better NAME for the unresolved edge.
            var info = model.GetSymbolInfo(invocation);
            var clean = info.Symbol as IMethodSymbol;
            // `nameof(...)` that binds NO symbol is the C# operator — it folds to a
            // compile-time constant and is not a call, so an edge would be noise, not
            // evidence. A real method NAMED nameof binds a symbol (clean non-null) and
            // keeps its edge; an ambiguous one has no constant value and stays unresolved.
            if (clean is null
                && invocation.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" }
                && model.GetConstantValue(invocation).HasValue)
            {
                continue;
            }
            var target = clean?.ReducedFrom?.OriginalDefinition ?? clean?.OriginalDefinition;
            var label = invocation.Expression.ToString();
            if (label.Length > 60) label = label[..60];

            if (target is not null && symbolToId.TryGetValue(target, out var toId))
            {
                var dispatch = target.IsVirtual || target.IsAbstract || target.IsOverride || target.ContainingType?.TypeKind == TypeKind.Interface;
                Emit(from, toId, dispatch ? "method" : "direct", invocation, label);
            }
            else
            {
                var candidate = info.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
                var name = target?.Name ?? candidate?.Name
                    ?? (invocation.Expression is MemberAccessExpressionSyntax ma ? ma.Name.Identifier.Text : label);
                Emit(from, $"unresolved#{name}", "unresolved", invocation, label);
            }
        }
        else if (node is BaseObjectCreationExpressionSyntax creation)
        {
            var from = EnclosingId(creation);
            if (from is null) continue;
            var ctor = model.GetSymbolInfo(creation).Symbol as IMethodSymbol;
            var createdType = ctor?.ContainingType?.OriginalDefinition;
            if (createdType is not null && symbolToId.TryGetValue(createdType, out var typeId))
            {
                Emit(from, typeId, "direct", creation, $"new {createdType.Name}"); // edge to the TYPE node
            }
            else
            {
                var name = createdType?.Name ?? "<ctor>";
                Emit(from, $"unresolved#{name}", "unresolved", creation, $"new {name}");
            }
        }
    }
}

// Visual Basic batch (ADR 0033): its own compilation over the same TPA references,
// appending into the shared declaration/edge/entry collections (ids are path-prefixed).
VbAnalyzer.Analyze(vbFiles, references, declarations, edges, entryPaths, seenIds, seenEdges);

var response = new Response(declarations, edges, entryPaths.OrderBy(p => p, StringComparer.Ordinal).ToList());
Console.WriteLine(JsonSerializer.Serialize(response, jsonOptions));
return 0;

internal sealed record RequestFile(string Path, string? Text);

internal sealed record Request(List<RequestFile>? Files);

internal sealed record DeclOut(string Id, string Symbol, string Path, string Kind, bool Exported);

internal sealed record EdgeOut(string From, string To, string CallKind, string Evidence);

internal sealed record Response(List<DeclOut> Declarations, List<EdgeOut> Edges, List<string> EntryPoints);
