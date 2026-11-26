import { useCallback, useEffect, useMemo, useState } from 'react';
import { analyze, type Progress } from './lib/api';
import type { Report } from './lib/types';
import { usePalette, seriesColors, foldToOther } from './lib/palette';
import {
  GRAINS,
  GRAIN_LABEL,
  METRICS,
  METRIC_LABEL,
  bucketTick,
  bucketTitle,
  metricSeries,
  noDetailBands,
  spendSeries,
  type Dimension,
  type Grain,
  type Metric,
} from './lib/series';
import {
  dateTime,
  duration,
  hours,
  homeRelative,
  int,
  longDate,
  modelLabel,
  pct,
  shortDate,
  tokens,
  usd,
  usdCompact,
} from './lib/format';
import { Card, Empty, Legend, Tile } from './components/primitives';
import { HBars, Histogram, Lines, StackedAreas, StackedBars } from './components/charts';
import { CalendarHeatmap, Punchcard } from './components/heatmaps';
import { DataTable, SeriesTable, type Column } from './components/tables';
import { FolderPicker } from './components/FolderPicker';
import { ProjectFilter } from './components/ProjectFilter';
import type { SessionRow } from './lib/types';

const TABS = ['Overview', 'Spend over time', 'Efficiency', 'Sessions', 'Habits'] as const;
type Tab = (typeof TABS)[number];

/**
 * A model keeps its slot regardless of how much it cost, so the colors mean
 * the same thing across projects. Models present are compacted into the first
 * N palette slots in this order, which keeps every on-screen pair adjacent in
 * the validated categorical ordering.
 */
// Matched by prefix in order, so a longer id (`claude-opus-5-5`) must sit
// before its prefix (`claude-opus-5`).
const MODEL_ORDER = [
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
];

/**
 * Which models get their own color. Never more series than palette slots: the
 * costliest seven keep a slot (in `MODEL_ORDER` order), the rest are `folded`
 * into "Other". Every model-colored chart uses this, so a model's color is the
 * same everywhere.
 */
function modelSlots(report: Report, slots: number) {
  const all = report.dailyByModel.models.filter((m) => m !== '<synthetic>');
  const cost = new Map(report.models.map((m) => [m.model, m.cost]));
  const { keep } = foldToOther(all, (m) => (m === 'unknown' ? -1 : (cost.get(m) ?? 0)), (m) => m, slots - 1);
  return { models: orderModels(keep), folded: all.filter((m) => !keep.includes(m)) };
}

/**
 * Same slot rule for projects: the costliest seven in view get a color (the
 * server already sorts them), the rest fold into "Other".
 */
function projectSlots(report: Report, slots: number) {
  const all = report.dailyByProject.projects;
  return { models: all.slice(0, slots - 1), folded: all.slice(slots - 1) };
}

/** A project's folder name; the home folder itself reads as `~`. */
function projectLabel(path: string, home: string) {
  return path === home ? '~' : path.split('/').pop() || path;
}

