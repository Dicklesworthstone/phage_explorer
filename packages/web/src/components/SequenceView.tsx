/**
 * SequenceView Component
 *
 * A canvas-based genome sequence viewer with scroll support.
 * Displays DNA or amino acid sequences with diff highlighting.
 */

import React, { useCallback, useEffect, useState, useRef } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { translateSequence, reverseComplement, type ViewMode } from '@phage-explorer/core';
import { useTheme } from '../hooks/useTheme';
import { useSequenceGrid, useReducedMotion, useHotkeys } from '../hooks';
import { useWebPreferences } from '../store/createWebStore';
import { AminoAcidHUD } from './AminoAcidHUD';
import type { ZoomLevel } from '../rendering';

type ViewModeOption = {
  id: ViewMode;
  label: string;
  icon: string;
  description: string;
};

const VIEW_MODE_OPTIONS: ViewModeOption[] = [
  { id: 'dna', label: 'DNA', icon: '🧬', description: 'Nucleotide view' },
  { id: 'dual', label: 'Dual', icon: '🔀', description: 'Stacked DNA + AA' },
  { id: 'aa', label: 'Amino Acids', icon: '🔬', description: 'Protein view' },
];

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  colors: ReturnType<typeof useTheme>['theme']['colors'];
}

function ViewModeToggle({ value, onChange, colors }: ViewModeToggleProps): React.ReactElement {
  const styleVars: React.CSSProperties = {
    '--view-toggle-bg': colors.backgroundAlt,
    '--view-toggle-border': colors.borderLight,
    '--view-toggle-active': colors.accent,
    '--view-toggle-text': colors.text,
    '--view-toggle-muted': colors.textMuted,
    '--view-toggle-active-text': '#000',
  } as React.CSSProperties; // Use type assertion for custom properties

  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        const next = VIEW_MODE_OPTIONS[(index + 1) % VIEW_MODE_OPTIONS.length];
        onChange(next.id);
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = VIEW_MODE_OPTIONS[(index - 1 + VIEW_MODE_OPTIONS.length) % VIEW_MODE_OPTIONS.length];
        onChange(prev.id);
        return;
      }
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        onChange(VIEW_MODE_OPTIONS[index].id);
      }
    },
    [onChange]
  );

  return (
    <div className="view-mode-toggle" role="radiogroup" aria-label="Sequence view mode" style={styleVars}>
      {VIEW_MODE_OPTIONS.map((option, idx) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className={`view-mode-segment ${active ? 'active' : ''}`}
            role="radio"
            aria-checked={active}
            aria-label={`${option.label} view`}
            title={`${option.label} view`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => handleKey(event, idx)}
          >
            <span className="view-mode-icon" aria-hidden="true">
              {option.icon}
            </span>
            <span className="view-mode-label">{option.label}</span>
            <span className="view-mode-subtle">{option.description}</span>
          </button>
        );
      })}
    </div>
  );
}

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

  // Amino acid HUD state
  const [hudAminoAcid, setHudAminoAcid] = useState<string | null>(null);
  const [hudPosition, setHudPosition] = useState<{ x: number; y: number } | null>(null);
  const [hudVisible, setHudVisible] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store state
  const viewMode = usePhageStore((s) => s.viewMode);
  const readingFrame = usePhageStore((s) => s.readingFrame);
  const setViewMode = usePhageStore((s) => s.setViewMode);
  const storeToggleViewMode = usePhageStore((s) => s.toggleViewMode);
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
    isMobile,
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

  // Cycle view mode (DNA/AA/Dual)
  const cycleViewMode = useCallback(() => {
    storeToggleViewMode();
  }, [storeToggleViewMode]);

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

  // Get amino acid at a given position (index is already in AA coordinates in AA mode)
  const getAminoAcidAtPosition = useCallback(
    (aaIndex: number): string | null => {
      if (!sequence || viewMode !== 'aa') return null;

      // Handle negative reading frames (reverse complement)
      let seqToTranslate = sequence;
      let frame: 0 | 1 | 2;

      if (readingFrame < 0) {
        // For negative frames: reverse complement and adjust frame
        seqToTranslate = reverseComplement(sequence);
        frame = (Math.abs(readingFrame) - 1) as 0 | 1 | 2;
      } else {
        frame = readingFrame as 0 | 1 | 2;
      }

      // Translate sequence and get the amino acid at this position
      const aaSequence = translateSequence(seqToTranslate, frame);

      // In AA mode, the index from getIndexAtPoint is already the AA index
      if (aaIndex >= 0 && aaIndex < aaSequence.length) {
        return aaSequence[aaIndex];
      }
      return null;
    },
    [sequence, viewMode, readingFrame]
  );

  // Touch start - show HUD after long press
  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLCanvasElement>) => {
      if (viewMode !== 'aa') return; // Only show HUD in amino acid mode
      const touch = event.touches[0];
      const canvas = canvasRef.current;
      if (!canvas || !touch) return;

      const rect = canvas.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;

      // Start long press timer (300ms)
      longPressTimerRef.current = setTimeout(() => {
        const idx = getIndexAtPoint(x, y);
        if (idx !== null) {
          const aa = getAminoAcidAtPosition(idx);
          if (aa && aa !== '*' && aa !== 'X') {
            setHudAminoAcid(aa);
            setHudPosition({ x: touch.clientX, y: touch.clientY });
            setHudVisible(true);
          }
        }
      }, 300);
    },
    [viewMode, canvasRef, getIndexAtPoint, getAminoAcidAtPosition]
  );

  // Touch end - hide HUD
  const handleTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    setHudVisible(false);
  }, []);

  // Touch cancel - hide HUD
  const handleTouchCancel = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    setHudVisible(false);
  }, []);

  // Touch move - cancel if moved too far, update position if HUD visible
  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLCanvasElement>) => {
      if (hudVisible) {
        // Update HUD position while visible
        const touch = event.touches[0];
        if (touch) {
          setHudPosition({ x: touch.clientX, y: touch.clientY });
        }
      } else if (longPressTimerRef.current) {
        // Cancel long press if moved before HUD shown
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    },
    [hudVisible]
  );

  // Context menu (right-click / long-press on desktop) - show HUD
  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (viewMode !== 'aa') return;
      event.preventDefault();

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const idx = getIndexAtPoint(x, y);

      if (idx !== null) {
        const aa = getAminoAcidAtPosition(idx);
        if (aa && aa !== '*' && aa !== 'X') {
          setHudAminoAcid(aa);
          setHudPosition({ x: event.clientX, y: event.clientY });
          setHudVisible(true);
          // Auto-hide after 3 seconds on desktop
          setTimeout(() => setHudVisible(false), 3000);
        }
      }
    },
    [viewMode, canvasRef, getIndexAtPoint, getAminoAcidAtPosition]
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  // Register hotkeys
  useHotkeys([
    { combo: { key: 'v' }, description: 'Cycle DNA / Amino Acid / Dual view', action: cycleViewMode, modes: ['NORMAL'] },
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
        : isMobile
          ? orientation === 'portrait'
            ? '72vh' // taller in portrait to show more bases
            : 'calc(100vh - 140px)' // landscape: nearly full height
          : orientation === 'portrait'
            ? '60vh'
            : '70vh';

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
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <span style={{ color: colors.primary, fontWeight: 'bold', fontSize: '0.9rem' }}>
          Sequence
        </span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* Zoom controls */}
          <div style={{ display: 'flex', gap: '0.15rem', alignItems: 'center' }}>
            <button
              onClick={() => zoomOut()}
              className="btn compact"
              style={{
                fontSize: '1rem',
                padding: '0.4rem 0.8rem',
                minWidth: '36px',
                minHeight: '36px',
                borderRadius: '6px 0 0 6px',
                lineHeight: 1,
              }}
              title="Zoom out (-)"
            >
              -
            </button>
            <span
              style={{
                fontSize: '0.8rem',
                padding: '0.4rem 0.5rem',
                background: colors.backgroundAlt,
                color: colors.textMuted,
                borderTop: `1px solid ${colors.borderLight}`,
                borderBottom: `1px solid ${colors.borderLight}`,
                minWidth: '3.5rem',
                textAlign: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '36px',
              }}
            >
              {zoomLabel}
            </span>
            <button
              onClick={() => zoomIn()}
              className="btn compact"
              style={{
                fontSize: '1rem',
                padding: '0.4rem 0.8rem',
                minWidth: '36px',
                minHeight: '36px',
                borderRadius: '0 6px 6px 0',
                lineHeight: 1,
              }}
              title="Zoom in (+)"
            >
              +
            </button>
            <button
              onClick={() => setSnapToCodon((prev) => !prev)}
              className="btn compact"
              style={{
                fontSize: '0.8rem',
                padding: '0.4rem 0.6rem',
                minHeight: '36px',
                marginLeft: '0.5rem',
                background: snapToCodon ? colors.backgroundAlt : 'transparent',
              }}
              title="Toggle codon snapping"
            >
              snap 3bp
            </button>
            <span style={{ fontSize: '0.75rem', color: colors.textMuted, marginLeft: '0.5rem', display: 'none' }}>
              {orientation === 'landscape' ? 'landscape' : 'portrait'}
            </span>
          </div>
          {/* View mode control */}
          <ViewModeToggle value={viewMode} onChange={setViewMode} colors={colors} />
          {/* Snap toggle (redundant, removing) */}
          
          {/* Reading frame badge */}
          {viewMode !== 'dna' && (
            <button
              onClick={cycleReadingFrame}
              className="btn compact"
              style={{
                fontSize: '0.8rem',
                padding: '0.4rem 0.6rem',
                minHeight: '36px',
              }}
              title="Cycle reading frame (f)"
            >
              Frame {frameLabel}
            </button>
          )}
          {/* Position indicator - hide on mobile to save space if needed, or wrap */}
          {visibleRange && (
            <span style={{ fontSize: '0.75rem', color: colors.textMuted, marginLeft: '4px' }}>
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
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          onTouchMove={handleTouchMove}
          onContextMenu={handleContextMenu}
          role="img"
          aria-label="Genome sequence canvas"
          style={{
            width: '100%',
            height: resolvedHeight,
            display: 'block',
            touchAction: hudVisible ? 'none' : 'pan-y',
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
        <span>
          {viewMode === 'aa' ? 'long-press for info · ' : ''}scroll to navigate
        </span>
      </div>
      <div id={descriptionId} className="sr-only">
        Sequence view in {viewModeLabel} mode, reading frame {frameLabel}. Showing positions
        {visibleRange ? ` ${visibleRange.startIndex} to ${visibleRange.endIndex}` : ' not loaded yet'}.
        Use v to toggle DNA or amino acid view and f to change frame, Home or End to jump to sequence edges, and scroll to navigate.
      </div>

      {/* Amino Acid HUD - shown on long press in AA mode */}
      <AminoAcidHUD
        aminoAcid={hudAminoAcid}
        position={hudPosition}
        visible={hudVisible}
        onClose={() => setHudVisible(false)}
      />
    </div>
  );
}

export default SequenceView;
