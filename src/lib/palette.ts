import { useEffect, useState } from 'react';

const TOKENS = [
  's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8',
  'seq-0', 'seq-1', 'seq-2', 'seq-3', 'seq-4', 'seq-5', 'seq-6', 'seq-7',
  'surface', 'surface-2', 'plane', 'ink', 'ink-2', 'ink-muted', 'grid', 'axis',
  'good', 'warning', 'critical', 'estimate',
] as const;

export type Palette = Record<(typeof TOKENS)[number], string>;

function read(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as Palette;
  for (const token of TOKENS) out[token] = cs.getPropertyValue(`--${token}`).trim();
  return out;
}

/**
 * Recharts wants concrete colors, so resolve the CSS custom properties once
 * per theme rather than passing `var(--s1)` into SVG attributes.
 *
 * `themeKey` must be the *resolved* theme (`light` / `dark`, never `system`),
 * which is also what `data-theme` carries — following the OS is App's job, so
 * there is nothing to listen for here.
 */
export function usePalette(themeKey: string): Palette {
  const [palette, setPalette] = useState<Palette>(() => read());
  useEffect(() => {
    // The stylesheet swap and the attribute change land in the same frame;
    // read after it so the computed values are the new ones.
    const id = requestAnimationFrame(() => setPalette(read()));
    return () => cancelAnimationFrame(id);
  }, [themeKey]);
  return palette;
}

/**
 * Categorical hues are assigned in fixed slot order and never cycled: the same
 * entity keeps its color when a filter changes the series count, and a 9th
 * series folds into "Other" rather than reusing a slot.
 */
export function seriesColors(p: Palette): string[] {
  return [p.s1, p.s2, p.s3, p.s4, p.s5, p.s6, p.s7, p.s8];
}

export function sequentialRamp(p: Palette): string[] {
  return [p['seq-0'], p['seq-1'], p['seq-2'], p['seq-3'], p['seq-4'], p['seq-5'], p['seq-6'], p['seq-7']];
}

export const MAX_SERIES = 8;

/** Keep the top N by weight in fixed order; everything else becomes "Other". */
export function foldToOther<T>(items: T[], weight: (t: T) => number, name: (t: T) => string, max = 7) {
  const sorted = [...items].sort((a, b) => weight(b) - weight(a));
  const keep = sorted.slice(0, max).map(name);
  return { keep, hasOther: sorted.length > max };
}
