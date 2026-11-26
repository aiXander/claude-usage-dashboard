import type { Report } from './types';
import { longDate, shortDate } from './format';

/**
 * Time-bucketing for the main spend chart.
 *
 * Buckets are local-calendar, matching the server's day keys — "when did I
 * work" is a wall-clock question, so a week is Monday..Sunday in local time and
 * a month is a calendar month, never a rolling 7/30 days.
 */
export const GRAINS = ['day', 'week', 'month'] as const;
export type Grain = (typeof GRAINS)[number];

export const GRAIN_LABEL: Record<Grain, string> = { day: 'Day', week: 'Week', month: 'Month' };

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `YYYY-MM-DD` -> bucket key. Week keys are the Monday; month keys `YYYY-MM`. */
export function bucketKey(iso: string, grain: Grain): string {
  if (grain === 'day') return iso;
  if (grain === 'month') return iso.slice(0, 7);
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Axis tick: as short as it can be and still be unambiguous. */
export function bucketTick(key: string, grain: Grain): string {
  if (grain === 'month') {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS_LONG[m - 1].slice(0, 3)} ${String(y).slice(2)}`;
  }
  return shortDate(key);
}

/** Tooltip and table heading: fully spelled out. */
export function bucketTitle(key: string, grain: Grain): string {
  if (grain === 'month') {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS_LONG[m - 1]} ${y}`;
  }
  if (grain === 'week') return `Week of ${longDate(key)}`;
  return longDate(key);
}

export interface SpendRow {
  /** Bucket key — the chart's x dataKey, kept as `date` for the shared axis. */
  date: string;
  /** One entry per model, plus these. */
  estimated: number;
  recorded: number;
  total: number;
  prompts: number;
  activeDays: number;
  [key: string]: number | string;
}

/**
 * The one series behind the main chart: per-model cost where a transcript
 * survives, plus the estimated remainder where it doesn't.
 *
 * The two halves are disjoint by construction — a day either has transcripts
 * (and therefore a model breakdown) or it is part of the pre-retention window
 * whose ledger dollars were spread by prompt volume. `costTimeline` spans all
 * time and is the source of truth for the total; `dailyByModel` only colors in
 * the days it covers, and its per-day model costs sum to that day's `exact`.
 */
/** What the bars are split by. The series columns are models or project paths. */
export type Dimension = 'model' | 'project';

const dimension = (report: Report, by: Dimension) => (by === 'model' ? report.dailyByModel : report.dailyByProject);

export function spendSeries(report: Report, keys: string[], grain: Grain, by: Dimension = 'model'): SpendRow[] {
  const byModel = new Map(dimension(report, by).rows.map((r) => [String(r.date), r]));
  const out = new Map<string, SpendRow>();

  for (const day of report.costTimeline) {
    const key = bucketKey(day.date, grain);
    let row = out.get(key);
    if (!row) {
      row = { date: key, estimated: 0, recorded: 0, total: 0, prompts: 0, activeDays: 0 };
      for (const m of keys) row[m] = 0;
      out.set(key, row);
    }
    const detail = byModel.get(day.date);
    if (detail) {
      for (const m of keys) row[m] = (row[m] as number) + Number(detail[m] || 0);
    }
    row.estimated += day.estimated;
    row.recorded += day.exact;
    row.total += day.exact + day.estimated;
    row.prompts += day.prompts;
    if (day.exact + day.estimated > 0 || day.prompts > 0) row.activeDays++;
  }

  // `costTimeline` is a continuous ascending day range, so insertion order is
  // already chronological and every gap keeps its width.
  return [...out.values()];
}

/** What the main chart's bars measure. Every metric stacks by model. */
export const METRICS = ['spend', 'tokens', 'lines', 'time'] as const;
export type Metric = (typeof METRICS)[number];

export const METRIC_LABEL: Record<Metric, string> = {
  spend: 'Spend',
  tokens: 'Tokens',
  lines: 'Lines changed',
  time: 'Time',
};

export interface MetricRow {
  date: string;
  total: number;
  /** Lines metric only: the split of `total`. */
  added: number;
  removed: number;
  edits: number;
  activeDays: number;
  prompts: number;
  /** Prompts sent on days whose transcripts were deleted before being archived. */
  promptsNoDetail: number;
  [key: string]: number | string;
}

/**
 * Per-model series for the non-dollar metrics. They exist only where a
 * transcript (live or archived) does, so they run over `report.daily`'s
 * continuous range rather than the all-time spend timeline.
 *
 * `categories` filters the lines metric by file type (code, markdown, …).
 */
export function metricSeries(
  report: Report,
  keys: string[],
  grain: Grain,
  metric: Exclude<Metric, 'spend'>,
  categories: Set<string>,
  by: Dimension = 'model',
): MetricRow[] {
  const out = new Map<string, MetricRow>();
  const rowFor = (iso: string) => {
    const key = bucketKey(iso, grain);
    let row = out.get(key);
    if (!row) {
      row = { date: key, total: 0, added: 0, removed: 0, edits: 0, activeDays: 0, prompts: 0, promptsNoDetail: 0 };
      for (const m of keys) row[m] = 0;
      out.set(key, row);
    }
    return row;
  };

  // Seed every day so idle stretches keep their width.
  const active = new Map<string, boolean>();
  for (const day of report.daily) {
    const row = rowFor(day.date);
    active.set(day.date, false);
    row.prompts += day.prompts;
    // A normal day runs ~14 requests per prompt. Fewer requests than prompts
    // means only stray rows survive (a session that crossed into the day), so
    // the day's real record is gone.
    if (day.requests < day.prompts) row.promptsNoDetail += day.prompts;
  }

  if (metric === 'lines') {
    for (const e of report.edits.rows) {
      const key = by === 'model' ? e.model : e.project;
      if (!categories.has(e.category) || !keys.includes(key)) continue;
      const row = rowFor(e.date);
      const lines = e.added + e.removed;
      row[key] = (row[key] as number) + lines;
      row.total += lines;
      row.added += e.added;
      row.removed += e.removed;
      row.edits += e.edits;
      if (lines) active.set(e.date, true);
    }
  } else {
    const dim = dimension(report, by);
    const source = metric === 'tokens' ? dim.tokens : dim.engagedHours;
    for (const day of source) {
      const row = rowFor(String(day.date));
      for (const m of keys) {
        const v = Number(day[m] || 0);
        row[m] = (row[m] as number) + v;
        row.total += v;
        if (v) active.set(String(day.date), true);
      }
    }
  }

  for (const [date, on] of active) if (on) rowFor(date).activeDays++;
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Runs of buckets where most prompts fall on days with no transcript detail
 * left: the work happened, but the per-model record of it was deleted before
 * it could be archived. Drawn as hatched bands so they don't read as idle time.
 */
export function noDetailBands(rows: MetricRow[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let open: { from: string; to: string } | null = null;
  for (const row of rows) {
    const missing = row.prompts > 0 && row.promptsNoDetail / row.prompts > 0.5;
    if (missing) {
      if (open) open.to = row.date;
      else out.push((open = { from: row.date, to: row.date }));
    } else open = null;
  }
  return out;
}
