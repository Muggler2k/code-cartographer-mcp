// Issue #5: the dogfood seed picker degraded to an arbitrary nodes[0] when ALL source lived
// under a dir the VENDORED pattern matches (e.g. packages/ in a monorepo). selectSeeds now treats
// the vendored skip as a preference and falls back to any code node when no app-code node exists.

import { describe, expect, it } from "vitest";

import { selectSeeds, type SeedEdge, type SeedNode } from "../eval/seeds.js";

describe("selectSeeds (dogfood harness seed picker)", () => {
  it("picks the real hub when ALL source lives under packages/ (Issue #5)", () => {
    // nodes[0] is a leaf; the real hub is nodes[1]. The old hard vendored filter saw no app code,
    // left out-degree empty, and degraded to nodes[0] (the leaf). The fallback must find the hub.
    const nodes: SeedNode[] = [
      { id: "packages/b/src/api.ts#serve", path: "packages/b/src/api.ts" },
      { id: "packages/a/src/index.ts#main", path: "packages/a/src/index.ts" },
      { id: "packages/a/src/util.ts#helper", path: "packages/a/src/util.ts" }
    ];
    const edges: SeedEdge[] = [
      { from: "packages/a/src/index.ts#main", to: "packages/a/src/util.ts#helper" },
      { from: "packages/a/src/index.ts#main", to: "packages/b/src/api.ts#serve" }
    ];

    const seeds = selectSeeds(nodes, edges);

    expect(seeds.symbol).toBe("packages/a/src/index.ts#main");
    expect(seeds.symbol).not.toBe(nodes[0].id);
    // `to` is a distinct callee of the hub, and `file` resolves to the hub's real source file.
    expect(["packages/a/src/util.ts#helper", "packages/b/src/api.ts#serve"]).toContain(seeds.to);
    expect(seeds.file).toBe("packages/a/src/index.ts");
  });

  it("still skips a vendored hub when real app code exists (regression guard)", () => {
    // A vendored library node has the highest raw out-degree, but app code is present, so the
    // vendored preference must hold and root the seed at the app-code node instead.
    const nodes: SeedNode[] = [
      { id: "vendor/jquery.js#$", path: "vendor/jquery.js" },
      { id: "src/app.ts#run", path: "src/app.ts" },
      { id: "src/helpers.ts#h1", path: "src/helpers.ts" },
      { id: "src/helpers.ts#h2", path: "src/helpers.ts" }
    ];
    const edges: SeedEdge[] = [
      { from: "vendor/jquery.js#$", to: "src/helpers.ts#h1" },
      { from: "vendor/jquery.js#$", to: "src/helpers.ts#h2" },
      { from: "vendor/jquery.js#$", to: "src/app.ts#run" },
      { from: "src/app.ts#run", to: "src/helpers.ts#h1" }
    ];

    const seeds = selectSeeds(nodes, edges);

    expect(seeds.symbol).toBe("src/app.ts#run");
    expect(seeds.symbol).not.toBe("vendor/jquery.js#$");
  });

  it("prefers a non-vendored callee for `to` when the hub has both", () => {
    // The vendored callee edge is listed first, so a naive `find` would pick it. The accept
    // preference must root `to` at the app-code callee instead, keeping the whole seed real code.
    const nodes: SeedNode[] = [
      { id: "src/app.ts#run", path: "src/app.ts" },
      { id: "vendor/lib.js#v", path: "vendor/lib.js" },
      { id: "src/util.ts#help", path: "src/util.ts" }
    ];
    const edges: SeedEdge[] = [
      { from: "src/app.ts#run", to: "vendor/lib.js#v" },
      { from: "src/app.ts#run", to: "src/util.ts#help" }
    ];

    const seeds = selectSeeds(nodes, edges);

    expect(seeds.symbol).toBe("src/app.ts#run");
    expect(seeds.to).toBe("src/util.ts#help");
  });

  it("resolves `file` from the files list when the graph has no nodes (file fallback tiers)", () => {
    // A repo with files but no resolved call-graph nodes (e.g. a language with no provider): the
    // symbol degrades to the sentinel, but `file` must still point at real code, preferring a
    // non-vendored code file over a vendored one or docs.
    const mixed = selectSeeds([], [], [{ path: "README.md" }, { path: "vendor/lib.js" }, { path: "src/main.ts" }]);
    expect(mixed.symbol).toBe("main");
    expect(mixed.file).toBe("src/main.ts");

    // No non-vendored code exists → any code file still beats the bare "src" sentinel (Issue #5).
    const allVendored = selectSeeds([], [], [{ path: "README.md" }, { path: "packages/a/x.ts" }]);
    expect(allVendored.file).toBe("packages/a/x.ts");
  });

  it("degrades to the 'main' sentinel on an empty graph, never throwing", () => {
    const seeds = selectSeeds([], []);
    expect(seeds).toEqual({ symbol: "main", to: "main", file: "src" });
  });
});
