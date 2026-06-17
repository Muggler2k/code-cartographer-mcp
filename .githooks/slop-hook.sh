#!/usr/bin/env bash
# Claude Code PostToolUse(Write|Edit|MultiEdit) anti-slop guard.
# Runs `npm run slop` (scripts/slop-check.mjs) when a file under src/** or test/** .ts
# was edited, and feeds any failure back to Claude. No-op for all other files.
# Pairs with typecheck-hook.sh + test-hook.sh; the CI `slop` gate is the backstop —
# this gives the same signal at edit time, the moment a disabled test / type
# suppression / tautological assertion is introduced.
set -u

INPUT="$(cat)"
FP="$(printf '%s' "$INPUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  let j;try{j=JSON.parse(s)}catch(e){process.exit(0)}
  const t=(j&&j.tool_input)||{};process.stdout.write(t.file_path||"");
});')"

# Only react to .ts files under src/ or test/ (handles / and \ separators).
printf '%s' "$FP" | grep -Eiq '[\\/](src|test)[\\/].*\.ts$' || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT="$(cd "$PROJECT_DIR" && npm run --silent slop 2>&1)"; CODE=$?
[ "$CODE" -eq 0 ] && exit 0

printf '%s' "$OUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  const out=s.slice(0,4000);
  process.stdout.write(JSON.stringify({decision:"block",reason:"`npm run slop` failed after your edit (a disabled/narrowed test, a type-checker suppression, or a tautological assertion). Fix it:\n"+out}));
});'
exit 0
