# Claude Usage Dashboard

A localhost dashboard that answers, for any folder on your machine: **what has
Claude cost me here, on what, and when?**

Point it at a project folder. It reads Claude Code's own records — nothing is
sent anywhere — and gives you spend over time, model mix, cache efficiency, a
session leaderboard, and a punchcard of when you actually work.

## Getting started

**Needs:** Node 20+, plus `jq` and `git` for the statusline. macOS is the
tested platform (the daily archive job is a macOS LaunchAgent).

1. **Install the statusline** (once per machine, recommended):

   ```bash
   make install-statusline
   ```

   Claude Code itself never writes a running cost total to disk. This
   statusline does: on every render it records the session's cost in a
   `.claude-costs` file at the git root (or the cwd outside a repo). That
   ledger is the only source for all-time totals and for the per-project
   filter. It copies `scripts/statusline.sh` to `~/.claude/statusline.sh` and
   sets `statusLine` in `~/.claude/settings.json`. If you already have a
   statusline, it stops without changing anything; merge the `# cost` section
   of `scripts/statusline.sh` into yours instead.

   Ledgers only start from install, so sessions before it have no ledger
   entry and show only what their transcripts hold. The file lands in every repo you use Claude
   Code in, so add it to your global gitignore:

   ```bash
   mkdir -p ~/.config/git && echo .claude-costs >> ~/.config/git/ignore
   ```

2. **Run the dashboard:**

   ```bash
   make start           # installs, builds, serves on :5178, opens a browser
   ```

   Pick a folder (a repo, or your home folder for everything). Without the
   statusline you still get the last ~30 days of transcripts: tokens, models,
   sessions, punchcard, just no all-time dollar total and no project split.

3. **Keep history past 30 days** (optional, macOS):

   ```bash
   make install-archive-agent
   ```

   Claude Code deletes transcripts after ~30 days. The dashboard keeps a
   compact digest of every transcript it has seen (~1% of the size), and that
   archive is what keeps older months' per-model detail. This schedules
   `make archive` daily as a LaunchAgent. A gap in the archive (no scan within
   30 days) is permanent. Re-run it after switching Node versions.

For UI work, with hot reload: `make dev` (API on :5178, UI on :5179, proxied).
`make` is a thin wrapper, so `npm install && npm run build && npm start` is
the same thing. `make stop` kills a server left running in the background.

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

`.claude-costs` is written by the statusline (`make install-statusline`,
above). Without it you still get everything the transcripts hold, just no
all-time total.

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
  cache.mjs       Per-file digest cache keyed on (mtime, size); also the archive
  archive.mjs     Digest-only pass behind `make archive`
scripts/
  statusline.sh               The statusline that writes .claude-costs
  install-statusline.sh       Installs it into ~/.claude
  install-archive-agent.sh    Daily LaunchAgent for archive.mjs
src/              React + Recharts UI
```

Digests are cached under `~/.cache/claude-usage-dashboard`, so a re-scan of a
400 MB project is near-instant. `DELETE /api/cache` clears digests of transcripts that still exist (archived
ones are kept); the `VERSION`
constant in `cache.mjs` invalidates it after a parser change.

## Adding a model

One row in `PRICES` in `server/pricing.mjs`. Add it to `MODEL_ORDER` in
`src/App.tsx` too so it keeps a stable color. Everything else follows.
