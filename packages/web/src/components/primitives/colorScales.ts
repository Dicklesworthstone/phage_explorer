import type { ColorScale } from './types';

export function createLinearColorScale(stops: string[]): ColorScale {
  if (stops.length < 2) {
    throw new Error('createLinearColorScale requires at least two color stops');
  }

  const lastIdx = stops.length - 1;
  return (value: number): string => {
    const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    const scaled = v * lastIdx;
    const lower = Math.floor(scaled);
    const upper = Math.min(lastIdx, lower + 1);
    const t = scaled - lower;

    const a = stops[lower];
    const b = stops[upper];
    if (a === b || upper === lower) return a;

    const parse = (hex: string) => {
      const clean = hex.replace('#', '');
      const chunk = (start: number) => parseInt(clean.slice(start, start + 2), 16);
      return [chunk(0), chunk(2), chunk(4)] as const;
    };

    const [r1, g1, b1] = parse(a);
    const [r2, g2, b2] = parse(b);
    const mix = (c1: number, c2: number) => Math.round(c1 + (c2 - c1) * t);

    const r = mix(r1, r2).toString(16).padStart(2, '0');
    const g = mix(g1, g2).toString(16).padStart(2, '0');
    const bComp = mix(b1, b2).toString(16).padStart(2, '0');

    return `#${r}${g}${bComp}`;
  };
}

export const DEFAULT_HEATMAP_SCALE = createLinearColorScale([
  '#0b1220',
  '#1d4ed8',
  '#06b6d4',
  '#22c55e',
  '#eab308',
  '#ef4444',
]);

