/**
 * SequenceView Component
 *
 * A canvas-based genome sequence viewer with scroll support.
 * Displays DNA or amino acid sequences with diff highlighting.
 */

import React, { memo, useCallback, useEffect, useLayoutEffect, useState, useRef, useMemo, useId } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { translateCodon, type ReadingFrame, type ViewMode } from '@phage-explorer/core';
import { useTheme } from '../hooks/useTheme';
import { useSequenceGrid } from '../hooks/useSequenceGrid';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { useHotkeys } from '../hooks/useHotkey';
import { ActionIds } from '../keyboard/actionRegistry';
import {
  allowHeavyFx,
  detectCoarsePointerDevice,
  getEffectiveGlow,
  getEffectiveScanlines,
  useWebPreferences,
} from '../store/createWebStore';
import { PostProcessPipeline } from '../rendering/PostProcessPipeline';
import { AminoAcidHUD } from './AminoAcidHUD';
import { SequenceViewSkeleton } from './ui/Skeleton';
import { IconDna, IconFlask, IconLayers } from './ui/icons';

type ViewModeOption = {
  id: ViewMode;
  label: string;
  shortLabel?: string;
  icon: React.ReactNode;
  description: string;
};

const VIEW_MODE_OPTIONS: ViewModeOption[] = [
  { id: 'dna', label: 'DNA', icon: <IconDna size={18} />, description: 'Nucleotide view' },
  { id: 'dual', label: 'Dual', icon: <IconLayers size={18} />, description: 'DNA + Amino Acids stacked' },
  { id: 'aa', label: 'Amino Acids', shortLabel: 'AA', icon: <IconFlask size={18} />, description: 'Protein view' },
];

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  compactLabels?: boolean;
}

