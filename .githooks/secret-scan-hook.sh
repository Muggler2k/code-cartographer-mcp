#!/usr/bin/env bash
# Claude Code PreToolUse(Write|Edit|MultiEdit) secret/PII guard.
# Reuses the regex set in .githooks/secret-patterns.txt (shared with pre-commit).
# Reads the hook JSON on stdin, scans the *pending* file content, and denies the
# write if a likely secret/PII is detected. Silent (exit 0, no output) otherwise.
set -u

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATTERNS_FILE="$HOOK_DIR/secret-patterns.txt"

INPUT="$(cat)"
[ -f "$PATTERNS_FILE" ] || exit 0

# Candidate text = what is about to be written:
#   Write.content, Edit.new_string, MultiEdit.edits[].new_string
CAND="$(printf '%s' "$INPUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  let j;try{j=JSON.parse(s)}catch(e){process.exit(0)}
  const t=(j&&j.tool_input)||{};const p=[];
  if(typeof t.content==="string")p.push(t.content);
  if(typeof t.new_string==="string")p.push(t.new_string);
  if(Array.isArray(t.edits))for(const e of t.edits){if(e&&typeof e.new_string==="string")p.push(e.new_string);}
  process.stdout.write(p.join("\n"));
});')"

[ -z "$CAND" ] && exit 0

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
printf '%s' "$CAND" > "$TMP"

FOUND=""
while IFS= read -r entry; do
  case "$entry" in ""|\#*) continue ;; esac
  label="${entry%%|*}"
  regex="${entry#*|}"
  # PCRE first (needs a UTF-8/unibyte locale on msys); fall back to ERE+ignorecase.
  if hits=$(LC_ALL=C.UTF-8 grep -nIP -- "$regex" "$TMP" 2>/dev/null); then :; else
    hits=$(LC_ALL=C.UTF-8 grep -nIEi -- "$regex" "$TMP" 2>/dev/null || true)
  fi
  [ -n "$hits" ] && FOUND="${FOUND}${label}; "
done < "$PATTERNS_FILE"

if [ -n "$FOUND" ]; then
  REASON="Secret/PII guard blocked this write: [${FOUND}]. Remove the secret/PII. If it is a confirmed false positive, adjust .githooks/secret-patterns.txt or express the value differently."
  node -e 'process.stdout.write(JSON.stringify({
    systemMessage:"Secret/PII guard blocked a write.",
    hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:process.argv[1]}
  }))' "$REASON"
fi
exit 0
