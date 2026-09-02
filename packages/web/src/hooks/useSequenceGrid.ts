/**
 * useSequenceGrid Hook
 *
 * React hook for integrating the CanvasSequenceGridRenderer with React components.
 * Handles canvas ref, resize events, and state updates.
 */

import { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo } from 'react';
import type React from 'react';
import type { Theme, ViewMode, ReadingFrame } from '@phage-explorer/core';
import { translateSequence, reverseComplement } from '@phage-explorer/core';
import { CanvasSequenceGridRenderer, type VisibleRange, type ZoomLevel, type ZoomPreset, type PostProcessPipeline, WebGLSequenceRenderer, detectWebGLSupport } from '../rendering';
import type { PostProcessOptions } from '../rendering/PostProcessPipeline';

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
  /** Enable OffscreenCanvas worker renderer when available */
  useWorkerRenderer?: boolean;
  /** Post-process pipeline options (worker-safe) */
  postProcessOptions?: PostProcessOptions;
  /** Initial scroll position index */
  initialPosition?: number;
  /**
   * Prefer WebGL-based GPU-accelerated rendering when available.
   * Falls back to Canvas 2D if WebGL is not supported.
   * Default: true (use WebGL when available)
   */
  preferWebGL?: boolean;
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
  // Match the renderer's default zoom logic for consistent first-run behavior.
  if (width < 480) return 1.4;  // Small phones: zoom in for readability
  if (width < 768) return 1.2;  // Larger phones: slight zoom
  return 1.0;                     // Tablets/desktop
}

export interface UseSequenceGridResult {
  /** Ref to attach to canvas element */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Current visible range */
  visibleRange: VisibleRange | null;
  /** Apply wheel deltas to the renderer (use with a passive:false wheel listener) */
  handleWheelDelta: (deltaX: number, deltaY: number, deltaMode?: 0 | 1 | 2) => void;
  /** Current screen orientation */
  orientation: 'portrait' | 'landscape';
  /** Whether device is detected as mobile (touch + small screen) */
  isMobile: boolean;
  /** Current scroll position (index in sequence) */
  scrollPosition: number;
  /** Scroll to a specific position, optionally centering it in view */
  scrollToPosition: (position: number, center?: boolean) => void;
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
  /**
   * Active renderer family. A canvas can only ever have one context type, so
   * SequenceView must remount the <canvas> (via `key`) when this changes.
   */
  rendererBackend: 'webgl' | 'canvas2d';
}

