# claude-usage-dashboard

A localhost dashboard that reports what Claude Code has cost in any folder on
this machine, and when. Node/Express API + React/Recharts UI, no database, no
network egress.

## Commands

```bash
make start       # build + serve on :5178 from one process, opens a browser
make stop        # kill a server left running
make dev         # API :5178 + Vite :5179 (proxied), hot reload
make check       # npx tsc --noEmit (there is no test suite yet)
make archive     # digest new transcripts into the archive (no UI)
make install-archive-agent  # daily LaunchAgent com.xander.claude-usage-archive running archive.mjs;
                 # pins nvm's node path, so re-run after a Node upgrade. Log: ~/Library/Logs/claude-usage-archive.log
```

`make` wraps the npm scripts (`dev`, `api`, `build`, `start`); either works.

`npx vite build` must pass before committing UI changes.

## Layout

```
server/index.mjs       Express: /api/fs, /api/roots, /api/analyze (job), /api/cache
server/discover.mjs    root -> transcript dirs, .claude-costs ledgers, prompt history
server/parse.mjs       one .jsonl -> compact digest
server/aggregate.mjs   digests + ledger + history -> the report object
server/pricing.mjs     model list prices, cache multipliers, non-billable models
server/cache.mjs       digest cache under ~/.cache/claude-usage-dashboard — also the archive
server/archive.mjs     digest-only pass, so transcripts are archived before Claude Code deletes them
src/App.tsx            all five tab panels
src/components/        charts.tsx, heatmaps.tsx, tables.tsx, primitives.tsx, FolderPicker.tsx, ProjectFilter.tsx
src/lib/               api.ts, palette.ts, format.ts, types.ts, series.ts
```

`src/lib/types.ts` mirrors the report `aggregate.mjs` produces. The server is
plain JS and the client is TS, so the two are only linked by that file — change
both together or the UI silently reads `undefined`.

## Reference docs

- [docs/reference/data-sources.md](docs/reference/data-sources.md) — what
  Claude Code writes to disk, what's lossy about it, and why the parser is
  shaped the way it is. **Read before touching `server/`.**
- [docs/reference/cost-model.md](docs/reference/cost-model.md) — the two cost
  figures, why they disagree, the ledger rescaling, and what "estimated" means.
- In-flight plans, if any, live in `docs/TODO/`.

## Rules that bite

- **Dedupe assistant rows on `message.id`.** They are written several times per
  message; summing raw rows double-counts every token.
- **Never decode a `~/.claude/projects` directory name.** `/` and `_` both
  flatten to `-`. Read the `cwd` field inside the file.
- **Keep the substring pre-filter in `parse.mjs`.** Without it a 400 MB project
  takes ~90s instead of ~2s.
- **Bump `VERSION` in `cache.mjs`** whenever `parse.mjs` changes what it
  extracts, or stale digests survive the fix.
- **Dollars follow the ledger, tokens stay raw.** Never rescale token counts.
- **Never delete an archived digest.** A digest whose transcript Claude Code has
  deleted is the only per-model record of that session. `clearCache` removes
  only digests of live transcripts; keep it that way, and keep old digest
  versions readable (`OLDEST_ARCHIVE_VERSION`) instead of discarding them.
- **A project is a folder with a `.claude-costs` ledger** (`projectOf`). The
  project filter hides transcripts, ledger and prompts together, server-side,
  so reconciliation stays consistent; never filter only one of the three.
- **Series colors go through `modelSlots` / `projectSlots`** in `App.tsx`:
  seven slots by cost, the rest fold into "Other". Never index `colors` by a
  raw model or project list. The main chart's Model/Project toggle reads
  `dailyByModel` or `dailyByProject` (same shape) via `Dimension` in `series.ts`.
- **Adding a model** = one row in `PRICES` (`server/pricing.mjs`) plus an entry
  in `MODEL_ORDER` (`src/App.tsx`) so it keeps a stable color. Both match by
  prefix, so a point release (`claude-opus-5-5`) silently inherits its
  predecessor's price and color until it gets its own row — check new model
  ids against list prices, cache-read rate included.
- **`data-theme` is always concrete** (`dark` or `light`, defaulting to dark) —
  `styles.css` has no `prefers-color-scheme` rules, so dark is the base token
  set and light the single override. `App` resolves `system` and the inline
  script in `index.html` repeats that resolution before the first paint;
  `usePalette` must be handed the *resolved* theme or the charts read stale
  colors.
- **A Recharts `<defs>` must be a literal element**, never a component
  returning one — Recharts filters its children down to real SVG tags, so
  `<Gradients/>` is dropped and every `url(#…)` fill silently becomes
  transparent. Same trap on ids: React 19's `useId()` returns `«r0»`, which is
  not a legal `url(#…)` target, so it has to be stripped to alphanumerics.
- **A stack's rounded top is per bar, not per series.** Recharts' `radius`
  rounds whichever `<Bar>` is declared last, which is the wrong segment on every
  bar where that series is zero — `StackedBars` decides it from the data in a
  custom `shape` instead.

## Chart conventions

The palette and rules come from the `dataviz` skill and its validator; both
mode palettes pass every check against the surfaces in `src/styles.css`.

- Categorical hues are a **fixed slot order**, never cycled and never assigned
  by rank. Models compact into the leading slots via `MODEL_ORDER`, which keeps
  every on-screen pair adjacent in the validated ordering.
- Never a dual-axis chart. Two measures of different scale get two charts.
- Fills are a vertical ramp of the **series' own hue** (opaque at the mark,
  near-zero at the baseline) — depth, not a second encoding. Hue still means
  "which series" and nothing else, so a ramp never spans two slots.
- Sequential (heatmaps) is one hue, quiet→loud on quantile bins (so it runs
  light→dark on the light surface and dark→light on the dark one).
- Every chart has a table twin — that is the relief for the light-mode contrast
  warning on three slots, and the accessible read of any color-encoded value.
- If you change the palette, re-run the validator from the `dataviz` skill for
  **both** modes against both surfaces before committing.
