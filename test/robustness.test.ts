// ADR 0034 S1 robustness corpus — the build pipeline must NEVER throw on pathological inputs.
// Each failure mode (broken syntax, non-UTF8, binary, huge, unreadable, symlinks, submodules,
// generated code) must degrade to a disclosed, non-analyzable file (or be skipped by the walk),
// with the codebase-only boundary preserved. This is the never-throw half of S1; the dogfood
// seed-picker fix (issue #5, eval/seeds.ts) is the other half.

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { analyzeReachability } from "../src/analysis.js";
import { initCodebase, readContextMap } from "../src/contextMap.js";
import { hashFile } from "../src/files.js";
import { LARGE_FILE_THRESHOLD_BYTES } from "../src/schema.js";
import { tempRepos } from "./helpers/fixtures.js";

const { makeRepo, cleanup } = tempRepos("ccm-robust-");
afterEach(cleanup);

/** Write raw bytes into an existing temp repo — `makeRepo` only writes utf8 strings. */
async function writeBytes(root: string, rel: string, bytes: Buffer): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, bytes);
}

describe("S1 robustness corpus — the build degrades, never throws (ADR 0034 S1)", () => {
  it("broken syntax degrades to a graded map, never aborts the build", async () => {
    const root = await makeRepo({
      "src/broken.ts": "export function f( { const ;; return", // unbalanced
      "src/broken.py": "def f(:\n    return", // invalid indentation/colon
      "src/ok.ts": "export function ok() { return 1; }\n"
    });
    const result = await initCodebase(root, { mode: "none" });
    expect(result.status).toBe("initialized");
    const map = await readContextMap(root);
    expect(map?.meta.codebaseOnlyBoundary).toBe(true);
    // Load-bearing: the well-formed file is still ANALYZED — its declaration node survives — so a
    // broken sibling neither aborted the build (hashFile) nor blanked the provider (runProviders).
    expect(map?.files.some((f) => f.path === "src/ok.ts" && f.analyzable)).toBe(true);
    expect(map?.callGraph.nodes.some((n) => n.symbol === "ok")).toBe(true);
  });

  it("a non-UTF8 text file degrades (read as utf8 → U+FFFD), never throws", async () => {
    const root = await makeRepo({ "src/ok.ts": "export const x = 1;\n" });
    // An invalid-UTF8 comment then a real declaration: the utf8 decode (→ U+FFFD) must not throw,
    // AND the provider must still extract the declaration that follows it.
    await writeBytes(
      root,
      "src/latin1.ts",
      Buffer.concat([Buffer.from("// "), Buffer.from([0xe9, 0xe8, 0xff]), Buffer.from("\nexport function latinFn() { return 1; }\n")])
    );
    const result = await initCodebase(root, { mode: "none" });
    expect(result.status).toBe("initialized");
    const map = await readContextMap(root);
    const latin = map?.files.find((f) => f.path === "src/latin1.ts");
    expect(latin?.analyzable).toBe(true); // no NUL → analyzable text; the decode never threw
    expect(map?.callGraph.nodes.some((n) => n.symbol === "latinFn")).toBe(true); // survived the decode
  });

  it("a binary file with a source extension is marked non-analyzable, never parsed as code", async () => {
    const root = await makeRepo({ "src/ok.ts": "export const x = 1;\n" });
    await writeBytes(root, "src/blob.ts", Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    await initCodebase(root, { mode: "none" });
    const blob = (await readContextMap(root))?.files.find((f) => f.path === "src/blob.ts");
    expect(blob?.analyzable).toBe(false);
    expect(blob?.analysisReason).toBe("binary: null byte");
  });

  it("a huge file is metadata-hashed and never read (over size cap)", async () => {
    const root = await makeRepo({ "src/ok.ts": "export const x = 1;\n" });
    await writeBytes(root, "src/huge.ts", Buffer.alloc(LARGE_FILE_THRESHOLD_BYTES + 1024, 0x61));
    await initCodebase(root, { mode: "none" });
    const huge = (await readContextMap(root))?.files.find((f) => f.path === "src/huge.ts");
    expect(huge?.analyzable).toBe(false);
    expect(huge?.analysisReason).toBe("over size cap");
    expect(huge?.hashScope).toBe("metadata");
  });

  it("hashFile degrades to a disclosed non-analyzable entry when a file can't be read (never throws)", async () => {
    const root = await makeRepo({});
    // A path that vanished between the walk and hashing (race), or is permission-denied.
    const h = await hashFile(root, "ghost.ts");
    expect(h.analyzable).toBe(false);
    expect(h.analysisReason).toBe("unreadable");
    expect(h.hashScope).toBe("metadata");
  });

  it("symlinks (directory cycle + dangling target) are skipped, never followed or read", async () => {
    const root = await makeRepo({ "src/ok.ts": "export const x = 1;\n" });
    let cycleLinked = true;
    try {
      // The directory cycle is the infinite-walk risk. A Windows "junction" needs no privilege;
      // "dir" on POSIX. Either way the walk must not recurse into it.
      await fs.symlink(root, path.join(root, "src", "loop"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      cycleLinked = false;
    }
    // A dangling file symlink (file type needs a privilege on Windows — tolerate its absence).
    await fs.symlink(path.join(root, "nope.ts"), path.join(root, "src", "dangling.ts")).catch(() => undefined);

    const result = await initCodebase(root, { mode: "none" }); // must NOT infinite-loop or throw
    expect(result.status).toBe("initialized");
    const map = await readContextMap(root);
    if (cycleLinked) {
      // The cycle back to the repo root was not recursed into (no duplicated/looped paths).
      expect(map?.files.some((f) => f.path.includes("loop"))).toBe(false);
    }
    // The dangling link is never hashed. This is load-bearing: had the walk NOT skipped it,
    // hashFile would stat-fail on the missing target and surface it as an "unreadable" FileEntry
    // with this path — so its absence proves the walk skipped it, not that hashing dropped it.
    expect(map?.files.some((f) => f.path.includes("dangling"))).toBe(false);
  });

  it("a git submodule gitlink (nested .git file) does not abort the build", async () => {
    // The cartographer does not special-case submodules: the gitlink file and sub/ contents are
    // walked as ordinary files (only a literal `.git` DIRECTORY is excluded). The contract here is
    // simply that the unusual gitlink layout never aborts the build.
    const root = await makeRepo({
      "src/ok.ts": "export const x = 1;\n",
      ".gitmodules": '[submodule "sub"]\n  path = sub\n  url = ../sub.git\n',
      "sub/.git": "gitdir: ../.git/modules/sub\n",
      "sub/lib.ts": "export const y = 2;\n"
    });
    const result = await initCodebase(root, { mode: "none" });
    expect(result.status).toBe("initialized");
    expect((await readContextMap(root))?.meta.codebaseOnlyBoundary).toBe(true);
  });

  it("kitchen sink: every failure mode at once → build AND a downstream capability never throw", async () => {
    const root = await makeRepo({
      "src/ok.ts": "export function main() { return helper(); }\nexport function helper() { return 1; }\n",
      "src/broken.ts": "export function f( {{{ ;;",
      "generated/bundle.min.js": "var a=1;",
      "package-lock.json": "{}"
    });
    await writeBytes(root, "src/latin1.ts", Buffer.from([0xe9, 0xff, 0x0a]));
    await writeBytes(root, "src/blob.ts", Buffer.from([0x00, 0x01, 0x00]));
    await writeBytes(root, "src/huge.ts", Buffer.alloc(LARGE_FILE_THRESHOLD_BYTES + 16, 0x61));
    const result = await initCodebase(root, { mode: "none" });
    expect(result.status).toBe("initialized");
    const map = await readContextMap(root);
    expect(map?.meta.codebaseOnlyBoundary).toBe(true);
    // Load-bearing: the well-formed file's call graph survives the degraded siblings — a broken
    // sibling did not blank the whole TS provider, so `helper` is still extracted.
    expect(map?.callGraph.nodes.some((n) => n.symbol === "helper")).toBe(true);
    // A downstream capability over the partly-degraded map must also never throw.
    await expect(analyzeReachability(root, "main")).resolves.toBeDefined();
  });
});