// Type for unified renderer interface (Canvas or WebGL)
type SequenceRenderer = CanvasSequenceGridRenderer | WebGLSequenceRenderer;

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
    scanlines = false,
    glow = false,
    postProcess,
    postProcessOptions,
    reducedMotion = false,
    initialZoomScale: initialZoomScaleOption,
    initialPosition = 0,
    enablePinchZoom = true,
    snapToCodon = true,
    onVisibleRangeChange,
    onZoomChange,
    densityMode = detectMobileDevice() ? 'compact' : 'standard',
    preferWebGL = true,  // Enable WebGL by default
  } = options;

  // Worker renderer disabled by default - OffscreenCanvas has DPI/sizing sync issues
  // that cause blur and scroll problems. Keep main-thread rendering for now.
  // Set when Worker construction fails at runtime, so the memo below stops
  // choosing the worker path. Mirrors the `webglInitFailed` flag used for the
  // WebGL backend a few lines down.
  const [workerInitFailed, setWorkerInitFailed] = useState(false);

  const useWorkerRenderer = useMemo(() => {
    if (typeof window === 'undefined') return false;
    // Only enable if explicitly requested
    if (options.useWorkerRenderer !== true) return false;
    if (workerInitFailed) return false;
    const offscreenSupported = typeof OffscreenCanvas !== 'undefined'
      && typeof (HTMLCanvasElement.prototype as unknown as { transferControlToOffscreen?: () => OffscreenCanvas }).transferControlToOffscreen === 'function';
    if (!offscreenSupported) return false;
    if ((navigator as Navigator).webdriver) return false;
    return true;
  }, [options.useWorkerRenderer, workerInitFailed]);

  // Once WebGL binds this canvas, Canvas 2D cannot be created on it. A constructor
  // failure after getContext('webgl') must remount a fresh canvas (via rendererBackend).
  const [webglInitFailed, setWebglInitFailed] = useState(false);

  // WebGL detection - re-evaluated when rendering requirements change
  // Detect WebGL 2 support with instanced rendering for 60fps GPU-accelerated scrolling
  const webglSupport = useMemo(() => {
    if (typeof window === 'undefined') return { supported: false, webgl2: false };
    if (webglInitFailed) return { supported: false, webgl2: false };
    // Skip WebGL if explicitly disabled
    if (!preferWebGL) return { supported: false, webgl2: false };
    // Skip WebGL if using worker renderer (incompatible)
    if (options.useWorkerRenderer === true) return { supported: false, webgl2: false };
    // Skip WebGL if post-processing effects are needed (WebGL renderer doesn't support them yet)
    if (scanlines || glow || postProcess) return { supported: false, webgl2: false };
    // Skip WebGL for amino acid/dual modes (WebGL shader only renders nucleotides currently)
    // Canvas 2D renderer handles AA coloring and dual-row layout properly
    if (viewMode !== 'dna') return { supported: false, webgl2: false };

    try {
      const detection = detectWebGLSupport();
      // Require WebGL 2 or WebGL 1 with instanced arrays
      const supported = detection.webgl2 || (detection.webgl1 && detection.maxInstances > 0);
      return { supported, webgl2: detection.webgl2 };
    } catch {
      return { supported: false, webgl2: false };
    }
  }, [preferWebGL, options.useWorkerRenderer, scanlines, glow, postProcess, viewMode, webglInitFailed]);

  const resolvedPostProcessOptions = useMemo<PostProcessOptions | null>(() => {
    if (postProcessOptions) return postProcessOptions;
    if (!scanlines && !glow) return null;
    return {
      reducedMotion,
      enableScanlines: scanlines,
      enableBloom: glow,
      enableChromaticAberration: scanlines,
    };
  }, [postProcessOptions, scanlines, glow, reducedMotion]);

  const postProcessOptionsRef = useRef<PostProcessOptions | null>(resolvedPostProcessOptions);
  useEffect(() => {
    postProcessOptionsRef.current = resolvedPostProcessOptions;
    if (useWorkerRenderer && workerRef.current) {
      workerRef.current.postMessage({ type: 'setPostProcess', options: resolvedPostProcessOptions });
    }
  }, [resolvedPostProcessOptions, useWorkerRenderer]);

  const initialZoomScaleRef = useRef<number>(initialZoomScaleOption ?? getMobileAwareZoom());
  const initialZoomScale = initialZoomScaleRef.current;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SequenceRenderer | null>(null);
  const isWebGLRendererRef = useRef<boolean>(false);
  const workerRef = useRef<Worker | null>(null);
  const displayLengthRef = useRef<number>(0);
  const workerStateRef = useRef<{
    visibleRange: VisibleRange | null;
    layout: { cols: number; rows: number; totalHeight: number; totalWidth: number } | null;
    scrollPosition: number;
    zoomPreset: ZoomPreset | null;
    cellMetrics: { cellWidth: number; cellHeight: number; rowHeight: number } | null;
  }>({
    visibleRange: null,
    layout: null,
    scrollPosition: 0,
    zoomPreset: null,
    cellMetrics: null,
  });
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

  // Initialize OffscreenCanvas worker renderer (if supported)
  useEffect(() => {
    if (!useWorkerRenderer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let worker: Worker | null = null;
    try {
      worker = new Worker(
        new URL('../workers/sequence-render.worker.ts', import.meta.url),
        { type: 'module' }
      );
    } catch {
      try {
        worker = new Worker(new URL('../workers/sequence-render.worker.ts', import.meta.url));
      } catch {
        // Module and classic worker creation both failed; fall back to
        // main-thread rendering.
        //
        // This previously called setUseWorkerRenderer(false), which does not
        // exist -- useWorkerRenderer is a useMemo, not state. So the graceful
        // fallback threw a ReferenceError instead of degrading, on exactly the
        // browsers that needed it. Never type-checked, because the root
        // tsconfig excluded packages/web entirely.
        setWorkerInitFailed(true);
        return;
      }
    }
    workerRef.current = worker;

    const offscreen = canvas.transferControlToOffscreen();
    const viewport = {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    };

    const handleMessage = (event: MessageEvent<any>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'visibleRange') {
        workerStateRef.current.visibleRange = msg.range ?? null;
        workerStateRef.current.layout = msg.layout ?? null;
        workerStateRef.current.cellMetrics = msg.cellMetrics ?? null;
        workerStateRef.current.scrollPosition = msg.scrollPosition ?? 0;
        handleVisibleRangeFromRenderer(msg.range);
      } else if (msg.type === 'zoom') {
        workerStateRef.current.zoomPreset = msg.preset ?? null;
        handleZoomChange(msg.scale, msg.preset);
      } else if (msg.type === 'error' && msg.message) {
        // If worker fails, fall back to main thread on next render
        console.error('[SequenceGridWorker]', msg.message);
      }
    };

    worker.addEventListener('message', handleMessage);

    // Proxy object to preserve renderer interface for the hook
    const proxy = {
      resize: (width?: number, height?: number) => {
        if (!workerRef.current) return;
        if (typeof width !== 'number' || typeof height !== 'number') {
          const rect = canvas.getBoundingClientRect();
          workerRef.current.postMessage({ type: 'resize', width: rect.width, height: rect.height });
          return;
        }
        workerRef.current.postMessage({ type: 'resize', width, height });
      },
      setSequence: (seq: string, mode: ViewMode, frame: ReadingFrame, aa: string | null) => {
        workerRef.current?.postMessage({ type: 'setSequence', sequence: seq, viewMode: mode, readingFrame: frame, aminoSequence: aa });
      },
      setDiffMode: (refSeq: string | null, enabled: boolean, mask?: Uint8Array | null) => {
        workerRef.current?.postMessage({ type: 'setDiff', diffSequence: refSeq, diffEnabled: enabled, diffMask: mask ?? null });
      },
      setTheme: (nextTheme: Theme) => {
        workerRef.current?.postMessage({ type: 'setTheme', theme: nextTheme });
      },
      setReducedMotion: (flag: boolean) => {
        workerRef.current?.postMessage({ type: 'setReducedMotion', reducedMotion: flag });
      },
      setScanlines: (enabled: boolean) => {
        workerRef.current?.postMessage({ type: 'setEffects', scanlines: enabled, glow });
      },
      setGlow: (enabled: boolean) => {
        workerRef.current?.postMessage({ type: 'setEffects', scanlines, glow: enabled });
      },
      setSnapToCodon: (flag: boolean) => {
        workerRef.current?.postMessage({ type: 'setSnapToCodon', enabled: flag });
      },
      setDensityMode: (mode: 'compact' | 'standard') => {
        workerRef.current?.postMessage({ type: 'setDensityMode', mode });
      },
      setPostProcess: () => {
        workerRef.current?.postMessage({ type: 'setPostProcess', options: postProcessOptionsRef.current });
      },
      handleWheel: (event: WheelEvent) => {
        event.preventDefault();
        workerRef.current?.postMessage({
          type: 'wheel',
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode as 0 | 1 | 2,
        });
      },
      handleTouchStart: (event: TouchEvent) => {
        if (event.touches.length === 0) return;
        const points = Array.from(event.touches).map((touch) => ({
          x: touch.clientX,
          y: touch.clientY,
        }));
        workerRef.current?.postMessage({ type: 'touchStart', points });
      },
      handleTouchMove: (event: TouchEvent) => {
        if (event.touches.length === 0) return;
        event.preventDefault();
        const points = Array.from(event.touches).map((touch) => ({
          x: touch.clientX,
          y: touch.clientY,
        }));
        workerRef.current?.postMessage({ type: 'touchMove', points });
      },
      handleTouchEnd: () => {
        workerRef.current?.postMessage({ type: 'touchEnd' });
      },
      scrollToPosition: (position: number, center: boolean = true) => {
        workerRef.current?.postMessage({ type: 'scrollTo', position, center });
      },
      scrollToStart: () => {
        workerRef.current?.postMessage({ type: 'scrollToStart' });
      },
      scrollToEnd: () => {
        workerRef.current?.postMessage({ type: 'scrollToEnd' });
      },
      getIndexAtPoint: (x: number, y: number): number | null => {
        const state = workerStateRef.current;
        if (!state.visibleRange || !state.layout || !state.cellMetrics) return null;
        const { cols } = state.layout;
        const { startRow, startIndex, offsetX, offsetY } = state.visibleRange;
        const cellWidth = state.cellMetrics.cellWidth;
        const rowHeight = state.cellMetrics.rowHeight;
        const scrollX = (startIndex - startRow * cols) * cellWidth - offsetX;
        const scrollY = startRow * rowHeight - offsetY;
        const absoluteX = scrollX + x;
        const absoluteY = scrollY + y;
        const col = Math.floor(absoluteX / cellWidth);
        const row = Math.floor(absoluteY / rowHeight);
        if (col < 0 || row < 0 || col >= cols || row >= state.layout.rows) return null;
        const idx = row * cols + col;
        if (idx >= displayLengthRef.current) return null;
        return idx >= 0 ? idx : null;
      },
      getScrollPosition: () => workerStateRef.current.scrollPosition,
      getVisibleRange: () => workerStateRef.current.visibleRange ?? null,
      getZoomPreset: () => workerStateRef.current.zoomPreset ?? null,
      setZoomScale: (scale: number) => {
        workerRef.current?.postMessage({ type: 'zoomScale', scale });
      },
      zoomIn: (factor = 1.3) => {
        workerRef.current?.postMessage({ type: 'zoomIn', factor });
      },
      zoomOut: (factor = 1.3) => {
        workerRef.current?.postMessage({ type: 'zoomOut', factor });
      },
      setZoomLevel: (level: ZoomLevel) => {
        workerRef.current?.postMessage({ type: 'zoomLevel', level });
      },
      pause: () => {
        workerRef.current?.postMessage({ type: 'pause' });
      },
      resume: () => {
        workerRef.current?.postMessage({ type: 'resume' });
      },
      markDirty: () => {
        workerRef.current?.postMessage({ type: 'markDirty' });
      },
      dispose: () => {
        workerRef.current?.postMessage({ type: 'dispose' });
      },
    } as unknown as CanvasSequenceGridRenderer;

    rendererRef.current = proxy;

    worker.postMessage(
      {
        type: 'init',
        canvas: offscreen,
        theme,
        viewport,
        options: {
          scanlines,
          glow,
          reducedMotion,
          zoomScale: initialZoomScale,
          enablePinchZoom,
          snapToCodon,
          densityMode,
          devicePixelRatio: window.devicePixelRatio || 1,
          postProcess: resolvedPostProcessOptions,
        },
      },
      [offscreen]
    );

    const handleResize = () => {
      const rect = canvas.getBoundingClientRect();
      worker.postMessage({ type: 'resize', width: rect.width, height: rect.height });
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(canvas);

    const handleOrientationChange = () => {
      setOrientation(window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait');
      setIsMobile(detectMobileDevice());
      handleResize();
    };

    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('resize', handleOrientationChange);

    const handleTouchStart = (e: TouchEvent) => proxy.handleTouchStart(e);
    const handleTouchMove = (e: TouchEvent) => proxy.handleTouchMove(e);
    const handleTouchEnd = (e: TouchEvent) => proxy.handleTouchEnd(e);

    canvas.addEventListener('touchstart', handleTouchStart, { passive: true });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      if (pendingUiSyncRafRef.current !== null) {
        cancelAnimationFrame(pendingUiSyncRafRef.current);
        pendingUiSyncRafRef.current = null;
      }
      resizeObserver.disconnect();
      window.removeEventListener('orientationchange', handleOrientationChange);
      window.removeEventListener('resize', handleOrientationChange);
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      worker.removeEventListener('message', handleMessage);
      worker.postMessage({ type: 'dispose' });
      worker.terminate();
      workerRef.current = null;
      rendererRef.current = null;
    };
  }, [useWorkerRenderer]);

  // Initialize renderer when canvas is available
  //
  // IMPORTANT: useLayoutEffect so the renderer + touch handlers are ready before
  // the first paint. Using useEffect leaves a brief window where the canvas is
  // visible but inert (wheel/touch does nothing), which feels like "stuck" scroll
  // on initial load—especially on mobile where the page itself may not scroll.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (useWorkerRenderer) return;

    let renderer: SequenceRenderer | null = null;
    let usingWebGL = false;

    // Try WebGL first if supported (60fps GPU-accelerated scrolling)
    if (webglSupport.supported) {
      try {
        renderer = new WebGLSequenceRenderer({
          canvas,
          theme,
          zoomScale: initialZoomScale,
          enablePinchZoom,
          snapToCodon,
          onZoomChange: (scale) => {
            // WebGL renderer doesn't have ZoomPreset concept, create a minimal one
            const preset: ZoomPreset = {
              cellWidth: Math.round(12 * scale),
              cellHeight: Math.round(14 * scale),
              showText: scale >= 0.7,
              showAA: scale >= 0.7,
              label: scale <= 0.25 ? 'Genome' : scale <= 0.55 ? 'Region' : scale <= 0.9 ? 'Micro' : scale <= 1.5 ? 'Codon' : 'Base',
            };
            handleZoomChange(scale, preset);
          },
          onVisibleRangeChange: handleVisibleRangeFromRenderer,
        });
        usingWebGL = true;
        if (import.meta.env.DEV) {
          console.info('[SequenceGrid] Using WebGL renderer for GPU-accelerated scrolling');
        }
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[SequenceGrid] WebGL renderer failed, remounting canvas for 2D fallback:', error);
        }
        // getContext('webgl') already bound this canvas. 2D cannot be created on it.
        setWebglInitFailed(true);
        return;
      }
    }

    // Fall back to Canvas 2D renderer (always works)
    if (!renderer) {
      renderer = new CanvasSequenceGridRenderer({
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
      usingWebGL = false;
    }

    rendererRef.current = renderer;
    isWebGLRendererRef.current = usingWebGL;

    // Initialize sequence and diff state on new renderer.
    // This is critical because the sequence/diff effects won't re-run
    // when renderer is recreated due to visual pipeline changes (scanlines, glow, etc).
    // Without this, the new renderer has currentState=null and render() exits early.
    if (usingWebGL) {
      // WebGL renderer uses setState()
      (renderer as WebGLSequenceRenderer).setState({
        sequence: displaySequence,
        aminoSequence,
        viewMode,
        readingFrame,
        diffSequence,
        diffEnabled,
        diffMask: diffMask ?? null,
      });
    } else {
      // Canvas renderer uses setSequence() + setDiffMode()
      (renderer as CanvasSequenceGridRenderer).setSequence(displaySequence, viewMode, readingFrame, aminoSequence);
      (renderer as CanvasSequenceGridRenderer).setDiffMode(diffSequence, diffEnabled, diffMask ?? null);
    }

    // Initialize zoom preset state
    if (!usingWebGL) {
      setZoomPreset((renderer as CanvasSequenceGridRenderer).getZoomPreset());
    }
    if (typeof initialPosition === 'number' && initialPosition > 0) {
      renderer.scrollToPosition(initialPosition, false);
    }
    latestRangeRef.current = renderer.getVisibleRange();
    commitUiState();

    // Handle resize - both renderers support resize()
    const handleResize = () => {
      if (usingWebGL) {
        const rect = canvas.getBoundingClientRect();
        (renderer as WebGLSequenceRenderer).resize(rect.width, rect.height);
      } else {
        (renderer as CanvasSequenceGridRenderer).resize();
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(canvas);

    // Track orientation changes explicitly (some mobile browsers delay resize events)
    const handleOrientationChange = () => {
      setOrientation(window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait');
      setIsMobile(detectMobileDevice()); // Re-detect on orientation change
      handleResize();
    };
    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('resize', handleOrientationChange); // Also track resize

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
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [useWorkerRenderer, webglSupport.supported, scanlines, glow, postProcess, reducedMotion, initialZoomScale, enablePinchZoom, handleZoomChange, handleVisibleRangeFromRenderer, commitUiState]); // Recreate when visual pipeline changes

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
      // Use a 0 threshold so we resume as soon as *any* pixel becomes visible.
      // WebKit can otherwise keep the renderer paused when only a small sliver is in view,
      // which looks like a permanently black/blank sequence grid.
      { threshold: 0 }
    );

    observer.observe(canvas);
    return () => observer.disconnect();
  }, [webglSupport.supported]);

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
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      // Avoid calling into a disposed/replaced renderer.
      if (rendererRef.current !== renderer) return;
      renderer.scrollToPosition(currentPosition, false);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [theme]);

  // Update snapping preference without reconstructing renderer
  useEffect(() => {
    rendererRef.current?.setSnapToCodon(snapToCodon);
  }, [snapToCodon]);

  // Update density mode without reconstructing renderer
  useEffect(() => {
    // Only Canvas renderer supports density mode
    if (!isWebGLRendererRef.current && rendererRef.current) {
      (rendererRef.current as CanvasSequenceGridRenderer).setDensityMode?.(densityMode);
    }
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

  useEffect(() => {
    displayLengthRef.current = displaySequence.length;
  }, [displaySequence]);

  // Update sequence
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (isWebGLRendererRef.current) {
      // WebGL renderer uses setState()
      (renderer as WebGLSequenceRenderer).setState({
        sequence: displaySequence,
        aminoSequence,
        viewMode,
        readingFrame,
      });
    } else {
      // Canvas renderer uses setSequence()
      (renderer as CanvasSequenceGridRenderer).setSequence(displaySequence, viewMode, readingFrame, aminoSequence);
    }
  }, [displaySequence, viewMode, readingFrame, aminoSequence]);

  // Update diff mode
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (isWebGLRendererRef.current) {
      // WebGL renderer uses setState()
      (renderer as WebGLSequenceRenderer).setState({
        diffSequence,
        diffEnabled,
        diffMask: diffMask ?? null,
      });
    } else {
      // Canvas renderer uses setDiffMode()
      (renderer as CanvasSequenceGridRenderer).setDiffMode(diffSequence, diffEnabled, diffMask ?? null);
    }
  }, [diffSequence, diffEnabled, diffMask]);

  // Update reduced motion flag without reconstructing renderer (Canvas only)
  useEffect(() => {
    if (!isWebGLRendererRef.current && rendererRef.current) {
      (rendererRef.current as CanvasSequenceGridRenderer).setReducedMotion?.(reducedMotion);
    }
  }, [reducedMotion]);

  // Update scanline/glow toggles without recreating renderer (Canvas only)
  useEffect(() => {
    if (useWorkerRenderer && workerRef.current) {
      workerRef.current.postMessage({ type: 'setEffects', scanlines, glow });
      return;
    }
    if (!isWebGLRendererRef.current && rendererRef.current) {
      (rendererRef.current as CanvasSequenceGridRenderer).setScanlines?.(scanlines);
      (rendererRef.current as CanvasSequenceGridRenderer).setGlow?.(glow);
    }
  }, [scanlines, glow, useWorkerRenderer]);

  // Update post-process pipeline without reconstructing renderer (Canvas only)
  useEffect(() => {
    if (!isWebGLRendererRef.current && rendererRef.current) {
      (rendererRef.current as CanvasSequenceGridRenderer).setPostProcess?.(postProcess);
    }
  }, [postProcess]);

  // Scroll methods
  const scrollToPosition = useCallback((position: number, center: boolean = true) => {
    rendererRef.current?.scrollToPosition(position, center);
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

  const handleWheelDelta = useCallback(
    (deltaX: number, deltaY: number, deltaMode: 0 | 1 | 2 = 0) => {
      if (useWorkerRenderer && workerRef.current) {
        workerRef.current.postMessage({ type: 'wheel', deltaX, deltaY, deltaMode });
        return;
      }
      rendererRef.current?.handleWheelDelta(deltaX, deltaY, deltaMode);
    },
    [useWorkerRenderer]
  );

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
    handleWheelDelta,
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
    rendererBackend: webglSupport.supported ? 'webgl' : 'canvas2d',
  };
}

export default useSequenceGrid;
