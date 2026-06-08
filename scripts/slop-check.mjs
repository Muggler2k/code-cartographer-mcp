#!/usr/bin/env node
// Slop gate — a TS-adapted Slopwatch. Fails if AI reward-hacking patterns appear in src/ or test/:
// disabled/narrowed/stub tests, type-checker suppressions, or tautological assertions. Pure Node,
// no dependencies, cross-platform (no reliance on grep). Run via `npm run slop`; wired into CI.
//
// This is a backstop against the gradual accumulation of "make it pass" shortcuts in a repo that
// will keep receiving AI-generated code. It does NOT replace review — it blocks the obvious cheats.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "test"];

const RULES = [
  {
    id: "SW001",
    re: /\b(?:it|describe|test)\.(?:skip|only|todo)\b|\bxit\b|\bxdescribe\b/,
    msg: "disabled/narrowed/stub test (.skip/.only/.todo/xit) — fix or delete it, don't disable"
  },
  {
    id: "SW002",
    re: /@ts-ignore|@ts-expect-error|@ts-nocheck/,
    msg: "type-checker suppression — fix the type instead of silencing it"
  },
  {
    id: "SW003",
    re: /expect\(\s*(?:true|false)\s*\)/,
    msg: "tautological assertion expect(true/false) — assert the real value"
  }
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const findings = [];
for (const root of ROOTS) {
  let files;
  try {
    files = walk(root);
  } catch {
    continue; // root absent — nothing to scan
  }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          findings.push({ id: rule.id, file: file.replace(/\\/g, "/"), line: index + 1, text: line.trim(), msg: rule.msg });
        }
      }
    });
  }
}

if (findings.length > 0) {
  console.error(`\nslop-check: ${findings.length} issue(s) — new slop is blocked:\n`);
  for (const f of findings) {
    console.error(`  ${f.id}  ${f.file}:${f.line}`);
    console.error(`        ${f.text}`);
    console.error(`        → ${f.msg}\n`);
  }
  process.exit(1);
}

console.log("slop-check: clean — no disabled tests, type suppressions, or tautological assertions.");
