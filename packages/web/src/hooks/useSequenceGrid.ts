/**
 * useSequenceGrid Hook
 *
 * React hook for integrating the CanvasSequenceGridRenderer with React components.
 * Handles canvas ref, resize events, and state updates.
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import type React from 'react';
import type { Theme, ViewMode, ReadingFrame } from '@phage-explorer/core';
import { translateSequence, reverseComplement } from '@phage-explorer/core';
import { CanvasSequenceGridRenderer, type VisibleRange, type ZoomLevel, type ZoomPreset } from '../rendering';

/** Post-processing pipeline type (placeholder for future WebGL effects) */
type PostProcessPipeline = unknown;

export interface UseSequenceGridOptions {
  theme: Theme;
  sequence: string;
  viewMode?: ViewMode;
  readingFrame?: ReadingFrame;
  diffSequence?: string | null;
  diffEnabled?: boolean;
  diffMask?: Uint8Array | null;
  diffPositions?: number[];
  scanlines?: boolean;
  glow?: boolean;
  postProcess?: PostProcessPipeline;
  reducedMotion?: boolean;
  /** Initial zoom scale (0.1 to 4.0). If not specified, uses mobile-aware default */
  initialZoomScale?: number;
  /** Enable pinch-to-zoom on touch devices */
  enablePinchZoom?: boolean;
  /** Snap scrolling to codon boundaries */
  snapToCodon?: boolean;
  onVisibleRangeChange?: (range: VisibleRange) => void;
  /** Callback when zoom changes */
  onZoomChange?: (scale: number, preset: ZoomPreset) => void;
  /** Density mode: compact favors more cells/letters per viewport */
  densityMode?: 'compact' | 'standard';
}

/**
 * Detect if current device is mobile (touch-primary, small screen)
 */
function detectMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isSmallScreen = window.innerWidth < 1024;
  return hasTouch && isSmallScreen;
}

/**
 * Get recommended initial zoom scale based on viewport width
 * Mobile devices start zoomed in for better readability
 */
function getMobileAwareZoom(): number {
  if (typeof window === 'undefined') return 1.0;
  const width = window.innerWidth;
  const landscape = window.innerWidth > window.innerHeight;
  // In landscape we want more columns visible, so start slightly zoomed out
  if (landscape && width < 800) return 0.9;
  if (width < 480) return 1.1;   // Small phones portrait
  if (width < 768) return 1.05;  // Larger phones portrait
  return 1.0;                     // Tablets/desktop
}

export interface UseSequenceGridResult {
  /** Ref to attach to canvas element */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Current visible range */
  visibleRange: VisibleRange | null;
  /** Current screen orientation */
  orientation: 'portrait' | 'landscape';
  /** Whether device is detected as mobile (touch + small screen) */
  isMobile: boolean;
  /** Current scroll position (index in sequence) */
  scrollPosition: number;
  /** Scroll to a specific position */
  scrollToPosition: (position: number) => void;
  /** Scroll to start */
  scrollToStart: () => void;
  /** Scroll to end */
  scrollToEnd: () => void;
  /** Jump to next/previous diff; returns target index or null if none */
  jumpToDiff: (direction: 'next' | 'prev') => number | null;
  /** Get index at viewport coordinates */
  getIndexAtPoint: (x: number, y: number) => number | null;
  /** Force re-render */
  refresh: () => void;
  /** Current zoom scale (0.1 to 4.0) */
  zoomScale: number;
  /** Current zoom preset info */
  zoomPreset: ZoomPreset | null;
  /** Set zoom scale directly */
  setZoomScale: (scale: number) => void;
  /** Zoom in by factor */
  zoomIn: (factor?: number) => void;
  /** Zoom out by factor */
  zoomOut: (factor?: number) => void;
  /** Set zoom to a preset level */
  setZoomLevel: (level: ZoomLevel) => void;
}

