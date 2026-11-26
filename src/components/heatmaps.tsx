import { useMemo, useState } from 'react';
import type { Palette } from '../lib/palette';
import { sequentialRamp } from '../lib/palette';
import { longDate } from '../lib/format';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Sequential encoding: one hue, light→dark, on quantile bins so a few huge
 * days don't flatten everything else into the first step. Bin 0 is the
 * near-surface "nothing happened" step.
 */
function useBins(values: number[], steps: number) {
  return useMemo(() => {
    const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (!positive.length) return [] as number[];
    const cuts: number[] = [];
    for (let i = 1; i < steps; i++) {
      cuts.push(positive[Math.min(positive.length - 1, Math.floor((positive.length * i) / steps))]);
    }
    return cuts;
  }, [values, steps]);
}

function binOf(value: number, cuts: number[]) {
  if (value <= 0) return 0;
  let bin = 1;
  for (const cut of cuts) if (value >= cut) bin++;
  return Math.min(bin, cuts.length + 1);
}

function localDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function keyOf(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ----------------------------------------------------------- calendar view ---

export function CalendarHeatmap({
  data,
  palette,
  valueLabel,
  format,
}: {
  data: { date: string; value: number; sub?: string }[];
  palette: Palette;
  valueLabel: string;
  format: (n: number) => string;
}) {
  const ramp = sequentialRamp(palette);
  const cuts = useBins(
    data.map((d) => d.value),
    ramp.length - 1,
  );
  const [hover, setHover] = useState<{ x: number; y: number; row: (typeof data)[number] } | null>(null);

  const byDate = useMemo(() => new Map(data.map((d) => [d.date, d])), [data]);

  const { weeks, monthMarks } = useMemo(() => {
    if (!data.length) return { weeks: [] as Date[][], monthMarks: [] as { index: number; label: string }[] };
    const first = localDate(data[0].date);
    const last = localDate(data[data.length - 1].date);
    // Snap to the Sunday on or before the first day so columns are weeks.
    const cursor = new Date(first);
    cursor.setDate(cursor.getDate() - cursor.getDay());

    const cols: Date[][] = [];
    const marks: { index: number; label: string }[] = [];
    let lastMonth = -1;
    while (cursor <= last) {
      const col: Date[] = [];
      for (let i = 0; i < 7; i++) {
        col.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      if (col[0].getMonth() !== lastMonth) {
        lastMonth = col[0].getMonth();
        // A month whose first week lands right next to the previous label
        // would overprint it — skip the label, keep the columns.
        const previous = marks[marks.length - 1];
        if (!previous || cols.length - previous.index >= 3) {
          marks.push({ index: cols.length, label: MONTHS[lastMonth] });
        }
      }
      cols.push(col);
    }
    return { weeks: cols, monthMarks: marks };
  }, [data]);

  const CELL = 12;
  const GAP = 3;
  const LEFT = 30;
  const TOP = 16;
  const width = LEFT + weeks.length * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);

  if (!weeks.length) return null;

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
        <svg width={width} height={height} role="img" aria-label={`${valueLabel} per day`}>
          {monthMarks.map((mark) => (
            <text
              key={`${mark.label}-${mark.index}`}
              x={LEFT + mark.index * (CELL + GAP)}
              y={10}
              fontSize={10}
              fill={palette['ink-muted']}
            >
              {mark.label}
            </text>
          ))}
          {[1, 3, 5].map((row) => (
            <text key={row} x={0} y={TOP + row * (CELL + GAP) + 10} fontSize={10} fill={palette['ink-muted']}>
              {DOW[row]}
            </text>
          ))}
          {weeks.map((col, ci) =>
            col.map((day, ri) => {
              const key = keyOf(day);
              const row = byDate.get(key);
              const value = row?.value ?? 0;
              const x = LEFT + ci * (CELL + GAP);
              const y = TOP + ri * (CELL + GAP);
              return (
                <rect
                  className="hm-cell"
                  key={key}
                  x={x}
                  y={y}
                  width={CELL}
                  height={CELL}
                  rx={3}
                  fill={ramp[binOf(value, cuts)]}
                  onMouseEnter={() =>
                    setHover({ x: x + CELL / 2, y, row: row ?? { date: key, value: 0 } })
                  }
                  onMouseLeave={() => setHover(null)}
                />
              );
            }),
          )}
        </svg>
      </div>

      <div className="hm-scale">
        <span>Less</span>
        {ramp.map((c) => (
          <i key={c} style={{ background: c }} />
        ))}
        <span>More</span>
      </div>

      {hover ? (
        <div
          className="tt"
          style={{
            position: 'absolute',
            left: Math.max(0, hover.x - 70),
            top: hover.y + 22,
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          <div className="ttdate">{longDate(hover.row.date)}</div>
          <div className="ttrow">
            <span className="k">{valueLabel}</span>
            <span className="v">{format(hover.row.value)}</span>
          </div>
          {hover.row.sub ? <div className="ttfoot">{hover.row.sub}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- punchcard ---

export function Punchcard({
  data,
  palette,
  format,
  valueLabel,
}: {
  data: { dow: number; hour: number; prompts: number }[];
  palette: Palette;
  format: (n: number) => string;
  valueLabel: string;
}) {
  const ramp = sequentialRamp(palette);
  const grid = useMemo(() => {
    const cells = new Map<string, number>();
    for (const row of data) cells.set(`${row.dow}:${row.hour}`, row.prompts);
    return cells;
  }, [data]);
  const cuts = useBins(
    data.map((d) => d.prompts),
    ramp.length - 1,
  );
  const [hover, setHover] = useState<{ x: number; y: number; dow: number; hour: number; value: number } | null>(null);

  const CELL = 20;
  const GAP = 3;
  const LEFT = 34;
  const TOP = 16;
  // Monday-first reads better for a work-hours chart than Sunday-first.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const width = LEFT + 24 * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
        <svg width={width} height={height} role="img" aria-label={`${valueLabel} by hour and weekday`}>
          {Array.from({ length: 24 }, (_, h) => h).map((h) =>
            h % 3 === 0 ? (
              <text key={h} x={LEFT + h * (CELL + GAP)} y={10} fontSize={10} fill={palette['ink-muted']}>
                {String(h).padStart(2, '0')}
              </text>
            ) : null,
          )}
          {order.map((dow, ri) => (
            <text key={dow} x={0} y={TOP + ri * (CELL + GAP) + 14} fontSize={10} fill={palette['ink-muted']}>
              {DOW[dow]}
            </text>
          ))}
          {order.map((dow, ri) =>
            Array.from({ length: 24 }, (_, hour) => {
              const value = grid.get(`${dow}:${hour}`) ?? 0;
              const x = LEFT + hour * (CELL + GAP);
              const y = TOP + ri * (CELL + GAP);
              return (
                <rect
                  className="hm-cell"
                  key={`${dow}-${hour}`}
                  x={x}
                  y={y}
                  width={CELL}
                  height={CELL}
                  rx={4}
                  fill={ramp[binOf(value, cuts)]}
                  onMouseEnter={() => setHover({ x: x + CELL / 2, y, dow, hour, value })}
                  onMouseLeave={() => setHover(null)}
                />
              );
            }),
          )}
        </svg>
      </div>

      <div className="hm-scale">
        <span>Less</span>
        {ramp.map((c) => (
          <i key={c} style={{ background: c }} />
        ))}
        <span>More</span>
      </div>

      {hover ? (
        <div
          className="tt"
          style={{
            position: 'absolute',
            left: Math.max(0, Math.min(hover.x - 60, width - 140)),
            top: hover.y + 26,
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          <div className="ttdate">
            {DOW[hover.dow]} {String(hover.hour).padStart(2, '0')}:00
          </div>
          <div className="ttrow">
            <span className="k">{valueLabel}</span>
            <span className="v">{format(hover.value)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
