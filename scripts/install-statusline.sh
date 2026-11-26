#!/bin/bash
# Install the Claude Code statusline that writes the `.claude-costs` ledger the
# dashboard reads (all-time cost per session, per project).
#
#   ./scripts/install-statusline.sh      (or: make install-statusline)
#
# Copies scripts/statusline.sh to ~/.claude/statusline.sh and points
# `statusLine` in ~/.claude/settings.json at it. It never overwrites a
# statusline you already have: if one exists, it stops and says what to merge.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/scripts/statusline.sh"
DEST="$HOME/.claude/statusline.sh"
SETTINGS="$HOME/.claude/settings.json"
CMD="~/.claude/statusline.sh"

command -v jq >/dev/null || { echo "jq is required (macOS: brew install jq)" >&2; exit 1; }
mkdir -p "$HOME/.claude"

if [[ -e "$DEST" ]] && ! cmp -s "$SRC" "$DEST"; then
  echo "$DEST already exists and differs from this repo's version; not touching it." >&2
  echo "Merge the '# cost' section of $SRC into it to get the ledger." >&2
  exit 1
fi

[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
CURRENT="$(jq -r '.statusLine.command // empty' "$SETTINGS")"
if [[ -n "$CURRENT" && "$CURRENT" != "$CMD" && "$CURRENT" != "$DEST" ]]; then
  echo "settings.json already has a statusLine: $CURRENT" >&2
  echo "Not replacing it. Merge the '# cost' section of $SRC into that script," >&2
  echo "or point statusLine.command at $CMD yourself." >&2
  exit 1
fi

install -m 755 "$SRC" "$DEST"
if [[ -z "$CURRENT" ]]; then
  cp "$SETTINGS" "$SETTINGS.bak"
  jq --arg cmd "$CMD" '.statusLine = {type: "command", command: $cmd}' "$SETTINGS.bak" > "$SETTINGS"
  echo "statusLine set in $SETTINGS (backup: $SETTINGS.bak)"
fi
echo "Installed $DEST. Ledgers start filling from your next Claude Code session."
echo "Tip: it writes .claude-costs into each repo root; add it to your global gitignore:"
echo "  mkdir -p ~/.config/git && echo .claude-costs >> ~/.config/git/ignore"
