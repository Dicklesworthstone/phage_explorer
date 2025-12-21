/**
 * CanvasTrack - Abstract Base for High-Performance Track Rendering
 *
 * Provides a canvas element with automatic resize handling, DPI scaling,
 * and integration with TrackContainer's scroll sync.
 */

import React, { useRef, useEffect, useCallback, useState, memo } from 'react';
import { useTrackSync, type TrackSyncState } from './TrackContainer';
import { useTheme } from '../../hooks/useTheme';
import type { Theme } from '@phage-explorer/core';

export interface TrackData {
  /** Array of values (one per window/position) */
  values: number[];
  /** Window size used for computation */
  windowSize: number;
  /** Total genome length */
  genomeLength: number;
  /** Optional min value for normalization */
  minValue?: number;
  /** Optional max value for normalization */
  maxValue?: number;
  /** Optional labels for specific positions */
  labels?: Array<{ position: number; label: string; color?: string }>;
}

export interface CanvasTrackProps {
  /** Track label shown on the left */
  label: string;
  /** Track height in pixels */
  height?: number;
  /** Data to render */
  data: TrackData | null;
  /** Loading state */
  loading?: boolean;
  /** Custom render function - override default line chart */
  customRender?: (
    ctx: CanvasRenderingContext2D,
    data: TrackData,
    sync: TrackSyncState,
    theme: Theme,
    width: number,
    height: number
  ) => void;
  /** Line color (uses theme primary if not specified) */
  color?: string;
  /** Fill color for area under curve (optional) */
  fillColor?: string;
  /** Whether to show grid lines */
  showGrid?: boolean;
  /** Whether to show a center line at y=0 */
  showCenterLine?: boolean;
  /** Click handler - receives base position */
  onClick?: (basePosition: number) => void;
  /** Tooltip formatter */
  formatTooltip?: (value: number, position: number) => string;
}

interface TrackTooltipState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
}

