import { useMemo, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  align?: 'left' | 'right';
  sort?: (row: T) => number | string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  rows,
  columns,
  initialSort,
  maxRows,
}: {
  rows: T[];
  columns: Column<T>[];
  initialSort?: string;
  maxRows?: number;
}) {
  const [sortKey, setSortKey] = useState(initialSort ?? columns[0].key);
  const [desc, setDesc] = useState(true);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return rows;
    const out = [...rows].sort((a, b) => {
      const av = col.sort!(a);
      const bv = col.sort!(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv));
      }
      return av - bv;
    });
    return desc ? out.reverse() : out;
  }, [rows, columns, sortKey, desc]);

  const shown = maxRows ? sorted.slice(0, maxRows) : sorted;

  return (
    <table className="data">
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={col.key}
              className={col.sort ? 'sortable' : undefined}
              style={{ textAlign: col.align ?? 'right' }}
              onClick={() => {
                if (!col.sort) return;
                if (col.key === sortKey) setDesc((d) => !d);
                else {
                  setSortKey(col.key);
                  setDesc(true);
                }
              }}
            >
              {col.label}
              {col.sort && col.key === sortKey ? <span className="arrow">{desc ? '↓' : '↑'}</span> : null}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {shown.map((row, i) => (
          <tr key={i}>
            {columns.map((col) => (
              <td key={col.key} style={{ textAlign: col.align ?? 'right' }}>
                {col.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Compact table twin for a time series — the WCAG-clean read of any chart. */
export function SeriesTable<T extends object>({
  rows,
  columns,
}: {
  rows: readonly T[];
  columns: { key: string; label: string; format?: (v: unknown) => string }[];
}) {
  const cell = (row: T, key: string) => (row as Record<string, unknown>)[key];
  return (
    <table className="data">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} style={{ textAlign: c.key === 'date' ? 'left' : 'right' }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {columns.map((c) => (
              <td key={c.key} style={{ textAlign: c.key === 'date' ? 'left' : 'right' }}>
                {c.format ? c.format(cell(row, c.key)) : String(cell(row, c.key) ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
