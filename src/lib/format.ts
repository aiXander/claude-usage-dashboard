export function usd(n: number, opts: { cents?: boolean } = {}) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (opts.cents || abs < 10) return `$${n.toFixed(2)}`;
  if (abs < 10_000) return `$${n.toFixed(0)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

/** Axis-width money: $9.2k rather than $9,249. */
export function usdCompact(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1e3).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs >= 10) return `$${n.toFixed(0)}`;
  if (abs === 0) return '$0';
  return `$${n.toFixed(2)}`;
}

export function tokens(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function int(n: number) {
  return Math.round(n).toLocaleString();
}

export function pct(n: number, digits = 0) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function hours(ms: number) {
  const h = ms / 3_600_000;
  if (h >= 100) return `${Math.round(h).toLocaleString()}h`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

export function duration(ms: number) {
  if (!ms || ms < 0) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-08-13` -> `13 Aug`. Parsed as a local calendar date, not UTC. */
export function shortDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y) return iso;
  return `${d} ${MONTHS[m - 1]}`;
}

export function longDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function dateTime(iso: string | null) {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}, ${String(at.getHours()).padStart(2, '0')}:${String(
    at.getMinutes(),
  ).padStart(2, '0')}`;
}

/** Strip the vendor prefix so legends read `opus-5` not `claude-opus-5`. */
export function modelLabel(model: string) {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function homeRelative(p: string, home: string) {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
