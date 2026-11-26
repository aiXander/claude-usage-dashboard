import { useId, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Palette } from '../lib/palette';
import { shortDate } from '../lib/format';

/**
 * Shared chart chrome. Grid and axes are solid hairlines one shade off the
 * surface; marks stay thin. Never two y-scales on one plot — two measures of
 * different magnitude get two charts.
 *
 * Fills are vertical ramps of the *same* slot hue (full at the mark, near-zero
 * at the baseline). That is depth, not a second encoding — hue still says
 * "which series" and nothing else.
 */
function axisProps(p: Palette) {
  return {
    stroke: p.axis,
    tick: { fill: p['ink-muted'], fontSize: 11 },
    tickLine: false,
    axisLine: { stroke: p.axis },
    tickMargin: 8,
  } as const;
}

function grid(p: Palette) {
  return <CartesianGrid stroke={p.grid} strokeDasharray="0" vertical={false} />;
}

/** Relative luminance of the plane, to decide whether a glow would read. */
function isDark(p: Palette) {
  const hex = p.plane.replace('#', '');
  if (hex.length < 6) return true;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
}

/** A soft bloom under a line — only on the dark plane, where it reads as glow
 *  rather than smudge. */
function lineGlow(p: Palette, color: string) {
  return isDark(p) ? { filter: `drop-shadow(0 2px 7px ${color}66)` } : undefined;
}

export interface TipRow {
  label: string;
  value: string;
  color?: string;
}

function Tip({ title, rows, foot }: { title: string; rows: TipRow[]; foot?: ReactNode }) {
  return (
    <div className="tt">
      <div className="ttdate">{title}</div>
      {rows.map((row) => (
        <div className="ttrow" key={row.label}>
          {row.color ? <i className="swatch" style={{ background: row.color }} /> : null}
          <span className="k">{row.label}</span>
          <span className="v">{row.value}</span>
        </div>
      ))}
      {foot ? <div className="ttfoot">{foot}</div> : null}
    </div>
  );
}

type TipBuilder = (payload: Record<string, number | string>) => { title: string; rows: TipRow[]; foot?: ReactNode };

function makeTooltip(build: TipBuilder) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function Rendered({ active, payload }: any) {
    if (!active || !payload?.length) return null;
    const spec = build(payload[0].payload);
    return <Tip {...spec} />;
  };
}

/**
 * Vertical fill ramps, one per series, keyed to a per-instance id.
 *
 * Called as a function, never rendered as `<Ramps/>`: Recharts filters its
 * children down to literal SVG elements, so a custom component wrapping
 * `<defs>` is dropped and every `url(#…)` fill silently resolves to nothing.
 * `useId` needs sanitizing too — React 19 returns `«r0»`, which is not a legal
 * id in a functional-notation reference.
 */
