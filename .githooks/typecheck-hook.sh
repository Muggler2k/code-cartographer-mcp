#!/usr/bin/env bash
# Claude Code PostToolUse(Write|Edit|MultiEdit) TypeScript guard.
# Runs `npm run typecheck` only when a file under src/**.ts was edited, and feeds
# any failure back to Claude. No-op for all other files.
set -u

INPUT="$(cat)"
FP="$(printf '%s' "$INPUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  let j;try{j=JSON.parse(s)}catch(e){process.exit(0)}
  const t=(j&&j.tool_input)||{};process.stdout.write(t.file_path||"");
});')"

# Only react to .ts files under a src/ directory (handles / and \ separators).
printf '%s' "$FP" | grep -Eiq '[\\/]src[\\/].*\.ts$' || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT="$(cd "$PROJECT_DIR" && npm run --silent typecheck 2>&1)"; CODE=$?
[ "$CODE" -eq 0 ] && exit 0

printf '%s' "$OUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  const out=s.slice(0,4000);
  process.stdout.write(JSON.stringify({decision:"block",reason:"`npm run typecheck` failed after your edit. Fix these type errors:\n"+out}));
});'
exit 0