function orderModels(models: string[]) {
  const rank = (m: string) => {
    const i = MODEL_ORDER.findIndex((k) => m.startsWith(k));
    return i === -1 ? MODEL_ORDER.length : i;
  };
  return [...models].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

type Theme = 'system' | 'light' | 'dark';

/**
 * The stylesheet carries no `prefers-color-scheme` rules — `data-theme` is
 * always a concrete `dark`/`light` — so `system` is resolved here and kept in
 * sync with the OS while it is selected. Dark is the default for a first
 * visit; index.html applies the same resolution before the first paint.
 */
function useResolvedTheme(theme: Theme): 'light' | 'dark' {
  const [system, setSystem] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return theme === 'system' ? system : theme;
}

const THEME_ICON: Record<Theme, string> = { dark: '◐', light: '○', system: '◑' };

// Hidden projects are remembered per scanned root.
function loadExclude(root: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(`cud.exclude:${root}`) || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function saveExclude(root: string, exclude: string[]) {
  try {
    localStorage.setItem(`cud.exclude:${root}`, JSON.stringify(exclude));
  } catch {
    /* storage blocked — the filter just won't persist */
  }
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('cud.theme') as Theme) || 'dark');
  const [root, setRoot] = useState<string | null>(() => localStorage.getItem('cud.root'));
  const [report, setReport] = useState<Report | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('Overview');
  const [picking, setPicking] = useState(false);
  const [filtering, setFiltering] = useState(false);

  const resolvedTheme = useResolvedTheme(theme);
  const palette = usePalette(resolvedTheme);
  const colors = seriesColors(palette);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    localStorage.setItem('cud.theme', theme);
  }, [theme, resolvedTheme]);

  const run = useCallback((target: string, exclude = loadExclude(target)) => {
    setBusy(true);
    setError(null);
    setProgress(null);
    localStorage.setItem('cud.root', target);
    saveExclude(target, exclude);
    analyze(target, exclude, setProgress)
      .then(setReport)
      .catch((e) => setError(String(e.message || e)))
      .finally(() => {
        setBusy(false);
        setProgress(null);
      });
  }, []);

  useEffect(() => {
    if (root) run(root);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (path: string) => {
    setPicking(false);
    setRoot(path);
    setReport(null);
    run(path);
  };

  const home = report?.home ?? '';
  const hiddenCount = report?.projects.filter((p) => p.hidden).length ?? 0;
  const shownProjects = report?.projects.filter((p) => !p.hidden) ?? [];
  const projectLabel = !report
    ? ''
    : !hiddenCount
      ? 'All projects'
      : shownProjects.length === 1
        ? `Only ${homeRelative(shownProjects[0].path, home).split('/').pop() || '~'}`
        : `${hiddenCount} hidden`;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <Glyph />
          </span>
          <span className="wordmark">
            <strong>Claude Usage</strong>
            <span className="kicker">local analytics</span>
          </span>
        </div>
        <div className="rootpill">
          {root ? (
            <>
              <b>Project</b>
              <span className="path" title={root}>
                {homeRelative(root, home)}
              </span>
            </>
          ) : (
            <span className="dim">No project selected</span>
          )}
        </div>
        <button className="btn" onClick={() => setPicking(true)}>
          {root ? 'Change' : 'Choose project'}
        </button>
        {report && report.projects.length > 1 ? (
          <button
            className={`btn${hiddenCount ? ' primary' : ' ghost'}`}
            disabled={busy}
            onClick={() => setFiltering(true)}
            title="Show or hide projects under this folder"
          >
            {projectLabel}
          </button>
        ) : null}
        <button className="btn ghost" disabled={!root || busy} onClick={() => root && run(root)} title="Re-scan">
          {busy ? (
            <>
              <i className="dotspin" /> Scanning…
            </>
          ) : (
            'Refresh'
          )}
        </button>
        <button
          className="btn ghost"
          title={`Theme: ${theme}`}
          onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
        >
          <span aria-hidden="true">{THEME_ICON[theme]}</span>
          {theme === 'system' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark'}
        </button>
      </div>

      {picking ? <FolderPicker initialPath={root ?? undefined} onPick={pick} onClose={() => setPicking(false)} /> : null}
      {filtering && report && root ? (
        <ProjectFilter
          projects={report.projects}
          home={home}
          onClose={() => setFiltering(false)}
          onApply={(exclude) => {
            setFiltering(false);
            run(root, exclude);
          }}
        />
      ) : null}

      {!report && busy ? (
        <div className="empty">
          <h1>Reading Claude&apos;s records…</h1>
          <p className="dim mono">{root}</p>
          <div className="progress">
            <i style={{ width: `${progress?.total ? (progress.done / progress.total) * 100 : 6}%` }} />
          </div>
          <p className="dim">
            {progress
              ? `${progress.phase} ${int(progress.done)} / ${int(progress.total)} transcripts · ${int(progress.fromCache)} cached`
              : 'Locating transcripts and cost ledgers'}
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="empty">
          <h1>Could not analyze that folder</h1>
          <p style={{ color: 'var(--critical)' }}>{error}</p>
          <button className="btn primary" onClick={() => setPicking(true)}>
            Choose another
          </button>
        </div>
      ) : null}

      {!report && !busy && !error ? (
        <div className="empty">
          <h1>Point this at a project folder</h1>
          <p>
            It reads the <code className="mono">.claude-costs</code> ledgers your statusline hook writes, the session
            transcripts under <code className="mono">~/.claude/projects</code>, and your prompt history — then works out
            what you spent, on what, and when.
          </p>
          <button className="btn primary" style={{ marginTop: 8 }} onClick={() => setPicking(true)}>
            Choose a project
          </button>
        </div>
      ) : null}

      {report ? (
        <>
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t} className="tab" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>

          {report.warnings.length ? (
            <div className="banner">
              <span>⚠</span>
              <div>
                {report.warnings.map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </div>
            </div>
          ) : null}

          {tab === 'Overview' && <Overview report={report} palette={palette} colors={colors} />}
          {tab === 'Spend over time' && <Timeline report={report} palette={palette} colors={colors} />}
          {tab === 'Efficiency' && <Efficiency report={report} palette={palette} colors={colors} />}
          {tab === 'Sessions' && <Sessions report={report} palette={palette} colors={colors} />}
          {tab === 'Habits' && <Habits report={report} palette={palette} colors={colors} />}

          <Footer report={report} home={home} />
        </>
      ) : null}
    </div>
  );
}

/** Six-spoke spark, the one piece of brand furniture in the shell. */
function Glyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.4v13.2M2.3 4.7l11.4 6.6M13.7 4.7L2.3 11.3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

type PanelProps = {
  report: Report;
  palette: ReturnType<typeof usePalette>;
  colors: string[];
};

// ============================================================== main chart ===

/**
 * The main chart. Each bar is one bucket of the chosen metric (dollars,
 * tokens, lines changed, engaged hours), split by the model that produced it.
 *
 * Only spend reaches back past transcript retention: those days' ledger
 * dollars are known in total but not per model, so they get the neutral slot
 * rather than a hue that would read as "some model". The other metrics exist
 * only where a transcript (live or archived) does.
 */
function SpendCard({ report, palette, colors }: PanelProps) {
  const [grain, setGrain] = useState<Grain>(() => stored('cud.grain', GRAINS, 'day'));
  const [metric, setMetric] = useState<Metric>(() => stored('cud.metric', METRICS, 'spend'));
  const [by, setBy] = useState<Dimension>(() => stored('cud.by', ['model', 'project'] as const, 'model'));
  const [cats, setCats] = useState<Set<string>>(() => {
    const all = report.edits.categories.map((c) => c.key);
    try {
      const v = JSON.parse(localStorage.getItem('cud.cats') || 'null');
      if (Array.isArray(v)) return new Set(v.filter((k) => all.includes(k)));
    } catch {
      /* fall through */
    }
    return new Set(all);
  });

  // `models` are the series keys: model ids, or project paths when coloring by project.
  const { models, folded } = useMemo(
    () => (by === 'model' ? modelSlots(report, colors.length) : projectSlots(report, colors.length)),
    [report, colors.length, by],
  );

  const { rows, bands } = useMemo(() => {
    const all = [...models, ...folded];
    const series = metric === 'spend' ? null : metricSeries(report, all, grain, metric, cats, by);
    const raw = series ?? spendSeries(report, all, grain, by);
    // Spend already shows those days, as the grey ledger estimate.
    const bands = series
      ? noDetailBands(series).map((b) => ({ ...b, label: b.from === b.to ? 'no detail' : 'no detail kept' }))
      : [];
    const rows = raw.map((row) => {
      const out: Record<string, number | string> = { ...row, other: 0 };
      for (const m of folded) {
        out.other = (out.other as number) + Number(row[m] || 0);
        delete out[m];
      }
      return out;
    });
    return { rows, bands };
  }, [report, models, folded, grain, metric, cats, by]);

  const hasOther = folded.length > 0;
  const isSpend = metric === 'spend';
  const estimatedShare = 1 - report.coverage.costCoverage;
  const hasEstimate = isSpend && report.coverage.costUndatedUsd > 0.005;
  const unit = GRAIN_LABEL[grain].toLowerCase();

  const keys = [...models, ...(hasOther ? ['other'] : []), ...(hasEstimate ? ['estimated'] : [])];
  const keyColors = [
    ...models.map((_, i) => colors[i]),
    ...(hasOther ? [colors[colors.length - 1]] : []),
    ...(hasEstimate ? [palette.estimate] : []),
  ];
  const seriesLabel = (k: string) => (by === 'model' ? modelLabel(k) : projectLabel(k, report.home));
  const otherLabel =
    by === 'model' ? `Other (${folded.map(modelLabel).join(', ')})` : `Other (${folded.length} projects)`;
  const keyLabel = (k: string) => (k === 'other' ? otherLabel : k === 'estimated' ? 'Estimated' : seriesLabel(k));

  const fmt = METRIC_FORMAT[metric];

  const pickGrain = (g: Grain) => {
    setGrain(g);
    store('cud.grain', g);
  };
  const pickBy = (d: Dimension) => {
    setBy(d);
    store('cud.by', d);
  };
  const pickMetric = (m: Metric) => {
    setMetric(m);
    store('cud.metric', m);
  };
  const toggleCat = (key: string) => {
    const next = new Set(cats);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCats(next);
    store('cud.cats', JSON.stringify([...next]));
  };

  const archived = report.archive.sessions
    ? ` Includes ${int(report.archive.sessions)} sessions whose transcripts Claude Code has deleted, kept as archived summaries.`
    : '';
  const note = {
    spend: hasEstimate ? (
      <>
        Every dollar spent, per {unit}, colored by the {by} that spent it. {pct(estimatedShare)} of the total —{' '}
        {usd(report.coverage.costUndatedUsd)} from sessions with no transcript or archived summary left — has no {by}
        detail, so it sits in grey, spread across those days by how many prompts you sent.{archived}
      </>
    ) : (
      <>Every dollar spent, per {unit}, colored by the {by} that spent it.{archived}</>
    ),
    tokens: (
      <>
        Every token sent to and returned by the model, per {unit}: input (cached and fresh) plus output. Cache reads
        dominate the count but bill at a fraction of the price, which is why this shape differs from spend.
      </>
    ),
    lines: (
      <>
        Lines added plus removed by successful Edit and Write calls, per {unit}, in the file types selected below.
        Changes Claude made through shell commands (sed, heredocs, scripts) leave no diff and are not counted.
      </>
    ),
    time: (
      <>
        Wall-clock time the model spent working on your prompts, per {unit}, summed from each turn&apos;s duration and
        credited to the model that answered. Overlapping sessions add up, so a day can exceed 24 hours.
      </>
    ),
  }[metric];

  const lineTotals = useMemo(() => {
    const t = new Map<string, number>();
    for (const e of report.edits.rows) t.set(e.category, (t.get(e.category) || 0) + e.added + e.removed);
    return t;
  }, [report]);

  return (
    <Card
      title={`${METRIC_LABEL[metric]} over time, by ${by}`}
      note={note}
      actions={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <div className="tabs mini" role="tablist" aria-label="Measure">
            {METRICS.map((m) => (
              <button key={m} className="tab" role="tab" aria-selected={metric === m} onClick={() => pickMetric(m)}>
                {METRIC_LABEL[m]}
              </button>
            ))}
          </div>
          <div className="tabs mini" role="tablist" aria-label="Color by">
            {(['model', 'project'] as const).map((d) => (
              <button key={d} className="tab" role="tab" aria-selected={by === d} onClick={() => pickBy(d)}>
                {d === 'model' ? 'Model' : 'Project'}
              </button>
            ))}
          </div>
          <div className="tabs mini" role="tablist" aria-label="Bucket size">
            {GRAINS.map((g) => (
              <button key={g} className="tab" role="tab" aria-selected={grain === g} onClick={() => pickGrain(g)}>
                {GRAIN_LABEL[g]}
              </button>
            ))}
          </div>
        </div>
      }
      table={
        <SeriesTable
          rows={[...rows].reverse().map((row) => ({ ...row, date: bucketTitle(String(row.date), grain) }))}
          columns={[
            { key: 'date', label: GRAIN_LABEL[grain] },
            ...keys.map((k) => ({ key: k, label: keyLabel(k), format: (v: unknown) => fmt.value(Number(v || 0)) })),
            { key: 'total', label: 'Total', format: (v: unknown) => fmt.value(Number(v || 0)) },
            ...(metric === 'lines'
              ? [
                  { key: 'added', label: 'Added', format: (v: unknown) => int(Number(v || 0)) },
                  { key: 'removed', label: 'Removed', format: (v: unknown) => int(Number(v || 0)) },
                  { key: 'edits', label: 'Edits', format: (v: unknown) => int(Number(v || 0)) },
                ]
              : []),
            ...(isSpend ? [{ key: 'prompts', label: 'Prompts', format: (v: unknown) => int(Number(v || 0)) }] : []),
          ]}
        />
      }
    >
      {metric === 'lines' ? (
        <div className="catfilter" role="group" aria-label="File types counted">
          <span className="dim">Count</span>
          {report.edits.categories.map((c) => (
            <button key={c.key} className="chip" aria-pressed={cats.has(c.key)} onClick={() => toggleCat(c.key)}>
              {c.label} <span className="dim">{fmt.value(lineTotals.get(c.key) || 0)}</span>
            </button>
          ))}
        </div>
      ) : null}
      <StackedBars
        data={rows}
        keys={keys}
        colors={keyColors}
        palette={palette}
        height={400}
        maxBarSize={grain === 'day' ? 40 : 84}
        bands={bands}
        yFormat={fmt.axis}
        xFormat={(v) => bucketTick(v, grain)}
        tooltip={(row) => {
          const active = keys.filter((k) => Number(row[k]) > 0);
          const lost = Number(row.promptsNoDetail || 0);
          const extra =
            (lost
              ? ` · no detail kept for ${int(lost)} of ${int(Number(row.prompts))} prompts`
              : '') +
            (metric === 'lines'
              ? ` · +${int(Number(row.added))} / −${int(Number(row.removed))} in ${int(Number(row.edits))} edits`
              : isSpend
                ? ` · ${int(Number(row.prompts))} prompts`
                : '');
          return {
            title: bucketTitle(String(row.date), grain),
            rows: active.map((k) => ({
              label: keyLabel(k),
              value: fmt.value(Number(row[k])),
              color: keyColors[keys.indexOf(k)],
            })),
            foot: `${fmt.value(Number(row.total))} total${extra}${
              grain === 'day' ? '' : ` · ${int(Number(row.activeDays))} active days`
            }`,
          };
        }}
      />
      <Legend items={keys.map((k, i) => ({ label: k === 'estimated' ? 'Estimated (no transcript left)' : keyLabel(k), color: keyColors[i] }))} />
    </Card>
  );
}

const METRIC_FORMAT: Record<Metric, { value: (n: number) => string; axis: (n: number) => string }> = {
  spend: { value: (n) => usd(n), axis: usdCompact },
  tokens: { value: tokens, axis: tokens },
  lines: { value: (n) => (n >= 10_000 ? tokens(n) : int(n)), axis: tokens },
  time: { value: (h) => hours(h * 3_600_000), axis: (h) => `${h >= 10 ? Math.round(h) : h.toFixed(1)}h` },
};

/** A remembered choice from a fixed set; storage can be blocked or stale. */
function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not persisted */
  }
}

