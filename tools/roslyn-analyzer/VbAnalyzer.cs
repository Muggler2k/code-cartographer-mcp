// Visual Basic extraction for the Roslyn sidecar (CAS ADR 0033). A SEPARATE
// compilation from the C# one — Roslyn cannot mix the two tree kinds — so a
// cross-language repo-internal call fails binding and stays `unresolved#name`
// (disclosed, like any external target). Semantics mirror Program.cs (ADR
// 0018/0027/0032): clean-binding-only resolved edges, dispatch as "method",
// constructor (`Sub New`) and accessor bodies attributed to the TYPE node,
// properties/fields as data-member declarations (signals, never graph nodes),
// `Sub Main` entry hints. VB's `NameOf(...)` is a distinct syntax node (never an
// invocation), so it cannot produce edge noise. VB invocation syntax ALSO covers
// array indexing and default-property access — those are DATA access, not calls,
// and emit nothing.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.VisualBasic;
using Microsoft.CodeAnalysis.VisualBasic.Syntax;

internal static class VbAnalyzer
{
    internal static void Analyze(
        List<RequestFile> vbFiles,
        List<MetadataReference> references,
        List<DeclOut> declarations,
        List<EdgeOut> edges,
        HashSet<string> entryPaths,
        HashSet<string> seenIds,
        HashSet<string> seenEdges)
    {
        if (vbFiles.Count == 0) return;

        var parseOptions = new VisualBasicParseOptions(LanguageVersion.Latest);
        var trees = new List<SyntaxTree>();
        foreach (var file in vbFiles)
        {
            trees.Add(VisualBasicSyntaxTree.ParseText(file.Text ?? "", parseOptions, path: file.Path));
        }

        // `.Emit()` is NEVER called (codebase-only, ADR 0001/0027/0033).
        var compilation = VisualBasicCompilation.Create(
            "codebase-vb",
            trees,
            references,
            new VisualBasicCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var symbolToId = new Dictionary<ISymbol, string>(SymbolEqualityComparer.Default);

        static bool IsPublic(ISymbol? symbol) => symbol?.DeclaredAccessibility == Accessibility.Public;

        static TypeBlockSyntax? OwnerTypeBlock(SyntaxNode node)
        {
            for (var cur = node.Parent; cur is not null; cur = cur.Parent)
            {
                if (cur is TypeBlockSyntax type) return type;
            }
            return null;
        }

        // Pass 1 — declarations (namespace types + methods; properties/fields as data members).
        foreach (var tree in trees)
        {
            var model = compilation.GetSemanticModel(tree);
            var rel = tree.FilePath;

            void Declare(string id, string symbol, string kind, bool exported)
            {
                if (seenIds.Add(id)) declarations.Add(new DeclOut(id, symbol, rel, kind, exported));
            }

            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                if (node is TypeBlockSyntax typeBlock)
                {
                    var typeSymbol = model.GetDeclaredSymbol(typeBlock.BlockStatement);
                    if (typeSymbol is null) continue;
                    var name = typeBlock.BlockStatement.Identifier.Text;
                    var kind = typeBlock is InterfaceBlockSyntax ? "interface" : "class"; // Module/Structure → class
                    Declare($"{rel}#{name}", name, kind, IsPublic(typeSymbol));
                    if (!symbolToId.ContainsKey(typeSymbol.OriginalDefinition)) symbolToId[typeSymbol.OriginalDefinition] = $"{rel}#{name}";
                }
                else if (node is EnumBlockSyntax enumBlock)
                {
                    var enumSymbol = model.GetDeclaredSymbol(enumBlock.EnumStatement);
                    if (enumSymbol is null) continue;
                    var name = enumBlock.EnumStatement.Identifier.Text;
                    Declare($"{rel}#{name}", name, "enum", IsPublic(enumSymbol));
                    if (!symbolToId.ContainsKey(enumSymbol.OriginalDefinition)) symbolToId[enumSymbol.OriginalDefinition] = $"{rel}#{name}";
                }
                else if (node is DelegateStatementSyntax delStmt)
                {
                    var delSymbol = model.GetDeclaredSymbol(delStmt);
                    if (delSymbol is null) continue;
                    var name = delStmt.Identifier.Text;
                    Declare($"{rel}#{name}", name, "type", IsPublic(delSymbol));
                    if (!symbolToId.ContainsKey(delSymbol.OriginalDefinition)) symbolToId[delSymbol.OriginalDefinition] = $"{rel}#{name}";
                }
                else if (node is MethodStatementSyntax methodStmt)
                {
                    // Covers BOTH block methods (statement inside a MethodBlock) and
                    // blockless members (interface / MustOverride): one node per name,
                    // overloads share it (mirrors the C# pass).
                    var owner = OwnerTypeBlock(methodStmt);
                    if (owner is null) continue;
                    var methodSymbol = model.GetDeclaredSymbol(methodStmt);
                    if (methodSymbol is null) continue;
                    var compound = $"{owner.BlockStatement.Identifier.Text}.{methodStmt.Identifier.Text}";
                    var methodId = $"{rel}#{compound}";
                    if (seenIds.Add(methodId))
                    {
                        var exported = IsPublic(methodSymbol) && IsPublic(methodSymbol.ContainingType);
                        declarations.Add(new DeclOut(methodId, compound, rel, "function", exported));
                    }
                    if (!symbolToId.ContainsKey(methodSymbol.OriginalDefinition)) symbolToId[methodSymbol.OriginalDefinition] = methodId;

                    // Module members are implicitly Shared, so IsStatic covers both forms.
                    if (methodStmt.Identifier.Text == "Main" && methodSymbol.IsStatic) entryPaths.Add(rel);
                }
                else if (node is PropertyStatementSyntax propStmt)
                {
                    // Data members (ADR 0032/0033): ownership signals on the Node side, never graph nodes.
                    var owner = OwnerTypeBlock(propStmt);
                    if (owner is null) continue;
                    var propSymbol = model.GetDeclaredSymbol(propStmt);
                    if (propSymbol is null) continue;
                    var compound = $"{owner.BlockStatement.Identifier.Text}.{propStmt.Identifier.Text}";
                    var exported = IsPublic(propSymbol) && IsPublic(propSymbol.ContainingType);
                    Declare($"{rel}#{compound}", compound, "property", exported);
                }
                else if (node is FieldDeclarationSyntax fieldDecl)
                {
                    var owner = OwnerTypeBlock(fieldDecl);
                    if (owner is null) continue;
                    foreach (var declarator in fieldDecl.Declarators)
                    {
                        foreach (var name in declarator.Names)
                        {
                            if (model.GetDeclaredSymbol(name) is not IFieldSymbol fieldSymbol) continue;
                            var compound = $"{owner.BlockStatement.Identifier.Text}.{name.Identifier.Text}";
                            var exported = IsPublic(fieldSymbol) && IsPublic(fieldSymbol.ContainingType);
                            Declare($"{rel}#{compound}", compound, "field", exported);
                        }
                    }
                }
            }
        }

        // Pass 2 — call edges from method bodies.
        foreach (var tree in trees)
        {
            var model = compilation.GetSemanticModel(tree);
            var rel = tree.FilePath;

            string? EnclosingId(SyntaxNode node)
            {
                for (var cur = node.Parent; cur is not null; cur = cur.Parent)
                {
                    if (cur is MethodBlockSyntax m)
                    {
                        var sym = model.GetDeclaredSymbol(m.SubOrFunctionStatement);
                        return sym is not null && symbolToId.TryGetValue(sym.OriginalDefinition, out var id) ? id : null;
                    }
                    // `Sub New` and property accessors have no method node of their own —
                    // attribute their calls to the TYPE node (mirrors the C# pass).
                    if (cur is ConstructorBlockSyntax or AccessorBlockSyntax)
                    {
                        var ownerType = OwnerTypeBlock(cur);
                        if (ownerType is null) return null;
                        var typeSym = model.GetDeclaredSymbol(ownerType.BlockStatement);
                        return typeSym is not null && symbolToId.TryGetValue(typeSym.OriginalDefinition, out var typeId) ? typeId : null;
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
                    var info = model.GetSymbolInfo(invocation);
                    // Bound to a NON-method symbol (Roslyn resolves a VB default-property
                    // access as the IPropertySymbol on some paths): data access, never a
                    // call edge (ADR 0032/0033). When Roslyn instead returns the getter
                    // METHOD (e.g. List(Of T) indexing → get_Item), it falls through and
                    // emits an unresolved external — correct: BCL targets stay unresolved.
                    if (info.Symbol is not null && info.Symbol is not IMethodSymbol) continue;
                    var clean = info.Symbol as IMethodSymbol;
                    var label = (invocation.Expression ?? (SyntaxNode)invocation).ToString();
                    if (label.Length > 60) label = label[..60];
                    var target = clean?.ReducedFrom?.OriginalDefinition ?? clean?.OriginalDefinition;

                    if (target is not null && symbolToId.TryGetValue(target, out var toId))
                    {
                        var dispatch = target.IsVirtual || target.IsAbstract || target.IsOverride || target.ContainingType?.TypeKind == TypeKind.Interface;
                        Emit(from, toId, dispatch ? "method" : "direct", invocation, label);
                    }
                    else
                    {
                        if (clean is null)
                        {
                            // Unbound invocation whose expression is a VALUE symbol:
                            // VB array indexing / default-property access — data, not a call.
                            var exprSym = invocation.Expression is null ? null : model.GetSymbolInfo(invocation.Expression).Symbol;
                            if (exprSym is ILocalSymbol or IParameterSymbol or IFieldSymbol or IPropertySymbol) continue;
                            // Only non-method candidates (e.g. a property group): data access.
                            if (info.CandidateSymbols.Length > 0 && !info.CandidateSymbols.OfType<IMethodSymbol>().Any()) continue;
                        }
                        var candidate = info.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
                        var name = target?.Name ?? candidate?.Name
                            ?? (invocation.Expression is MemberAccessExpressionSyntax ma ? ma.Name.Identifier.Text : label);
                        Emit(from, $"unresolved#{name}", "unresolved", invocation, label);
                    }
                }
                else if (node is ObjectCreationExpressionSyntax creation)
                {
                    var from = EnclosingId(creation);
                    if (from is null) continue;
                    var ctor = model.GetSymbolInfo(creation).Symbol as IMethodSymbol;
                    var createdType = ctor?.ContainingType?.OriginalDefinition;
                    if (createdType is not null && symbolToId.TryGetValue(createdType, out var typeId))
                    {
                        Emit(from, typeId, "direct", creation, $"New {createdType.Name}"); // edge to the TYPE node
                    }
                    else
                    {
                        var name = createdType?.Name ?? "<ctor>";
                        Emit(from, $"unresolved#{name}", "unresolved", creation, $"New {name}");
                    }
                }
            }
        }
    }
}
