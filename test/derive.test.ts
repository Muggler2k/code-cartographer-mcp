import { describe, expect, it } from "vitest";

import type { FileEntry } from "../src/schema.js";
import { detectEntryPoints, groupModules } from "../src/contextMap.js";
import { categorizeFile } from "../src/files.js";

function f(path: string): FileEntry {
  return {
    path,
    category: categorizeFile(path),
    sizeBytes: 1,
    sha256: "h",
    hashScope: "content",
    analyzable: true,
    analysisReason: "text source",
    mtimeMs: 0
  };
}

describe("detectEntryPoints (B2, ADR 0017)", () => {
  it("marks package manifests confirmed (filename-identity fact)", () => {
    const eps = detectEntryPoints([f("package.json"), f("pkgs/x/go.mod"), f("Cargo.toml")]);
    expect(eps.every((e) => e.kind === "package_manifest" && e.confidence === "confirmed")).toBe(true);
    expect(eps.map((e) => e.path)).toEqual(["Cargo.toml", "package.json", "pkgs/x/go.mod"]);
  });

  it("does not treat lockfiles as entry points", () => {
    expect(detectEntryPoints([f("package-lock.json"), f("go.sum")])).toEqual([]);
  });

  it("marks conventional source entries likely, never confirmed", () => {
    const eps = detectEntryPoints([f("src/index.ts"), f("cmd/server/main.go"), f("pkg/__main__.py")]);
    const byPath = new Map(eps.map((e) => [e.path, e]));
    expect(byPath.get("src/index.ts")?.kind).toBe("source_entry");
    expect(byPath.get("src/index.ts")?.confidence).toBe("likely");
    expect(byPath.get("cmd/server/main.go")?.confidence).toBe("likely");
    expect(eps.every((e) => e.confidence !== "confirmed")).toBe(true);
  });

  it("classifies test files as test entries (precedence over source)", () => {
    const eps = detectEntryPoints([f("foo.test.ts"), f("pkg/thing_test.go"), f("index.test.ts")]);
    expect(eps.every((e) => e.kind === "test_entry")).toBe(true);
  });
});

describe("groupModules (B3, ADR 0017)", () => {
  it("clusters second-level dirs under common roots", () => {
    const mods = groupModules([f("src/auth/login.ts"), f("src/auth/logout.ts"), f("src/index.ts")]);
    const auth = mods.find((m) => m.root === "src/auth");
    expect(auth?.name).toBe("auth");
    expect(auth?.category).toBe("source");
    expect(auth?.files).toEqual(["src/auth/login.ts", "src/auth/logout.ts"]);
    expect(mods.find((m) => m.root === "src")?.files).toEqual(["src/index.ts"]);
  });

  it("marks test roots as test category and groups top-level files under (root)", () => {
    const mods = groupModules([f("tests/unit/a_test.go"), f("package.json"), f("README.md"), f("cmd/server/main.go")]);
    expect(mods.find((m) => m.root === "tests/unit")?.category).toBe("test");
    expect(mods.find((m) => m.root === ".")?.name).toBe("(root)");
    expect(mods.find((m) => m.root === "cmd")?.category).toBe("source");
  });

  it("covers every file exactly once", () => {
    const files = [f("src/a.ts"), f("src/b/c.ts"), f("README.md"), f("test/x.test.ts")];
    const mods = groupModules(files);
    const total = mods.reduce((n, m) => n + m.files.length, 0);
    expect(total).toBe(files.length);
  });
});