function CanvasTrackBase({
  label,
  height = 60,
  data,
  loading = false,
  customRender,
  color,
  fillColor,
  showGrid = true,
  showCenterLine = true,
  onClick,
  formatTooltip,
}: CanvasTrackProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const colors = theme.colors;
  const sync = useTrackSync();
  const [tooltip, setTooltip] = useState<TrackTooltipState>({
    visible: false,
    x: 0,
    y: 0,
    text: '',
  });

  // Render the track
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.values.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;

    // Set canvas size with DPI scaling
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Use custom render if provided
    if (customRender) {
      customRender(ctx, data, sync, theme, width, height);
      return;
    }

    // Default line chart rendering
    const { values, windowSize, minValue, maxValue, labels } = data;

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Calculate value range
    let min = minValue ?? Math.min(...values);
    let max = maxValue ?? Math.max(...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const range = max - min;

    // Draw grid
    if (showGrid) {
      ctx.strokeStyle = colors.borderLight;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 2]);

      // Horizontal grid lines
      for (let i = 0; i <= 4; i++) {
        const y = (i / 4) * height;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      ctx.setLineDash([]);
    }

    // Draw center line at zero if range spans zero
    if (showCenterLine && min < 0 && max > 0) {
      const zeroY = height - ((0 - min) / range) * height;
      ctx.strokeStyle = colors.textMuted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(width, zeroY);
      ctx.stroke();
    }

    // Calculate which values are visible
    const { visibleStart, visibleEnd } = sync;
    const startIdx = Math.max(0, Math.floor(visibleStart / windowSize) - 1);
    const endIdx = Math.min(values.length, Math.ceil(visibleEnd / windowSize) + 1);

    // Draw filled area under curve if fill color specified
    if (fillColor) {
      ctx.beginPath();
      const baseY = min < 0 && max > 0
        ? height - ((0 - min) / range) * height
        : height;

      let firstX = true;
      for (let i = startIdx; i < endIdx; i++) {
        const basePos = i * windowSize;
        const x = ((basePos - visibleStart) / (visibleEnd - visibleStart)) * width;
        const normalized = (values[i] - min) / range;
        const y = height - normalized * height;

        if (firstX) {
          ctx.moveTo(x, baseY);
          ctx.lineTo(x, y);
          firstX = false;
        } else {
          ctx.lineTo(x, y);
        }
      }

      // Close the path
      if (!firstX) {
        const lastX = ((endIdx * windowSize - visibleStart) / (visibleEnd - visibleStart)) * width;
        ctx.lineTo(lastX, baseY);
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
      }
    }

    // Draw line
    ctx.beginPath();
    ctx.strokeStyle = color ?? colors.primary;
    ctx.lineWidth = 1.5;

    let firstPoint = true;
    for (let i = startIdx; i < endIdx; i++) {
      const basePos = i * windowSize;
      const x = ((basePos - visibleStart) / (visibleEnd - visibleStart)) * width;
      const normalized = (values[i] - min) / range;
      const y = height - normalized * height;

      if (firstPoint) {
        ctx.moveTo(x, y);
        firstPoint = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Draw labels/markers
    if (labels && labels.length > 0) {
      for (const { position, label: markerLabel, color: markerColor } of labels) {
        if (position < visibleStart || position > visibleEnd) continue;

        const x = ((position - visibleStart) / (visibleEnd - visibleStart)) * width;
        const idx = Math.floor(position / windowSize);
        const value = values[idx] ?? 0;
        const normalized = (value - min) / range;
        const y = height - normalized * height;

        // Draw marker circle
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = markerColor ?? colors.accent;
        ctx.fill();

        // Draw label
        ctx.font = '10px monospace';
        ctx.fillStyle = markerColor ?? colors.accent;
        ctx.textAlign = 'center';
        ctx.fillText(markerLabel, x, y - 8);
      }
    }
  }, [data, sync, theme, colors, height, color, fillColor, showGrid, showCenterLine, customRender]);

  // Re-render when dependencies change
  useEffect(() => {
    render();
  }, [render]);

  // Handle click
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onClick || !data) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const { visibleStart, visibleEnd } = sync;

      // Convert x position to base position
      const basePosition = Math.round(visibleStart + (x / rect.width) * (visibleEnd - visibleStart));
      onClick(basePosition);
    },
    [onClick, data, sync]
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (!formatTooltip || !data) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return;

      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const span = sync.visibleEnd - sync.visibleStart;
      if (span <= 0) return;

      const basePosition = Math.max(
        0,
        Math.round(sync.visibleStart + (x / rect.width) * span)
      );

      const idx = Math.floor(basePosition / data.windowSize);
      const value = data.values[idx];
      if (value == null) {
        setTooltip((prev) => (prev.visible ? { ...prev, visible: false } : prev));
        return;
      }

      const text = formatTooltip(value, basePosition);
      setTooltip((prev) => {
        if (prev.visible && prev.x === x && prev.y === y && prev.text === text) return prev;
        return { visible: true, x, y, text };
      });
    },
    [data, formatTooltip, sync]
  );

  const handleMouseLeave = useCallback(() => {
    setTooltip((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  return (
    <div
      className="canvas-track"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        backgroundColor: colors.background,
        borderBottom: `1px solid ${colors.borderLight}`,
      }}
    >
      {/* Label column */}
      <div
        className="track-label"
        style={{
          width: '80px',
          minWidth: '80px',
          padding: '0.25rem 0.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          fontSize: '0.75rem',
          color: colors.textMuted,
          backgroundColor: colors.backgroundAlt,
          borderRight: `1px solid ${colors.borderLight}`,
        }}
      >
        {label}
      </div>

      {/* Canvas column */}
      <div style={{ flex: 1, position: 'relative' }}>
        {loading ? (
          <div
            style={{
              height,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: colors.textMuted,
              fontSize: '0.8rem',
            }}
          >
            Loading...
          </div>
        ) : !data || data.values.length === 0 ? (
          <div
            style={{
              height,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: colors.textMuted,
              fontSize: '0.8rem',
            }}
          >
            No data
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            onClick={onClick ? handleClick : undefined}
            onMouseMove={formatTooltip ? handleMouseMove : undefined}
            onMouseLeave={formatTooltip ? handleMouseLeave : undefined}
            style={{
              width: '100%',
              height,
              display: 'block',
              cursor: onClick ? 'crosshair' : 'default',
            }}
          />
        )}
        {tooltip.visible && (
          <div
            className="track-tooltip"
            style={{
              position: 'absolute',
              left: tooltip.x + 10,
              top: tooltip.y + 10,
              zIndex: 20,
              pointerEvents: 'none',
              backgroundColor: colors.backgroundAlt,
              color: colors.text,
              border: `1px solid ${colors.border}`,
              borderRadius: '6px',
              padding: '0.25rem 0.5rem',
              fontSize: '0.75rem',
              fontFamily: 'monospace',
              whiteSpace: 'nowrap',
              boxShadow: '0 6px 16px rgba(0,0,0,0.35)',
            }}
          >
            {tooltip.text}
          </div>
        )}
      </div>
    </div>
  );
}

export const CanvasTrack = memo(CanvasTrackBase);
export default CanvasTrack;
