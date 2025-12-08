import React, { useEffect, useRef } from 'react';
import type { ScatterPoint, ColorScale } from './types';

export interface ScatterCanvasProps {
  width: number;
  height: number;
  points: ScatterPoint[];
  colorScale?: ColorScale;
  pointColor?: string;
  pointSize?: number;
  padding?: number;
  backgroundColor?: string;
  onHover?: (point: ScatterPoint | null) => void;
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
  onHover,
  ariaLabel = 'scatter plot',
}: ScatterCanvasProps): React.ReactElement {
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

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dx = maxX - minX || 1;
    const dy = maxY - minY || 1;

    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);

    const innerW = width - padding * 2;
    const innerH = height - padding * 2;

    for (const p of points) {
      const normX = (p.x - minX) / dx;
      const normY = (p.y - minY) / dy;
      const cx = padding + normX * innerW;
      const cy = padding + (1 - normY) * innerH;
      const size = p.size ?? pointSize;
      ctx.fillStyle = p.color ?? (colorScale ? colorScale(p.value ?? normY) : pointColor);
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [backgroundColor, colorScale, height, padding, pointColor, pointSize, points, width]);

  useEffect(() => {
    if (!onHover) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dx = maxX - minX || 1;
    const dy = maxY - minY || 1;
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
      const targetX = x / innerW * dx + minX;
      const targetY = (1 - y / innerH) * dy + minY;
      let closest: ScatterPoint | null = null;
      let bestDist = Infinity;
      for (const p of points) {
        const dist = (p.x - targetX) ** 2 + (p.y - targetY) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          closest = p;
        }
      }
      onHover(closest);
    };

    const handleLeave = () => onHover(null);
    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    return () => {
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mouseleave', handleLeave);
    };
  }, [height, onHover, padding, points, width]);

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

