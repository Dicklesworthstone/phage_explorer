/**
 * DotPlotView - Interactive WebGL Dot Plot Component
 *
 * GPU-accelerated visualization for comparing two DNA sequences.
 * Features:
 * - Smooth pan/zoom with mouse and touch gestures
 * - Position tooltip showing sequence coordinates
 * - Configurable similarity threshold and k-mer window size
 */

import React, { useRef, useEffect, useCallback, useState, memo } from 'react';
import { WebGLDotPlotRenderer } from '../visualization/webgl-dotplot';
import { useTheme } from '../hooks/useTheme';

export interface DotPlotViewProps {
  /** First sequence (displayed on X axis) */
  sequenceA: string;
  /** Second sequence (displayed on Y axis) */
  sequenceB: string;
  /** Label for sequence A */
  labelA?: string;
  /** Label for sequence B */
  labelB?: string;
  /** K-mer window size for matching (default: 11) */
  windowSize?: number;
  /** Similarity threshold 0-1 (default: 0.7) */
  threshold?: number;
  /** Callback when position is clicked */
  onClick?: (posA: number, posB: number) => void;
  /** Component height (default: 400) */
  height?: number;
  /** Class name for container */
  className?: string;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  posA: number;
  posB: number;
}

function DotPlotViewBase({
  sequenceA,
  sequenceB,
  labelA = 'Sequence A',
  labelB = 'Sequence B',
  windowSize = 11,
  threshold = 0.7,
  onClick,
  height = 400,
  className = '',
}: DotPlotViewProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGLDotPlotRenderer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const colors = theme.colors;

  // Tooltip state
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    posA: 0,
    posB: 0,
  });

  // Pan/zoom state for gestures
  const dragState = useRef<{
    isDragging: boolean;
    startX: number;
    startY: number;
    startPan: [number, number];
  }>({
    isDragging: false,
    startX: 0,
    startY: 0,
    startPan: [0, 0],
  });

  // Convert theme colors to RGB arrays
  const getMatchColor = useCallback((): [number, number, number] => {
    // Parse hex color to RGB 0-1
    const hex = colors.primary.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return [r, g, b];
  }, [colors.primary]);

  const getBgColor = useCallback((): [number, number, number] => {
    const hex = colors.background.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return [r, g, b];
  }, [colors.background]);

  // Initialize renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      rendererRef.current = new WebGLDotPlotRenderer({
        canvas,
        windowSize,
        threshold,
        matchColor: getMatchColor(),
        bgColor: getBgColor(),
      });

      // Initial resize
      rendererRef.current.resize();
    } catch (err) {
      console.error('Failed to initialize WebGL DotPlot:', err);
    }

    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Update sequences
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    if (sequenceA && sequenceB) {
      renderer.setSequences(sequenceA, sequenceB);
    }
  }, [sequenceA, sequenceB]);

  // Update parameters
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    renderer.setWindowSize(windowSize);
    renderer.setThreshold(threshold);
  }, [windowSize, threshold]);

  // Update theme colors
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setColors(getMatchColor(), getBgColor());
  }, [getMatchColor, getBgColor]);

  // Handle resize
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const handleResize = () => renderer.resize();
    window.addEventListener('resize', handleResize);

    // ResizeObserver for container changes
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
    };
  }, []);

  // Mouse move handler for tooltip
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    const pos = renderer.canvasToSequence(x, y);
    if (pos) {
      setTooltip({
        visible: true,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        posA: pos.posA,
        posB: pos.posB,
      });
    } else {
      setTooltip((prev) => ({ ...prev, visible: false }));
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTooltip((prev) => ({ ...prev, visible: false }));
  }, []);

  // Click handler
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onClick) return;

      const renderer = rendererRef.current;
      const canvas = canvasRef.current;
      if (!renderer || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (canvas.width / rect.width);
      const y = (e.clientY - rect.top) * (canvas.height / rect.height);

      const pos = renderer.canvasToSequence(x, y);
      if (pos) {
        onClick(pos.posA, pos.posB);
      }
    },
    [onClick]
  );

  // Pan gesture handlers
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    dragState.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startPan: renderer.getState().pan as [number, number],
    };
  }, []);

  const handleMouseMovePan = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas || !dragState.current.isDragging) return;

    const dx = (e.clientX - dragState.current.startX) / canvas.clientWidth;
    const dy = (e.clientY - dragState.current.startY) / canvas.clientHeight;
    const state = renderer.getState();

    renderer.setPan(
      dragState.current.startPan[0] - dx / state.zoom,
      dragState.current.startPan[1] + dy / state.zoom // Flip Y
    );
  }, []);

  const handleMouseUp = useCallback(() => {
    dragState.current.isDragging = false;
  }, []);

  // Zoom with wheel
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const renderer = rendererRef.current;
    if (!renderer) return;

    const state = renderer.getState();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    renderer.setZoom(state.zoom * zoomFactor);
  }, []);

  // Touch handlers for mobile
  const touchState = useRef<{
    lastTouchDistance: number | null;
    lastTouchCenter: [number, number] | null;
  }>({
    lastTouchDistance: null,
    lastTouchCenter: null,
  });

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    if (e.touches.length === 1) {
      // Single touch = pan
      dragState.current = {
        isDragging: true,
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startPan: renderer.getState().pan as [number, number],
      };
    } else if (e.touches.length === 2) {
      // Two touches = pinch zoom
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      touchState.current.lastTouchDistance = Math.sqrt(dx * dx + dy * dy);
      touchState.current.lastTouchCenter = [
        (e.touches[0].clientX + e.touches[1].clientX) / 2,
        (e.touches[0].clientY + e.touches[1].clientY) / 2,
      ];
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas) return;

    if (e.touches.length === 1 && dragState.current.isDragging) {
      // Pan
      const dx = (e.touches[0].clientX - dragState.current.startX) / canvas.clientWidth;
      const dy = (e.touches[0].clientY - dragState.current.startY) / canvas.clientHeight;
      const state = renderer.getState();

      renderer.setPan(
        dragState.current.startPan[0] - dx / state.zoom,
        dragState.current.startPan[1] + dy / state.zoom
      );
    } else if (e.touches.length === 2 && touchState.current.lastTouchDistance !== null) {
      // Pinch zoom
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const scale = distance / touchState.current.lastTouchDistance;

      const state = renderer.getState();
      renderer.setZoom(state.zoom * scale);

      touchState.current.lastTouchDistance = distance;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    dragState.current.isDragging = false;
    touchState.current.lastTouchDistance = null;
    touchState.current.lastTouchCenter = null;
  }, []);

  // Reset view button
  const handleResetView = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    renderer.setPan(0, 0);
    renderer.setZoom(1);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`dot-plot-view ${className}`}
      style={{
        position: 'relative',
        backgroundColor: colors.background,
        border: `1px solid ${colors.border}`,
        borderRadius: '0.5rem',
        overflow: 'hidden',
      }}
    >
      {/* Axis labels */}
      <div
        style={{
          position: 'absolute',
          top: '0.5rem',
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: '0.75rem',
          color: colors.textMuted,
          zIndex: 10,
          backgroundColor: `${colors.background}cc`,
          padding: '0.125rem 0.5rem',
          borderRadius: '0.25rem',
        }}
      >
        {labelA} →
      </div>
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '0.5rem',
          transform: 'translateY(-50%) rotate(-90deg)',
          fontSize: '0.75rem',
          color: colors.textMuted,
          zIndex: 10,
          backgroundColor: `${colors.background}cc`,
          padding: '0.125rem 0.5rem',
          borderRadius: '0.25rem',
          transformOrigin: 'left center',
        }}
      >
        {labelB} →
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height,
          display: 'block',
          cursor: dragState.current.isDragging ? 'grabbing' : 'crosshair',
          touchAction: 'none',
        }}
        onMouseMove={(e) => {
          handleMouseMove(e);
          handleMouseMovePan(e);
        }}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />

      {/* Tooltip */}
      {tooltip.visible && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x + 12,
            top: tooltip.y - 30,
            backgroundColor: colors.backgroundAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: '0.25rem',
            padding: '0.25rem 0.5rem',
            fontSize: '0.7rem',
            color: colors.text,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            zIndex: 20,
          }}
        >
          {labelA}: {tooltip.posA.toLocaleString()} bp
          <br />
          {labelB}: {tooltip.posB.toLocaleString()} bp
        </div>
      )}

      {/* Controls */}
      <div
        style={{
          position: 'absolute',
          bottom: '0.5rem',
          right: '0.5rem',
          display: 'flex',
          gap: '0.25rem',
          zIndex: 10,
        }}
      >
        <button
          onClick={handleResetView}
          style={{
            backgroundColor: colors.backgroundAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: '0.25rem',
            padding: '0.25rem 0.5rem',
            fontSize: '0.7rem',
            color: colors.text,
            cursor: 'pointer',
          }}
          title="Reset view"
        >
          Reset
        </button>
      </div>

      {/* Sequence length info */}
      <div
        style={{
          position: 'absolute',
          bottom: '0.5rem',
          left: '0.5rem',
          fontSize: '0.65rem',
          color: colors.textMuted,
          zIndex: 10,
        }}
      >
        {sequenceA?.length?.toLocaleString() ?? 0} × {sequenceB?.length?.toLocaleString() ?? 0} bp
      </div>
    </div>
  );
}

export const DotPlotView = memo(DotPlotViewBase);
export default DotPlotView;
