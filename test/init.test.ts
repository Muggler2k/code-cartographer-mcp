import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { checkInitState, initCodebase, readContextMap } from "../src/contextMap.js";
import { tempRepos } from "./helpers/fixtures.js";

const { makeRepo, cleanup } = tempRepos("ccm-init-");
afterEach(cleanup);

describe("init build + persistence + staleness (A5 / A3e)", () => {
  it("reports not_initialized before init", async () => {
    const root = await makeRepo({ "a.ts": "1" });
    expect((await checkInitState(root)).status).toBe("not_initialized");
  });

  it("init writes a map with files[], summary, and records resolved scope (A3e)", async () => {
    const root = await makeRepo({ "src/a.ts": "export const x = 1;\n", "README.md": "# hi" });
    const result = await initCodebase(root, { mode: "none" });
    expect(result.status).toBe("initialized");
    expect(result.analysisBoundary).toBe("codebase_only");
    expect(result.map.files.map((f) => f.path).sort()).toEqual(["README.md", "src/a.ts"]);
    expect(result.map.summary.totalFiles).toBe(2);
    expect(result.map.summary.categories.source).toBe(1);
    expect(result.map.summary.categories.documentation).toBe(1);
    expect(result.map.summary.excluded.source).toBe("none");
    expect(result.map.summary.excluded.scopeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.map.meta.mapHash).toMatch(/^[0-9a-f]{64}$/);
    // Epic B: providers populate ownership + the call graph.
    expect(result.map.summary.ownershipSignals.map((s) => s.symbol)).toContain("x");
    expect(result.map.callGraph.nodes.some((n) => n.symbol === "x")).toBe(true);
    expect(result.map.summary.modules.some((m) => m.root === "src")).toBe(true);
  });

  it("persists atomically and gitignores the artifact dir", async () => {
    const root = await makeRepo({ "a.ts": "1" });
    await initCodebase(root, { mode: "none" });
    const gitignore = await fs.readFile(path.join(root, ".code-cartographer-mcp", ".gitignore"), "utf8");
    expect(gitignore.trim()).toBe("*");
    const saved = await readContextMap(root);
    expect(saved?.meta.codebaseOnlyBoundary).toBe(true);
  });

  it("reports initialized when nothing changed", async () => {
    const root = await makeRepo({ "a.ts": "1" });
    await initCodebase(root, { mode: "none" });
    expect((await checkInitState(root)).status).toBe("initialized");
  });

  it("reports stale when a file's content changes (mapHash differs)", async () => {
    const root = await makeRepo({ "a.ts": "1" });
    await initCodebase(root, { mode: "none" });
    await fs.writeFile(path.join(root, "a.ts"), "2222"); // size + content change
    const state = await checkInitState(root);
    expect(state.status).toBe("stale");
    expect(state.currentMapHash).not.toBe(state.previousMapHash);
  });

  it("reports stale when a new file is added (re-walk detects it)", async () => {
    const root = await makeRepo({ "a.ts": "1" });
    await initCodebase(root, { mode: "none" });
    await fs.writeFile(path.join(root, "b.ts"), "2");
    expect((await checkInitState(root)).status).toBe("stale");
  });

  it("stays initialized after a touch with no content change (rehash confirms)", async () => {
    const root = await makeRepo({ "a.ts": "1" });
    await initCodebase(root, { mode: "none" });
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(root, "a.ts"), future, future); // mtime changes, content does not
    expect((await checkInitState(root)).status).toBe("initialized");
  });

  it("reports stale when the schemaVersion changes even if file content is identical", async () => {
    // schemaVersion is the staleness driver a tool upgrade triggers (a scope reconfiguration
    // produces a new map; checkInitState always re-walks with the SAVED scope, so scopeHash is
    // fixed per saved map and folded into mapHash — not independently checkable here).
    const root = await makeRepo({ "a.ts": "1" });
    await initCodebase(root, { mode: "none" });
    const mapPath = path.join(root, ".code-cartographer-mcp", "context-map.json");
    const saved = JSON.parse(await fs.readFile(mapPath, "utf8"));
    saved.meta.schemaVersion = 99; // simulate a schema bump (content untouched)
    await fs.writeFile(mapPath, JSON.stringify(saved));
    expect((await checkInitState(root)).status).toBe("stale");
  });

  it("reports initializing while a live marker is present, failed for a dead one (ADR 0014)", async () => {
    const root = await makeRepo({ "a.ts": "1" });
    await initCodebase(root, { mode: "none" });
    const markerPath = path.join(root, ".code-cartographer-mcp", ".initializing");

    await fs.writeFile(markerPath, JSON.stringify({ startedAt: "now", pid: process.pid }));
    expect((await checkInitState(root)).status).toBe("initializing");

    await fs.writeFile(markerPath, JSON.stringify({ startedAt: "old", pid: 2147483646 }));
    expect((await checkInitState(root)).status).toBe("failed");
  });
});
