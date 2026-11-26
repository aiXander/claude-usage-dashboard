# Where the numbers come from

Read this before changing anything in `server/`. The shape of the code follows
from these facts about Claude Code's on-disk records, none of which are
documented or stable.

Related: [cost-model.md](cost-model.md) for how dollars are derived.

## The three stores

### 1. `<root>/.claude-costs` — the cost ledger

Written by the statusline hook (`~/.claude/statusline.sh`), not by Claude Code
itself. Flat JSON: `{ "<session-uuid>": <usd-float> }`, overwritten in place as
a session's cost grows.

- Location is the **git root** when there is one, otherwise the cwd. A repo has
  one ledger at the top; a loose folder tree can have several. `findLedgers()`
  walks 4 levels down from the root, **and** adds the nearest ledger above
  every cwd a session ran in. The walk alone missed deep repos
  (`~/Documents/GitHub/Gigabrain/VJ/WZRD`, $4k) — never drop the second half.
- A ledger's folder is also a **project** for the project filter
  (`projectOf()`); every session belongs to its nearest ledgered ancestor.
- No timestamps. This is the single most consequential gap in the whole
  dataset — it is why the all-time daily curve needs an estimate.
- The hook writes under a lock and re-reads inside it, so concurrent sessions
  don't clobber each other. Treat the file as append-mostly but never assume
  it parses — `readLedgers()` skips unparseable files and reports them.

### 2. `~/.claude/projects/<mangled-cwd>/<session>.jsonl` — transcripts

- **The directory name is lossy.** Both `/` and `_` flatten to `-`, so
  `agent_frameworks/motherbrain` and `agent-frameworks-motherbrain` are
  indistinguishable. Never decode it. Every record carries an authoritative
  `cwd` field; `cwdOfProjectDir()` reads one line from one file instead.
- **One directory per cwd, not per project.** A repo worked on from a
  subdirectory gets a second directory. Selecting a root means taking every
  directory whose `cwd` is under it.
- **Retention is roughly 30 days.** Files are pruned (see
  `~/.claude/.last-cleanup`). On a heavily used project this leaves under half
  the ledger's sessions with a surviving transcript.
- **Records repeat.** The same assistant message is written several times
  during streaming and replay. Summing raw rows double-counts tokens; dedupe on
  `message.id`. The statusline script relies on the same invariant.
- **Lines are enormous** — tens of KB average, most of it `file-history-snapshot`
  and attachment records nobody needs. `parse.mjs` substring-tests each line
  before `JSON.parse`, which is the difference between ~10s and ~90s on a
  400 MB project. Widen `WANTED` if you need a new record type; don't drop the
  filter.

Record types that matter: `assistant` (usage, model, tools, branch, effort),
`system` with `subtype: "turn_duration"` (wall-clock per turn, credited to the
model of the last reply before it), `ai-title` (the human-readable session
name), and `user` rows whose `toolUseResult` has a `structuredPatch` — the
exact diff of a successful Edit/Write, used for lines changed. A Write that
creates a file has an empty patch, so its `content` counts as added. The patch
row carries no model; it is matched to the assistant `tool_use` by id. Edits
made through Bash leave no patch and are invisible here.

### The archive

The digest cache (`~/.cache/claude-usage-dashboard/digests`, one file per
transcript, keyed by path hash) outlives the transcripts. `analyze` counts the
digests of deleted transcripts too (`archivedDigests`), which is what keeps
per-model detail for months Claude Code has already pruned. Digests written
before v7 have no `edits` and no per-turn model, so those months show no line
counts and turn time falls back to the session's active model. The archive
only grows when something parses transcripts — the UI or `make archive`.

`isSidechain: true` marks subagent turns. It is frequently absent rather than
`false`; treat only an explicit `true` as a sidechain.

- **Subagents write their own files**, at
  `<mangled-cwd>/<session>/subagents/agent-<id>.jsonl` (next to an
  `agent-<id>.meta.json`), under the *parent's* `sessionId`. On a heavy
  subagent user they outnumber main transcripts and carry ~25% of spend.
  `projectIndex()` collects them, and `aggregate.mjs` merges every file sharing
  a `sessionId` into one session before matching it to the ledger — the
  ledger's per-session total includes subagent cost, so reconciling the main
  file alone made raw cost look ~20% short.

### 3. `~/.claude/history.jsonl` — prompt history

`{display, timestamp, project}` per prompt, where `project` is the **real,
unmangled cwd**. Spans the account's full history (~11 months observed). It is
the only per-day signal that survives transcript cleanup, which makes it the
weighting basis for the estimated portion of the cost timeline.

## Things that look like data and aren't

- `~/.claude/telemetry/1p_failed_events.*.json` — failed telemetry uploads, not
  usage.
- `~/.claude/statusline-cache/*.tsv` — the statusline's own incremental token
  cache. Same numbers as the transcripts, pruned after 14 days. No extra reach.
- `~/.claude/session-env/` — per-session env, no usage data.
- Model `<synthetic>` — Claude Code's placeholder for API errors and local
  command output. Not billable; listed in `NON_BILLABLE` in `pricing.mjs`.

## Caching

`cache.mjs` keys a per-file digest on `(path, mtime, size)`. Transcripts are
append-only and never rewritten, so a file that hasn't grown cannot have
changed. Bump `VERSION` whenever `parse.mjs` changes what it extracts —
otherwise stale digests silently survive a parser fix.
