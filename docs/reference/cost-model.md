# How dollars are derived

Prerequisite: [data-sources.md](data-sources.md).

There are two independent cost figures, and keeping them separate is the point.

## Ledger cost (authoritative)

Straight from `.claude-costs`: Claude Code's own per-session total. Every
headline dollar figure — total spend, cost per prompt, cost per active day —
comes from here. It has no time dimension.

## Token cost (derived)

Recomputed from the transcript's own token counts at public list prices:

```
cost = (fresh_input        × in_rate
      + cache_write_5m     × in_rate × 1.25
      + cache_write_1h     × in_rate × 2.00
      + cache_read         × in_rate × read_mult
      + output             × out_rate) / 1e6
```

Rates live in `PRICES` in `server/pricing.mjs`. The two cache-write
multipliers are uniform across the API; `read_mult` is 0.10 except on the
newest models (0.05 on Opus/Sonnet 5.5, 0.025 on Fable/Mythos 5.1+), which
carry it as a third column. Haiku 5.5 bills a second, 5× rate card when the
whole prompt is over 100K tokens (`LONG_PROMPT`). Model ids appear with and
without date suffixes (`claude-haiku-4-5-20251001`), so lookup matches the
longest known prefix — which means a new point release (`claude-opus-5-5`)
silently inherits its predecessor's price until it gets its own row.
`speed: "fast"` gets its own table.

Older records carry only a flat `cache_creation_input_tokens`; newer ones split
it by TTL under `cache_creation`. The 1.25× vs 2.00× difference is material —
`parse.mjs` keeps them apart and attributes the flat legacy field to the 5m
default.

## Why they disagree, and what we do about it

Measured on a real project: token cost lands ~8% **below** ledger cost in
aggregate. Per session the ratio is mostly 0.94–0.99, with occasional far
outliers (one session measured 0.29). The outliers are partial transcripts —
cleanup trimmed the file, or a session was resumed and only its tail survived.

`aggregate.mjs` therefore rescales each session's per-request costs by
`ledgerCost / rawCost` before any time-series aggregation. This puts the true
session spend on the days its requests actually happened.

Two guards on that:

- The factor is clamped to `(0.2, 8)`. A ratio outside that means the
  transcript is a stub; inflating three requests to carry $100 would corrupt
  cost-per-request, cost-per-hour, and the model split. Those sessions keep
  raw cost.
- **Token counts are never rescaled.** Only dollars. Anything reported in
  tokens is raw from the transcript.

`report.reconciliation` exposes the pre-rescale gap so the UI can say so out
loud rather than quietly presenting a corrected number.

## The estimated portion of the timeline

`costCoverage` = ledger dollars belonging to sessions that still have a
transcript. On a long-lived project this is well under half.

The remainder has no date. It is distributed across the days that have prompt
history but no transcript, in proportion to that day's prompt count. The UI
charts it as a separate, differently-coloured series labelled *Estimated*, and
never folds it into an "exact" figure.

The assumption — cost per prompt is roughly stable across a project's life — is
the weakest link in the whole pipeline. It is fine for shape and terrible for
any single day. Do not build a metric on `costTimeline.estimated` that implies
per-day precision.

## Date axes

Every daily series is filled across its full calendar range, gaps included: an
idle week has to occupy a week's width. Rate metrics (`cacheHit`,
`avgContext`) are `null` rather than `0` on days with no requests, and the
charts pass `connectNulls` so a line skips the gap instead of diving to the
floor. All bucketing is local time — "when did I work" is a wall-clock
question.

The server only ever emits days. Week and month grain is a client-side re-sum
in `src/lib/series.ts`, over the same local calendar (weeks are Monday-anchored,
months are calendar months, never rolling windows). Coarser grain is also the
honest way to read the estimated portion: the spread-by-prompt assumption is
worthless per day and defensible per month, so it gets *more* trustworthy as the
bucket grows — which is why the grain switch sits on the main chart rather than
being a display preference.

## The main chart

`SpendCard` in `src/App.tsx` is the one place both halves of the cost record are
drawn together: per-model dollars where a transcript survives, plus the
estimated remainder where it doesn't. The two are disjoint by construction — a
day either has transcripts and therefore a model breakdown, or it is part of the
pre-retention window — so a bar is never half-attributed, and `costTimeline` (all
time) rather than `dailyByModel` (transcript window) is the total each bucket
must add up to. The remainder takes the neutral `--estimate` grey, never a
categorical slot, because "which model" is exactly the thing that record lost.
