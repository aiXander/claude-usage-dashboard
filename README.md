# Claude Usage Dashboard

A localhost dashboard that answers, for any folder on your machine: **what has
Claude cost me here, on what, and when?**

Point it at a project folder. It reads Claude Code's own records — nothing is
sent anywhere — and gives you spend over time, model mix, cache efficiency, a
session leaderboard, and a punchcard of when you actually work.

```bash
make start           # installs, builds, serves on :5178, opens a browser
```

Or for UI work, with hot reload:

```bash
make dev             # API on :5178, UI on :5179 (proxied)
```

`make archive` digests new transcripts without opening the UI. Claude Code
deletes transcripts after ~30 days; the dashboard keeps a compact digest of
every transcript it has seen (~1% of the size), and that archive is what keeps
older months' per-model detail. `make install-archive-agent` schedules it daily
as a macOS LaunchAgent; a gap in the archive (no scan within 30 days) is
permanent.

`make` is a thin wrapper — `npm install && npm run build && npm start` is the
same thing. `make stop` kills a server left running in the background.

The server binds `127.0.0.1` only. It reads your filesystem, so it must not be
exposed to a network.

## What it reads

Three stores, with very different reach. The dashboard keeps them distinct
rather than blending them into one number you can't reason about.

| Source | Reach | Carries |
|---|---|---|
| `<project>/.claude-costs` | **All time**, exact | Cost per session id — but no timestamps |
| `~/.claude/projects/**/*.jsonl` | **~30 days** (Claude Code prunes) | Tokens, models, tools, effort, branch, timings |
| `~/.claude/history.jsonl` | **All time** | Every prompt, with a timestamp and a cwd |

So: the ledger knows the true total but not *when*; the transcripts know
everything but only recently; the prompt history is the only thing spanning
both. Anything that needs all three at once — the all-time daily cost curve —
is computed as an estimate and **labelled as one** in the UI.

`.claude-costs` is written by the statusline hook in `~/.claude/statusline.sh`.
Without it you still get everything the transcripts hold, just no all-time
total.

## Two cost numbers, deliberately

- **Ledger cost** — what Claude Code recorded per session. Authoritative, used
  for every headline dollar figure.
- **Token cost** — recomputed from the transcript's own token counts at list
  prices (`server/pricing.mjs`).

They differ by a few percent because some transcripts are partial. Per-session
token costs are therefore **rescaled to match the ledger**, which puts the true
session spend on the days its requests actually happened. Token counts
themselves are never rescaled. The Overview tab reports the gap.

## Metrics worth knowing about

- **Cache hit rate** — the biggest lever on cost. Cached input bills at 0.1×;
  a dip means a prompt prefix changed and the cache was rebuilt.
- **Cost per million output tokens** — cost divided by tokens *actually
  written*. On a long-context agentic project this is far above list price, and
  it is the honest measure of what context bloat costs you.
- **Context per request** — rising means sessions run longer before a reset.
- **Top 5% session share** — how concentrated your spend is.
- **Engaged model time** — summed turn durations; the closest thing to "hours
  worked" in the record.

## Layout

```
server/
  index.mjs       Express API — file browser, analysis jobs, cache admin
  discover.mjs    Locates transcript dirs, ledgers, prompt history for a root
  parse.mjs       One transcript -> a compact digest (dedupes replayed rows)
  aggregate.mjs   Digests + ledger + history -> the report the UI renders
  pricing.mjs     Per-model list prices and cache multipliers
  cache.mjs       Per-file digest cache keyed on (mtime, size)
src/              React + Recharts UI
```

Digests are cached under `~/.cache/claude-usage-dashboard`, so a re-scan of a
400 MB project is near-instant. `DELETE /api/cache` clears it; the `VERSION`
constant in `cache.mjs` invalidates it after a parser change.

## Adding a model

One row in `PRICES` in `server/pricing.mjs`. Add it to `MODEL_ORDER` in
`src/App.tsx` too so it keeps a stable color. Everything else follows.