function ViewModeToggle({ value, onChange, compactLabels }: ViewModeToggleProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [indicatorStyle, setIndicatorStyle] = useState<{ x: number; width: number } | null>(null);

  // Shared helper to calculate indicator position
  const updateIndicatorPosition = useCallback(() => {
    const activeIndex = VIEW_MODE_OPTIONS.findIndex(opt => opt.id === value);
    const activeButton = segmentRefs.current[activeIndex];
    const container = containerRef.current;

    if (!activeButton || !container) return;

    const containerRect = container.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    // Read actual padding from computed styles (handles mobile vs desktop)
    const computedPadding = parseFloat(getComputedStyle(container).paddingLeft) || 6;

    setIndicatorStyle({
      x: buttonRect.left - containerRect.left - computedPadding,
      width: buttonRect.width,
    });
  }, [value]);

  // Calculate indicator position when value changes
  useEffect(() => {
    // Use requestAnimationFrame for smooth measurement after render
    const rafId = requestAnimationFrame(updateIndicatorPosition);
    return () => cancelAnimationFrame(rafId);
  }, [updateIndicatorPosition]);

  // Update on resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      updateIndicatorPosition();
    });

    observer.observe(container);
    for (const segment of segmentRefs.current) {
      if (segment) observer.observe(segment);
    }

    return () => observer.disconnect();
  }, [updateIndicatorPosition]);

  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (direction) {
        event.preventDefault();
        const next = (index + direction + VIEW_MODE_OPTIONS.length) % VIEW_MODE_OPTIONS.length;
        onChange(VIEW_MODE_OPTIONS[next].id);
        segmentRefs.current[next]?.focus();
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
    <div
      ref={containerRef}
      className={`view-mode-toggle ${indicatorStyle ? 'has-indicator' : ''}`}
      role="radiogroup"
      data-arrow-navigation
      aria-label="Sequence view mode"
      style={indicatorStyle ? {
        '--indicator-x': `${indicatorStyle.x}px`,
        '--indicator-width': `${indicatorStyle.width}px`,
      } as React.CSSProperties : undefined}
    >
      {/* Sliding indicator - positioned absolutely behind active segment */}
      {indicatorStyle && (
        <div className="view-mode-indicator" aria-hidden="true" />
      )}
      {VIEW_MODE_OPTIONS.map((option, idx) => {
        const active = value === option.id;
        const displayLabel = compactLabels && option.shortLabel ? option.shortLabel : option.label;
        return (
          <button
            key={option.id}
            ref={el => { segmentRefs.current[idx] = el; }}
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
            <span className="view-mode-label">{displayLabel}</span>
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
  /** Own the viewport without reading or writing the main explorer navigation. */
  isolated?: boolean;
  /** Custom class name */
  className?: string;
  /** Height of the canvas */
  height?: number | string;
  /** Expose navigation helpers */
  onControlsReady?: (controls: { jumpToDiff: (direction: 'next' | 'prev') => number | null }) => void;
}

const TEXT_PASSAGE_LENGTH = 60;

function SequenceTextReader({ displaySequence, aminoSequence, viewMode, readingFrame, frameLabel, gridStart }: {
  displaySequence: string; aminoSequence: string | null; viewMode: ViewMode;
  readingFrame: ReadingFrame; frameLabel: string; gridStart: number;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<number | null>(null);
  const [jump, setJump] = useState('');
  const panelId = useId();
  const rangeId = useId();
  useEffect(() => {
    setIndex(null);
    setJump('');
  }, [displaySequence, viewMode, readingFrame]);

  const length = displaySequence.length;
  const start = Math.max(0, Math.min(length - 1, index ?? gridStart));
  const end = Math.min(length, start + TEXT_PASSAGE_LENGTH);
  const aminoOnly = viewMode === 'aa';
  const units = aminoOnly ? 'Amino acid' : 'DNA';
  let dualText = '';
  if (open && viewMode === 'dual' && aminoSequence) {
    // Select the already translated cells overlapping this DNA passage. In a
    // negative frame the canvas places the last translated residue on the left.
    const reverse = readingFrame < 0;
    const offset = reverse ? (length - (Math.abs(readingFrame) - 1)) % 3 : readingFrame;
    const count = aminoSequence.length;
    const first = Math.min(count, Math.max(0, Math.floor((start - offset) / 3)));
    const afterLast = Math.min(count, Math.max(0, Math.ceil((end - offset) / 3)));
    dualText = reverse
      ? aminoSequence.slice(count - afterLast, count - first).split('').reverse().join('')
      : aminoSequence.slice(first, afterLast);
  }

  return <div className="sequence-text-reader">
    <button type="button" className="btn compact" aria-expanded={open} aria-controls={panelId}
      onClick={() => { setOpen(!open); setIndex(null); setJump(''); }}>Read sequence as text</button>
    <div id={panelId} hidden={!open}>
      {open && (length === 0 ? <p role="status">No {aminoOnly ? 'amino acids' : 'sequence characters'} to display.</p> : <>
        <p id={rangeId} role="status" aria-atomic="true">
          {units} indices {start} through {end - 1} of {length.toLocaleString()} {aminoOnly ? 'residues' : 'bases'}
          {viewMode !== 'dna' && `, frame ${frameLabel}`}. Indices start at 0.
        </p>
        <label>{aminoOnly ? 'Amino acid sequence' : 'DNA sequence'}
          <textarea readOnly spellCheck={false} rows={2} aria-describedby={rangeId}
            value={displaySequence.slice(start, end)} />
        </label>
        {viewMode === 'dual' && (dualText ? <label>Amino acids overlapping this passage
          <textarea readOnly spellCheck={false} rows={1} aria-describedby={rangeId} value={dualText} />
        </label> : <p>No complete codon overlaps this passage in frame {frameLabel}.</p>)}
        <div className="sequence-text-reader__actions">
          <button type="button" className="btn compact" aria-disabled={start === 0}
            onClick={() => { if (start > 0) setIndex(Math.max(0, start - TEXT_PASSAGE_LENGTH)); }}>Previous passage</button>
          <button type="button" className="btn compact" aria-disabled={end >= length}
            onClick={() => { if (end < length) setIndex(end); }}>Next passage</button>
          <button type="button" className="btn compact" aria-disabled={index === null}
            onClick={() => setIndex(null)}>Follow grid position</button>
        </div>
        <form className="sequence-view__jump-form" onSubmit={event => {
          event.preventDefault();
          const target = Number(jump);
          if (jump.trim() && Number.isSafeInteger(target) && target >= 0 && target < length) setIndex(target);
        }}>
          <label>Start index <input className="sequence-view__jump-input" type="number" min={0} max={length - 1}
            step={1} required value={jump} onChange={event => setJump(event.target.value)} /></label>
          <button type="submit" className="btn compact">Read from index</button>
        </form>
      </>)}
    </div>
  </div>;
}

/**
 * Detect if the browser supports dvh (dynamic viewport height) units.
 * Falls back to vh on older browsers (pre Safari 15.4, etc).
 */
function useDvhSupport(): boolean {
  const [supported, setSupported] = useState(() => {
    if (typeof window === 'undefined' || typeof CSS === 'undefined') return false;
    // Check if CSS.supports is available and dvh is recognized
    try {
      return CSS.supports('height', '1dvh');
    } catch {
      return false;
    }
  });

  useEffect(() => {
    // Re-check on mount in case SSR detection was wrong
    if (typeof CSS !== 'undefined') {
      try {
        setSupported(CSS.supports('height', '1dvh'));
      } catch {
        setSupported(false);
      }
    }
  }, []);

  return supported;
}

function SequenceViewBase({
  sequence,
  diffSequence = null,
  diffMask = null,
  diffPositions = [],
  diffEnabledOverride,
  isolated = false,
  className = '',
  height, // undefined = use internal responsive calculation
  onControlsReady,
}: SequenceViewProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const reducedMotion = useReducedMotion();
  const supportsDvh = useDvhSupport();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const normalizedHeight = useMemo(() => {
    if (typeof height === 'string' && !supportsDvh && height.includes('dvh')) {
      // Older iOS Safari treats dvh as invalid, which can collapse the canvas height to 0.
      return height.replace(/dvh/g, 'vh');
    }
    return height;
  }, [height, supportsDvh]);
  const [snapToCodon, setSnapToCodon] = useState(true);
  const defaultDensity: 'compact' | 'standard' =
    typeof window !== 'undefined' && window.innerWidth < 1024 ? 'compact' : 'standard';
  const [densityMode, setDensityMode] = useState<'compact' | 'standard'>(defaultDensity);
  const [jumpInput, setJumpInput] = useState<string>('');
  const instanceId = useId();

  // Loading state for skeleton - show skeleton on initial mount until sequence arrives or timeout
  const [showLoadingSkeleton, setShowLoadingSkeleton] = useState(!sequence);

  // Amino acid HUD state
  const [hudAminoAcid, setHudAminoAcid] = useState<string | null>(null);
  const [hudPosition, setHudPosition] = useState<{ x: number; y: number } | null>(null);
  const [hudVisible, setHudVisible] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const hudHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store state
  const explorerViewMode = usePhageStore((s) => s.viewMode);
  const explorerReadingFrame = usePhageStore((s) => s.readingFrame);
  const explorerScrollPosition = usePhageStore((s) => s.scrollPosition);
  const explorerZoomScale = usePhageStore((s) => s.zoomScale);
  const setExplorerViewMode = usePhageStore((s) => s.setViewMode);
  const storeToggleViewMode = usePhageStore((s) => s.toggleViewMode);
  const setExplorerReadingFrame = usePhageStore((s) => s.setReadingFrame);
  const setExplorerScrollPosition = usePhageStore((s) => s.setScrollPosition);
  const setExplorerZoomScale = usePhageStore((s) => s.setZoomScale);
  const storeDiffEnabled = usePhageStore((s) => s.diffEnabled);
  const diffEnabled = diffEnabledOverride ?? storeDiffEnabled;
  const [localViewMode, setLocalViewMode] = useState<ViewMode>('dna');
  const [localReadingFrame, setLocalReadingFrame] = useState<ReadingFrame>(0);
  const [localScrollPosition, setLocalScrollPosition] = useState(0);
  const [localZoomScale, setLocalZoomScale] = useState<number | null>(null);
  const viewMode = isolated ? localViewMode : explorerViewMode;
  const readingFrame = isolated ? localReadingFrame : explorerReadingFrame;
  // All renderer callbacks and direct jump controls share these setters. An
  // imported comparison can have unrelated coordinates, even with matching IDs.
  const storeScrollPosition = isolated ? localScrollPosition : explorerScrollPosition;
  const storeZoomScale = isolated ? localZoomScale : explorerZoomScale;
  const setScrollPosition = isolated ? setLocalScrollPosition : setExplorerScrollPosition;
  const setStoreZoomScale = isolated ? setLocalZoomScale : setExplorerZoomScale;
  const setReadingFrame = isolated ? setLocalReadingFrame : setExplorerReadingFrame;
  const setViewMode = useCallback((mode: ViewMode) => {
    if (isolated) { setLocalViewMode(mode); setLocalScrollPosition(0); }
    else setExplorerViewMode(mode);
  }, [isolated, setExplorerViewMode]);

  // Web preferences
  const scanlines = useWebPreferences((s) => s.scanlines);
  const scanlineIntensity = useWebPreferences((s) => s.scanlineIntensity);
  const glow = useWebPreferences((s) => s.glow);

  const coarsePointer = useMemo(() => detectCoarsePointerDevice(), []);
  const crtConstraints = useMemo(
    () => ({ reducedMotion, coarsePointer }),
    [coarsePointer, reducedMotion]
  );
  const allowCrtFx = allowHeavyFx(crtConstraints);
  const effectiveScanlines = getEffectiveScanlines(scanlines, crtConstraints);
  const effectiveGlow = getEffectiveGlow(glow, crtConstraints);

  // Create PostProcessPipeline for WebGL2 CRT effects
  const postProcess = useMemo(() => {
    if (!allowCrtFx || (!effectiveScanlines && !effectiveGlow)) return undefined;
    return new PostProcessPipeline({
      reducedMotion,
      enableScanlines: effectiveScanlines,
      enableBloom: effectiveGlow,
      enableChromaticAberration: effectiveScanlines,
      scanlineIntensity: scanlineIntensity,
      bloomIntensity: effectiveGlow ? 0.4 : 0,
      aberrationOffset: effectiveScanlines ? 1.5 : 0,
    });
  }, [allowCrtFx, effectiveGlow, effectiveScanlines, reducedMotion, scanlineIntensity]);

  const postProcessOptions = useMemo(
    () => ({
      reducedMotion,
      enableScanlines: effectiveScanlines,
      enableBloom: effectiveGlow,
      enableChromaticAberration: effectiveScanlines,
      scanlineIntensity,
      bloomIntensity: effectiveGlow ? 0.4 : 0,
      aberrationOffset: effectiveScanlines ? 1.5 : 0,
    }),
    [effectiveGlow, effectiveScanlines, reducedMotion, scanlineIntensity]
  );

  // Update pipeline options when preferences change
  useEffect(() => {
    if (postProcess) {
      postProcess.updateOptions({
        enableScanlines: effectiveScanlines,
        enableBloom: effectiveGlow,
        enableChromaticAberration: effectiveScanlines,
        scanlineIntensity: scanlineIntensity,
        bloomIntensity: effectiveGlow ? 0.4 : 0,
      });
    }
  }, [effectiveGlow, effectiveScanlines, postProcess, scanlineIntensity]);

  // Track the last scroll position WE set (from user scrolling).
  // This distinguishes our updates from truly external changes (gene map clicks).
  const lastScrollWeSetRef = useRef<number | null>(null);

  // Stable callbacks to avoid renderer recreation on every render.
  // CRITICAL: Inline functions in useSequenceGrid options cause the renderer
  // to be destroyed and recreated on every React render, breaking scrolling.
  const handleVisibleRangeChange = useCallback(
    (range: { startIndex: number }) => {
      // Mark this as our own update BEFORE setting store
      lastScrollWeSetRef.current = range.startIndex;
      setScrollPosition(range.startIndex);
    },
    [setScrollPosition]
  );

  // Track the last zoom scale WE set (from user pinch/zoom).
  const lastZoomWeSetRef = useRef<number | null>(null);

  const handleZoomChange = useCallback(
    (scale: number) => {
      lastZoomWeSetRef.current = scale;
      setStoreZoomScale(scale);
    },
    [setStoreZoomScale]
  );

  // Sequence grid hook with zoom support
  const {
    canvasRef,
    displaySequence,
    aminoSequence,
    visibleRange,
	    handleWheelDelta,
	    orientation,
	    isMobile,
	    scrollToStart,
	    scrollToEnd,
	    jumpToDiff,
    getIndexAtPoint,
    scrollToPosition,
    zoomScale,
    zoomPreset,
    setZoomScale: setRendererZoomScale,
    zoomIn,
    zoomOut,
    rendererBackend,
  } = useSequenceGrid({
    theme,
    sequence,
    viewMode,
    readingFrame,
    diffSequence,
    diffEnabled,
    diffMask,
    diffPositions,
    scanlines: effectiveScanlines,
    glow: effectiveGlow,
    postProcess,
    postProcessOptions,
    reducedMotion,
    enablePinchZoom: true,
    snapToCodon,
    // Let the renderer pick a mobile-aware default zoom when the store has not yet set one.
    initialZoomScale: storeZoomScale ?? undefined,
    initialPosition: storeScrollPosition > 0 ? storeScrollPosition : undefined,
    densityMode,
    onVisibleRangeChange: handleVisibleRangeChange,
    onZoomChange: handleZoomChange,
  });

  useEffect(() => {
    if (!isolated) return;
    lastScrollWeSetRef.current = 0;
    setLocalScrollPosition(0);
    scrollToStart();
  }, [isolated, sequence, diffSequence, scrollToStart]);

  const latestVisibleRangeRef = useRef(visibleRange);

  const displaySequenceLength = useMemo(() => {
    const len = sequence?.length ?? 0;
    if (!len) return 0;
    if (viewMode !== 'aa') return len;
    const frameOffset = (readingFrame < 0 ? Math.abs(readingFrame) - 1 : readingFrame) as 0 | 1 | 2;
    return Math.max(0, Math.floor((len - frameOffset) / 3));
  }, [sequence, viewMode, readingFrame]);

  const sequenceLengthRef = useRef(displaySequenceLength);

  useLayoutEffect(() => {
    latestVisibleRangeRef.current = visibleRange;
    sequenceLengthRef.current = displaySequenceLength;
  });

  // Desktop wheel/trackpad scroll: attach ONLY to the canvas wrapper so page scroll
  // works when pointer is over header controls. This fixes mousewheel page scroll.
  useLayoutEffect(() => {
    const wrapper = canvasWrapperRef.current;
    if (!wrapper) return;

    const onWheel = (event: WheelEvent) => {
      // Allow browser pinch-to-zoom (trackpad) and page scroll while loading.
      if (event.ctrlKey) return;
      const visibleRangeLatest = latestVisibleRangeRef.current;
      const totalLength = sequenceLengthRef.current;
      if (!totalLength) return;

      const deltaY = event.deltaY;

      // If visibleRange hasn't committed to React state yet (common right after mount),
      // still forward wheel deltas to the renderer so the *first* scroll attempt works.
      // Without this, the wheel event does nothing and the UI feels "stuck" on first load.
      if (!visibleRangeLatest) {
        event.preventDefault();
        handleWheelDelta(event.deltaX, event.deltaY, event.deltaMode as 0 | 1 | 2);
        return;
      }
      const atTop = visibleRangeLatest.startIndex <= 0;
      const atEnd = visibleRangeLatest.endIndex >= totalLength;

      if ((deltaY < 0 && atTop) || (deltaY > 0 && atEnd)) {
        return;
      }

      event.preventDefault();
      handleWheelDelta(event.deltaX, event.deltaY, event.deltaMode as 0 | 1 | 2);
    };

    wrapper.addEventListener('wheel', onWheel, { passive: false });
    return () => wrapper.removeEventListener('wheel', onWheel);
  }, [handleWheelDelta]);

  // Keep the renderer in sync when OTHER UI components set scrollPosition
  // (e.g. gene map clicks, collaboration state sync).
  //
  // CRITICAL: We must distinguish between:
  //   1. OUR updates (from user scrolling via handleVisibleRangeChange) - SKIP these
  //   2. EXTERNAL updates (gene map clicks, collaboration) - APPLY these
  //
  // We track what we set in lastScrollWeSetRef. If the store value matches what
  // we just set, it's our own update and we skip. Otherwise, it's external and
  // we scroll to that position (without centering, since we want top-alignment).
  //
  // FIX: Don't sync scroll on initial load before renderer is ready. Wait until
  // we have a valid visibleRange (renderer has processed the sequence) before
  // attempting external scroll syncs. This prevents the "stuck scroll" bug.
  useEffect(() => {
    if (typeof storeScrollPosition !== 'number' || !Number.isFinite(storeScrollPosition)) return;
    // Skip if this is our own update from normal scrolling
    if (lastScrollWeSetRef.current === storeScrollPosition) return;
    // Skip if renderer hasn't processed sequence yet (prevents stuck scroll on first load)
    if (!visibleRange) return;
    // This is an external update - scroll to it WITHOUT centering for consistency.
    // Gene map clicks that WANT centering should call scrollToPosition directly via ref.
    scrollToPosition(storeScrollPosition, false);
  }, [storeScrollPosition, scrollToPosition, visibleRange]);

  // Sync zoom from external sources (collaboration, presets) to renderer.
  // Skip our own updates by checking lastZoomWeSetRef.
  useEffect(() => {
    if (storeZoomScale === null) {
      setStoreZoomScale(zoomScale);
      return;
    }

    if (!Number.isFinite(storeZoomScale)) return;
    // Skip if this is our own update
    if (lastZoomWeSetRef.current !== null && Math.abs(lastZoomWeSetRef.current - storeZoomScale) < 1e-4) return;
    // Apply external zoom change
    setRendererZoomScale(storeZoomScale);
  }, [storeZoomScale, zoomScale, setRendererZoomScale, setStoreZoomScale]);

  // Auto-compact for landscape mobile unless user overrode
  useEffect(() => {
    const next = isMobile && orientation === 'landscape' ? 'compact' : defaultDensity;
    if (next !== densityMode) {
      setDensityMode(next);
    }
  }, [isMobile, orientation, defaultDensity, densityMode]);

  // Manage skeleton loading state - hide when sequence arrives or after timeout
  useEffect(() => {
    if (sequence) {
      // Sequence loaded - hide skeleton immediately
      setShowLoadingSkeleton(false);
    } else {
      // No sequence - show skeleton for max 2 seconds then show empty state
      const timer = setTimeout(() => setShowLoadingSkeleton(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [sequence]);

  useEffect(() => {
    if (onControlsReady) {
      onControlsReady({ jumpToDiff });
    }
  }, [jumpToDiff, onControlsReady]);

  // Cycle view mode (DNA/AA/Dual)
  const cycleViewMode = useCallback(() => {
    if (!isolated) { storeToggleViewMode(); return; }
    const next = viewMode === 'dna' ? 'aa' : viewMode === 'aa' ? 'dual' : 'dna';
    setLocalScrollPosition(position => viewMode === 'dna' && next === 'aa' ? Math.floor(position / 3)
      : viewMode === 'aa' ? position * 3 : position);
    setLocalViewMode(next);
  }, [isolated, viewMode, storeToggleViewMode]);

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

      const frameOffset = (readingFrame < 0 ? Math.abs(readingFrame) - 1 : readingFrame) as 0 | 1 | 2;
      const aaLength = Math.max(0, Math.floor((sequence.length - frameOffset) / 3));
      if (aaIndex < 0 || aaIndex >= aaLength) return null;

      // In AA mode we reverse the display for negative frames, so the *display index*
      // runs left-to-right along the forward genome. Map back to the reverse-complement
      // translation index before computing codons.
      const translationIndex = readingFrame < 0 ? aaLength - 1 - aaIndex : aaIndex;
      const codonStart = frameOffset + translationIndex * 3;

      if (readingFrame >= 0) {
        if (codonStart + 3 > sequence.length) return null;
        return translateCodon(sequence.slice(codonStart, codonStart + 3));
      }

      // Negative frames: translate codon on the reverse complement without allocating a full RC string.
      // reverseComplement[i] = complement(sequence[len - 1 - i])
      const complementBase = (base: string): string => {
        switch (base.toUpperCase()) {
          case 'A':
            return 'T';
          case 'T':
            return 'A';
          case 'G':
            return 'C';
          case 'C':
            return 'G';
          case 'N':
            return 'N';
          case 'R':
            return 'Y';
          case 'Y':
            return 'R';
          case 'S':
            return 'S';
          case 'W':
            return 'W';
          case 'K':
            return 'M';
          case 'M':
            return 'K';
          case 'B':
            return 'V';
          case 'V':
            return 'B';
          case 'D':
            return 'H';
          case 'H':
            return 'D';
          default:
            return 'N';
        }
      };

      const len = sequence.length;
      const o0 = len - 1 - codonStart;
      const o1 = len - 2 - codonStart;
      const o2 = len - 3 - codonStart;
      if (o2 < 0 || o0 >= len) return null;

      const codon = `${complementBase(sequence[o0])}${complementBase(sequence[o1])}${complementBase(sequence[o2])}`;
      return translateCodon(codon);
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
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };

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
    touchStartRef.current = null;
    setHudVisible(false);
  }, []);

  // Touch cancel - hide HUD
  const handleTouchCancel = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    touchStartRef.current = null;
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
        const touch = event.touches[0];
        const start = touchStartRef.current;
        if (!touch || !start) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        // 22px threshold accounts for finger jitter and prevents accidental cancellation
        if (dx * dx + dy * dy > 22 * 22) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
          touchStartRef.current = null;
        }
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
          if (hudHideTimerRef.current) {
            clearTimeout(hudHideTimerRef.current);
          }
          hudHideTimerRef.current = setTimeout(() => setHudVisible(false), 3000);
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
      if (hudHideTimerRef.current) {
        clearTimeout(hudHideTimerRef.current);
      }
    };
  }, []);

  // Register hotkeys
  const hotkeys = useMemo(() => ([
    { actionId: ActionIds.ViewCycleMode, action: cycleViewMode, modes: ['NORMAL'] as const, priority: isolated ? 3 : 2 },
    { actionId: ActionIds.ViewCycleReadingFrame, action: cycleReadingFrame, modes: ['NORMAL'] as const, priority: isolated ? 3 : 2 },
    { actionId: ActionIds.ViewScrollStart, action: scrollToStart, modes: ['NORMAL'] as const, priority: isolated ? 3 : 2 },
    { actionId: ActionIds.ViewScrollEnd, action: scrollToEnd, modes: ['NORMAL'] as const, priority: isolated ? 3 : 2 },
    { actionId: ActionIds.ViewZoomIn, action: handleZoomIn, modes: ['NORMAL'] as const, priority: isolated ? 3 : 2 },
    { actionId: ActionIds.ViewZoomOut, action: handleZoomOut, modes: ['NORMAL'] as const, priority: isolated ? 3 : 2 },
  ]), [isolated, cycleReadingFrame, cycleViewMode, handleZoomIn, handleZoomOut, scrollToEnd, scrollToStart]);

  useHotkeys(hotkeys);

  const frameLabel = readingFrame === 0 ? '+1' : readingFrame > 0 ? `+${readingFrame + 1}` : `${readingFrame}`;
  const zoomLabel = zoomPreset?.label ?? `${Math.round(zoomScale * 100)}%`;
  const seqLength = displaySequenceLength;
  const visibleStart = visibleRange?.startIndex ?? 0;
  const visibleEnd = visibleRange?.endIndex ?? Math.min(seqLength, visibleStart + 1);
  const visiblePercent = seqLength ? Math.round((visibleStart / seqLength) * 100) : 0;
  const descriptionId = isolated ? `sequence-view-description-${instanceId}` : 'sequence-view-description';
  const jumpId = isolated ? `sequence-view-jump-${instanceId}` : 'sequence-view-jump';
  // Use dvh (dynamic viewport height) when supported, fallback to vh for older browsers.
  // dvh accounts for mobile browser chrome (address bar), vh does not.
  const vhUnit = supportsDvh ? 'dvh' : 'vh';
  // On mobile, subtract the control deck height to prevent canvas from extending under
  // the fixed tab bar and capturing touch events meant for navigation.
  // Portrait: 56px tab bar, Landscape: 48px tab bar (matches control-deck.css)
  const mobileTabBarHeightPortrait = 'calc(56px + env(safe-area-inset-bottom, 0px))';
  const mobileTabBarHeightLandscape = 'calc(48px + env(safe-area-inset-bottom, 0px))';
  const resolvedHeight =
    typeof normalizedHeight === 'number'
      ? normalizedHeight
      : typeof normalizedHeight === 'string'
        ? normalizedHeight
        : isMobile
          ? orientation === 'portrait'
            ? `calc(65${vhUnit} - ${mobileTabBarHeightPortrait})` // Account for control deck
            : `calc(85${vhUnit} - ${mobileTabBarHeightLandscape})` // landscape: smaller tab bar
          : orientation === 'portrait'
            ? `60${vhUnit}`
            : `70${vhUnit}`;

  return (
    <div
      ref={containerRef}
      className={`sequence-view lenis-prevent ${className}`}
      data-lenis-prevent
      role="region"
      aria-label="Sequence viewer"
      aria-describedby={descriptionId}
    >
      <p id={descriptionId} className="sr-only">
        Use Read sequence as text to read and page through the letters. Use the controls to change view mode, reading frame, and zoom. Use the position bar or jump input to navigate.
        Use scroll or touch gestures to navigate the sequence.
      </p>
      {/* Header */}
      <div className="sequence-view__header">
        <span className="sequence-view__title">Sequence</span>
        <div className="sequence-view__controls">
          {/* Zoom controls */}
          <div className="sequence-view__zoom">
            <button
              type="button"
              onClick={() => zoomOut()}
              className="btn compact sequence-view__zoom-btn"
              title="Zoom out (-)"
              aria-label="Zoom out"
            >
              -
            </button>
            <span className="sequence-view__zoom-label">
              {zoomLabel}
            </span>
            <button
              type="button"
              onClick={() => zoomIn()}
              className="btn compact sequence-view__zoom-btn"
              title="Zoom in (+)"
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setSnapToCodon((prev) => !prev)}
              className={`btn compact sequence-view__snap-btn ${snapToCodon ? 'is-active' : ''}`}
              title="Toggle codon snapping"
              aria-label="Toggle codon snapping"
              aria-pressed={snapToCodon}
            >
              Snap 3bp
            </button>
            <span className="sequence-view__orientation">
              {orientation === 'landscape' ? 'landscape' : 'portrait'}
            </span>
          </div>

          {/* View mode control */}
          <ViewModeToggle
            value={viewMode}
            onChange={setViewMode}
            compactLabels={isMobile && typeof window !== 'undefined' && window.innerWidth <= 640}
          />
          {/* Reading frame badge */}
          {viewMode !== 'dna' && (
            <button
              type="button"
              onClick={cycleReadingFrame}
              className="btn compact sequence-view__frame-btn"
              title="Cycle reading frame (f)"
              aria-label={`Cycle reading frame, currently ${frameLabel}`}
            >
              Frame {frameLabel}
            </button>
          )}
          {/* Position indicator - hide on mobile to save space if needed, or wrap */}
          {visibleRange && (
            <span className="sequence-view__range">
              {visibleRange.startIndex.toLocaleString()} - {Math.max(0, visibleRange.endIndex - 1).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Canvas */}
      <SequenceTextReader displaySequence={displaySequence} aminoSequence={aminoSequence}
        viewMode={viewMode} readingFrame={readingFrame} frameLabel={frameLabel} gridStart={visibleStart} />
      <div ref={canvasWrapperRef} style={{ flex: 1, minHeight: resolvedHeight, position: 'relative' }}>
        <canvas
          key={rendererBackend}
          ref={canvasRef}
          onClick={handleCanvasClick}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          onTouchMove={handleTouchMove}
          onContextMenu={handleContextMenu}
          role="img"
          aria-label="Genome sequence canvas"
          aria-describedby={descriptionId}
          className="sequence-grid-canvas"
          style={{
            width: '100%',
            height: resolvedHeight,
            display: 'block',
            // Allow page scroll until the renderer has processed the sequence and is ready for touch input.
            // We need BOTH sequence AND visibleRange to be truthy:
            // - sequence: indicates data is available
            // - visibleRange: indicates the renderer has processed it and touch handlers will work
            // Without this check, touchAction:'none' blocks native scroll before our handlers are ready,
            // causing the "stuck scroll on first load" bug on mobile.
            touchAction: sequence && visibleRange ? 'none' : 'auto',
            backgroundColor: colors.background, // Prevent black flash during scroll
          }}
        />
        {/* Loading skeleton state */}
        {!sequence && showLoadingSkeleton && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              padding: '1rem',
              background: colors.background,
            }}
            aria-busy="true"
            aria-label="Loading sequence data"
          >
            <SequenceViewSkeleton rows={4} />
          </div>
        )}
        {/* Empty state (after loading timeout) */}
        {!sequence && !showLoadingSkeleton && (
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

      {/* Navigator + jump */}
      <div
        style={{
          padding: '0.35rem 0.75rem 0.6rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.45rem',
          borderTop: `1px solid ${colors.borderLight}`,
        }}
      >
        <div
          style={{
            height: '12px',
            background: colors.backgroundAlt,
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '8px',
            position: 'relative',
            cursor: 'pointer',
            overflow: 'hidden',
          }}
          title="Tap or click to jump"
          onClick={(e) => {
            if (!seqLength) return;
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const pct = x / rect.width;
            const target = Math.floor(seqLength * pct);
            scrollToPosition(target);
            setScrollPosition(target);
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '0',
              top: 0,
              bottom: 0,
              width: `${visiblePercent}%`,
              background: colors.primary + '44',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: `${visiblePercent}%`,
              top: 0,
              bottom: 0,
              width: `${seqLength ? ((visibleEnd - visibleStart) / seqLength) * 100 : 0}%`,
              background: colors.accent + '88',
            }}
          />
        </div>

        <div className="sequence-view__jump-row">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!seqLength) return;
              const raw = jumpInput.trim();
              if (!raw) return;
              let target = 0;
              if (raw.endsWith('%')) {
                const pct = parseFloat(raw.slice(0, -1));
                if (!Number.isNaN(pct)) target = Math.floor((pct / 100) * seqLength);
              } else {
                const n = parseInt(raw, 10);
                if (!Number.isNaN(n)) target = n;
              }
              target = Math.max(0, Math.min(seqLength - 1, target));
              scrollToPosition(target);
              setScrollPosition(target);
            }}
            className="sequence-view__jump-form"
          >
            <label htmlFor={jumpId} className="sr-only">
              Jump to sequence position (index or percent)
            </label>
            <input
              id={jumpId}
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)}
              placeholder="Jump (idx or %)"
              className="sequence-view__jump-input"
            />
            <button
              type="submit"
              className="btn compact sequence-view__jump-btn"
              aria-label="Go to jumped position"
            >
              Go
            </button>
            <span className="sequence-view__jump-status">
              Pos: {visibleStart.toLocaleString()}/{seqLength.toLocaleString()} ({visiblePercent}%)
            </span>
          </form>
        </div>
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
      {/* Amino Acid HUD - shown on long press in AA mode */}
      <AminoAcidHUD
        aminoAcid={hudAminoAcid}
        position={hudPosition}
        visible={hudVisible}
        onClose={() => setHudVisible(false)}
      />

      {/* Mobile sticky badge for scroll progress */}
      {isMobile && seqLength > 0 && (
        <div
          style={{
            position: 'fixed',
            right: 'calc(12px + env(safe-area-inset-right, 0px))',
            bottom:
              'calc(var(--mobile-tab-bar-height, 56px) + env(safe-area-inset-bottom, 0px) + 12px)',
            zIndex: 20,
            background: colors.backgroundAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: '999px',
            padding: '6px 10px',
            fontSize: '0.8rem',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          {visibleStart.toLocaleString()} / {seqLength.toLocaleString()} ({visiblePercent}%)
        </div>
      )}
    </div>
  );
}

// Memoize to prevent re-renders when parent updates but props haven't changed
export const SequenceView = memo(SequenceViewBase);
export default SequenceView;
