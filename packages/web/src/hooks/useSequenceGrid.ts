/**
 * useSequenceGrid Hook
 *
 * React hook for integrating the CanvasSequenceGridRenderer with React components.
 * Handles canvas ref, resize events, and state updates.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import type { Theme, ViewMode, ReadingFrame } from '@phage-explorer/core';
import { CanvasSequenceGridRenderer, type VisibleRange } from '../rendering';

export interface UseSequenceGridOptions {
  theme: Theme;
  sequence: string;
  viewMode?: ViewMode;
  readingFrame?: ReadingFrame;
  diffSequence?: string | null;
  diffEnabled?: boolean;
  scanlines?: boolean;
  glow?: boolean;
  postProcess?: PostProcessPipeline;
  reducedMotion?: boolean;
  onVisibleRangeChange?: (range: VisibleRange) => void;
}

export interface UseSequenceGridResult {
  /** Ref to attach to canvas element */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Current visible range */
  visibleRange: VisibleRange | null;
  /** Current scroll position (index in sequence) */
  scrollPosition: number;
  /** Scroll to a specific position */
  scrollToPosition: (position: number) => void;
  /** Scroll to start */
  scrollToStart: () => void;
  /** Scroll to end */
  scrollToEnd: () => void;
  /** Get index at viewport coordinates */
  getIndexAtPoint: (x: number, y: number) => number | null;
  /** Force re-render */
  refresh: () => void;
}

export function useSequenceGrid(options: UseSequenceGridOptions): UseSequenceGridResult {
  const {
    theme,
    sequence,
    viewMode = 'dna',
    readingFrame = 0,
    diffSequence = null,
    diffEnabled = false,
    scanlines = true,
    glow = false,
    postProcess,
    reducedMotion = false,
    onVisibleRangeChange,
  } = options;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasSequenceGridRenderer | null>(null);
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const [scrollPosition, setScrollPosition] = useState(0);

  // Initialize renderer when canvas is available
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create renderer
    const renderer = new CanvasSequenceGridRenderer({
      canvas,
      theme,
      scanlines,
      glow,
      postProcess,
      reducedMotion,
    });

    rendererRef.current = renderer;

    // Handle resize
    const handleResize = () => {
      renderer.resize();
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(canvas);

    // Handle wheel events
    const handleWheel = (e: WheelEvent) => {
      renderer.handleWheel(e);
      setScrollPosition(renderer.getScrollPosition());
      setVisibleRange(renderer.getVisibleRange());
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });

    // Cleanup
    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener('wheel', handleWheel);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [scanlines, glow, postProcess, reducedMotion]); // Recreate when visual pipeline changes

  // Update theme
  useEffect(() => {
    rendererRef.current?.setTheme(theme);
  }, [theme]);

  // Update sequence
  useEffect(() => {
    rendererRef.current?.setSequence(sequence, viewMode, readingFrame);
  }, [sequence, viewMode, readingFrame]);

  // Update diff mode
  useEffect(() => {
    rendererRef.current?.setDiffMode(diffSequence, diffEnabled);
  }, [diffSequence, diffEnabled]);

  // Notify visible range changes
  useEffect(() => {
    if (visibleRange && onVisibleRangeChange) {
      onVisibleRangeChange(visibleRange);
    }
  }, [visibleRange, onVisibleRangeChange]);

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
    if (rendererRef.current) {
      setScrollPosition(rendererRef.current.getScrollPosition());
      setVisibleRange(rendererRef.current.getVisibleRange());
    }
  }, []);

  const scrollToStart = useCallback(() => {
    rendererRef.current?.scrollToStart();
    setScrollPosition(0);
    if (rendererRef.current) {
      setVisibleRange(rendererRef.current.getVisibleRange());
    }
  }, []);

  const scrollToEnd = useCallback(() => {
    rendererRef.current?.scrollToEnd();
    if (rendererRef.current) {
      setScrollPosition(rendererRef.current.getScrollPosition());
      setVisibleRange(rendererRef.current.getVisibleRange());
    }
  }, []);

  const getIndexAtPoint = useCallback((x: number, y: number): number | null => {
    return rendererRef.current?.getIndexAtPoint(x, y) ?? null;
  }, []);

  const refresh = useCallback(() => {
    rendererRef.current?.markDirty();
  }, []);

  return {
    canvasRef,
    visibleRange,
    scrollPosition,
    scrollToPosition,
    scrollToStart,
    scrollToEnd,
    getIndexAtPoint,
    refresh,
  };
}

export default useSequenceGrid;
