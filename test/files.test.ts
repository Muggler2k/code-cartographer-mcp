import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { categorizeFile, hashFile } from "../src/files.js";
import { tempRepos } from "./helpers/fixtures.js";

const { makeRepo, cleanup } = tempRepos("ccm-files-");
afterEach(cleanup);

async function writeFixture(name: string, data: string | Buffer): Promise<{ root: string; rel: string }> {
  const root = await makeRepo();
  await fs.writeFile(path.join(root, name), data);
  return { root, rel: name };
}

describe("hashFile (A4, Decision 0010/0011)", () => {
  it("hashes a text file: content scope, analyzable, sha256 + size", async () => {
    const { root, rel } = await writeFixture("a.ts", "export const x = 1;\n"); // 20 bytes
    const h = await hashFile(root, rel);
    expect(h.hashScope).toBe("content");
    expect(h.analyzable).toBe(true);
    expect(h.analysisReason).toBe("text source");
    expect(h.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h.sizeBytes).toBe(20);
  });

  it("flags a binary file (null byte) as non-analyzable, still content-hashed", async () => {
    const { root, rel } = await writeFixture("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const h = await hashFile(root, rel);
    expect(h.hashScope).toBe("content");
    expect(h.analyzable).toBe(false);
    expect(h.analysisReason).toBe("binary: null byte");
  });

  it("over-cap files use a metadata hash and are non-analyzable", async () => {
    const { root, rel } = await writeFixture("big.txt", "0123456789");
    const h = await hashFile(root, rel, 4); // cap = 4 bytes
    expect(h.hashScope).toBe("metadata");
    expect(h.analyzable).toBe(false);
    expect(h.analysisReason).toBe("over size cap");
  });

  it("over-cap precedence: a large binary is 'over size cap', not 'binary'", async () => {
    const { root, rel } = await writeFixture("big.bin", Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const h = await hashFile(root, rel, 2);
    expect(h.analysisReason).toBe("over size cap");
    expect(h.hashScope).toBe("metadata");
  });

  it("content hash is deterministic; metadata hash keys off path+size instead", async () => {
    const { root, rel } = await writeFixture("a.txt", "hello");
    const h1 = await hashFile(root, rel);
    const h2 = await hashFile(root, rel);
    expect(h1.sha256).toBe(h2.sha256);
    const meta = await hashFile(root, rel, 1);
    expect(meta.sha256).not.toBe(h1.sha256);
  });
});

describe("categorizeFile (C2)", () => {
  it.each([
    ["src/index.ts", "source"],
    ["lib/util.py", "source"],
    ["test/foo.test.ts", "test"],
    ["src/foo.spec.js", "test"],
    ["tests/test_thing.py", "test"],
    ["README.md", "documentation"],
    ["docs/guide.md", "documentation"],
    ["LICENSE", "documentation"],
    ["package.json", "config"],
    ["tsconfig.json", "config"],
    [".gitignore", "config"],
    ["package-lock.json", "generated"],
    ["go.sum", "generated"],
    ["context/00_index/index.md", "context"],
    ["data.bin", "other"]
  ] as const)("categorizes %s as %s", (relPath, expected) => {
    expect(categorizeFile(relPath)).toBe(expected);
  });
});
