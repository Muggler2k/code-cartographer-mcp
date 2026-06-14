// ADR 0034 S4 (autonomous slice) — validate ADR 0011 staleness + incremental re-analysis under a
// realistic churn SEQUENCE. Each modify/add/delete must flip `checkInitState` to `stale`, and the
// RE-ANALYZED map must reflect the churn: a changed file's new symbols appear, an added file is
// included, a deleted file's symbols vanish. init.test covers single staleness DETECTION cases;
// this pins the detect→re-analyze loop end-to-end (incl. deletion, which the unit tests omit).
// The other half of S4 — latency SLAs on large repos — needs representative repos (out of scope).

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { checkInitState, initCodebase, readContextMap } from "../src/contextMap.js";
import type { StaticContextMap } from "../src/schema.js";
import { tempRepos } from "./helpers/fixtures.js";

const { makeRepo, cleanup } = tempRepos("ccm-churn-");
afterEach(cleanup);

function symbolsOf(map: StaticContextMap | null): string[] {
  return (map?.callGraph.nodes ?? []).map((n) => n.symbol);
}

describe("ADR 0011 staleness + incremental re-analysis under churn (ADR 0034 S4 slice)", () => {
  it("detects and re-analyzes a modify→add→delete sequence, keeping the map correct each time", async () => {
    const root = await makeRepo({
      "src/a.ts": "export function alpha() { return 1; }\n",
      "src/b.ts": "export function beta() { return 2; }\n"
    });
    await initCodebase(root, { mode: "none" });
    expect((await checkInitState(root)).status).toBe("initialized");
    expect(symbolsOf(await readContextMap(root))).toEqual(expect.arrayContaining(["alpha", "beta"]));

    // 1) MODIFY — content change introduces a new symbol → stale → re-analysis includes it.
    await fs.writeFile(
      path.join(root, "src/a.ts"),
      "export function alpha() { return gamma(); }\nexport function gamma() { return 3; }\n"
    );
    expect((await checkInitState(root)).status).toBe("stale");
    await initCodebase(root, { mode: "none" });
    expect(symbolsOf(await readContextMap(root))).toContain("gamma");

    // 2) ADD — a new file changes the walk count → stale → re-analysis includes it.
    await fs.writeFile(path.join(root, "src/c.ts"), "export function delta() { return 4; }\n");
    expect((await checkInitState(root)).status).toBe("stale");
    await initCodebase(root, { mode: "none" });
    expect(symbolsOf(await readContextMap(root))).toContain("delta");

    // 3) DELETE — removing a file changes the walk count → stale → re-analysis drops its symbols.
    await fs.rm(path.join(root, "src/b.ts"));
    expect((await checkInitState(root)).status).toBe("stale");
    await initCodebase(root, { mode: "none" });
    const afterDelete = await readContextMap(root);
    expect(symbolsOf(afterDelete)).not.toContain("beta");
    expect(afterDelete?.files.some((f) => f.path === "src/b.ts")).toBe(false);
    expect(symbolsOf(afterDelete)).toEqual(expect.arrayContaining(["alpha", "gamma", "delta"]));

    // Settled — nothing changed since the last init → fresh again (the cheap fingerprint matches).
    expect((await checkInitState(root)).status).toBe("initialized");
  });

  it("a rename (delete old + add new) is a stale-then-correct re-analysis, not a silent carry-over", async () => {
    const root = await makeRepo({ "src/old.ts": "export function oldName() { return 1; }\n" });
    await initCodebase(root, { mode: "none" });
    expect(symbolsOf(await readContextMap(root))).toContain("oldName");

    await fs.rm(path.join(root, "src/old.ts"));
    await fs.writeFile(path.join(root, "src/new.ts"), "export function newName() { return 1; }\n");
    expect((await checkInitState(root)).status).toBe("stale");
    await initCodebase(root, { mode: "none" });

    const map = await readContextMap(root);
    expect(symbolsOf(map)).toContain("newName");
    expect(symbolsOf(map)).not.toContain("oldName"); // the deleted file's symbol is gone, not stale-carried
    expect(map?.files.some((f) => f.path === "src/old.ts")).toBe(false);
  });
});
