/**
 * SequenceView Component
 *
 * A canvas-based genome sequence viewer with scroll support.
 * Displays DNA or amino acid sequences with diff highlighting.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { useTheme } from '../hooks/useTheme';
import { useSequenceGrid, useReducedMotion, useHotkeys } from '../hooks';
import { useWebPreferences } from '../store/createWebStore';
import type { ZoomLevel } from '../rendering';

interface SequenceViewProps {
  /** The sequence to display */
  sequence: string;
  /** Optional diff reference sequence */
  diffSequence?: string | null;
  /** Optional per-position diff mask (0=match,1=sub,2=ins,3=del) */
  diffMask?: Uint8Array | null;
  /** Sorted list of diff positions for navigation */
  diffPositions?: number[];
  /** Override diff enabled flag (defaults to store) */
  diffEnabledOverride?: boolean;
  /** Custom class name */
  className?: string;
  /** Height of the canvas */
  height?: number | string;
  /** Expose navigation helpers */
  onControlsReady?: (controls: { jumpToDiff: (direction: 'next' | 'prev') => number | null }) => void;
}

export function SequenceView({
  sequence,
  diffSequence = null,
  diffMask = null,
  diffPositions = [],
  diffEnabledOverride,
  className = '',
  height = 300,
  onControlsReady,
}: SequenceViewProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const reducedMotion = useReducedMotion();
  const [snapToCodon, setSnapToCodon] = useState(true);

  // Store state
  const viewMode = usePhageStore((s) => s.viewMode);
  const readingFrame = usePhageStore((s) => s.readingFrame);
  const setViewMode = usePhageStore((s) => s.setViewMode);
  const setReadingFrame = usePhageStore((s) => s.setReadingFrame);
  const setScrollPosition = usePhageStore((s) => s.setScrollPosition);
  const storeDiffEnabled = usePhageStore((s) => s.diffEnabled);
  const diffEnabled = diffEnabledOverride ?? storeDiffEnabled;

  // Web preferences
  const scanlines = useWebPreferences((s) => s.scanlines);
  const glow = useWebPreferences((s) => s.glow);

  // Sequence grid hook with zoom support
  const {
    canvasRef,
    visibleRange,
    orientation,
    scrollToStart,
    scrollToEnd,
    jumpToDiff,
    getIndexAtPoint,
    scrollToPosition,
    zoomScale,
    zoomPreset,
    zoomIn,
    zoomOut,
    setZoomLevel,
  } = useSequenceGrid({
    theme,
    sequence,
    viewMode,
    readingFrame,
    diffSequence,
    diffEnabled,
    diffMask,
    diffPositions,
    scanlines,
    glow,
    reducedMotion,
    initialZoomScale: 1.0,
    enablePinchZoom: true,
    snapToCodon,
    onVisibleRangeChange: (range) => {
      setScrollPosition(range.startIndex);
    },
  });

  useEffect(() => {
    if (onControlsReady) {
      onControlsReady({ jumpToDiff });
    }
  }, [jumpToDiff, onControlsReady]);

  // Toggle view mode (DNA/AA)
  const toggleViewMode = useCallback(() => {
    setViewMode(viewMode === 'dna' ? 'aa' : 'dna');
  }, [viewMode, setViewMode]);

  // Cycle reading frame
  const cycleReadingFrame = useCallback(() => {
    const frames: Array<0 | 1 | 2 | -1 | -2 | -3> = [0, 1, 2, -1, -2, -3];
    const currentIdx = frames.indexOf(readingFrame as typeof frames[number]);
    const nextIdx = (currentIdx + 1) % frames.length;
    setReadingFrame(frames[nextIdx]);
  }, [readingFrame, setReadingFrame]);

  // Zoom hotkeys handlers
  const handleZoomIn = useCallback(() => zoomIn(), [zoomIn]);
  const handleZoomOut = useCallback(() => zoomOut(), [zoomOut]);

  // Tap/click to jump to position under cursor
  const handleCanvasClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const idx = getIndexAtPoint(x, y);
      if (idx !== null) {
        scrollToPosition(idx);
        setScrollPosition(idx);
      }
    },
    [canvasRef, getIndexAtPoint, scrollToPosition, setScrollPosition]
  );

  // Register hotkeys
  useHotkeys([
    { combo: { key: 'v' }, description: 'Toggle DNA/Amino Acid view', action: toggleViewMode, modes: ['NORMAL'] },
    { combo: { key: 'f' }, description: 'Cycle reading frame', action: cycleReadingFrame, modes: ['NORMAL'] },
    { combo: { key: 'Home' }, description: 'Go to start', action: scrollToStart, modes: ['NORMAL'] },
    { combo: { key: 'End' }, description: 'Go to end', action: scrollToEnd, modes: ['NORMAL'] },
    { combo: { key: '+' }, description: 'Zoom in', action: handleZoomIn, modes: ['NORMAL'] },
    { combo: { key: '=' }, description: 'Zoom in', action: handleZoomIn, modes: ['NORMAL'] },
    { combo: { key: '-' }, description: 'Zoom out', action: handleZoomOut, modes: ['NORMAL'] },
  ]);

  const viewModeLabel = viewMode === 'dna' ? 'DNA' : viewMode === 'aa' ? 'Amino Acids' : 'Dual';
  const frameLabel = readingFrame === 0 ? '+1' : readingFrame > 0 ? `+${readingFrame + 1}` : `${readingFrame}`;
  const zoomLabel = zoomPreset?.label ?? `${Math.round(zoomScale * 100)}%`;
  const descriptionId = 'sequence-view-description';
  const resolvedHeight =
    typeof height === 'number'
      ? height
      : typeof height === 'string'
        ? height
        : orientation === 'portrait'
          ? 360
          : 300;

  return (
    <div
      className={`sequence-view ${className}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${colors.border}`,
        borderRadius: '6px',
        backgroundColor: colors.background,
        overflow: 'hidden',
      }}
      role="region"
      aria-label="Sequence viewer"
      aria-describedby={descriptionId}
      aria-live="polite"
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.4rem 0.75rem',
          borderBottom: `1px solid ${colors.borderLight}`,
        }}
      >
        <span style={{ color: colors.primary, fontWeight: 'bold', fontSize: '0.9rem' }}>
          Sequence
        </span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Zoom controls */}
          <div style={{ display: 'flex', gap: '0.15rem', alignItems: 'center' }}>
            <button
              onClick={() => zoomOut()}
              style={{
                fontSize: '0.8rem',
                padding: '0.1rem 0.3rem',
                borderRadius: '3px 0 0 3px',
                border: `1px solid ${colors.borderLight}`,
                background: colors.backgroundAlt,
                color: colors.text,
                cursor: 'pointer',
                lineHeight: 1,
              }}
              title="Zoom out (-)"
            >
              -
            </button>
            <span
              style={{
                fontSize: '0.7rem',
                padding: '0.1rem 0.25rem',
                background: colors.backgroundAlt,
                color: colors.textMuted,
                borderTop: `1px solid ${colors.borderLight}`,
                borderBottom: `1px solid ${colors.borderLight}`,
                minWidth: '3.5rem',
                textAlign: 'center',
              }}
            >
              {zoomLabel}
            </span>
            <button
              onClick={() => zoomIn()}
              style={{
                fontSize: '0.8rem',
                padding: '0.1rem 0.3rem',
                borderRadius: '0 3px 3px 0',
                border: `1px solid ${colors.borderLight}`,
                background: colors.backgroundAlt,
                color: colors.text,
                cursor: 'pointer',
                lineHeight: 1,
              }}
              title="Zoom in (+)"
            >
              +
            </button>
            <button
              onClick={() => setSnapToCodon((prev) => !prev)}
              style={{
                fontSize: '0.7rem',
                padding: '0.1rem 0.3rem',
                borderRadius: '3px',
                border: `1px solid ${colors.borderLight}`,
                background: snapToCodon ? colors.backgroundAlt : 'transparent',
                color: colors.text,
                cursor: 'pointer',
              }}
              title="Toggle codon snapping"
            >
              snap 3bp
            </button>
            <span style={{ fontSize: '0.7rem', color: colors.textMuted }}>
              {orientation === 'landscape' ? 'landscape' : 'portrait'}
            </span>
          </div>
          {/* View mode badge */}
          <button
            onClick={toggleViewMode}
            style={{
              fontSize: '0.75rem',
              padding: '0.15rem 0.4rem',
              borderRadius: '3px',
              border: `1px solid ${colors.borderLight}`,
              background: viewMode === 'aa' || viewMode === 'dual' ? colors.accent : colors.backgroundAlt,
              color: viewMode === 'aa' || viewMode === 'dual' ? '#000' : colors.text,
              cursor: 'pointer',
            }}
            title="Toggle DNA/Amino Acids/Dual view (v)"
          >
            {viewModeLabel}
          </button>
          {/* Snap toggle */}
          <button
            onClick={() => setSnapToCodon((prev) => !prev)}
            style={{
              fontSize: '0.72rem',
              padding: '0.15rem 0.4rem',
              borderRadius: '3px',
              border: `1px solid ${colors.borderLight}`,
              background: snapToCodon ? colors.backgroundAlt : colors.background,
              color: colors.text,
              cursor: 'pointer',
            }}
            title="Toggle codon snapping"
          >
            Snap {snapToCodon ? 'On' : 'Off'}
          </button>
          {/* Reading frame badge */}
          {viewMode !== 'dna' && (
            <button
              onClick={cycleReadingFrame}
              style={{
                fontSize: '0.75rem',
                padding: '0.15rem 0.4rem',
                borderRadius: '3px',
                border: `1px solid ${colors.borderLight}`,
                background: colors.backgroundAlt,
                color: colors.text,
                cursor: 'pointer',
              }}
              title="Cycle reading frame (f)"
            >
              {frameLabel}
            </button>
          )}
          {/* Position indicator */}
          {visibleRange && (
            <span style={{ fontSize: '0.75rem', color: colors.textMuted }}>
              {visibleRange.startIndex.toLocaleString()} - {visibleRange.endIndex.toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, minHeight: resolvedHeight, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          role="img"
          aria-label="Genome sequence canvas"
          style={{
            width: '100%',
            height: resolvedHeight,
            display: 'block',
          }}
        />
        {/* Empty state */}
        {!sequence && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: colors.textMuted,
            }}
          >
            No sequence loaded
          </div>
        )}
      </div>

      {/* Footer hints */}
      <div
        style={{
          padding: '0.25rem 0.5rem',
          borderTop: `1px solid ${colors.borderLight}`,
          fontSize: '0.7rem',
          color: colors.textMuted,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>
          <kbd style={{ backgroundColor: colors.backgroundAlt, padding: '0 0.2rem', borderRadius: '2px' }}>v</kbd>
          {' view'}
          {viewMode === 'aa' && (
            <>
              {' '}
              <kbd style={{ backgroundColor: colors.backgroundAlt, padding: '0 0.2rem', borderRadius: '2px' }}>f</kbd>
              {' frame'}
            </>
          )}
        </span>
        <span>scroll to navigate</span>
      </div>
      <div id={descriptionId} className="sr-only">
        Sequence view in {viewModeLabel} mode, reading frame {frameLabel}. Showing positions
        {visibleRange ? ` ${visibleRange.startIndex} to ${visibleRange.endIndex}` : ' not loaded yet'}.
        Use v to toggle DNA or amino acid view and f to change frame, Home or End to jump to sequence edges, and scroll to navigate.
      </div>
    </div>
  );
}

export default SequenceView;
