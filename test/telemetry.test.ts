// ADR 0034 S2 — telemetry is gated (off by default), local-file only, and code-content-free:
// records carry tool name / timing / outcome / output SIZE / arg KEY names / an anonymized repo
// hash — never source, paths, symbol names, arg values, or output content.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { recordToolCall, repoId, resetTelemetryShapeCache, telemetryEnabled } from "../src/telemetry.js";
import { tempRepos } from "./helpers/fixtures.js";

const { makeRepo, cleanup } = tempRepos("ccm-telemetry-");

beforeEach(() => {
  resetTelemetryShapeCache();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

async function readJsonl(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(file, "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

const REC = {
  ts: "2026-06-14T00:00:00.000Z",
  tool: "analyze_reachability",
  ms: 12,
  ok: true,
  outputChars: 345,
  argKeys: ["outputMode", "repositoryRoot", "target"]
};

describe("telemetry (ADR 0034 S2) — gated, local-file, code-content-free", () => {
  it("is a no-op when CCM_TELEMETRY is unset/empty", async () => {
    vi.stubEnv("CCM_TELEMETRY", "");
    const root = await makeRepo({});
    expect(telemetryEnabled()).toBe(false);
    await recordToolCall(root, REC);
    await expect(fs.readFile(path.join(root, ".code-cartographer-mcp", "telemetry.jsonl"), "utf8")).rejects.toThrow();
  });

  it("writes a metadata-only, anonymized tool_call record when CCM_TELEMETRY=1", async () => {
    vi.stubEnv("CCM_TELEMETRY", "1");
    const root = await makeRepo({});
    await recordToolCall(root, REC);
    const file = path.join(root, ".code-cartographer-mcp", "telemetry.jsonl");
    const records = await readJsonl(file);
    const call = records.find((r) => r.type === "tool_call")!;
    expect(call).toMatchObject({
      type: "tool_call",
      tool: "analyze_reachability",
      ms: 12,
      ok: true,
      outputChars: 345,
      argKeys: ["outputMode", "repositoryRoot", "target"]
    });
    // Anonymized: `repo` is a 12-hex hash of the path, and the real path never appears in the file.
    expect(call.repo).toBe(repoId(root));
    expect(call.repo).toMatch(/^[0-9a-f]{12}$/);
    expect(await fs.readFile(file, "utf8")).not.toContain(root);
    // ADR 0011: telemetry created the artifact dir before init, so it must still be gitignored.
    expect(await fs.readFile(path.join(root, ".code-cartographer-mcp", ".gitignore"), "utf8")).toContain("*");
  });

  it("emits a counts-only repo_shape record once per repo, with only bare-extension language keys", async () => {
    vi.stubEnv("CCM_TELEMETRY", "1");
    const root = await makeRepo({});
    await fs.mkdir(path.join(root, ".code-cartographer-mcp"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".code-cartographer-mcp", "context-map.json"),
      // The "src/leaked/path" key is path-like and must be sanitized out of the histogram.
      JSON.stringify({
        summary: { totalFiles: 7, languages: { ts: 5, md: 2, "src/leaked/path": 1 } },
        callGraph: { nodes: [1, 2, 3], edges: [1, 2] }
      })
    );
    await recordToolCall(root, REC);
    await recordToolCall(root, REC); // second call must NOT repeat the shape record
    const records = await readJsonl(path.join(root, ".code-cartographer-mcp", "telemetry.jsonl"));
    const shapes = records.filter((r) => r.type === "repo_shape");
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ totalFiles: 7, languages: { ts: 5, md: 2 }, nodes: 3, edges: 2, repo: repoId(root) });
    expect(shapes[0].languages).not.toHaveProperty("src/leaked/path"); // path-like key dropped
    expect(records.filter((r) => r.type === "tool_call")).toHaveLength(2);
  });

  it("honors a custom output file path", async () => {
    const root = await makeRepo({});
    const custom = path.join(root, "logs", "tele.jsonl");
    vi.stubEnv("CCM_TELEMETRY", custom);
    await recordToolCall(root, REC);
    const records = await readJsonl(custom);
    expect(records.some((r) => r.type === "tool_call")).toBe(true);
  });

  it("never throws when the target can't be written (telemetry must not break a tool call)", async () => {
    const root = await makeRepo({});
    vi.stubEnv("CCM_TELEMETRY", root); // a directory, not a file → appendFile fails, must be swallowed
    await expect(recordToolCall(root, REC)).resolves.toBeUndefined();
  });

  it("refuses a UNC path so records can't be routed over a network share", async () => {
    const root = await makeRepo({});
    vi.stubEnv("CCM_TELEMETRY", "\\\\server\\share\\tele.jsonl");
    await expect(recordToolCall(root, REC)).resolves.toBeUndefined();
    // Nothing was written into the repo's artifact dir either.
    await expect(fs.readFile(path.join(root, ".code-cartographer-mcp", "telemetry.jsonl"), "utf8")).rejects.toThrow();
  });
});
