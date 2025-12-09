import React, { useCallback, useEffect, useRef } from 'react';
import type { HeatmapMatrix, HeatmapHover, HeatmapShape, ColorScale } from './types';

export interface HeatmapCanvasProps {
  width: number;
  height: number;
  matrix: HeatmapMatrix;
  colorScale: ColorScale;
  padding?: number;
  backgroundColor?: string;
  onHover?: (hover: HeatmapHover | null) => void;
  onClick?: (hover: HeatmapHover) => void;
  shape?: HeatmapShape;
  ariaLabel?: string;
}

export function HeatmapCanvas({
  width,
  height,
  matrix,
  colorScale,
  padding = 8,
  backgroundColor = '#0b1220',
  onHover,
  onClick,
  shape = 'full',
  ariaLabel = 'heatmap',
}: HeatmapCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const shouldRenderCell = useCallback((row: number, col: number): boolean => {
    if (shape === 'upper') return col >= row;
    if (shape === 'lower') return row >= col;
    return true;
  }, [shape]);

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

    const innerWidth = width - padding * 2;
    const innerHeight = height - padding * 2;
    const cellW = matrix.cols ? innerWidth / matrix.cols : 0;
    const cellH = matrix.rows ? innerHeight / matrix.rows : 0;
    const values = matrix.values;
    const min = matrix.min ?? Math.min(...values);
    const max = matrix.max ?? Math.max(...values);
    const denom = max - min || 1;

    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);

    for (let r = 0; r < matrix.rows; r++) {
      for (let c = 0; c < matrix.cols; c++) {
        if (!shouldRenderCell(r, c)) continue;
        const idx = r * matrix.cols + c;
        const v = values[idx] ?? 0;
        const norm = (v - min) / denom;
        ctx.fillStyle = colorScale(norm);
        ctx.fillRect(padding + c * cellW, padding + r * cellH, cellW, cellH);
      }
    }
  }, [backgroundColor, colorScale, height, matrix.cols, matrix.max, matrix.min, matrix.rows, matrix.values, padding, width]);

  useEffect(() => {
    if (!onHover) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleMove = (evt: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left - padding;
      const y = evt.clientY - rect.top - padding;
      if (x < 0 || y < 0 || x > width - padding * 2 || y > height - padding * 2) {
        onHover(null);
        return;
      }
      const cellW = (width - padding * 2) / matrix.cols;
      const cellH = (height - padding * 2) / matrix.rows;
      const col = Math.floor(x / cellW);
      const row = Math.floor(y / cellH);
      const idx = row * matrix.cols + col;
      const value = matrix.values[idx] ?? 0;
      if (!shouldRenderCell(row, col)) {
        onHover(null);
        return;
      }
      onHover({
        row,
        col,
        value,
        canvasX: padding + col * cellW,
        canvasY: padding + row * cellH,
      });
    };

    const handleLeave = () => onHover(null);

    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    return () => {
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mouseleave', handleLeave);
    };
  }, [height, matrix.cols, matrix.rows, matrix.values, onHover, padding, shape, shouldRenderCell, width]);

  useEffect(() => {
    if (!onClick) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleClick = (evt: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left - padding;
      const y = evt.clientY - rect.top - padding;
      if (x < 0 || y < 0 || x > width - padding * 2 || y > height - padding * 2) return;
      const cellW = (width - padding * 2) / matrix.cols;
      const cellH = (height - padding * 2) / matrix.rows;
      const col = Math.floor(x / cellW);
      const row = Math.floor(y / cellH);
      if (!shouldRenderCell(row, col)) return;
      const idx = row * matrix.cols + col;
      const value = matrix.values[idx] ?? 0;
      onClick({
        row,
        col,
        value,
        canvasX: padding + col * cellW,
        canvasY: padding + row * cellH,
      });
    };
    canvas.addEventListener('click', handleClick);
    return () => {
      canvas.removeEventListener('click', handleClick);
    };
  }, [height, matrix.cols, matrix.rows, matrix.values, onClick, padding, shape, shouldRenderCell, width]);

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

export default HeatmapCanvas;

