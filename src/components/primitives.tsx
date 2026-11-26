import { useState, type CSSProperties, type ReactNode } from 'react';

export function Card({
  title,
  note,
  span = 'full',
  actions,
  table,
  children,
}: {
  title: string;
  note?: ReactNode;
  span?: 'full' | 'half' | 'third' | 'twothird';
  actions?: ReactNode;
  /**
   * Every chart ships a table twin. It is the relief for the light-mode
   * contrast warning on three palette slots, and the WCAG-clean way to read
   * any value that the plot only encodes in color.
   */
  table?: ReactNode;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const cls = span === 'full' ? 'card' : `card ${span}`;
  return (
    <section className={cls}>
      <div className="cardhead">
        <div>
          <h3>{title}</h3>
          {note ? <p>{note}</p> : null}
        </div>
        <div style={{ display: 'flex', gap: 6, flex: 'none', alignItems: 'center' }}>
          {actions}
          {table ? (
            <button className="btn ghost" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Chart' : 'Table'}
            </button>
          ) : null}
        </div>
      </div>
      {showTable && table ? <div className="tablewrap">{table}</div> : <div className="chartbody">{children}</div>}
    </section>
  );
}

export function Tile({
  label,
  value,
  unit,
  sub,
  accent,
  lead,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: ReactNode;
  /** Colors the 1px seam on the top edge, and the wash if `lead`. */
  accent?: string;
  /** The one headline number of a panel — double width, larger type. */
  lead?: boolean;
}) {
  return (
    <div
      className={lead ? 'tile lead' : 'tile'}
      style={accent ? ({ '--tile-accent': accent } as CSSProperties) : undefined}
    >
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit ? <small> {unit}</small> : null}
      </div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((item) => (
        <span className="item" key={item.label}>
          <i className="swatch" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '38px 0', textAlign: 'center', color: 'var(--ink-muted)', fontSize: 13 }}>{children}</div>
  );
}
