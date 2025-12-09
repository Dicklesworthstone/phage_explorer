import React, { useEffect, useMemo, useRef } from 'react';
import type { ScatterPoint, ColorScale, ScatterHover } from './types';

export interface ScatterCanvasProps {
  width: number;
  height: number;
  points: ScatterPoint[];
  colorScale?: ColorScale;
  pointColor?: string;
  pointSize?: number;
  padding?: number;
  backgroundColor?: string;
  showAxes?: boolean;
  showGrid?: boolean;
  xLabel?: string;
  yLabel?: string;
  onHover?: (hover: ScatterHover | null) => void;
  onClick?: (hover: ScatterHover | null) => void;
  ariaLabel?: string;
}

export function ScatterCanvas({
  width,
  height,
  points,
  colorScale,
  pointColor = '#38bdf8',
  pointSize = 3,
  padding = 24,
  backgroundColor = '#0f172a',
  showAxes = true,
  showGrid = true,
  xLabel,
  yLabel,
  onHover,
  onClick,
  ariaLabel = 'scatter plot',
}: ScatterCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const bounds = useMemo(() => {
    if (points.length === 0) {
      return {
        minX: 0,
        maxX: 1,
        minY: 0,
        maxY: 1,
        dx: 1,
        dy: 1,
      };
    }
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dx = maxX - minX || 1;
    const dy = maxY - minY || 1;
    return { minX, maxX, minY, maxY, dx, dy };
  }, [points]);

  const toCanvas = (p: ScatterPoint) => {
    const innerW = width - padding * 2;
    const innerH = height - padding * 2;
    const normX = (p.x - bounds.minX) / bounds.dx;
    const normY = (p.y - bounds.minY) / bounds.dy;
    const cx = padding + normX * innerW;
    const cy = padding + (1 - normY) * innerH;
    return { cx, cy };
  };

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

    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);

    const innerW = width - padding * 2;
    const innerH = height - padding * 2;

    if (showGrid) {
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      for (let i = 1; i <= 3; i++) {
        const x = padding + (innerW / 4) * i;
        const y = padding + (innerH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(x, padding);
        ctx.lineTo(x, height - padding);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    if (showAxes) {
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padding, padding);
      ctx.lineTo(padding, height - padding);
      ctx.lineTo(width - padding, height - padding);
      ctx.stroke();

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '12px Inter, sans-serif';
      if (xLabel) {
        ctx.fillText(xLabel, width - padding - 48, height - padding + 18);
      }
      if (yLabel) {
        ctx.save();
        ctx.translate(padding - 22, padding + 12);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();
      }
    }

    for (const p of points) {
      const { cx, cy } = toCanvas(p);
      const size = p.size ?? pointSize;
      ctx.fillStyle = p.color ?? (colorScale ? colorScale(p.value ?? 0) : pointColor);
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [backgroundColor, colorScale, height, padding, pointColor, pointSize, points, showAxes, showGrid, toCanvas, width, xLabel, yLabel]);

  useEffect(() => {
    if (!onHover) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const innerW = width - padding * 2;
    const innerH = height - padding * 2;

    const handleMove = (evt: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left - padding;
      const y = evt.clientY - rect.top - padding;
      if (x < 0 || y < 0 || x > innerW || y > innerH) {
        onHover(null);
        return;
      }
      const targetX = (x / innerW) * bounds.dx + bounds.minX;
      const targetY = (1 - y / innerH) * bounds.dy + bounds.minY;
      let closest: ScatterPoint | null = null;
      let bestDist = Infinity;
      for (const p of points) {
        const dist = (p.x - targetX) ** 2 + (p.y - targetY) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          closest = p;
        }
      }
      if (!closest) {
        onHover(null);
        return;
      }
      const { cx, cy } = toCanvas(closest);
      onHover({
        point: closest,
        canvasX: cx,
        canvasY: cy,
      });
    };

    const handleLeave = () => onHover(null);
    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    return () => {
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mouseleave', handleLeave);
    };
  }, [bounds.dx, bounds.minX, bounds.minY, bounds.dy, height, onHover, padding, points, toCanvas, width]);

  useEffect(() => {
    if (!onClick) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const innerW = width - padding * 2;
    const innerH = height - padding * 2;

    const handleClick = (evt: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left - padding;
      const y = evt.clientY - rect.top - padding;
      if (x < 0 || y < 0 || x > innerW || y > innerH) {
        onClick(null);
        return;
      }
      const targetX = (x / innerW) * bounds.dx + bounds.minX;
      const targetY = (1 - y / innerH) * bounds.dy + bounds.minY;
      let closest: ScatterPoint | null = null;
      let bestDist = Infinity;
      for (const p of points) {
        const dist = (p.x - targetX) ** 2 + (p.y - targetY) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          closest = p;
        }
      }
      if (!closest) {
        onClick(null);
        return;
      }
      const { cx, cy } = toCanvas(closest);
      onClick({
        point: closest,
        canvasX: cx,
        canvasY: cy,
      });
    };

    canvas.addEventListener('click', handleClick);
    return () => {
      canvas.removeEventListener('click', handleClick);
    };
  }, [bounds.dx, bounds.dy, bounds.minX, bounds.minY, height, onClick, padding, points, toCanvas, width]);

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

export default ScatterCanvas;

