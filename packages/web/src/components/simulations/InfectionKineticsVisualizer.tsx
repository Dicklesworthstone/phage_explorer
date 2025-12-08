import React, { useEffect, useMemo, useRef } from 'react';
import type { InfectionKineticsState } from '../../workers/types';
import { useTheme } from '../../hooks/useTheme';

interface InfectionKineticsVisualizerProps {
  state: InfectionKineticsState;
  width?: number;
  height?: number;
}

const COLORS = {
  bacteria: '#22c55e',
  infected: '#eab308',
  phage: '#6366f1',
};

export function InfectionKineticsVisualizer({
  state,
  width = 540,
  height = 260,
}: InfectionKineticsVisualizerProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const series = useMemo(() => {
    const history = (state as any).history as Array<{ time: number; bacteria: number; infected: number; phage: number }> | undefined;
    const points = history && history.length > 0
      ? history
      : [{ time: state.time, bacteria: state.bacteria, infected: state.infected, phage: state.phage }];
    // Ensure time ascending
    return [...points].sort((a, b) => a.time - b.time);
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const padding = { top: 20, right: 180, bottom: 32, left: 58 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const maxVal = Math.max(
      1,
      ...series.flatMap(p => [p.bacteria, p.infected, p.phage]).map(Math.abs),
    );
    const maxTime = Math.max(1, ...series.map(p => p.time));

    const xScale = (t: number) => padding.left + (t / maxTime) * chartW;
    const yScale = (v: number) => padding.top + chartH - (v / maxVal) * chartH;

    // Gridlines
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    // Y ticks
    ctx.fillStyle = colors.textDim;
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    const yTicks = 3;
    for (let i = 0; i <= yTicks; i++) {
      const val = (maxVal / yTicks) * i;
      const y = yScale(val);
      ctx.fillText(val >= 1e6 ? `${(val / 1e6).toFixed(1)}M` : val.toFixed(0), padding.left - 6, y + 3);
      ctx.strokeStyle = colors.borderLight;
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center';
    ctx.fillText('Time (arbitrary units)', padding.left + chartW / 2, height - 8);

    const drawSeries = (key: 'bacteria' | 'infected' | 'phage', color: string) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      series.forEach((p, i) => {
        const x = xScale(p.time);
        const y = yScale((p as any)[key]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawSeries('bacteria', COLORS.bacteria);
    drawSeries('infected', COLORS.infected);
    drawSeries('phage', COLORS.phage);

    // Legend + metrics panel
    const legendX = width - padding.right + 10;
    const legendY = padding.top;
    ctx.font = '11px monospace';

    const rows: Array<{ label: string; color: string; value: number }> = [
      { label: 'Bacteria', color: COLORS.bacteria, value: series.at(-1)?.bacteria ?? 0 },
      { label: 'Infected', color: COLORS.infected, value: series.at(-1)?.infected ?? 0 },
      { label: 'Phage', color: COLORS.phage, value: series.at(-1)?.phage ?? 0 },
    ];
    rows.forEach((row, idx) => {
      const y = legendY + idx * 18;
      ctx.fillStyle = row.color;
      ctx.fillRect(legendX, y - 8, 10, 10);
      ctx.fillStyle = colors.text;
      ctx.fillText(row.label, legendX + 16, y);
      ctx.fillStyle = colors.textDim;
      ctx.fillText(formatCount(row.value), legendX + 110, y);
    });

    // Phase-plane inset (B vs P)
    const insetW = 110;
    const insetH = 90;
    const insetX = width - padding.right + 10;
    const insetY = legendY + 70;
    ctx.strokeStyle = colors.borderLight;
    ctx.strokeRect(insetX, insetY, insetW, insetH);
    const insetPadding = 6;
    const maxB = Math.max(...series.map(p => p.bacteria), 1);
    const maxP = Math.max(...series.map(p => p.phage), 1);
    const xInset = (v: number) => insetX + insetPadding + (v / maxB) * (insetW - insetPadding * 2);
    const yInset = (v: number) => insetY + insetH - insetPadding - (v / maxP) * (insetH - insetPadding * 2);

    ctx.beginPath();
    series.forEach((p, i) => {
      const x = xInset(p.bacteria);
      const y = yInset(p.phage);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = colors.textDim;
    ctx.font = '9px monospace';
    ctx.fillText('Phase plane (B vs P)', insetX + insetW / 2, insetY - 4);
  }, [series, width, height, colors]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
    />
  );
}

function formatCount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}

export default InfectionKineticsVisualizer;
