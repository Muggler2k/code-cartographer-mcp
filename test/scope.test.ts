import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { detectLanguages, previewScope, resolveScope, walkFiles } from "../src/scope.js";
import { tempRepos } from "./helpers/fixtures.js";

const { makeRepo, cleanup } = tempRepos("ccm-scope-");
afterEach(cleanup);

describe("detectLanguages (A3a, Decision 0009)", () => {
  it("returns [] when no known languages are present", async () => {
    const root = await makeRepo({ "README.md": "# hi", "notes.txt": "x" });
    expect(await detectLanguages(root)).toEqual([]);
  });

  it("detects Go from go.mod + .go files", async () => {
    const root = await makeRepo({ "go.mod": "module x", "main.go": "package main" });
    expect(await detectLanguages(root)).toEqual(["go"]);
  });

  it("detects a TS/JS project from manifests + extensions (sorted, unique)", async () => {
    const root = await makeRepo({
      "package.json": "{}",
      "tsconfig.json": "{}",
      "src/index.ts": "export {}"
    });
    expect(await detectLanguages(root)).toEqual(["javascript", "typescript"]);
  });

  it("detects C# from a .csproj pattern", async () => {
    const root = await makeRepo({ "App.csproj": "<Project/>", "Program.cs": "" });
    expect(await detectLanguages(root)).toEqual(["csharp"]);
  });

  it("skips vendor/build dirs so dependency languages do not leak in", async () => {
    const root = await makeRepo({
      "app.py": "x = 1",
      "node_modules/foo/index.js": "1",
      "dist/bundle.js": "1"
    });
    expect(await detectLanguages(root)).toEqual(["python"]);
  });
});