export function useSequenceGrid(options: UseSequenceGridOptions): UseSequenceGridResult {
  const {
    theme,
    sequence,
    viewMode = 'dna',
    readingFrame = 0,
    diffSequence = null,
    diffEnabled = false,
    diffMask = null,
    diffPositions = [],
    scanlines = true,
    glow = false,
    postProcess,
    reducedMotion = false,
    initialZoomScale: initialZoomScaleOption,
    enablePinchZoom = true,
    snapToCodon = true,
    onVisibleRangeChange,
    onZoomChange,
    densityMode = detectMobileDevice() ? 'compact' : 'standard',
  } = options;

  const initialZoomScaleRef = useRef<number | null>(null);
  if (initialZoomScaleRef.current === null) {
    initialZoomScaleRef.current = initialZoomScaleOption ?? getMobileAwareZoom();
  }
  const initialZoomScale = initialZoomScaleRef.current;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasSequenceGridRenderer | null>(null);
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const [scrollPosition, setScrollPosition] = useState(0);
  const [zoomScale, setZoomScaleState] = useState(initialZoomScale);
  const [zoomPreset, setZoomPreset] = useState<ZoomPreset | null>(null);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(() => {
    if (typeof window === 'undefined') return 'landscape';
    return window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait';
  });
  // Track mobile device state for responsive features
  const [isMobile, setIsMobile] = useState(() => detectMobileDevice());

  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  useEffect(() => {
    onVisibleRangeChangeRef.current = onVisibleRangeChange;
  }, [onVisibleRangeChange]);

  const pendingUiSyncRafRef = useRef<number | null>(null);
  const latestRangeRef = useRef<VisibleRange | null>(null);
  const lastCommittedRangeRef = useRef<VisibleRange | null>(null);
  const lastCommittedAtRef = useRef(0);

  const commitUiState = useCallback(() => {
    pendingUiSyncRafRef.current = null;

    const renderer = rendererRef.current;
    const latestRange = latestRangeRef.current ?? renderer?.getVisibleRange() ?? null;
    if (!latestRange) return;

    const now = performance.now();
    if (now - lastCommittedAtRef.current < 50) {
      pendingUiSyncRafRef.current = requestAnimationFrame(commitUiState);
      return;
    }
    lastCommittedAtRef.current = now;

    // Avoid re-rendering on sub-row scroll (offsetY) changes; only commit when indices change.
    const prev = lastCommittedRangeRef.current;
    if (!prev || prev.startIndex !== latestRange.startIndex || prev.endIndex !== latestRange.endIndex) {
      lastCommittedRangeRef.current = latestRange;
      setVisibleRange(latestRange);
      onVisibleRangeChangeRef.current?.(latestRange);
    }

    if (renderer) {
      const nextPos = renderer.getScrollPosition();
      setScrollPosition(nextPos);
    } else {
      setScrollPosition(latestRange.startIndex);
    }
  }, []);

  const handleVisibleRangeFromRenderer = useCallback((range: VisibleRange) => {
    latestRangeRef.current = range;

    if (pendingUiSyncRafRef.current === null) {
      pendingUiSyncRafRef.current = requestAnimationFrame(commitUiState);
    }
  }, [commitUiState]);

  // Handle zoom change callback from renderer
  const handleZoomChange = useCallback((scale: number, preset: ZoomPreset) => {
    setZoomScaleState(scale);
    setZoomPreset(preset);
    if (onZoomChange) {
      onZoomChange(scale, preset);
    }
  }, [onZoomChange]);

  // Initialize renderer when canvas is available
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create renderer with zoom options
    const renderer = new CanvasSequenceGridRenderer({
      canvas,
      theme,
      scanlines,
      glow,
      postProcess,
      reducedMotion,
      zoomScale: initialZoomScale,
      enablePinchZoom,
      onZoomChange: handleZoomChange,
      onVisibleRangeChange: handleVisibleRangeFromRenderer,
      snapToCodon,
      densityMode,
    });

    rendererRef.current = renderer;

    // Initialize zoom preset state
    setZoomPreset(renderer.getZoomPreset());
    latestRangeRef.current = renderer.getVisibleRange();
    commitUiState();

    // Handle resize
    const handleResize = () => {
      renderer.resize();
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(canvas);

    // Track orientation changes explicitly (some mobile browsers delay resize events)
    const handleOrientationChange = () => {
      setOrientation(window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait');
      setIsMobile(detectMobileDevice()); // Re-detect on orientation change
      renderer.resize();
    };
    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('resize', handleOrientationChange); // Also track resize

    // Handle wheel events
    const handleWheel = (e: WheelEvent) => {
      renderer.handleWheel(e);
    };

    // Handle touch events for mobile scrolling
    const handleTouchStart = (e: TouchEvent) => {
      renderer.handleTouchStart(e);
    };

    const handleTouchMove = (e: TouchEvent) => {
      renderer.handleTouchMove(e);
    };

    const handleTouchEnd = (e: TouchEvent) => {
      renderer.handleTouchEnd(e);
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('touchstart', handleTouchStart, { passive: true });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: true });

    // Cleanup
    return () => {
      if (pendingUiSyncRafRef.current !== null) {
        cancelAnimationFrame(pendingUiSyncRafRef.current);
        pendingUiSyncRafRef.current = null;
      }
      resizeObserver.disconnect();
      window.removeEventListener('orientationchange', handleOrientationChange);
      window.removeEventListener('resize', handleOrientationChange);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [scanlines, glow, postProcess, reducedMotion, initialZoomScale, enablePinchZoom, handleZoomChange, handleVisibleRangeFromRenderer, commitUiState]); // Recreate when visual pipeline changes

  // Stop rendering when canvas is offscreen (battery/GPU saver, especially on mobile)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!('IntersectionObserver' in window)) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const renderer = rendererRef.current;
        if (!renderer) return;

        if (entry.isIntersecting) {
          renderer.resume();
        } else {
          renderer.pause();
        }
      },
      { threshold: 0.05 }
    );

    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Avoid background GPU/CPU work when the tab is hidden
  useEffect(() => {
    const onVisibilityChange = () => {
      const renderer = rendererRef.current;
      if (!renderer) return;

      if (document.hidden) {
        renderer.pause();
      } else {
        renderer.resume();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Update theme - preserve scroll position across theme changes
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    // Capture current scroll position before theme change
    const currentPosition = renderer.getScrollPosition();

    // Apply the new theme
    renderer.setTheme(theme);

    // Restore scroll position after render cycle completes
    // Use requestAnimationFrame to ensure the theme render has finished
    requestAnimationFrame(() => {
      renderer.scrollToPosition(currentPosition, false);
    });
  }, [theme]);

  // Update snapping preference without reconstructing renderer
  useEffect(() => {
    rendererRef.current?.setSnapToCodon(snapToCodon);
  }, [snapToCodon]);

  // Update density mode without reconstructing renderer
  useEffect(() => {
    rendererRef.current?.setDensityMode(densityMode);
  }, [densityMode]);

  // Compute sequences for rendering
  const { displaySequence, aminoSequence } = useMemo(() => {
    if (!sequence) return { displaySequence: '', aminoSequence: null as string | null };
    if (viewMode === 'dna') return { displaySequence: sequence, aminoSequence: null as string | null };

    const computeAA = () => {
      if (readingFrame >= 0) {
        const frame = readingFrame as 0 | 1 | 2;
        return translateSequence(sequence, frame);
      }
      const revComp = reverseComplement(sequence);
      const frame = (Math.abs(readingFrame) - 1) as 0 | 1 | 2;
      return translateSequence(revComp, frame);
    };

    const aaSeq = computeAA();
    if (viewMode === 'aa') {
      // For negative frames in single-view AA mode, we must reverse the sequence
      // to map N->C (logical) to Left->Right (spatial/5'->3' relative to forward DNA).
      // (N-term is at 3' end of Forward, so it should be on the Right).
      if (readingFrame < 0) {
        return { displaySequence: aaSeq.split('').reverse().join(''), aminoSequence: aaSeq };
      }
      return { displaySequence: aaSeq, aminoSequence: aaSeq };
    }
    // dual mode: keep DNA as display, but supply AA sequence separately (unreversed)
    // The renderer handles coordinate mapping for dual mode.
    return { displaySequence: sequence, aminoSequence: aaSeq };
  }, [sequence, viewMode, readingFrame]);

  // Update sequence
  useEffect(() => {
    rendererRef.current?.setSequence(displaySequence, viewMode, readingFrame, aminoSequence);
  }, [displaySequence, viewMode, readingFrame, aminoSequence]);

  // Update diff mode
  useEffect(() => {
    rendererRef.current?.setDiffMode(diffSequence, diffEnabled, diffMask ?? null);
  }, [diffSequence, diffEnabled, diffMask]);

  // Update reduced motion flag without reconstructing renderer
  useEffect(() => {
    rendererRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  // Update post-process pipeline without reconstructing renderer
  useEffect(() => {
    rendererRef.current?.setPostProcess(postProcess);
  }, [postProcess]);

  // Scroll methods
  const scrollToPosition = useCallback((position: number) => {
    rendererRef.current?.scrollToPosition(position);
  }, []);

  const scrollToStart = useCallback(() => {
    rendererRef.current?.scrollToStart();
  }, []);

  const scrollToEnd = useCallback(() => {
    rendererRef.current?.scrollToEnd();
  }, []);

  const getIndexAtPoint = useCallback((x: number, y: number): number | null => {
    return rendererRef.current?.getIndexAtPoint(x, y) ?? null;
  }, []);

  const refresh = useCallback(() => {
    rendererRef.current?.markDirty();
  }, []);

  const jumpToDiff = useCallback(
    (direction: 'next' | 'prev'): number | null => {
      if (!diffPositions || diffPositions.length === 0) return null;
      const current = rendererRef.current?.getScrollPosition() ?? 0;
      const sorted = diffPositions;
      if (direction === 'next') {
        const target = sorted.find((pos) => pos > current);
        const selected = target ?? sorted[0];
        scrollToPosition(selected);
        return selected;
      }
      // prev
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i] < current) {
          scrollToPosition(sorted[i]);
          return sorted[i];
        }
      }
      const fallback = sorted[sorted.length - 1];
      scrollToPosition(fallback);
      return fallback;
    },
    [diffPositions, scrollToPosition]
  );

  // Zoom methods
  const setZoomScale = useCallback((scale: number) => {
    rendererRef.current?.setZoomScale(scale);
  }, []);

  const zoomIn = useCallback((factor = 1.3) => {
    rendererRef.current?.zoomIn(factor);
  }, []);

  const zoomOut = useCallback((factor = 1.3) => {
    rendererRef.current?.zoomOut(factor);
  }, []);

  const setZoomLevel = useCallback((level: ZoomLevel) => {
    rendererRef.current?.setZoomLevel(level);
  }, []);

  return {
    canvasRef,
    visibleRange,
    orientation,
    isMobile,
    scrollPosition,
    scrollToPosition,
    scrollToStart,
    scrollToEnd,
    jumpToDiff,
    getIndexAtPoint,
    refresh,
    zoomScale,
    zoomPreset,
    setZoomScale,
    zoomIn,
    zoomOut,
    setZoomLevel,
  };
}

export default useSequenceGrid;