function ramps(uid: string, colors: string[], keys: string[], from: number, to: number) {
  return (
    <defs>
      {keys.map((key, i) => (
        <linearGradient key={key} id={`${uid}-${i}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors[i % colors.length]} stopOpacity={from} />
          <stop offset="100%" stopColor={colors[i % colors.length]} stopOpacity={to} />
        </linearGradient>
      ))}
    </defs>
  );
}

// ------------------------------------------------------------ stacked bars ---

/**
 * One segment of a stack.
 *
 * Recharts' own `radius` rounds whichever series is declared last, which is
 * wrong for a stack whose top series is empty on most bars — those columns come
 * out square. Rounding is decided per bar instead, from the data.
 *
 * The seam between neighbours is a 1px surface line on the segment's top edge —
 * never a contrasting border drawn around the mark, and never on a sliver too
 * thin to survive it.
 */
function StackSegment({
  x,
  y,
  width,
  height,
  fill,
  seam,
  rounded,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  seam: string;
  rounded: boolean;
}) {
  if (!(height > 0.3) || !(width > 0)) return null;
  const r = rounded ? Math.min(4, width / 2, height) : 0;
  const d = r
    ? `M${x} ${y + height} L${x} ${y + r} A${r} ${r} 0 0 1 ${x + r} ${y}` +
      ` L${x + width - r} ${y} A${r} ${r} 0 0 1 ${x + width} ${y + r} L${x + width} ${y + height} Z`
    : `M${x} ${y} h${width} v${height} h${-width} Z`;
  return (
    <g>
      <path d={d} fill={fill} />
      {!rounded && height > 2.5 ? (
        <line x1={x} x2={x + width} y1={y + 0.5} y2={y + 0.5} stroke={seam} strokeWidth={1} />
      ) : null}
    </g>
  );
}

export function StackedBars({
  data,
  keys,
  colors,
  palette,
  height = 260,
  yFormat,
  xFormat = shortDate,
  tooltip,
  maxBarSize,
  bands = [],
}: {
  data: Record<string, number | string>[];
  keys: string[];
  colors: string[];
  palette: Palette;
  height?: number;
  yFormat: (n: number) => string;
  /** Category labels; the default is a day axis. */
  xFormat?: (v: string) => string;
  tooltip: TipBuilder;
  /** Keeps a month view from rendering a handful of slabs. */
  maxBarSize?: number;
  /**
   * Runs of categories to hatch behind the bars, inclusive `from`..`to`
   * x-values — e.g. stretches where the data is missing rather than zero.
   */
  bands?: { from: string; to: string; label: string }[];
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const topKey = (row: Record<string, number | string>) => {
    for (let i = keys.length - 1; i >= 0; i--) if (Number(row[keys[i]]) > 0) return keys[i];
    return null;
  };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap="16%">
        {ramps(uid, colors, keys, 1, 0.72)}
        <defs>
          <pattern id={`${uid}-hatch`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke={palette.estimate} strokeWidth="2" strokeOpacity="0.35" />
          </pattern>
        </defs>
        {grid(palette)}
        <XAxis dataKey="date" {...axisProps(palette)} tickFormatter={xFormat} minTickGap={24} />
        <YAxis {...axisProps(palette)} tickFormatter={yFormat} width={54} />
        <Tooltip
          content={makeTooltip(tooltip)}
          cursor={{ fill: palette['surface-2'], radius: 4 }}
          wrapperStyle={{ outline: 'none' }}
        />
        {bands.map((b) => (
          <ReferenceArea
            key={b.from}
            x1={b.from}
            x2={b.to}
            fill={`url(#${uid}-hatch)`}
            stroke="none"
            ifOverflow="hidden"
            label={{ value: b.label, position: 'insideTop', fill: palette['ink-muted'], fontSize: 11, offset: 10 }}
          />
        ))}
        {keys.map((key, i) => (
          <Bar
            key={key}
            dataKey={key}
            stackId="a"
            fill={`url(#${uid}-${i})`}
            maxBarSize={maxBarSize}
            isAnimationActive={false}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            shape={((props: any) => (
              <StackSegment
                x={props.x}
                y={props.y}
                width={props.width}
                height={props.height}
                fill={props.fill}
                seam={palette.surface}
                rounded={topKey(props.payload) === key}
              />
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            )) as any}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ----------------------------------------------------------- stacked areas ---

export function StackedAreas({
  data,
  keys,
  colors,
  palette,
  height = 240,
  yFormat,
  tooltip,
}: {
  data: Record<string, number | string>[];
  keys: string[];
  colors: string[];
  palette: Palette;
  height?: number;
  yFormat: (n: number) => string;
  tooltip: TipBuilder;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
        {ramps(uid, colors, keys, 0.5, 0.04)}
        {grid(palette)}
        <XAxis dataKey="date" {...axisProps(palette)} tickFormatter={shortDate} minTickGap={28} />
        <YAxis {...axisProps(palette)} tickFormatter={yFormat} width={54} />
        <Tooltip
          content={makeTooltip(tooltip)}
          cursor={{ stroke: palette['ink-muted'], strokeWidth: 1, strokeDasharray: '3 3' }}
          wrapperStyle={{ outline: 'none' }}
        />
        {keys.map((key, i) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stackId="a"
            stroke={colors[i % colors.length]}
            strokeWidth={1.75}
            fill={`url(#${uid}-${i})`}
            fillOpacity={1}
            activeDot={{ r: 3.5, strokeWidth: 2, stroke: palette.surface }}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ------------------------------------------------------------------ lines ---

export function Lines({
  data,
  keys,
  colors,
  palette,
  height = 220,
  yFormat,
  tooltip,
  reference,
  domain,
  connectNulls,
}: {
  data: Record<string, number | string>[];
  keys: string[];
  colors: string[];
  palette: Palette;
  height?: number;
  yFormat: (n: number) => string;
  tooltip: TipBuilder;
  reference?: { y: number; label: string };
  domain?: [number | 'auto', number | 'auto'];
  /** For rate series, which are null (not zero) on days with no requests. */
  connectNulls?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        {ramps(uid, colors, keys, 0.22, 0)}
        {grid(palette)}
        <XAxis dataKey="date" {...axisProps(palette)} tickFormatter={shortDate} minTickGap={28} />
        <YAxis {...axisProps(palette)} tickFormatter={yFormat} width={54} domain={domain} />
        <Tooltip
          content={makeTooltip(tooltip)}
          cursor={{ stroke: palette['ink-muted'], strokeWidth: 1, strokeDasharray: '3 3' }}
          wrapperStyle={{ outline: 'none' }}
        />
        {reference ? (
          <ReferenceLine
            y={reference.y}
            stroke={palette['ink-muted']}
            strokeWidth={1}
            strokeDasharray="4 4"
            label={{ value: reference.label, position: 'insideTopRight', fill: palette['ink-muted'], fontSize: 11 }}
          />
        ) : null}
        {keys.map((key, i) => {
          const color = colors[i % colors.length];
          return (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              fill={`url(#${uid}-${i})`}
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: palette.surface }}
              connectNulls={connectNulls}
              isAnimationActive={false}
              style={lineGlow(palette, color)}
            />
          );
        })}
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ------------------------------------------------------- horizontal bars ---

/**
 * One series, one color. Nominal categories never get a value-ramp — bar
 * length already encodes magnitude, and a ramp would burn the hue channel on
 * information the chart shows twice.
 */
export function HBars({
  rows,
  palette,
  format,
  color,
  highlight,
}: {
  rows: { label: string; value: number; note?: string }[];
  palette: Palette;
  format: (n: number) => string;
  color?: string;
  /** Optional per-row color, for the one case where rows *are* the entities. */
  highlight?: (label: string, index: number) => string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  const dark = isDark(palette);
  return (
    <div style={{ display: 'grid', gap: 9, marginTop: 4 }}>
      {rows.map((row, i) => {
        const fill = highlight ? highlight(row.label, i) : color || palette.s1;
        return (
          <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '1fr 84px', gap: 12, alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontSize: 12,
                  marginBottom: 5,
                  color: palette.ink,
                }}
              >
                <span className="trunc">{row.label}</span>
                {row.note ? <span style={{ color: palette['ink-muted'], flex: 'none' }}>{row.note}</span> : null}
              </div>
              <div className="hbar-track">
                <div
                  className="hbar-fill"
                  style={{
                    width: `${Math.max(1.5, (row.value / max) * 100)}%`,
                    background: `linear-gradient(90deg, ${fill}cc, ${fill})`,
                    boxShadow: dark ? `0 0 12px -3px ${fill}` : undefined,
                  }}
                />
              </div>
            </div>
            <div
              style={{
                textAlign: 'right',
                fontSize: 12,
                fontVariantNumeric: 'tabular-nums',
                color: palette['ink-2'],
              }}
            >
              {format(row.value)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------- histogram ---

export function Histogram({
  buckets,
  palette,
  height = 200,
}: {
  buckets: { from: number; to: number; count: number; cost: number }[];
  palette: Palette;
  height?: number;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const data = buckets.map((b) => ({
    date: b.to === Infinity || b.to === null ? `$${b.from}+` : `$${b.from}–${b.to}`,
    count: b.count,
    cost: b.cost,
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap="24%">
        {ramps(uid, [palette.s1], ['count'], 1, 0.55)}
        {grid(palette)}
        <XAxis dataKey="date" {...axisProps(palette)} interval={0} angle={-32} textAnchor="end" height={54} />
        <YAxis {...axisProps(palette)} width={40} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: palette['surface-2'], radius: 4 }}
          wrapperStyle={{ outline: 'none' }}
          content={makeTooltip((row) => ({
            title: `Sessions costing ${row.date}`,
            rows: [
              { label: 'Sessions', value: String(row.count), color: palette.s1 },
              { label: 'Combined cost', value: `$${Number(row.cost).toFixed(2)}` },
            ],
          }))}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((row) => (
            <Cell key={row.date} fill={`url(#${uid}-0)`} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
