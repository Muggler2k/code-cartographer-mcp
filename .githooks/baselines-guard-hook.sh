#!/usr/bin/env bash
# Claude Code PreToolUse(Write|Edit|MultiEdit) baselines guard.
# eval/baselines.json gates structural metrics HARD (ADR 0030) — "Budgets are data:
# edit consciously, with reasoning, never auto-regenerate." When a write targets it,
# ASK for confirmation so a baseline drift is a deliberate choice, never silent.
# Silent (exit 0, no output) for every other file.
set -u

INPUT="$(cat)"
FP="$(printf '%s' "$INPUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  let j;try{j=JSON.parse(s)}catch(e){process.exit(0)}
  const t=(j&&j.tool_input)||{};process.stdout.write(t.file_path||"");
});')"

# Only react to eval/baselines.json (handles / and \ separators).
printf '%s' "$FP" | grep -Eiq '[\\/]eval[\\/]baselines\.json$' || exit 0

REASON="eval/baselines.json gates structural metrics HARD (ADR 0030): a change here is a real product change, not noise. Confirm the new numbers are intentional and that the commit message will record the reasoning — never auto-regenerate a baseline."
node -e 'process.stdout.write(JSON.stringify({
  hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:process.argv[1]}
}))' "$REASON"
exit 0
