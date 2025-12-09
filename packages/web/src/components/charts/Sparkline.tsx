import React, { useEffect, useRef } from 'react';
import { useTheme } from '../../hooks/useTheme';

export type SparklineVariant = 'line' | 'dots' | 'wave' | 'bar';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  variant?: SparklineVariant;
  threshold?: number;
  showPeaks?: boolean;
  showValleys?: boolean;
  className?: string;
}

export const Sparkline: React.FC<SparklineProps> = ({
  values,
  width = 180,
  height = 48,
  variant = 'line',
  threshold,
  showPeaks = true,
  showValleys = true,
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
    const toX = (i: number) => (values.length === 1 ? width / 2 : (i / (values.length - 1)) * (width - 1));
    const toY = (v: number) => height - ((v - min) / span) * (height - 4) - 2; // padding 2px

    // Background
    ctx.clearRect(0, 0, width, height);

    // Gradient stroke
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    const stops = theme.palette.sparkline;
    stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.2;

    const points = values.map((v, i) => ({ x: toX(i), y: toY(v), v }));

    // Threshold band
    if (typeof threshold === 'number') {
      const ty = toY(threshold);
      ctx.fillStyle = `${theme.palette.warning}22`; // subtle alpha
      ctx.fillRect(0, 0, width, ty);
      ctx.fillStyle = `${theme.palette.success}22`;
      ctx.fillRect(0, ty, width, height - ty);
      ctx.strokeStyle = theme.palette.warning;
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(width, ty);
      ctx.stroke();
    }

    // Wave fill
    if (variant === 'wave') {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.lineTo(points[points.length - 1].x, height);
      ctx.lineTo(points[0].x, height);
      ctx.closePath();
      ctx.fillStyle = `${stops[2]}33`;
      ctx.fill();
    }

    // Bar chart
    if (variant === 'bar') {
      const barWidth = Math.max(1, (width / values.length) - 1);
      ctx.fillStyle = grad;
      points.forEach(p => {
        const h = height - p.y;
        // Align bar center to point x
        ctx.fillRect(p.x - barWidth/2, p.y, barWidth, h);
      });
    }

    // Line/dots (line is default if not bar/wave/dots, or explicit line)
    if (variant === 'line' || variant === 'wave') {
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }

    if (variant === 'dots') {
      ctx.fillStyle = grad;
      points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Peaks/valleys markers
    const markers: { x: number; y: number; type: 'peak' | 'valley' }[] = [];
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1].v;
      const curr = points[i].v;
      const next = points[i + 1].v;
      if (showPeaks && curr >= prev && curr >= next) markers.push({ x: points[i].x, y: points[i].y, type: 'peak' });
      if (showValleys && curr <= prev && curr <= next) markers.push({ x: points[i].x, y: points[i].y, type: 'valley' });
    }
    const maxMarkers = 4;
    markers.slice(0, maxMarkers).forEach(m => {
      ctx.fillStyle = m.type === 'peak' ? theme.palette.error : theme.palette.info;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [values, width, height, variant, threshold, showPeaks, showValleys, theme.palette]);

  return (
    <canvas
      ref={canvasRef}
      className={`sparkline ${className}`.trim()}
      role="img"
      aria-label="sparkline chart"
      width={width}
      height={height}
    />
  );
};

export default Sparkline;
