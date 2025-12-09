import React, { useEffect, useRef } from 'react';
import { useTheme } from '../../hooks/useTheme';

export interface HistogramProps {
  values: number[];
  bins?: number;
  width?: number;
  height?: number;
  showDensityLine?: boolean;
  className?: string;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const Histogram: React.FC<HistogramProps> = ({
  values,
  bins = 30,
  width = 240,
  height = 140,
  showDensityLine = true,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || values.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max === min ? 1 : max - min;
    const binWidth = span / bins;
    const hist = Array(bins).fill(0);
    values.forEach(v => {
      const idx = clamp(Math.floor((v - min) / binWidth), 0, bins - 1);
      hist[idx] += 1;
    });
    const maxCount = Math.max(...hist, 1);

    const padding = { top: 6, right: 4, bottom: 10, left: 4 };
    const drawWidth = width - padding.left - padding.right;
    const drawHeight = height - padding.top - padding.bottom;
    const barWidth = drawWidth / bins;

    ctx.clearRect(0, 0, width, height);

    // Bars
    ctx.fillStyle = theme.palette.kmerNormal;
    hist.forEach((count, i) => {
      const h = (count / maxCount) * drawHeight;
      const x = padding.left + i * barWidth;
      const y = padding.top + (drawHeight - h);
      ctx.fillRect(x, y, barWidth - 1, h);
    });

    // Density line (simple moving average)
    if (showDensityLine) {
      const smooth = 3;
      const smoothed = hist.map((_, i) => {
        let sum = 0;
        let c = 0;
        for (let k = -smooth; k <= smooth; k++) {
          const idx = i + k;
          if (idx >= 0 && idx < hist.length) {
            sum += hist[idx];
            c++;
          }
        }
        return sum / Math.max(1, c);
      });

      ctx.strokeStyle = theme.palette.accent;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      smoothed.forEach((v, i) => {
        const h = (v / maxCount) * drawHeight;
        const x = padding.left + i * barWidth + barWidth / 2;
        const y = padding.top + (drawHeight - h);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }, [values, bins, width, height, showDensityLine, theme.palette]);

  return (
    <canvas
      ref={canvasRef}
      className={`histogram ${className}`.trim()}
      aria-label="histogram"
    />
  );
};

export default Histogram;