describe("resolveScope (A3b, Decision 0009)", () => {
  it("mode none excludes nothing", async () => {
    const root = await makeRepo({ "a.ts": "" });
    const r = await resolveScope(root, { mode: "none" });
    expect(r.source).toBe("none");
    expect(r.excludeDirs).toEqual([]);
    expect(r.patterns).toEqual([]);
    expect(r.scopeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mode gitignore reads .gitignore patterns (comments/blanks stripped)", async () => {
    const root = await makeRepo({ ".gitignore": "# build\ndist/\n\nnode_modules/\n" });
    const r = await resolveScope(root, { mode: "gitignore" });
    expect(r.source).toBe("gitignore");
    expect(r.patterns).toEqual(["dist/", "node_modules/"]);
    expect(r.excludeDirs).toEqual([]);
  });

  it("mode gitignore with no .gitignore yields no patterns but keeps the source", async () => {
    const root = await makeRepo({ "a.ts": "" });
    const r = await resolveScope(root, { mode: "gitignore" });
    expect(r.source).toBe("gitignore");
    expect(r.patterns).toEqual([]);
  });

  it("mode language uses explicit languages and their conventional dirs", async () => {
    const root = await makeRepo({ "main.go": "package main" });
    const r = await resolveScope(root, { mode: "language", languages: ["go"] });
    expect(r.source).toBe("language");
    expect(r.languages).toEqual(["go"]);
    expect(r.excludeDirs).toEqual(expect.arrayContaining(["vendor", "bin"]));
  });

  it("mode language with no explicit languages auto-detects them", async () => {
    const root = await makeRepo({ "app.py": "x = 1" });
    const r = await resolveScope(root, { mode: "language" });
    expect(r.languages).toEqual(["python"]);
    expect(r.excludeDirs).toContain("__pycache__");
  });

  it("auto honors .gitignore when present", async () => {
    const root = await makeRepo({ ".gitignore": "dist/\n", "a.ts": "" });
    const r = await resolveScope(root, { mode: "auto" });
    expect(r.source).toBe("gitignore");
    expect(r.patterns).toEqual(["dist/"]);
  });

  it("auto falls back to language detection when no .gitignore (default mode)", async () => {
    const root = await makeRepo({ "main.go": "package main" });
    const r = await resolveScope(root); // default = auto
    expect(r.source).toBe("language");
    expect(r.languages).toEqual(["go"]);
  });

  it("appends extraExcludes / extraIncludes as patterns", async () => {
    const root = await makeRepo({ ".gitignore": "dist/\n" });
    const r = await resolveScope(root, {
      mode: "gitignore",
      extraExcludes: ["*.log"],
      extraIncludes: ["keep.log"]
    });
    expect(r.patterns).toEqual(["dist/", "*.log", "!keep.log"]);
  });

  it("scopeHash is stable for the same plan and differs across plans", async () => {
    const root = await makeRepo({ "main.go": "package main" });
    const a = await resolveScope(root, { mode: "language", languages: ["go"] });
    const b = await resolveScope(root, { mode: "language", languages: ["go"] });
    const c = await resolveScope(root, { mode: "none" });
    expect(a.scopeHash).toBe(b.scopeHash);
    expect(a.scopeHash).not.toBe(c.scopeHash);
  });
});

describe("walkFiles (A3c, Decision 0009)", () => {
  it("language mode prunes conventional dirs by name", async () => {
    const root = await makeRepo({ "src/a.ts": "", "node_modules/foo/b.js": "" });
    const res = await resolveScope(root, { mode: "language", languages: ["typescript"] });
    const w = await walkFiles(root, res);
    expect(w.files).toEqual(["src/a.ts"]);
    expect(w.excludedDirs).toContain("node_modules");
  });

  it("gitignore mode excludes matched dirs and files, counting skipped files", async () => {
    const root = await makeRepo({
      ".gitignore": "*.log\ndist/\n",
      "a.ts": "",
      "debug.log": "",
      "dist/out.js": ""
    });
    const res = await resolveScope(root, { mode: "gitignore" });
    const w = await walkFiles(root, res);
    expect(w.files).toEqual([".gitignore", "a.ts"]);
    expect(w.excludedDirs).toEqual(["dist"]);
    expect(w.excludedFileCount).toBe(1); // debug.log
  });

  it("honors gitignore negation (re-included files are not skipped)", async () => {
    const root = await makeRepo({ ".gitignore": "*.log\n!keep.log\n", "debug.log": "", "keep.log": "" });
    const res = await resolveScope(root, { mode: "gitignore" });
    const w = await walkFiles(root, res);
    expect(w.files).toEqual([".gitignore", "keep.log"]);
    expect(w.excludedFileCount).toBe(1); // debug.log
  });

  it("always excludes .git and the tool's own dir, even in none mode", async () => {
    const root = await makeRepo({
      "a.ts": "",
      ".git/config": "x",
      ".code-cartographer-mcp/context-map.json": "{}"
    });
    const res = await resolveScope(root, { mode: "none" });
    const w = await walkFiles(root, res);
    expect(w.files).toEqual(["a.ts"]);
    expect(w.excludedDirs).toEqual(expect.arrayContaining([".git", ".code-cartographer-mcp"]));
  });

  it("returns sorted relative POSIX paths", async () => {
    const root = await makeRepo({ "b.ts": "", "a/c.ts": "", "a/b.ts": "" });
    const res = await resolveScope(root, { mode: "none" });
    const w = await walkFiles(root, res);
    expect(w.files).toEqual(["a/b.ts", "a/c.ts", "b.ts"]);
  });
});

describe("previewScope (A3d, Decision 0009)", () => {
  it("returns counts + sample paths and marks the codebase-only boundary", async () => {
    const root = await makeRepo({
      ".gitignore": "dist/\n*.log\n",
      "a.ts": "",
      "b.ts": "",
      "debug.log": "",
      "dist/out.js": ""
    });
    const preview = await previewScope(root, { mode: "gitignore" });
    expect(preview.analysisBoundary).toBe("codebase_only");
    expect(preview.resolution.source).toBe("gitignore");
    expect(preview.includedFileCount).toBe(3); // .gitignore, a.ts, b.ts
    expect(preview.excludedDirCount).toBe(1); // dist
    expect(preview.excludedFileCount).toBe(1); // debug.log
    expect(preview.sampleIncluded).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
    expect(preview.sampleExcluded).toContain("dist");
  });

  it("does NOT write a context map (preview only)", async () => {
    const root = await makeRepo({ "a.ts": "" });
    await previewScope(root, { mode: "none" });
    await expect(fs.access(path.join(root, ".code-cartographer-mcp", "context-map.json"))).rejects.toThrow();
  });
});
