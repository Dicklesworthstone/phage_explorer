import React, { useEffect, useRef } from 'react';
import type { ColorScale } from './types';

export interface ColorLegendProps {
  width?: number;
  height?: number;
  colorScale?: ColorScale;
  stops?: string[];
  tickCount?: number;
  minLabel?: string;
  maxLabel?: string;
  ariaLabel?: string;
}

export function ColorLegend({
  width = 200,
  height = 28,
  colorScale,
  stops,
  tickCount = 3,
  minLabel = 'min',
  maxLabel = 'max',
  ariaLabel = 'color legend',
}: ColorLegendProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    if (stops && stops.length >= 2) {
      stops.forEach((stop, idx) => {
        const t = stops.length === 1 ? 0 : idx / (stops.length - 1);
        gradient.addColorStop(t, stop);
      });
    } else if (colorScale) {
      const segments = 16;
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        gradient.addColorStop(t, colorScale(t));
      }
    } else {
      gradient.addColorStop(0, '#0ea5e9');
      gradient.addColorStop(1, '#22c55e');
    }

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height - 10);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '11px JetBrains Mono, ui-monospace, monospace';
    ctx.textBaseline = 'top';

    ctx.fillText(minLabel, 0, height - 10);
    const maxWidth = ctx.measureText(maxLabel).width;
    ctx.fillText(maxLabel, width - maxWidth, height - 10);

    const usableWidth = width;
    const ticks = Math.max(0, tickCount);
    for (let i = 0; i <= ticks; i++) {
      const x = (i / ticks) * usableWidth;
      ctx.fillRect(x, height - 12, 1, 4);
    }
  }, [colorScale, height, maxLabel, minLabel, stops, tickCount, width]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      aria-label={ariaLabel}
      role="img"
      style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
    />
  );
}

export default ColorLegend;