// ================================================================ overview ===

function Overview({ report, palette, colors }: PanelProps) {
  const { totals, coverage, efficiency } = report;

  const timelineTable = (
    <SeriesTable
      rows={[...report.costTimeline].reverse()}
      columns={[
        { key: 'date', label: 'Day', format: (v) => longDate(String(v)) },
        { key: 'exact', label: 'Recorded', format: (v) => usd(Number(v)) },
        { key: 'estimated', label: 'Estimated', format: (v) => usd(Number(v)) },
        { key: 'prompts', label: 'Prompts', format: (v) => int(Number(v)) },
        { key: 'cumulative', label: 'Cumulative', format: (v) => usd(Number(v)) },
      ]}
    />
  );

  return (
    <>
      <div className="tiles">
        <Tile
          label="Total spend"
          value={usd(totals.ledgerCost)}
          sub={`${int(coverage.sessionsInLedger)} sessions, all time`}
          accent={colors[0]}
          lead
        />
        <Tile
          label="Cache savings"
          value={usd(totals.cacheSavings)}
          sub="vs. full input price, analyzed window"
        />
        <Tile label="Prompts sent" value={int(totals.promptsAllTime)} sub={`${usd(efficiency.costPerPrompt)} each`} />
        <Tile label="Active days" value={int(totals.activeDays)} sub={`${usd(efficiency.costPerActiveDay)} per active day`} />
        <Tile label="Engaged model time" value={hours(totals.engagedMs)} sub={`${usd(efficiency.costPerEngagedHour)} per hour`} />
        <Tile label="Tokens written" value={tokens(totals.output)} sub={`${tokens(totals.totalInput)} in`} />
      </div>

      <div className="grid">
        <SpendCard report={report} palette={palette} colors={colors} />

        <Card
          title="What the numbers are built from"
          span="third"
          note="Three stores with different reach, kept separate rather than blended."
        >
          <div style={{ display: 'grid', gap: 10, marginTop: 6, fontSize: 13 }}>
            <SourceLine
              label="Cost ledgers"
              value={`${usd(totals.ledgerCost)} · ${int(coverage.sessionsInLedger)} sessions`}
              note="Exact, all time, but undated."
            />
            <SourceLine
              label="Session transcripts"
              value={`${int(coverage.sessionsWithTranscripts)} sessions · ${int(report.sources.transcriptFiles)} files`}
              note={
                coverage.transcriptFirst
                  ? `Full token detail from ${longDate(coverage.transcriptFirst.slice(0, 10))} onward (~30-day retention).`
                  : 'No transcripts retained for this project.'
              }
            />
            <SourceLine
              label="Prompt history"
              value={`${int(report.sources.historyRows)} prompts`}
              note={
                coverage.historyFirst
                  ? `Timestamps back to ${longDate(coverage.historyFirst.slice(0, 10))}.`
                  : 'No history entries.'
              }
            />
          </div>
        </Card>

        <Card title="Findings" span="twothird" note="Generated from this project's own numbers.">
          <div style={{ marginTop: 2 }}>
            {report.insights.map((insight) => (
              <div className="insight" data-level={insight.level} key={insight.title}>
                <i className="dot" />
                <div>
                  <div className="title">{insight.title}</div>
                  <div className="detail">{insight.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Cumulative spend"
          span="half"
          note="Where the money went in, over the life of the project."
          table={timelineTable}
        >
          <Lines
            data={report.costTimeline as unknown as Record<string, number | string>[]}
            keys={['cumulative']}
            colors={[colors[0]]}
            palette={palette}
            height={230}
            yFormat={usdCompact}
            tooltip={(row) => ({
              title: longDate(String(row.date)),
              rows: [{ label: 'Spent to date', value: usd(Number(row.cumulative)), color: colors[0] }],
            })}
          />
        </Card>

        <Card
          title="Activity calendar"
          span="half"
          note="Prompts per day. The darker the square, the more you asked for."
          table={
            <SeriesTable
              rows={[...report.costTimeline].reverse().filter((r) => r.prompts > 0)}
              columns={[
                { key: 'date', label: 'Day', format: (v) => longDate(String(v)) },
                { key: 'prompts', label: 'Prompts', format: (v) => int(Number(v)) },
              ]}
            />
          }
        >
          <CalendarHeatmap
            palette={palette}
            valueLabel="Prompts"
            format={(n) => int(n)}
            data={report.costTimeline.map((row) => ({
              date: row.date,
              value: row.prompts,
              sub: row.exact + row.estimated > 0 ? `${usd(row.exact + row.estimated)} spent` : undefined,
            }))}
          />
        </Card>
      </div>
    </>
  );
}

function SourceLine({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <b>{label}</b>
        <span className="nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </span>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        {note}
      </div>
    </div>
  );
}

// ================================================================ timeline ===

function Timeline({ report, palette, colors }: PanelProps) {
  // The continuous range, gaps included — an idle week must occupy a week's width.
  const withRequests = report.daily;
  const hasData = report.daily.some((d) => d.requests > 0);

  // Charted as cost, not raw tokens. Cache reads are ~98% of tokens but a much
  // smaller slice of the bill — as a token stack the other three bands are a
  // hairline, and the chart says nothing you can act on.
  const costKeys = ['costCacheRead', 'costCacheWrite', 'costFresh', 'costOutput'];
  const costLabels: Record<string, string> = {
    costCacheRead: 'Cache read (0.025–0.1×)',
    costCacheWrite: 'Cache write (1.25–2×)',
    costFresh: 'Fresh input (1×)',
    costOutput: 'Output',
  };
  const tokenFor: Record<string, keyof (typeof withRequests)[number]> = {
    costCacheRead: 'cacheRead',
    costCacheWrite: 'cacheWrite',
    costFresh: 'inputFresh',
    costOutput: 'output',
  };

  if (!hasData) {
    return (
      <div className="grid">
        <Card title="No transcripts in range">
          <Empty>
            Claude keeps session transcripts for about 30 days. This project&apos;s ledger still has the totals — see
            Overview — but there is no per-request detail left to chart.
          </Empty>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid">
      <SpendCard report={report} palette={palette} colors={colors} />

      <Card
        title="What each day's dollars bought"
        span="twothird"
        note="Cost split by token class. Re-sent conversation served from cache is the bulk of the tokens but bills at a tenth of the rate — this is the split that actually moves the bill."
        table={
          <SeriesTable
            rows={[...withRequests].reverse()}
            columns={[
              { key: 'date', label: 'Day', format: (v) => longDate(String(v)) },
              ...costKeys.map((k) => ({ key: k, label: costLabels[k], format: (v: unknown) => usd(Number(v)) })),
              { key: 'cacheRead', label: 'Cache-read tokens', format: (v: unknown) => tokens(Number(v)) },
              { key: 'output', label: 'Output tokens', format: (v: unknown) => tokens(Number(v)) },
            ]}
          />
        }
      >
        <StackedAreas
          data={withRequests as unknown as Record<string, number | string>[]}
          keys={costKeys}
          colors={colors}
          palette={palette}
          height={250}
          yFormat={usdCompact}
          tooltip={(row) => ({
            title: longDate(String(row.date)),
            rows: costKeys.map((k, i) => ({
              label: costLabels[k],
              value: `${usd(Number(row[k]))} · ${tokens(Number(row[tokenFor[k]]))} tok`,
              color: colors[i],
            })),
            foot: `${usd(Number(row.cost))} total · ${int(Number(row.requests))} requests`,
          })}
        />
        <Legend items={costKeys.map((k, i) => ({ label: costLabels[k], color: colors[i] }))} />
      </Card>

      <Card
        title="Requests per day"
        span="third"
        note="One request is one model turn, including tool round-trips."
        table={
          <SeriesTable
            rows={[...withRequests].reverse()}
            columns={[
              { key: 'date', label: 'Day', format: (v) => longDate(String(v)) },
              { key: 'requests', label: 'Requests', format: (v) => int(Number(v)) },
              { key: 'prompts', label: 'Prompts', format: (v) => int(Number(v)) },
            ]}
          />
        }
      >
        <Lines
          data={withRequests as unknown as Record<string, number | string>[]}
          keys={['requests']}
          colors={[colors[0]]}
          palette={palette}
          height={250}
          yFormat={int}
          tooltip={(row) => ({
            title: longDate(String(row.date)),
            rows: [
              { label: 'Requests', value: int(Number(row.requests)), color: colors[0] },
              { label: 'Your prompts', value: int(Number(row.prompts)) },
            ],
            foot: `${(Number(row.requests) / Math.max(1, Number(row.prompts))).toFixed(1)} requests per prompt`,
          })}
        />
      </Card>

      <Card
        title="Engaged model time per day"
        span="half"
        note="Wall-clock time Claude spent working on a turn — the closest thing to 'hours worked' in the record."
        table={
          <SeriesTable
            rows={[...withRequests].reverse()}
            columns={[
              { key: 'date', label: 'Day', format: (v) => longDate(String(v)) },
              { key: 'engagedHours', label: 'Hours', format: (v) => `${Number(v).toFixed(2)}h` },
            ]}
          />
        }
      >
        <Lines
          data={withRequests as unknown as Record<string, number | string>[]}
          keys={['engagedHours']}
          colors={[colors[0]]}
          palette={palette}
          height={220}
          yFormat={(n) => `${n.toFixed(n < 10 ? 1 : 0)}h`}
          tooltip={(row) => ({
            title: longDate(String(row.date)),
            rows: [{ label: 'Engaged time', value: hours(Number(row.engagedMs)), color: colors[0] }],
            foot: `${usd(Number(row.cost))} that day`,
          })}
        />
      </Card>

      <Card
        title="Cost per day"
        span="half"
        note="Recorded days only — the all-time view including estimated days is on Overview."
        table={
          <SeriesTable
            rows={[...withRequests].reverse()}
            columns={[
              { key: 'date', label: 'Day', format: (v) => longDate(String(v)) },
              { key: 'cost', label: 'Cost', format: (v) => usd(Number(v)) },
              { key: 'requests', label: 'Requests', format: (v) => int(Number(v)) },
            ]}
          />
        }
      >
        <Lines
          data={withRequests as unknown as Record<string, number | string>[]}
          keys={['cost']}
          colors={[colors[0]]}
          palette={palette}
          height={220}
          yFormat={usdCompact}
          tooltip={(row) => ({
            title: longDate(String(row.date)),
            rows: [{ label: 'Cost', value: usd(Number(row.cost)), color: colors[0] }],
            foot: `${int(Number(row.requests))} requests`,
          })}
        />
      </Card>
    </div>
  );
}

// ============================================================== efficiency ===

function Efficiency({ report, palette, colors }: PanelProps) {
  const e = report.efficiency;
  const withRequests = report.daily;
  const { models } = modelSlots(report, colors.length);

  return (
    <>
      <div className="tiles">
        <Tile
          label="Cache hit rate"
          value={pct(e.cacheHitRate, 1)}
          sub={`${tokens(report.totals.cacheRead)} of ${tokens(report.totals.totalInput)} input served from cache`}
          accent={colors[0]}
          lead
        />
        <Tile label="Context per request" value={tokens(e.avgContextPerRequest)} sub="average tokens sent per turn" />
        <Tile label="Cost per request" value={usd(e.costPerRequest)} sub={`${int(e.outputPerRequest)} output tokens each`} />
        <Tile
          label="Cost per M output"
          value={usd(e.costPerMOutputToken)}
          sub="what a million written tokens really cost"
        />
        <Tile label="Output share of tokens" value={pct(e.outputTokenShare, 2)} sub="the rest is re-sent context" />
        <Tile label="Burn rate" value={usd(e.costPerEngagedHour)} unit="/h" sub="per hour of engaged model time" />
      </div>

      <div className="grid">
        <Card
          title="Cache hit rate over time"
          span="half"
          note="The single biggest cost lever. Cached input bills at a tenth of fresh input; a dip means a prompt prefix changed and the cache was rebuilt."
          table={
            <SeriesTable
              rows={[...withRequests].reverse()}
              columns={[
                { key: 'date', label: 'Day', format: (v) => longDate(String(v)) },
                { key: 'cacheHit', label: 'Hit rate', format: (v) => pct(Number(v), 1) },
              ]}
            />
          }
        >
          <Lines
            data={withRequests as unknown as Record<string, number | string>[]}
            keys={['cacheHit']}
            colors={[colors[0]]}
            palette={palette}
            height={220}
            domain={[0, 1]}
            connectNulls
            yFormat={(n) => pct(n)}
            reference={{ y: 0.9, label: '90% healthy' }}
            tooltip={(row) => ({
              title: longDate(String(row.date)),
              rows: [
                { label: 'Cache hit rate', value: pct(Number(row.cacheHit), 1), color: colors[0] },
                { label: 'Cache read', value: tokens(Number(row.cacheRead)) },
                { label: 'Cache write', value: tokens(Number(row.cacheWrite)) },
              ],
            })}
          />
        </Card>

        <Card
          title="Context carried per request"
          span="half"
          note="Every turn re-sends the whole conversation. A rising line means sessions run longer before a reset, so each new answer costs more."
          table={
            <SeriesTable
              rows={[...withRequests].reverse()}
              columns={[
                { key: 'date', label: 'Day', format: (v) => longDate(String(v)) },
                { key: 'avgContext', label: 'Avg context', format: (v) => tokens(Number(v)) },
              ]}
            />
          }
        >
          <Lines
            data={withRequests as unknown as Record<string, number | string>[]}
            keys={['avgContext']}
            colors={[colors[0]]}
            palette={palette}
            height={220}
            connectNulls
            yFormat={tokens}
            tooltip={(row) => ({
              title: longDate(String(row.date)),
              rows: [{ label: 'Avg context', value: `${tokens(Number(row.avgContext))} tokens`, color: colors[0] }],
              foot: `${int(Number(row.requests))} requests`,
            })}
          />
        </Card>

        <Card
          title="Where the money goes, by model"
          span="half"
          note="Cost share, not request share — a cheap model can dominate turn count and barely register here."
          table={
            <DataTable
              rows={report.models}
              initialSort="cost"
              columns={[
                { key: 'model', label: 'Model', align: 'left', sort: (r) => r.model, render: (r) => modelLabel(r.model) },
                { key: 'cost', label: 'Cost', sort: (r) => r.cost, render: (r) => usd(r.cost) },
                { key: 'share', label: 'Share', sort: (r) => r.share, render: (r) => pct(r.share, 1) },
                { key: 'requests', label: 'Requests', sort: (r) => r.requests, render: (r) => int(r.requests) },
                { key: 'output', label: 'Output', sort: (r) => r.output, render: (r) => tokens(r.output) },
              ] as Column<Report['models'][number]>[]}
            />
          }
        >
          <HBars
            palette={palette}
            format={usd}
            highlight={(_label, i) =>
              colors[models.indexOf(report.models.filter((m) => m.cost > 0)[i]?.model ?? '')] ?? palette['ink-muted']
            }
            rows={report.models
              .filter((m) => m.cost > 0)
              .map((m) => ({
                label: modelLabel(m.model),
                value: m.cost,
                note: `${pct(m.share)} · ${int(m.requests)} req`,
              }))}
          />
          <div className="legend">
            {report.models
              .filter((m) => m.cost > 0)
              .map((m) => (
                <span className="item" key={m.model}>
                  <i className="swatch" style={{ background: colors[models.indexOf(m.model)] ?? palette['ink-muted'] }} />
                  {modelLabel(m.model)}
                </span>
              ))}
          </div>
        </Card>

        <Card
          title="Effort level mix"
          span="half"
          note="Effort controls how much the model thinks per turn. Requests recorded without an effort field ran at the account default."
          table={
            <DataTable
              rows={report.effort}
              initialSort="cost"
              columns={[
                { key: 'effort', label: 'Effort', align: 'left', sort: (r) => r.effort, render: (r) => r.effort },
                { key: 'cost', label: 'Cost', sort: (r) => r.cost, render: (r) => usd(r.cost) },
                { key: 'requests', label: 'Requests', sort: (r) => r.requests, render: (r) => int(r.requests) },
              ] as Column<Report['effort'][number]>[]}
            />
          }
        >
          <HBars
            palette={palette}
            format={usd}
            color={colors[0]}
            rows={report.effort.map((row) => ({
              label: row.effort,
              value: row.cost,
              note: `${int(row.requests)} req · ${usd(row.cost / Math.max(1, row.requests))}/req`,
            }))}
          />
        </Card>

        {report.branches.length > 1 ? (
          <Card
            title="Cost by git branch"
            note="Which line of work the spend went to."
            table={
              <DataTable
                rows={report.branches}
                initialSort="cost"
                columns={[
                  { key: 'branch', label: 'Branch', align: 'left', sort: (r) => r.branch, render: (r) => r.branch },
                  { key: 'cost', label: 'Cost', sort: (r) => r.cost, render: (r) => usd(r.cost) },
                  { key: 'requests', label: 'Requests', sort: (r) => r.requests, render: (r) => int(r.requests) },
                ] as Column<Report['branches'][number]>[]}
              />
            }
          >
            <HBars
              palette={palette}
              format={usd}
              color={colors[0]}
              rows={report.branches.slice(0, 14).map((b) => ({
                label: b.branch,
                value: b.cost,
                note: `${int(b.requests)} req`,
              }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}

// ================================================================ sessions ===

function Sessions({ report, palette, colors }: PanelProps) {
  const e = report.efficiency;
  const columns: Column<SessionRow>[] = [
    {
      key: 'title',
      label: 'Session',
      align: 'left',
      sort: (r) => r.title ?? '',
      render: (r) => (
        <div className="trunc" title={r.title ?? r.id ?? ''}>
          {r.title ?? <span className="dim mono">{r.id?.slice(0, 8)}</span>}
        </div>
      ),
    },
    { key: 'start', label: 'Started', sort: (r) => (r.start ? Date.parse(r.start) : 0), render: (r) => dateTime(r.start) },
    { key: 'cost', label: 'Cost', sort: (r) => r.cost, render: (r) => usd(r.cost) },
    { key: 'requests', label: 'Requests', sort: (r) => r.requests, render: (r) => int(r.requests) },
    { key: 'output', label: 'Output', sort: (r) => r.output, render: (r) => tokens(r.output) },
    { key: 'cacheHit', label: 'Cache', sort: (r) => r.cacheHit, render: (r) => pct(r.cacheHit) },
    { key: 'engagedMs', label: 'Engaged', sort: (r) => r.engagedMs, render: (r) => duration(r.engagedMs) },
    { key: 'toolCalls', label: 'Tools', sort: (r) => r.toolCalls, render: (r) => int(r.toolCalls) },
    {
      key: 'topModel',
      label: 'Model',
      align: 'left',
      sort: (r) => r.topModel ?? '',
      render: (r) => <span className="dim">{r.topModel ? modelLabel(r.topModel) : '—'}</span>,
    },
    { key: 'branch', label: 'Branch', align: 'left', sort: (r) => r.branch ?? '', render: (r) => <span className="dim">{r.branch ?? '—'}</span> },
  ];

  const priciest = report.sessions[0];

  return (
    <>
      <div className="tiles">
        <Tile label="Median session" value={usd(e.medianSessionCost)} sub="half cost less than this" />
        <Tile label="90th percentile" value={usd(e.p90SessionCost)} sub="one session in ten costs more" />
        <Tile
          label="Top 5% of sessions"
          value={pct(e.top5PctSessionShare)}
          sub="of all spend in the analyzed window"
        />
        <Tile
          label="Most expensive"
          value={priciest ? usd(priciest.cost) : '—'}
          sub={priciest?.title ?? priciest?.id?.slice(0, 8) ?? '—'}
        />
      </div>

      <div className="grid">
        <Card
          title="Session cost distribution"
          span="half"
          note="Log-spaced buckets. A long right tail is normal; it is where the marginal dollar goes."
          table={
            <SeriesTable
              rows={report.sessionCostHistogram.map((b) => ({
                bucket: b.to === null || !Number.isFinite(b.to) ? `$${b.from}+` : `$${b.from}–${b.to}`,
                count: b.count,
                cost: b.cost,
              }))}
              columns={[
                { key: 'bucket', label: 'Bucket' },
                { key: 'count', label: 'Sessions', format: (v) => int(Number(v)) },
                { key: 'cost', label: 'Combined', format: (v) => usd(Number(v)) },
              ]}
            />
          }
        >
          <Histogram buckets={report.sessionCostHistogram} palette={palette} height={230} />
        </Card>

        <Card
          title="Cost vs. session length"
          span="half"
          note="Requests against cost, one dot per session. Points far above the pack are sessions carrying an unusually large context."
        >
          <ScatterCostVsRequests sessions={report.sessions} palette={palette} color={colors[0]} />
        </Card>

        <Card
          title={`Sessions (${int(report.sessions.length)})`}
          note="Click a column to sort. Costs are reconciled against the recorded ledger; token counts are raw from the transcript."
        >
          <div className="tablewrap" style={{ maxHeight: 560, borderTop: 'none' }}>
            <DataTable rows={report.sessions} columns={columns} initialSort="cost" />
          </div>
        </Card>
      </div>
    </>
  );
}

/** Small bespoke scatter — Recharts' is heavier than this needs to be. */
function ScatterCostVsRequests({
  sessions,
  palette,
  color,
}: {
  sessions: SessionRow[];
  palette: ReturnType<typeof usePalette>;
  color: string;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; row: SessionRow } | null>(null);
  const W = 520;
  const H = 230;
  const PAD = { l: 52, r: 12, t: 10, b: 30 };

  const maxReq = Math.max(...sessions.map((s) => s.requests), 1);
  const maxCost = Math.max(...sessions.map((s) => s.cost), 0.01);
  const x = (n: number) => PAD.l + (n / maxReq) * (W - PAD.l - PAD.r);
  const y = (n: number) => H - PAD.b - (n / maxCost) * (H - PAD.t - PAD.b);

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Session cost against request count">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(maxCost * t)} y2={y(maxCost * t)} stroke={palette.grid} />
            <text x={PAD.l - 8} y={y(maxCost * t) + 4} textAnchor="end" fontSize={11} fill={palette['ink-muted']}>
              {usdCompact(maxCost * t)}
            </text>
          </g>
        ))}
        {/* Drop the last tick — the axis caption sits there. */}
        {ticks.slice(0, -1).map((t) => (
          <text key={t} x={x(maxReq * t)} y={H - 10} textAnchor="middle" fontSize={11} fill={palette['ink-muted']}>
            {int(maxReq * t)}
          </text>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke={palette.axis} />
        {sessions.map((s, i) => (
          <circle
            key={s.id ?? i}
            cx={x(s.requests)}
            cy={y(s.cost)}
            r={4}
            fill={color}
            fillOpacity={0.55}
            stroke={palette.surface}
            strokeWidth={1.5}
            onMouseEnter={() => setHover({ x: x(s.requests), y: y(s.cost), row: s })}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        <text x={W - PAD.r} y={H - 10} textAnchor="end" fontSize={11} fill={palette['ink-muted']}>
          requests →
        </text>
      </svg>
      {hover ? (
        <div
          className="tt"
          style={{
            position: 'absolute',
            left: `${Math.min(72, (hover.x / W) * 100)}%`,
            top: (hover.y / H) * 100 + '%',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          <div className="ttdate">{hover.row.title ?? hover.row.id?.slice(0, 8)}</div>
          <div className="ttrow">
            <span className="k">Cost</span>
            <span className="v">{usd(hover.row.cost)}</span>
          </div>
          <div className="ttrow">
            <span className="k">Requests</span>
            <span className="v">{int(hover.row.requests)}</span>
          </div>
          <div className="ttfoot">
            {tokens(hover.row.inputTotal)} in · {tokens(hover.row.output)} out · {duration(hover.row.engagedMs)} engaged
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ================================================================== habits ===

/** Top ten tools plus a folded "Other" — a long tail of 0% rows reads as noise. */
function topToolRows(report: Report) {
  const share = (n: number) => pct(n / Math.max(1, report.totals.toolCalls));
  const top = report.tools.slice(0, 10);
  const rest = report.tools.slice(10);
  const rows = top.map((t) => ({ label: t.name, value: t.count, note: share(t.count) }));
  if (rest.length) {
    const total = rest.reduce((a, t) => a + t.count, 0);
    rows.push({ label: `Other (${rest.length} tools)`, value: total, note: share(total) });
  }
  return rows;
}

function Habits({ report, palette, colors }: PanelProps) {
  const toolsPerSession = report.totals.sessions ? report.totals.toolCalls / report.totals.sessions : 0;
  const promptsPerSession = report.coverage.sessionsInLedger
    ? report.totals.promptsAllTime / report.coverage.sessionsInLedger
    : 0;

  const hourTotals = new Map<number, number>();
  for (const cell of report.punchcard) hourTotals.set(cell.hour, (hourTotals.get(cell.hour) ?? 0) + cell.prompts);
  const peakHour = [...hourTotals.entries()].sort((a, b) => b[1] - a[1])[0];

  return (
    <>
      <div className="tiles">
        <Tile
          label="Peak hour"
          value={peakHour ? `${String(peakHour[0]).padStart(2, '0')}:00` : '—'}
          sub={peakHour ? `${int(peakHour[1])} prompts sent in that hour, all time` : undefined}
        />
        <Tile label="Prompts per session" value={promptsPerSession.toFixed(1)} sub="across the whole ledger" />
        <Tile label="Tool calls" value={int(report.totals.toolCalls)} sub={`${toolsPerSession.toFixed(1)} per session`} />
        <Tile
          label="Sessions per active day"
          value={(report.coverage.sessionsInLedger / Math.max(1, report.totals.activeDays)).toFixed(1)}
          sub={`${int(report.totals.activeDays)} days with activity`}
        />
      </div>

      <div className="grid">
        <Card
          title="When you work"
          note="Prompts by weekday and hour of day, local time, over the full prompt history."
          table={
            <SeriesTable
              rows={[...report.punchcard]
                .sort((a, b) => b.prompts - a.prompts)
                .map((c) => ({
                  slot: `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][c.dow]} ${String(c.hour).padStart(2, '0')}:00`,
                  prompts: c.prompts,
                }))}
              columns={[
                { key: 'slot', label: 'Slot' },
                { key: 'prompts', label: 'Prompts', format: (v) => int(Number(v)) },
              ]}
            />
          }
        >
          <Punchcard data={report.punchcard} palette={palette} valueLabel="Prompts" format={(n) => int(n)} />
        </Card>

        <Card
          title="Tool usage"
          span="half"
          note="Which tools Claude reached for, across the analyzed window."
          table={
            <DataTable
              rows={report.tools}
              initialSort="count"
              columns={[
                { key: 'name', label: 'Tool', align: 'left', sort: (r) => r.name, render: (r) => r.name },
                { key: 'count', label: 'Calls', sort: (r) => r.count, render: (r) => int(r.count) },
              ] as Column<Report['tools'][number]>[]}
            />
          }
        >
          {report.tools.length ? (
            <HBars
              palette={palette}
              color={colors[0]}
              format={int}
              rows={topToolRows(report)}
            />
          ) : (
            <Empty>No tool calls recorded in the retained transcripts.</Empty>
          )}
        </Card>

        <Card
          title="Prompts per day"
          span="half"
          note="Your own typing volume, all time — the one signal that survives transcript cleanup."
          table={
            <SeriesTable
              rows={[...report.costTimeline].reverse().filter((r) => r.prompts > 0)}
              columns={[
                { key: 'date', label: 'Day', format: (v) => longDate(String(v)) },
                { key: 'prompts', label: 'Prompts', format: (v) => int(Number(v)) },
              ]}
            />
          }
        >
          <Lines
            data={report.costTimeline as unknown as Record<string, number | string>[]}
            keys={['prompts']}
            colors={[colors[0]]}
            palette={palette}
            height={230}
            yFormat={int}
            tooltip={(row) => ({
              title: longDate(String(row.date)),
              rows: [{ label: 'Prompts', value: int(Number(row.prompts)), color: colors[0] }],
            })}
          />
        </Card>
      </div>
    </>
  );
}

// ================================================================== footer ===

function Footer({ report, home }: { report: Report; home: string }) {
  return (
    <div className="footer">
      <span>
        Scanned {int(report.sources.transcriptFiles)} transcripts in {(report.scanMs / 1000).toFixed(1)}s (
        {int(report.sources.filesFromCache)} cached)
      </span>
      <span>
        {report.sources.ledgerFiles.length
          ? `Ledgers: ${report.sources.ledgerFiles.map((f) => homeRelative(f, home)).join(', ')}`
          : 'No .claude-costs ledger found under this root'}
      </span>
      <span>Generated {shortDate(report.generatedAt.slice(0, 10))}</span>
    </div>
  );
}
