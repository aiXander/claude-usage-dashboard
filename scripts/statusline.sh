#!/bin/bash
# Claude Code statusline: model | context | tokens | cost
#
# stdin is the statusline JSON payload from Claude Code. Everything here must
# degrade quietly: a broken section drops out of the line rather than breaking it.

input=$(cat)

eval "$(printf '%s' "$input" | jq -r '
  @sh "MODEL=\(.model.display_name // "?")",
  @sh "COST=\(.cost.total_cost_usd // 0)",
  @sh "PCT=\(.context_window.used_percentage // 0 | floor)",
  @sh "SESSION_ID=\(.session_id // "")",
  @sh "TRANSCRIPT=\(.transcript_path // "")",
  @sh "CWD=\(.cwd // "")"
')"

BOLD=$'\033[1m'; RESET=$'\033[0m'
RED=$'\033[31m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'

# ---------------------------------------------------------------- tokens ----
# Assistant rows in the transcript carry a .message.usage block. The same
# message is written several times (streaming/replay), so rows are deduped on
# message.id before summing.
#
# The transcript is append-only and reaches tens of MB, so rather than
# rescanning it every render we keep a per-session cache of the deduped rows
# plus a byte offset, and only parse the bytes appended since last time.
# Because dedupe is by id, re-reading an overlapping tail is always harmless —
# that's what makes the checkpointing safe against partial writes and races.
TOK=""
if [ -f "$TRANSCRIPT" ]; then
  CACHE_DIR="$HOME/.claude/statusline-cache"
  CACHE="$CACHE_DIR/${SESSION_ID:-$(basename "$TRANSCRIPT" .jsonl)}.tsv"
  SIZE=$(stat -f%z "$TRANSCRIPT" 2>/dev/null || stat -c%s "$TRANSCRIPT" 2>/dev/null || echo 0)

  OFFSET=0
  CACHED_ROWS=""
  if [ -f "$CACHE" ]; then
    OFFSET=$(sed -n '1s/^#offset=//p' "$CACHE")
    case "$OFFSET" in ''|*[!0-9]*) OFFSET=0 ;; esac
    # File shrank or was rotated: the offset is meaningless, rescan.
    [ "$OFFSET" -gt "$SIZE" ] && OFFSET=0
    [ "$OFFSET" -gt 0 ] && CACHED_ROWS=$(tail -n +2 "$CACHE")
  else
    mkdir -p "$CACHE_DIR" 2>/dev/null
    find "$CACHE_DIR" -type f -name '*.tsv' -mtime +14 -delete 2>/dev/null
  fi

  # jq streams, so a half-written trailing line makes it exit non-zero *after*
  # emitting every complete record before it — which is exactly what we want,
  # hence the ignored exit status.
  #
  # Note the two input paths: BSD `tail -c +1` falls off a fast path and is ~7x
  # slower than letting jq open the file itself, so a full scan reads the file
  # directly and only a real (non-zero) offset goes through tail.
  USAGE_FILTER='
    select(.message.usage != null)
    | [ .message.id,
        (.message.usage.input_tokens // 0),
        (.message.usage.cache_creation_input_tokens // 0),
        (.message.usage.cache_read_input_tokens // 0),
        (.message.usage.output_tokens // 0)
      ] | @tsv
  '
  if [ "$OFFSET" -gt 0 ]; then
    NEW_ROWS=$(tail -c "+$((OFFSET + 1))" "$TRANSCRIPT" 2>/dev/null | jq -r "$USAGE_FILTER" 2>/dev/null)
  else
    NEW_ROWS=$(jq -r "$USAGE_FILTER" "$TRANSCRIPT" 2>/dev/null)
  fi

  ROWS=$(printf '%s\n%s\n' "$CACHED_ROWS" "$NEW_ROWS" | grep -v '^$' | sort -t$'\t' -u -k1,1)

  if [ -n "$ROWS" ]; then
    # Only checkpoint at EOF when the file ends on a newline, i.e. the last
    # record is complete.
    NEW_OFFSET=$OFFSET
    [ -z "$(tail -c 1 "$TRANSCRIPT" 2>/dev/null)" ] && NEW_OFFSET=$SIZE
    if [ "$NEW_OFFSET" != "$OFFSET" ] || [ ! -f "$CACHE" ]; then
      TMP="$CACHE.$$"
      { echo "#offset=$NEW_OFFSET"; printf '%s\n' "$ROWS"; } > "$TMP" 2>/dev/null &&
        mv "$TMP" "$CACHE" 2>/dev/null || rm -f "$TMP" 2>/dev/null
    fi

    # -> "<total-in-human> <cache-hit-%> <out-human> <total-in-raw>"
    read -r IN_H HIT OUT_H IN_RAW <<<"$(printf '%s\n' "$ROWS" | awk -F'\t' '
      function human(n) {
        if (n >= 1000000) return sprintf("%.1fM", n / 1000000)
        if (n >= 1000)    return sprintf("%.1fk", n / 1000)
        return sprintf("%d", n)
      }
      { fresh += $2; cwrite += $3; cread += $4; out += $5 }
      END {
        tin = fresh + cwrite + cread
        printf "%s %.0f %s %d", human(tin), (tin ? 100 * cread / tin : 0), human(out), tin
      }
    ')"

    # Cache hit rate is only meaningful once the session has some history —
    # early turns are legitimately all cache-writes.
    HIT_COL=""
    if [ "${IN_RAW:-0}" -gt 200000 ]; then
      if   [ "$HIT" -ge 90 ]; then HIT_COL=$GREEN
      elif [ "$HIT" -ge 70 ]; then HIT_COL=$YELLOW
      else                         HIT_COL=$RED
      fi
    fi
    TOK="in $IN_H (${HIT_COL}${HIT}%${RESET} cached) · out $OUT_H"
  fi
fi

# ------------------------------------------------------------------ cost ----
COST_FMT=$(printf '$%.4f' "$COST")

TOTAL_FMT=""
if [ -n "$CWD" ] && [ -n "$SESSION_ID" ]; then
  GIT_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)
  PROJECT_ROOT="${GIT_ROOT:-$CWD}"
  if [ -n "$PROJECT_ROOT" ]; then
    COST_FILE="$PROJECT_ROOT/.claude-costs"

    DATA=$(cat "$COST_FILE" 2>/dev/null)
    [ -z "$DATA" ] && DATA='{}'

    TOTAL=$(printf '%s' "$DATA" | jq -r --arg sid "$SESSION_ID" --argjson cost "$COST" '
      (.[$sid] // -1) as $prev
      | .[$sid] = $cost
      | "\($prev)\t\([.[]] | add // 0)"
    ' 2>/dev/null)
    PREV=${TOTAL%%$'\t'*}
    TOTAL=${TOTAL##*$'\t'}

    # Persist only when this session's cost actually moved. Most renders then
    # do no write at all, which keeps the ledger off the disk-write path and
    # shrinks the window in which two concurrent sessions can collide.
    if [ -n "$TOTAL" ] && [ "$PREV" != "$COST" ]; then
      # The lock lives under $HOME, never in the project: this script runs in
      # every repo on the machine and most of them do not gitignore stray
      # .claude-costs* artefacts.
      LOCK_DIR="$HOME/.claude/statusline-cache"
      mkdir -p "$LOCK_DIR" 2>/dev/null
      LOCK="$LOCK_DIR/$(printf '%s' "$COST_FILE" | cksum | cut -d' ' -f1).lock"
      LOCKED=""
      for _ in 1 2 3 4 5 6 7 8; do
        if mkdir "$LOCK" 2>/dev/null; then LOCKED=1; break; fi
        # Break a lock left behind by a killed session.
        [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$LOCK" 2>/dev/null
        # Randomised backoff: several panes tend to render in lockstep.
        sleep "0.0$((RANDOM % 9 + 1))"
      done
      # Losing the race is harmless — the next render retries the same write.
      if [ -n "$LOCKED" ]; then
        # Re-read inside the lock: another session may have written since our
        # read, and its entry must survive our update.
        FRESH=$(cat "$COST_FILE" 2>/dev/null)
        [ -z "$FRESH" ] && FRESH='{}'
        UPDATED=$(printf '%s' "$FRESH" | jq -c --arg sid "$SESSION_ID" --argjson cost "$COST" '
          .[$sid] = $cost
        ' 2>/dev/null)
        if [ -n "$UPDATED" ]; then
          TMPFILE=$(mktemp "${COST_FILE}.XXXXXX" 2>/dev/null)
          if [ -n "$TMPFILE" ]; then
            printf '%s\n' "$UPDATED" > "$TMPFILE" && mv "$TMPFILE" "$COST_FILE" || rm -f "$TMPFILE"
          fi
          TOTAL=$(printf '%s' "$UPDATED" | jq -r '[.[]] | add // 0' 2>/dev/null)
        fi
        rmdir "$LOCK" 2>/dev/null
      fi
    fi

    if [ -n "$TOTAL" ]; then
      TOTAL_FMT=$(printf '$%.1f' "$TOTAL")
    elif [ -s "$COST_FILE" ]; then
      # Unparseable ledger. Deliberately not rewritten — it may hold months of
      # history and a bad overwrite is unrecoverable — but surfaced rather than
      # silently dropping cost tracking for this project.
      TOTAL_FMT="?"
    fi
  fi
fi

# ------------------------------------------------------------------ line ----
if   [ "${PCT:-0}" -ge 80 ]; then CTX_COL=$RED
elif [ "${PCT:-0}" -ge 60 ]; then CTX_COL=$YELLOW
else                              CTX_COL=""
fi

LINE="$MODEL | ${CTX_COL}${PCT}%${RESET} context"
[ -n "$TOK" ]       && LINE="$LINE | ${BOLD}tokens:${RESET} $TOK"
LINE="$LINE | ${BOLD}cost:${RESET} session $COST_FMT"
[ -n "$TOTAL_FMT" ] && LINE="$LINE · project $TOTAL_FMT"

echo "$LINE"
