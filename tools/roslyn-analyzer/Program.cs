// Roslyn sidecar for the C# provider (CAS ADR 0027). CODEBASE-ONLY: parses and
// semantically analyzes the SOURCE TEXTS handed to it — one ad-hoc compilation over
// the batch's syntax trees, no MSBuild evaluation, no execution of target code, no
// assembly loading from the target. Reads a request JSON file (argv[0]) carrying the
// file texts; writes the extraction JSON to stdout.
//
// Output semantics mirror the TS provider (ADR 0018):
//   - declarations: namespace types + their methods; ids `path#Type` / `path#Type.Method`.
//   - edges: semantic-model-resolved targets only; virtual/abstract/override/interface
//     dispatch is "method" (runtime-polymorphic — the Node side caps it at `likely`);
//     non-virtual resolved is "direct"; everything else is `unresolved#name`.
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

var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
var trees = new List<SyntaxTree>();
foreach (var file in request.Files)
{
    // tree.FilePath carries the repo-relative path so every emitted id maps straight back.
    trees.Add(CSharpSyntaxTree.ParseText(file.Text ?? "", parseOptions, path: file.Path));
}

var compilation = CSharpCompilation.Create(
    "codebase",
    trees,
    new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
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
            var symbol = model.GetSymbolInfo(invocation).Symbol as IMethodSymbol
                ?? model.GetSymbolInfo(invocation).CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
            var target = symbol?.ReducedFrom?.OriginalDefinition ?? symbol?.OriginalDefinition;
            var label = invocation.Expression.ToString();
            if (label.Length > 60) label = label[..60];

            if (target is not null && symbolToId.TryGetValue(target, out var toId))
            {
                var dispatch = target.IsVirtual || target.IsAbstract || target.IsOverride || target.ContainingType?.TypeKind == TypeKind.Interface;
                Emit(from, toId, dispatch ? "method" : "direct", invocation, label);
            }
            else
            {
                var name = target?.Name ?? (invocation.Expression is MemberAccessExpressionSyntax ma ? ma.Name.Identifier.Text : label);
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

var response = new Response(declarations, edges, entryPaths.OrderBy(p => p, StringComparer.Ordinal).ToList());
Console.WriteLine(JsonSerializer.Serialize(response, jsonOptions));
return 0;

internal sealed record RequestFile(string Path, string? Text);

internal sealed record Request(List<RequestFile>? Files);

internal sealed record DeclOut(string Id, string Symbol, string Path, string Kind, bool Exported);

internal sealed record EdgeOut(string From, string To, string CallKind, string Evidence);

internal sealed record Response(List<DeclOut> Declarations, List<EdgeOut> Edges, List<string> EntryPoints);
