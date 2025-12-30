/**
 * CanvasSequenceGridRenderer - Main Rendering Engine
 *
 * High-performance canvas renderer for genome sequence grids.
 * Features: double-buffering, dirty region tracking, color batching,
 * high-DPI support, row tile caching, and 60fps target rendering.
 *
 * Performance optimizations:
 * - Row tile caching: Pre-render rows to OffscreenCanvas, reuse on scroll
 * - Sequence encoding: Uint8Array for O(1) character lookups
 * - Dirty frame detection: Skip renders when content unchanged
 * - Batch rendering: Group same-color operations in micro mode
 * - Incremental scroll blit: Only render newly visible rows
 */

import type { Theme, ViewMode, ReadingFrame } from '@phage-explorer/core';
import { GlyphAtlas } from './GlyphAtlas';
import { VirtualScroller, type VisibleRange } from './VirtualScroller';
import type { PostProcessPipeline } from './PostProcessPipeline';

// Sequence character encoding for fast O(1) lookups
const CHAR_TO_CODE: Record<string, number> = {
  'A': 0, 'a': 0,
  'C': 1, 'c': 1,
  'G': 2, 'g': 2,
  'T': 3, 't': 3,
  'N': 4, 'n': 4,
  'U': 3, 'u': 3, // RNA uracil -> thymine
};
const CODE_TO_CHAR = ['A', 'C', 'G', 'T', 'N'];

// Encode sequence string to Uint8Array for faster iteration
function encodeSequence(seq: string): Uint8Array {
  const encoded = new Uint8Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    encoded[i] = CHAR_TO_CODE[seq[i]] ?? 4; // Default to N
  }
  return encoded;
}

// Row tile cache entry
interface RowTile {
  canvas: OffscreenCanvas;
  row: number;
  hash: number; // Content hash for invalidation
  timestamp: number;
}

export interface SequenceGridOptions {
  /** Canvas element to render to */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Initial theme */
  theme: Theme;
  /** Cell width in CSS pixels */
  cellWidth?: number;
  /** Cell height in CSS pixels */
  cellHeight?: number;
  /** Density mode: compact favors smaller cells/letters */
  densityMode?: 'compact' | 'standard';
  /** Enable scanline effect */
  scanlines?: boolean;
  /** Enable glow effect */
  glow?: boolean;
  /** Optional post-processing pipeline */
  postProcess?: PostProcessPipeline;
  /** Reduced motion flag */
  reducedMotion?: boolean;
  /** Initial zoom scale (0.1 to 4.0, default 1.0) */
  zoomScale?: number;
  /** Enable pinch-to-zoom on mobile */
  enablePinchZoom?: boolean;
  /** Explicit viewport width (required for OffscreenCanvas) */
  viewportWidth?: number;
  /** Explicit viewport height (required for OffscreenCanvas) */
  viewportHeight?: number;
  /** Explicit device pixel ratio (worker-safe) */
  devicePixelRatio?: number;
  /** Callback when zoom changes */
  onZoomChange?: (scale: number, preset: ZoomPreset) => void;
  /** Callback when visible range changes (scroll/resize/momentum) */
  onVisibleRangeChange?: (range: VisibleRange) => void;
  /** Snap scrolling to codon boundaries (3 bases) */
  snapToCodon?: boolean;
}

export interface GridRenderState {
  sequence: string;
  aminoSequence: string | null;
  viewMode: ViewMode;
  readingFrame: ReadingFrame;
  diffSequence: string | null;
  diffEnabled: boolean;
  diffMask: Uint8Array | null;
}

// Zoom level presets for mobile sequence grid
// Users can pinch-to-zoom between these levels
export type ZoomLevel = 'genome' | 'micro' | 'region' | 'codon' | 'base';

export interface ZoomPreset {
  cellWidth: number;
  cellHeight: number;
  showText: boolean;
  showAA: boolean;  // Show amino acid row below DNA
  label: string;
}

// Zoom presets - from ultra-dense genome overview to single-base detail
const ZOOM_PRESETS: Record<ZoomLevel, ZoomPreset> = {
  genome: { cellWidth: 1, cellHeight: 1, showText: false, showAA: false, label: 'Genome' },
  micro: { cellWidth: 10, cellHeight: 12, showText: true, showAA: true, label: 'Micro' }, // Enlarged for readability
  region: { cellWidth: 4, cellHeight: 4, showText: false, showAA: false, label: 'Region' },
  codon: { cellWidth: 12, cellHeight: 14, showText: true, showAA: true, label: 'Codon' },
  base: { cellWidth: 18, cellHeight: 24, showText: true, showAA: true, label: 'Base' },
};

// Get zoom preset based on scale factor (0.25 to 4.0)
function getZoomPresetForScale(scale: number): ZoomPreset {
  if (scale <= 0.25) return ZOOM_PRESETS.genome;
  if (scale <= 0.55) return ZOOM_PRESETS.region; // Swapped region/micro order for logical progression
  if (scale <= 0.9) return ZOOM_PRESETS.micro;
  if (scale <= 1.5) return ZOOM_PRESETS.codon;
  return ZOOM_PRESETS.base;
}

// Orientation detection for mobile devices
function isLandscape(viewportWidth: number, viewportHeight: number): boolean {
  return viewportWidth > viewportHeight;
}

// Responsive BASE cell sizes - these get multiplied by zoom scale
// Mobile-first with orientation awareness for maximum utility
// UPDATED: Increased cell sizes on mobile for better readability (xivy Pillar 1)
function getResponsiveCellSize(
  viewportWidth: number,
  viewportHeight?: number,
  densityMode: 'compact' | 'standard' = 'standard'
): { width: number; height: number } {
  const height = viewportHeight ?? viewportWidth * 0.6; // Assume portrait if no height
  const landscape = isLandscape(viewportWidth, height);
  const compact = densityMode === 'compact';

  if (viewportWidth < 375) {
    return landscape
      ? { width: compact ? 6 : 9, height: compact ? 7 : 11 }
      : { width: compact ? 8 : 12, height: compact ? 9 : 14 };
  }
  if (viewportWidth < 480) {
    return landscape
      ? { width: compact ? 6 : 9, height: compact ? 7 : 11 }
      : { width: compact ? 9 : 14, height: compact ? 10 : 16 };
  }
  if (viewportWidth < 640) {
    return landscape
      ? { width: compact ? 7 : 10, height: compact ? 8 : 12 }
      : { width: compact ? 11 : 16, height: compact ? 12 : 18 };
  }
  if (viewportWidth < 768) {
    return landscape
      ? { width: compact ? 8 : 11, height: compact ? 9 : 13 }
      : { width: compact ? 12 : 18, height: compact ? 13 : 20 };
  }
  if (viewportWidth < 1024) {
    return landscape
      ? { width: compact ? 9 : 12, height: compact ? 10 : 14 }
      : { width: compact ? 12 : 14, height: compact ? 13 : 16 };
  }
  if (viewportWidth < 1440) {
    return { width: compact ? 12 : 14, height: compact ? 14 : 16 };
  }
  return { width: compact ? 14 : 16, height: compact ? 16 : 20 };
}

// Detect if device is mobile (touch-primary)
function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  // Check touch capability and screen width
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isSmallScreen = window.innerWidth < 1024;
  return hasTouch && isSmallScreen;
}

// Get recommended initial zoom scale based on viewport
// Mobile devices benefit from starting zoomed in slightly for readability
function getDefaultZoomScale(viewportWidth: number): number {
  if (viewportWidth < 480) return 1.4;  // Small phones: zoom in for readability
  if (viewportWidth < 768) return 1.2;  // Larger phones: slight zoom
  return 1.0;                            // Tablets/desktop: standard zoom
}

export class CanvasSequenceGridRenderer {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private backBuffer: OffscreenCanvas | null = null;
  private backCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  private theme: Theme;
  private glyphAtlas: GlyphAtlas;
  private scroller: VirtualScroller;

  private baseCellWidth: number;  // Base cell size before zoom
  private baseCellHeight: number;
  private cellWidth: number;      // Effective cell size after zoom
  private cellHeight: number;
  private rowHeight: number;      // Effective row height (dual rows double this)
  private dpr: number;
  private zoomScale: number = 1.0;
  private currentZoomPreset: ZoomPreset;
  private enablePinchZoom: boolean;
  private onZoomChange?: (scale: number, preset: ZoomPreset) => void;
  private onVisibleRangeChange?: (range: VisibleRange) => void;

  // Pinch-to-zoom state
  private pinchStartDistance: number = 0;
  private pinchStartScale: number = 1.0;
  private isPinching: boolean = false;

  private currentState: GridRenderState | null = null;
  private dirtyRegions: DOMRect[] = [];
  private needsFullRedraw = true;

  private scanlines: boolean;
  private glow: boolean;
  private animationFrameId: number | null = null;
  private isRendering = false;
  private postProcess?: PostProcessPipeline;
  private reducedMotion: boolean;
  private snapToCodon: boolean;
  private densityMode: 'compact' | 'standard';
  private slowFrameLastLoggedAt = 0;
  private scanlinePattern: CanvasPattern | null = null;
  private scanlinePatternCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private paused = false;
  private isScrolling = false;
  private scrollEndTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderRange: VisibleRange | null = null;
  private lastRenderLayout: { cols: number; rows: number } | null = null;
  private lastScrollY: number | null = null;
  private lastScrollX: number | null = null;
  private lastViewport: { width: number; height: number } | null = null;
  private lastRowHeight: number = 0;
  private viewportWidth: number;
  private viewportHeight: number;
  private useNativeRaf: boolean;

  // Performance optimizations
  private encodedSequence: Uint8Array | null = null;
  private rowTileCache: Map<number, RowTile> = new Map();
  private maxCachedRows = 100; // LRU cache limit
  private lastContentHash = 0; // For detecting content changes
  private frameSkipCount = 0; // Track skipped frames for debugging
  private useTileCache = true; // Enable row tile caching
  private lastRenderedState: {
    viewMode: ViewMode;
    zoomScale: number;
    themeHash: number;
    diffEnabled: boolean;
  } | null = null;

  constructor(options: SequenceGridOptions) {
    this.canvas = options.canvas;
    this.theme = options.theme;
    this.scanlines = options.scanlines ?? false;
    this.glow = options.glow ?? false;
    this.postProcess = options.postProcess;
    this.reducedMotion = options.reducedMotion ?? false;
    this.enablePinchZoom = options.enablePinchZoom ?? true;
    this.onZoomChange = options.onZoomChange;
    this.onVisibleRangeChange = options.onVisibleRangeChange;
    this.snapToCodon = options.snapToCodon ?? false;
    this.densityMode = options.densityMode ?? 'standard';
    this.useNativeRaf = typeof globalThis.requestAnimationFrame === 'function';

    // Get device pixel ratio for high-DPI
    const rawDpr = options.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
    this.dpr = isMobileDevice() ? Math.min(rawDpr, 2) : rawDpr;

    // Initialize zoom scale - use mobile-aware default if not specified
    // This ensures mobile users start with readable cell sizes
    const defaultZoom = getDefaultZoomScale(options.viewportWidth ?? (this.isDomCanvas() ? this.canvas.clientWidth : 0));
    this.zoomScale = options.zoomScale ?? defaultZoom;
    this.currentZoomPreset = getZoomPresetForScale(this.zoomScale);

    // Use responsive BASE cell sizes (before zoom) with orientation awareness
    if (options.cellWidth !== undefined && options.cellHeight !== undefined) {
      this.baseCellWidth = options.cellWidth;
      this.baseCellHeight = options.cellHeight;
    } else {
      const responsiveSize = getResponsiveCellSize(
        options.viewportWidth ?? this.getViewportSize().width,
        options.viewportHeight ?? this.getViewportSize().height,
        this.densityMode
      );
      this.baseCellWidth = responsiveSize.width;
      this.baseCellHeight = responsiveSize.height;
    }

    // Apply zoom to get effective cell sizes
    this.cellWidth = Math.max(1, Math.round(this.baseCellWidth * this.zoomScale));
    this.cellHeight = Math.max(1, Math.round(this.baseCellHeight * this.zoomScale));
    this.rowHeight = this.cellHeight;

    // Get context
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;

    // Create glyph atlas with effective (zoomed) cell sizes
    this.glyphAtlas = new GlyphAtlas(this.theme, {
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      devicePixelRatio: this.dpr,
    });

    // Create virtual scroller (will be configured when sequence is set)
    this.scroller = new VirtualScroller({
      totalItems: 0,
      itemWidth: this.cellWidth,
      itemHeight: this.rowHeight,
      viewportWidth: options.viewportWidth ?? this.getViewportSize().width,
      viewportHeight: options.viewportHeight ?? this.getViewportSize().height,
    });
    this.updateCodonSnap();

    // Set up scroll callback with scroll state tracking for performance
    this.scroller.onScroll((range) => {
      // Mark as scrolling to disable expensive effects during animation
      this.isScrolling = true;
      if (this.scrollEndTimer) {
        clearTimeout(this.scrollEndTimer);
      }
      // End scrolling state after 150ms of inactivity, then do final quality render
      this.scrollEndTimer = setTimeout(() => {
        this.isScrolling = false;
        this.needsFullRedraw = true;
        this.scheduleRender(); // Final high-quality render after scroll stops
      }, 150);

      this.onVisibleRangeChange?.(range);
      this.scheduleRender();
    });

    // Initialize canvas size
    const initialViewport = this.getViewportSize(options.viewportWidth, options.viewportHeight);
    this.viewportWidth = initialViewport.width;
    this.viewportHeight = initialViewport.height;
    this.resize(initialViewport.width, initialViewport.height);
  }

  /**
   * Resize canvas to match container and handle DPI
   */
  resize(widthOverride?: number, heightOverride?: number): void {
    const rect = this.getViewportSize(widthOverride, heightOverride);
    const width = rect.width;
    const height = rect.height;
    this.viewportWidth = width;
    this.viewportHeight = height;

    // Recalculate responsive BASE cell sizes with orientation awareness
    const responsiveSize = getResponsiveCellSize(width, height, this.densityMode);
    this.baseCellWidth = responsiveSize.width;
    this.baseCellHeight = responsiveSize.height;

    // Apply zoom to get effective cell sizes
    this.updateCellSizes();

    // Set canvas size with DPI scaling
    this.canvas.width = width * this.dpr;
    this.canvas.height = height * this.dpr;

    // Reset any existing transform then scale for DPI
    if (typeof this.ctx.setTransform === 'function') {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    this.ctx.scale(this.dpr, this.dpr);

    // Create/resize back buffer
    this.createBackBuffer(width, height);

    // Update scroller viewport and cell sizes
    this.scroller.updateOptions({
      viewportWidth: width,
      viewportHeight: height,
      itemWidth: this.cellWidth,
      itemHeight: this.rowHeight,
    });
    this.updateCodonSnap();
    this.onVisibleRangeChange?.(this.scroller.getVisibleRange());

    // Mark as needing full redraw
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  setDensityMode(mode: 'compact' | 'standard'): void {
    if (this.densityMode === mode) return;
    this.densityMode = mode;
    const rect = this.getViewportSize();
    const width = rect.width;
    const height = rect.height;
    const responsiveSize = getResponsiveCellSize(width, height, this.densityMode);
    this.baseCellWidth = responsiveSize.width;
    this.baseCellHeight = responsiveSize.height;
    this.updateCellSizes();
    this.scroller.updateOptions({
      itemWidth: this.cellWidth,
      itemHeight: this.rowHeight,
      viewportWidth: width,
      viewportHeight: height,
    });
    this.onVisibleRangeChange?.(this.scroller.getVisibleRange());
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Update effective cell sizes based on zoom scale
   * Enforces minimum readable sizes on mobile devices
   */
  private updateCellSizes(): void {
    // Minimum cell sizes for readability on mobile (text needs ~8px minimum)
    const mobile = isMobileDevice();
    const compact = this.densityMode === 'compact';
    const minWidth = compact ? 4 : mobile ? 6 : 1;
    const minHeight = compact ? 5 : mobile ? 8 : 1;

    const newCellWidth = Math.max(minWidth, Math.round(this.baseCellWidth * this.zoomScale));
    const newCellHeight = Math.max(minHeight, Math.round(this.baseCellHeight * this.zoomScale));

    if (newCellWidth !== this.cellWidth || newCellHeight !== this.cellHeight) {
      this.cellWidth = newCellWidth;
      this.cellHeight = newCellHeight;
      this.rowHeight = this.currentState?.viewMode === 'dual' ? this.cellHeight * 2 : this.cellHeight;

      // Rebuild glyph atlas with new cell sizes
      this.glyphAtlas = new GlyphAtlas(this.theme, {
        cellWidth: this.cellWidth,
        cellHeight: this.cellHeight,
        devicePixelRatio: this.dpr,
      });
    }
    this.updateCodonSnap();
  }

  /**
   * Create double-buffer for smooth rendering
   */
  private createBackBuffer(width: number, height: number): void {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    if (typeof OffscreenCanvas === 'undefined') {
      this.backBuffer = null;
      this.backCtx = null;
      return;
    }

    const targetWidth = safeWidth * this.dpr;
    const targetHeight = safeHeight * this.dpr;

    if (!this.backBuffer) {
      this.backBuffer = new OffscreenCanvas(targetWidth, targetHeight);
    } else if (this.backBuffer.width !== targetWidth || this.backBuffer.height !== targetHeight) {
      this.backBuffer.width = targetWidth;
      this.backBuffer.height = targetHeight;
    }

    const ctx = this.backBuffer.getContext('2d', { alpha: false });
    if (!ctx) {
      this.backCtx = null;
      return;
    }
    this.backCtx = ctx;
    if (typeof ctx.setTransform === 'function') {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.scale(this.dpr, this.dpr);
  }

  /**
   * Set the sequence to render
   */
  setSequence(
    sequence: string,
    viewMode: ViewMode = 'dna',
    readingFrame: ReadingFrame = 0,
    aminoSequence: string | null = null
  ): void {
    // Encode sequence for fast O(1) lookups
    this.encodedSequence = encodeSequence(sequence);

    this.currentState = {
      sequence,
      aminoSequence,
      viewMode,
      readingFrame,
      diffSequence: null,
      diffEnabled: false,
      diffMask: null,
    };

    // Update row height for dual mode
    this.rowHeight = viewMode === 'dual' ? this.cellHeight * 2 : this.cellHeight;

    // Update scroller for new sequence length
    this.scroller.updateOptions({
      totalItems: sequence.length,
      itemHeight: this.rowHeight,
    });
    this.updateCodonSnap();
    this.onVisibleRangeChange?.(this.scroller.getVisibleRange());

    // Invalidate row tile cache on sequence change
    this.invalidateRowCache();
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Invalidate the row tile cache (on sequence/theme/zoom changes)
   */
  private invalidateRowCache(): void {
    this.rowTileCache.clear();
    this.lastContentHash = 0;
  }

  /**
   * Compute a simple hash for a row's content (for cache invalidation)
   */
  private computeRowHash(row: number, cols: number): number {
    if (!this.encodedSequence) return 0;
    const start = row * cols;
    const end = Math.min(start + cols, this.encodedSequence.length);
    // FNV-1a hash for fast content fingerprinting
    let hash = 2166136261;
    for (let i = start; i < end; i++) {
      hash ^= this.encodedSequence[i];
      hash = Math.imul(hash, 16777619);
    }
    // Include diff state in hash
    if (this.currentState?.diffEnabled && this.currentState.diffMask) {
      for (let i = start; i < end; i++) {
        hash ^= this.currentState.diffMask[i] ?? 0;
        hash = Math.imul(hash, 16777619);
      }
    }
    return hash >>> 0;
  }

  /**
   * Get or create a cached row tile
   * Returns null if tile caching is disabled or not applicable
   */
  private getRowTile(
    row: number,
    cols: number,
    rowHeight: number,
    viewMode: ViewMode
  ): RowTile | null {
    // Skip caching for very small cells (micro mode uses batch rendering instead)
    if (this.cellWidth <= 3 || this.cellHeight <= 3) return null;
    // Skip caching during scroll for immediate responsiveness
    if (this.isScrolling) return null;
    if (!this.useTileCache) return null;

    const hash = this.computeRowHash(row, cols);
    const cached = this.rowTileCache.get(row);

    // Return cached tile if content hash matches
    if (cached && cached.hash === hash) {
      cached.timestamp = performance.now(); // Update LRU timestamp
      return cached;
    }

    // Create new tile
    const tileWidth = cols * this.cellWidth;
    const tileHeight = rowHeight;
    const tile: RowTile = {
      canvas: new OffscreenCanvas(
        Math.max(1, tileWidth * this.dpr),
        Math.max(1, tileHeight * this.dpr)
      ),
      row,
      hash,
      timestamp: performance.now(),
    };

    // Render row to tile
    const tileCtx = tile.canvas.getContext('2d', { alpha: false });
    if (!tileCtx) return null;

    tileCtx.scale(this.dpr, this.dpr);
    this.renderRowToTile(tileCtx, row, cols, rowHeight, viewMode);

    // Store in cache with LRU eviction
    this.rowTileCache.set(row, tile);
    this.evictOldTiles();

    return tile;
  }

  /**
   * Render a single row to a tile canvas
   */
  private renderRowToTile(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    row: number,
    cols: number,
    rowHeight: number,
    viewMode: ViewMode
  ): void {
    if (!this.currentState || !this.encodedSequence) return;

    const { sequence, aminoSequence, diffSequence, diffEnabled, diffMask } = this.currentState;
    const { cellWidth } = this;
    const rowStart = row * cols;
    const rowEnd = Math.min(rowStart + cols, sequence.length);

    // Clear tile
    ctx.fillStyle = this.theme.colors.background;
    ctx.fillRect(0, 0, cols * cellWidth, rowHeight);

    if (viewMode === 'dual') {
      // Render DNA row at top, AA row at bottom
      this.renderRowCellsDual(ctx, row, cols, rowStart, rowEnd, sequence, aminoSequence ?? '', diffSequence, diffEnabled, diffMask);
    } else {
      // Single row mode
      this.renderRowCells(ctx, rowStart, rowEnd, sequence, viewMode, diffSequence, diffEnabled, diffMask);
    }
  }

  /**
   * Render cells for a single row (non-dual mode)
   */
  private renderRowCells(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    rowStart: number,
    rowEnd: number,
    sequence: string,
    viewMode: ViewMode,
    diffSequence: string | null,
    diffEnabled: boolean,
    diffMask: Uint8Array | null
  ): void {
    const { cellWidth, cellHeight } = this;
    const drawAmino = viewMode === 'aa';
    const validDiffMask = diffMask && diffMask.length === sequence.length ? diffMask : null;

    for (let i = rowStart; i < rowEnd; i++) {
      const col = i - rowStart;
      const x = col * cellWidth;
      const char = this.encodedSequence ? CODE_TO_CHAR[this.encodedSequence[i]] : sequence[i];

      let diffCode = 0;
      if (diffEnabled) {
        if (validDiffMask) {
          diffCode = validDiffMask[i] ?? 0;
        } else if (diffSequence) {
          diffCode = diffSequence[i] && diffSequence[i] !== char ? 1 : 0;
        }
      }

      if (diffCode > 0) {
        this.drawDiffRect(ctx, x, 0, cellWidth, cellHeight, diffCode);
      } else {
        if (drawAmino) {
          this.glyphAtlas.drawAminoAcid(ctx, char, x, 0, cellWidth, cellHeight);
        } else {
          this.glyphAtlas.drawNucleotide(ctx, char, x, 0, cellWidth, cellHeight);
        }
      }
    }
  }

  /**
   * Render cells for a dual-mode row (DNA + AA)
   */
  private renderRowCellsDual(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    _row: number,
    cols: number,
    rowStart: number,
    rowEnd: number,
    sequence: string,
    aminoSequence: string,
    diffSequence: string | null,
    diffEnabled: boolean,
    diffMask: Uint8Array | null
  ): void {
    const { cellWidth, cellHeight } = this;
    const validDiffMask = diffMask && diffMask.length === sequence.length ? diffMask : null;
    const rawFrame = this.currentState?.readingFrame ?? 0;
    const isReverse = rawFrame < 0;
    const forwardFrame: 0 | 1 | 2 = isReverse
      ? ((Math.abs(rawFrame) - 1) as 0 | 1 | 2)
      : (rawFrame as 0 | 1 | 2);
    const seqLength = sequence.length;

    // DNA row (top)
    for (let i = rowStart; i < rowEnd; i++) {
      const col = i - rowStart;
      const x = col * cellWidth;
      const char = this.encodedSequence ? CODE_TO_CHAR[this.encodedSequence[i]] : sequence[i];

      let diffCode = 0;
      if (diffEnabled) {
        if (validDiffMask) {
          diffCode = validDiffMask[i] ?? 0;
        } else if (diffSequence) {
          diffCode = diffSequence[i] && diffSequence[i] !== char ? 1 : 0;
        }
      }

      if (diffCode > 0) {
        this.drawDiffRect(ctx, x, 0, cellWidth, cellHeight * 2, diffCode);
      } else {
        this.glyphAtlas.drawNucleotide(ctx, char, x, 0, cellWidth, cellHeight);
      }
    }

    // AA row (bottom) - aligned to codons
    let aaRowStart = rowStart;
    if (!isReverse) {
      while ((aaRowStart - forwardFrame) % 3 !== 0) aaRowStart++;
    } else {
      while ((seqLength - 3 - aaRowStart - forwardFrame) % 3 !== 0) aaRowStart++;
    }

    ctx.strokeStyle = this.theme.colors.borderLight ?? '#374151';
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let i = aaRowStart; i < rowEnd; i += 3) {
      let aaIndex: number;
      if (!isReverse) {
        const codonOffset = i - forwardFrame;
        if (codonOffset < 0) continue;
        aaIndex = Math.floor(codonOffset / 3);
      } else {
        const rcStart = seqLength - 3 - i;
        const codonOffset = rcStart - forwardFrame;
        if (codonOffset < 0) continue;
        aaIndex = Math.floor(codonOffset / 3);
      }
      const aaChar = aminoSequence[aaIndex] ?? 'X';

      const col = i - rowStart;
      const x = col * cellWidth;
      const destWidth = Math.min(cellWidth * 3, (rowEnd - i) * cellWidth);
      this.glyphAtlas.drawAminoAcid(ctx, aaChar, x, cellHeight, destWidth, cellHeight);

      const lineX = x + destWidth;
      ctx.moveTo(lineX, 0);
      ctx.lineTo(lineX, cellHeight * 2);
    }
    ctx.stroke();

    // Separator line
    ctx.strokeStyle = this.theme.colors.border ?? '#4b5563';
    ctx.beginPath();
    ctx.moveTo(0, cellHeight);
    ctx.lineTo(cols * cellWidth, cellHeight);
    ctx.stroke();
  }

  /**
   * Evict oldest tiles when cache exceeds limit (LRU)
   */
  private evictOldTiles(): void {
    if (this.rowTileCache.size <= this.maxCachedRows) return;

    // Sort by timestamp and remove oldest
    const entries = Array.from(this.rowTileCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = entries.slice(0, entries.length - this.maxCachedRows);
    for (const [key] of toRemove) {
      this.rowTileCache.delete(key);
    }
  }

  /**
   * Batch render micro cells using fillRect batching for maximum performance
   * Used when cells are too small for text (genome overview mode)
   *
   * Note: We use fillRect batching instead of ImageData because:
   * - ImageData ignores canvas transforms (breaks DPI scaling)
   * - fillRect respects the canvas DPI transform
   * - Batching by color minimizes fillStyle changes (5 changes vs thousands)
   */
  private renderMicroBatch(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    range: VisibleRange,
    layout: { cols: number; rows: number }
  ): void {
    if (!this.currentState || !this.encodedSequence) return;

    const { startRow, endRow, offsetY } = range;
    const { cellWidth, cellHeight } = this;

    // Batch cells by nucleotide code for minimal fillStyle changes
    // Using arrays instead of Map for faster iteration
    const batches: Array<Array<{ x: number; y: number }>> = [[], [], [], [], []];

    for (let row = startRow; row < endRow; row++) {
      const rowY = (row - startRow) * cellHeight + offsetY;
      const rowStart = row * layout.cols;
      const rowEnd = Math.min(rowStart + layout.cols, this.encodedSequence.length);

      for (let i = rowStart; i < rowEnd; i++) {
        const col = i - rowStart;
        const x = col * cellWidth;
        const code = this.encodedSequence[i];
        // Bounds check for safety (code should always be 0-4)
        if (code >= 0 && code < 5) {
          batches[code].push({ x, y: rowY });
        }
      }
    }

    // Render each color batch - only 5 fillStyle changes total
    const colorKeys = ['A', 'C', 'G', 'T', 'N'] as const;
    for (let code = 0; code < 5; code++) {
      const batch = batches[code];
      if (batch.length === 0) continue;

      ctx.fillStyle = this.theme.nucleotides[colorKeys[code]].bg;
      for (let i = 0; i < batch.length; i++) {
        const cell = batch[i];
        ctx.fillRect(cell.x, cell.y, cellWidth, cellHeight);
      }
    }
  }

  /**
   * Enable diff mode with reference sequence
   */
  setDiffMode(refSequence: string | null, enabled: boolean, diffMask?: Uint8Array | null): void {
    if (this.currentState) {
      this.currentState.diffSequence = refSequence;
      this.currentState.diffEnabled = enabled;
      this.currentState.diffMask = diffMask ?? null;
      this.invalidateRowCache(); // Diff state affects row rendering
      this.needsFullRedraw = true;
      this.scheduleRender();
    }
  }

  /**
   * Update theme
   */
  setTheme(theme: Theme): void {
    this.theme = theme;
    this.glyphAtlas.setTheme(theme);
    this.invalidateRowCache(); // Theme change invalidates cached tiles
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Update reduced-motion preference
   */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Toggle scanlines effect without reconstructing renderer
   */
  setScanlines(enabled: boolean): void {
    this.scanlines = enabled;
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Toggle glow effect without reconstructing renderer
   */
  setGlow(enabled: boolean): void {
    this.glow = enabled;
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Toggle codon snapping (align scroll to multiples of 3 bases)
   */
  setSnapToCodon(enabled: boolean): void {
    this.snapToCodon = enabled;
    this.updateCodonSnap();
  }

  /**
   * Update post-processing pipeline
   */
  setPostProcess(pipeline?: PostProcessPipeline): void {
    this.postProcess = pipeline;
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Set zoom scale (0.1 to 4.0)
   * - 0.1-0.3: Ultra-dense genome view (1-3px cells)
   * - 0.3-0.6: Region view (3-7px cells)
   * - 0.6-1.5: Codon view (8-15px cells, text visible)
   * - 1.5-4.0: Base view (16-48px cells, large text)
   */
  setZoomScale(scale: number): void {
    const clampedScale = Math.max(0.1, Math.min(4.0, scale));
    if (clampedScale === this.zoomScale) return;

    this.zoomScale = clampedScale;
    this.currentZoomPreset = getZoomPresetForScale(clampedScale);

    // Update cell sizes based on new zoom
    this.updateCellSizes();

    // Recalculate row height if in dual mode
    this.rowHeight = this.currentState?.viewMode === 'dual' ? this.cellHeight * 2 : this.cellHeight;

    // Update scroller with new cell sizes
    this.scroller.updateOptions({
      itemWidth: this.cellWidth,
      itemHeight: this.rowHeight,
    });
    this.updateCodonSnap();
    this.onVisibleRangeChange?.(this.scroller.getVisibleRange());

    // Notify listeners
    if (this.onZoomChange) {
      this.onZoomChange(this.zoomScale, this.currentZoomPreset);
    }

    // Zoom change invalidates cached tiles (cell sizes changed)
    this.invalidateRowCache();
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Get current zoom scale
   */
  getZoomScale(): number {
    return this.zoomScale;
  }

  /**
   * Get current zoom preset
   */
  getZoomPreset(): ZoomPreset {
    return this.currentZoomPreset;
  }

  /**
   * Zoom in by a factor
   */
  zoomIn(factor = 1.3): void {
    this.setZoomScale(this.zoomScale * factor);
  }

  /**
   * Zoom out by a factor
   */
  zoomOut(factor = 1.3): void {
    this.setZoomScale(this.zoomScale / factor);
  }

  /**
   * Set zoom to a specific preset level
   */
  setZoomLevel(level: ZoomLevel): void {
    const presetScales: Record<ZoomLevel, number> = {
      genome: 0.15,
      micro: 0.45,
      region: 0.7,
      codon: 1.0,
      base: 2.0,
    };
    this.setZoomScale(presetScales[level]);
  }

  /**
   * Handle pinch gesture start (two-finger touch)
   */
  handlePinchStart(event: TouchEvent): void {
    if (!this.enablePinchZoom || event.touches.length !== 2) return;

    this.isPinching = true;
    this.pinchStartScale = this.zoomScale;
    this.pinchStartDistance = this.getTouchDistance(event.touches[0], event.touches[1]);
    this.scroller.stopMomentum(); // Stop any ongoing scroll
  }

  /**
   * Handle pinch gesture move
   */
  handlePinchMove(event: TouchEvent): void {
    if (!this.isPinching || event.touches.length !== 2) return;
    event.preventDefault();

    const currentDistance = this.getTouchDistance(event.touches[0], event.touches[1]);
    const scaleRatio = currentDistance / this.pinchStartDistance;
    const newScale = this.pinchStartScale * scaleRatio;

    this.setZoomScale(newScale);
  }

  /**
   * Handle pinch gesture end
   */
  handlePinchEnd(): void {
    this.isPinching = false;
  }

  /**
   * Calculate distance between two touch points
   */
  private getTouchDistance(touch1: Touch, touch2: Touch): number {
    const dx = touch2.clientX - touch1.clientX;
    const dy = touch2.clientY - touch1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Schedule a render on next animation frame
   */
  scheduleRender(): void {
    if (this.animationFrameId !== null || this.paused) return;

    this.animationFrameId = this.requestRaf(() => {
      this.animationFrameId = null;
      if (!this.paused) {
        this.render();
      }
    });
  }

  /**
   * Pause rendering (when component is offscreen or tab is hidden)
   */
  pause(): void {
    this.paused = true;
    if (this.animationFrameId !== null) {
      this.cancelRaf(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Resume rendering (when component becomes visible)
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Check if renderer is paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Main render loop
   */
  private render(): void {
    if (this.isRendering || !this.currentState) return;
    const { width: clientWidth, height: clientHeight } = this.getViewportSize();
    if (clientWidth === 0 || clientHeight === 0) {
      // Canvas not laid out yet; skip this frame
      return;
    }
    this.isRendering = true;

    const startTime = performance.now();
    const ctx = this.backCtx ?? this.ctx;
    const { sequence, aminoSequence, viewMode, diffSequence, diffEnabled, diffMask } = this.currentState;

    // Get visible range from scroller
    const range = this.scroller.getVisibleRange();
    const layout = this.scroller.getLayout();

    const rowHeight = viewMode === 'dual' ? this.cellHeight * 2 : this.cellHeight;

    // Attempt incremental scroll blit for smoother scrolling (renders only new rows).
    const didScrollBlit = this.tryScrollBlit(
      ctx,
      range,
      layout,
      rowHeight,
      sequence,
      aminoSequence,
      viewMode,
      diffSequence,
      diffEnabled,
      diffMask
    );

    if (!didScrollBlit) {
      // Always clear the back buffer before drawing to prevent ghosting during scroll.
      // The old approach only cleared on needsFullRedraw, but during scrolling the offsetY
      // changes frame-to-frame, leaving stale pixels at row edges. Clearing every frame
      // with the background color is cheap and eliminates flickering.
      ctx.fillStyle = this.theme.colors.background;
      ctx.fillRect(0, 0, clientWidth, clientHeight);
      this.needsFullRedraw = false;

      // Use optimized rendering path based on cell size
      const isMicroMode = this.cellWidth <= 5 && this.cellHeight <= 5 && !diffEnabled;

      if (isMicroMode && viewMode !== 'dual') {
        // Micro mode: use batch rendering for maximum performance
        this.renderMicroBatch(ctx, range, layout);
      } else {
        // Normal mode: use tile caching for larger cells
        this.renderVisibleRangeOptimized(ctx, range, layout, viewMode, rowHeight);
      }
    }

    // Apply scanline effect (skip during scroll for performance)
    if (this.scanlines && !this.reducedMotion && !this.isScrolling) {
      this.renderScanlines(ctx);
    }

    // Copy back buffer to main canvas (reset transform to avoid double-scaling).
    // IMPORTANT: If we have a WebGL post-process pipeline, apply it *after* the back buffer render
    // (or directly from backBuffer -> canvas), otherwise the back buffer copy would overwrite it.
    const shouldPostProcess = !!this.postProcess && !this.reducedMotion && !this.isScrolling;
    if (this.backBuffer && this.backCtx) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      const postProcessed = shouldPostProcess ? this.postProcess!.process(this.backBuffer, this.canvas) : false;
      if (!postProcessed) {
        this.ctx.drawImage(this.backBuffer, 0, 0);
      }
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // Restore DPR scaling
    } else if (shouldPostProcess) {
      // Ensure identity transform for the 2D context copy inside PostProcessPipeline.
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.postProcess!.process(this.canvas, this.canvas);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // Restore DPR scaling
    }

    // Performance tracking
    const endTime = performance.now();
    const frameTime = endTime - startTime;

    if (import.meta.env.DEV && frameTime > 16.67) {
      // Avoid console spam (which itself can hurt perf).
      if (endTime - this.slowFrameLastLoggedAt > 1000) {
        this.slowFrameLastLoggedAt = endTime;
        console.warn(`SequenceGrid slow frame: ${frameTime.toFixed(2)}ms (target: 16.67ms)`);
      }
    }

    // Track last render state for incremental scroll blits.
    this.lastRenderRange = range;
    this.lastRenderLayout = layout;
    this.lastScrollY = this.getScrollY(range, rowHeight);
    this.lastScrollX = this.getScrollX(range, layout.cols, this.cellWidth);
    this.lastViewport = { width: clientWidth, height: clientHeight };
    this.lastRowHeight = rowHeight;

    this.isRendering = false;
  }

  /**
   * Optimized rendering using tile caching
   * Renders rows from cache when possible, only creating new tiles for uncached rows
   */
  private renderVisibleRangeOptimized(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    range: VisibleRange,
    layout: { cols: number; rows: number },
    viewMode: ViewMode,
    rowHeight: number
  ): void {
    if (!this.currentState) return;

    const { startRow, endRow, offsetY } = range;
    const { sequence, aminoSequence, diffSequence, diffEnabled, diffMask } = this.currentState;

    // Try to use cached tiles for each row
    for (let row = startRow; row < endRow; row++) {
      const rowY = (row - startRow) * rowHeight + offsetY;
      const tile = this.getRowTile(row, layout.cols, rowHeight, viewMode);

      if (tile) {
        // Draw cached tile
        ctx.drawImage(
          tile.canvas,
          0, 0, tile.canvas.width, tile.canvas.height,
          0, rowY, layout.cols * this.cellWidth, rowHeight
        );
      } else {
        // Render row directly (no cache available or disabled)
        const rowStart = row * layout.cols;
        const rowEnd = Math.min(rowStart + layout.cols, sequence.length);

        if (viewMode === 'dual') {
          this.renderDualRows(
            ctx, range, layout, sequence, aminoSequence ?? '',
            diffSequence, diffEnabled, diffMask, row, row + 1
          );
        } else {
          // Inline render for uncached rows
          const drawAmino = viewMode === 'aa';
          const validDiffMask = diffMask && diffMask.length === sequence.length ? diffMask : null;

          for (let i = rowStart; i < rowEnd; i++) {
            const col = i - rowStart;
            const x = col * this.cellWidth;
            const char = this.encodedSequence ? CODE_TO_CHAR[this.encodedSequence[i]] : sequence[i];

            let diffCode = 0;
            if (diffEnabled) {
              if (validDiffMask) {
                diffCode = validDiffMask[i] ?? 0;
              } else if (diffSequence) {
                diffCode = diffSequence[i] && diffSequence[i] !== char ? 1 : 0;
              }
            }

            if (diffCode > 0) {
              this.drawDiffRect(ctx, x, rowY, this.cellWidth, this.cellHeight, diffCode);
            } else {
              if (drawAmino) {
                this.glyphAtlas.drawAminoAcid(ctx, char, x, rowY, this.cellWidth, this.cellHeight);
              } else {
                this.glyphAtlas.drawNucleotide(ctx, char, x, rowY, this.cellWidth, this.cellHeight);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Render the visible range of characters
   */
  private renderVisibleRange(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    range: VisibleRange,
    layout: { cols: number; rows: number },
    sequence: string,
    aminoSequence: string | null,
    viewMode: ViewMode,
    diffSequence: string | null,
    diffEnabled: boolean,
    diffMask: Uint8Array | null,
    rowStartOverride?: number,
    rowEndOverride?: number
  ): void {
    const { cellWidth, cellHeight } = this;
    const rowHeight = viewMode === 'dual' ? cellHeight * 2 : cellHeight;
    const { offsetY, startRow, endRow } = range;
    const renderStartRow = rowStartOverride ?? startRow;
    const renderEndRow = rowEndOverride ?? endRow;

    if (viewMode === 'dual') {
      this.renderDualRows(ctx, range, layout, sequence, aminoSequence ?? '', diffSequence, diffEnabled, diffMask, renderStartRow, renderEndRow);
      return;
    }

    const drawAmino = viewMode === 'aa';

    // Pre-calculate diff text settings (avoid setting font on every cell)
    const diffFontSize = Math.max(0, Math.floor(cellHeight * 0.7));
    // Always show text if cell is wide enough (10px), even if small
    const shouldDrawDiffText = cellWidth >= 10 && diffFontSize >= 6;

    // Collect diff cells for batch rendering
    const diffCells: Array<{ x: number; y: number; char: string; fillStyle: string }> = [];

    // Pre-validate diffMask length to avoid checking in inner loop
    const validDiffMask = diffMask && diffMask.length === sequence.length ? diffMask : null;

    // Track alpha state to avoid excessive context calls
    let currentAlpha = 1.0;

    // Render row by row
    for (let row = renderStartRow; row < renderEndRow; row++) {
      const rowY = (row - startRow) * rowHeight + offsetY;
      const rowStart = row * layout.cols;
      const rowEnd = Math.min(rowStart + layout.cols, sequence.length);

      // Diff coalescing state
      let pendingDiffStartCol = -1;
      let pendingDiffType = 0;

      for (let i = rowStart; i < rowEnd; i++) {
        const col = i - rowStart;
        const x = col * cellWidth;
        const char = sequence[i];

        let diffCode = 0;
        if (diffEnabled) {
          if (validDiffMask) {
            diffCode = validDiffMask[i] ?? 0;
          } else if (diffSequence) {
            diffCode = diffSequence[i] && diffSequence[i] !== char ? 1 : 0;
          }
        }

        if (diffCode > 0) {
          // Reset alpha for diffs (full visibility)
          if (currentAlpha !== 1.0) {
            ctx.globalAlpha = 1.0;
            currentAlpha = 1.0;
          }

          // Coalesce diffs
          if (diffCode !== pendingDiffType) {
            // Flush pending diff run
            if (pendingDiffStartCol !== -1) {
              const runWidth = (col - pendingDiffStartCol) * cellWidth;
              this.drawDiffRect(ctx, pendingDiffStartCol * cellWidth, rowY, runWidth, cellHeight, pendingDiffType);
            }
            pendingDiffStartCol = col;
            pendingDiffType = diffCode;
          }

          // Collect for batch text rendering
          if (shouldDrawDiffText) {
            let fillStyle: string;
            // For deletions (gaps), show gap marker character
            const displayChar = diffCode === 3 ? '−' : char;
            switch (diffCode) {
              case 1: fillStyle = this.theme.colors.diffHighlight ?? '#facc15'; break;
              case 2: fillStyle = '#22c55e'; break;
              case 3: fillStyle = '#ef4444'; break;
              default: fillStyle = this.theme.colors.diffHighlight ?? '#facc15';
            }
            diffCells.push({ x, y: rowY, char: displayChar, fillStyle });
          }
        } else {
          // Flush pending diff run if we hit non-diff
          if (pendingDiffStartCol !== -1) {
            // Ensure alpha is 1.0 for rect drawing (though we reset above, check just in case logic flows change)
            if (currentAlpha !== 1.0) {
              ctx.globalAlpha = 1.0;
              currentAlpha = 1.0;
            }
            const runWidth = (col - pendingDiffStartCol) * cellWidth;
            this.drawDiffRect(ctx, pendingDiffStartCol * cellWidth, rowY, runWidth, cellHeight, pendingDiffType);
            pendingDiffStartCol = -1;
            pendingDiffType = 0;
          }

          // In diff mode, render matched bases with reduced opacity (dimmed)
          if (diffEnabled) {
            if (currentAlpha !== 0.5) {
              ctx.globalAlpha = 0.5;
              currentAlpha = 0.5;
            }
          } else if (currentAlpha !== 1.0) {
             ctx.globalAlpha = 1.0;
             currentAlpha = 1.0;
          }

          if (drawAmino) {
            this.glyphAtlas.drawAminoAcid(ctx, char, x, rowY, cellWidth, cellHeight);
          } else {
            this.glyphAtlas.drawNucleotide(ctx, char, x, rowY, cellWidth, cellHeight);
          }
        }
      }

      // Flush pending diff at end of row
      if (pendingDiffStartCol !== -1) {
        if (currentAlpha !== 1.0) {
          ctx.globalAlpha = 1.0;
          currentAlpha = 1.0;
        }
        const runWidth = ((rowEnd - rowStart) - pendingDiffStartCol) * cellWidth;
        this.drawDiffRect(ctx, pendingDiffStartCol * cellWidth, rowY, runWidth, cellHeight, pendingDiffType);
      }
    }

    // Ensure alpha is reset after loop
    if (currentAlpha !== 1.0) {
      ctx.globalAlpha = 1.0;
    }

    // Batch render diff text with proper save/restore
    if (diffCells.length > 0) {
      const contrastCache = new Map<string, string>();
      const getContrastText = (bg: string): string => {
        const cached = contrastCache.get(bg);
        if (cached) return cached;
        let r = 255;
        let g = 255;
        let b = 255;

        if (bg.startsWith('#')) {
          const hex = bg.slice(1);
          if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
          } else if (hex.length === 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
          }
        } else if (bg.startsWith('rgb')) {
          const match = bg.match(/rgba?\(([^)]+)\)/);
          if (match) {
            const parts = match[1].split(',').map((v) => Number.parseFloat(v.trim()));
            if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) {
              [r, g, b] = parts;
            }
          }
        }

        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const text = luminance > 0.6 ? '#0b0b0b' : '#ffffff';
        contrastCache.set(bg, text);
        return text;
      };

      ctx.save();
      ctx.font = `bold ${diffFontSize}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      let lastFillStyle = '';
      for (const cell of diffCells) {
        if (cell.fillStyle !== lastFillStyle) {
          ctx.fillStyle = getContrastText(cell.fillStyle);
          lastFillStyle = cell.fillStyle;
        }
        ctx.fillText(cell.char, cell.x + cellWidth / 2, cell.y + cellHeight / 2);
      }

      ctx.restore();
    }
  }

  private drawDiffRect(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    diffCode: number
  ): void {
    let fillStyle: string;
    switch (diffCode) {
      case 1: fillStyle = this.theme.colors.diffHighlight ?? '#facc15'; break;
      case 2: fillStyle = '#22c55e'; break;
      case 3: fillStyle = '#ef4444'; break;
      default: fillStyle = this.theme.colors.diffHighlight ?? '#facc15';
    }

    // Skip expensive glow effect during scroll for 60fps performance
    // Glow is re-applied in final render after scroll stops
    if (this.glow && !this.reducedMotion && !this.isScrolling && this.cellWidth >= 10 && this.cellHeight >= 10) {
      const blur = Math.max(2, Math.min(10, Math.round(this.cellHeight * 0.35)));
      ctx.save();
      ctx.shadowColor = fillStyle;
      ctx.shadowBlur = blur;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = fillStyle;
      ctx.fillRect(x, y, width, height);
      ctx.restore();
    }

    ctx.fillStyle = fillStyle;
    ctx.fillRect(x, y, width, height);
  }

  /**
   * Render dual-row DNA + AA view
   */
  private renderDualRows(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    range: VisibleRange,
    layout: { cols: number; rows: number },
    sequence: string,
    aminoSequence: string,
    diffSequence: string | null,
    diffEnabled: boolean,
    diffMask: Uint8Array | null,
    rowStartOverride?: number,
    rowEndOverride?: number
  ): void {
    const { cellWidth, cellHeight } = this;
    const rowHeight = cellHeight * 2;
    const { offsetY, startRow, endRow } = range;
    const renderStartRow = rowStartOverride ?? startRow;
    const renderEndRow = rowEndOverride ?? endRow;
    const rawFrame = this.currentState?.readingFrame ?? 0;
    const isReverse = rawFrame < 0;
    const forwardFrame: 0 | 1 | 2 = isReverse
      ? ((Math.abs(rawFrame) - 1) as 0 | 1 | 2)
      : (rawFrame as 0 | 1 | 2);
    const seqLength = sequence.length;
    const validDiffMask = diffMask && diffMask.length === sequence.length ? diffMask : null;

    let currentAlpha = 1.0;

    for (let row = renderStartRow; row < renderEndRow; row++) {
      const rowY = (row - startRow) * rowHeight + offsetY;
      const rowStart = row * layout.cols;
      const rowEnd = Math.min(rowStart + layout.cols, sequence.length);

      // First pass: nucleotides (top row)
      let pendingDiffStartCol = -1;
      let pendingDiffType = 0;

      for (let i = rowStart; i < rowEnd; i++) {
        const col = i - rowStart;
        const x = col * cellWidth;
        const char = sequence[i];

        let diffCode = 0;
        if (diffEnabled) {
          if (validDiffMask) {
            diffCode = validDiffMask[i] ?? 0;
          } else if (diffSequence) {
            diffCode = diffSequence[i] && diffSequence[i] !== char ? 1 : 0;
          }
        }

        if (diffCode > 0) {
          if (currentAlpha !== 1.0) {
            ctx.globalAlpha = 1.0;
            currentAlpha = 1.0;
          }

          if (diffCode !== pendingDiffType) {
            if (pendingDiffStartCol !== -1) {
              const runWidth = (col - pendingDiffStartCol) * cellWidth;
              this.drawDiffRect(ctx, pendingDiffStartCol * cellWidth, rowY, runWidth, rowHeight, pendingDiffType);
            }
            pendingDiffStartCol = col;
            pendingDiffType = diffCode;
          }
          // Draw gap marker for deletions in dual mode
          if (diffCode === 3 && cellWidth >= 10) {
            ctx.save();
            ctx.font = `bold ${Math.floor(cellHeight * 0.7)}px 'JetBrains Mono', monospace`;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('−', x + cellWidth / 2, rowY + cellHeight / 2);
            ctx.restore();
          }
        } else {
          if (pendingDiffStartCol !== -1) {
            if (currentAlpha !== 1.0) {
              ctx.globalAlpha = 1.0;
              currentAlpha = 1.0;
            }
            const runWidth = (col - pendingDiffStartCol) * cellWidth;
            this.drawDiffRect(ctx, pendingDiffStartCol * cellWidth, rowY, runWidth, rowHeight, pendingDiffType);
            pendingDiffStartCol = -1;
            pendingDiffType = 0;
          }
          // In diff mode, render matched bases with reduced opacity (dimmed)
          if (diffEnabled) {
            if (currentAlpha !== 0.5) {
              ctx.globalAlpha = 0.5;
              currentAlpha = 0.5;
            }
          } else if (currentAlpha !== 1.0) {
             ctx.globalAlpha = 1.0;
             currentAlpha = 1.0;
          }
          this.glyphAtlas.drawNucleotide(ctx, char, x, rowY, cellWidth, cellHeight);
        }
      }
      if (pendingDiffStartCol !== -1) {
        if (currentAlpha !== 1.0) {
          ctx.globalAlpha = 1.0;
          currentAlpha = 1.0;
        }
        const runWidth = ((rowEnd - rowStart) - pendingDiffStartCol) * cellWidth;
        this.drawDiffRect(ctx, pendingDiffStartCol * cellWidth, rowY, runWidth, rowHeight, pendingDiffType);
      }

      if (currentAlpha !== 1.0) {
        ctx.globalAlpha = 1.0;
        currentAlpha = 1.0;
      }

      // Second pass: amino acids (bottom row)
      let aaRowStart = rowStart;
      if (!isReverse) {
        while ((aaRowStart - forwardFrame) % 3 !== 0) aaRowStart++;
      } else {
        while ((seqLength - 3 - aaRowStart - forwardFrame) % 3 !== 0) aaRowStart++;
      }

      // Batch codon boundary lines
      ctx.strokeStyle = this.theme.colors.borderLight ?? '#374151';
      ctx.lineWidth = 1;
      ctx.beginPath();

      for (let i = aaRowStart; i < rowEnd; i += 3) {
        let aaIndex: number;
        if (!isReverse) {
          const codonOffset = i - forwardFrame;
          if (codonOffset < 0) continue;
          aaIndex = Math.floor(codonOffset / 3);
        } else {
          const rcStart = seqLength - 3 - i;
          const codonOffset = rcStart - forwardFrame;
          if (codonOffset < 0) continue;
          aaIndex = Math.floor(codonOffset / 3);
        }
        const aaChar = aminoSequence[aaIndex] ?? 'X';

        const col = i - rowStart;
        const x = col * cellWidth;
        const destWidth = Math.min(cellWidth * 3, (rowEnd - i) * cellWidth);
        this.glyphAtlas.drawAminoAcid(ctx, aaChar, x, rowY + cellHeight, destWidth, cellHeight);

        // Add line to batch
        const lineX = x + destWidth;
        ctx.moveTo(lineX, rowY);
        ctx.lineTo(lineX, rowY + rowHeight);
      }
      
      ctx.stroke();

      // Separator between DNA and AA rows
      ctx.strokeStyle = this.theme.colors.border ?? '#4b5563';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, rowY + cellHeight);
      ctx.lineTo(layout.cols * cellWidth, rowY + cellHeight);
      ctx.stroke();
    }
  }

  /**
   * Update scroller snapping for codon boundaries (align start index to multiples of 3)
   */
  private updateCodonSnap(): void {
    if (!this.snapToCodon) {
      this.scroller.setSnapToMultiple(null);
      return;
    }
    const { cols } = this.scroller.getLayout();
    const g = this.gcd(cols, 3);
    // Use integer division to ensure rowsPerSnap is always an integer
    // (g is always 1 or 3 since it's gcd with 3, so 3/g is already integer, but be explicit)
    const rowsPerSnap = Math.max(1, Math.floor(3 / g));
    this.scroller.setSnapToMultiple(rowsPerSnap);
  }

  private getScrollY(range: VisibleRange, rowHeight: number): number {
    return range.startRow * rowHeight - range.offsetY;
  }

  private getScrollX(range: VisibleRange, cols: number, itemWidth: number): number {
    const startCol = range.startIndex - range.startRow * cols;
    return startCol * itemWidth - range.offsetX;
  }

  private tryScrollBlit(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    range: VisibleRange,
    layout: { cols: number; rows: number },
    rowHeight: number,
    sequence: string,
    aminoSequence: string | null,
    viewMode: ViewMode,
    diffSequence: string | null,
    diffEnabled: boolean,
    diffMask: Uint8Array | null
  ): boolean {
    if (this.needsFullRedraw || !this.isScrolling) return false;
    if (!this.lastRenderRange || !this.lastRenderLayout || !this.lastViewport) return false;
    const { width: clientWidth, height: clientHeight } = this.getViewportSize();
    if (clientWidth === 0 || clientHeight === 0) return false;
    if (this.lastViewport.width !== clientWidth || this.lastViewport.height !== clientHeight) return false;
    if (this.lastRowHeight !== rowHeight) return false;
    if (this.lastRenderLayout.cols !== layout.cols || this.lastRenderLayout.rows !== layout.rows) return false;

    const currentScrollY = this.getScrollY(range, rowHeight);
    const lastScrollY = this.lastScrollY ?? currentScrollY;
    const deltaY = lastScrollY - currentScrollY;
    if (Math.abs(deltaY) < 0.5) return false;
    if (Math.abs(deltaY) >= clientHeight) return false;

    const currentScrollX = this.getScrollX(range, layout.cols, this.cellWidth);
    const lastScrollX = this.lastScrollX ?? currentScrollX;
    const deltaX = lastScrollX - currentScrollX;
    if (Math.abs(deltaX) > 0.5) return false;

    // Shift previous frame into the back buffer. Use the main canvas as source.
    // NOTE: This may include post-process artifacts from the last non-scroll frame,
    // but we skip heavy effects while scrolling, so this keeps motion smooth.
    const source = this.canvas;
    ctx.drawImage(
      source,
      0,
      0,
      source.width,
      source.height,
      0,
      deltaY,
      clientWidth,
      clientHeight
    );

    // Clear the newly exposed region and redraw only the affected rows.
    ctx.fillStyle = this.theme.colors.background;
    const exposedHeight = Math.min(clientHeight, Math.abs(deltaY));
    const rowsToRender = Math.min(
      range.endRow - range.startRow,
      Math.ceil(exposedHeight / Math.max(1, rowHeight)) + 1
    );

    if (deltaY < 0) {
      // Scrolling down: new content appears at the bottom
      ctx.fillRect(0, clientHeight - exposedHeight, clientWidth, exposedHeight);
      const renderStart = Math.max(range.startRow, range.endRow - rowsToRender);
      this.renderVisibleRange(
        ctx,
        range,
        layout,
        sequence,
        aminoSequence,
        viewMode,
        diffSequence,
        diffEnabled,
        diffMask,
        renderStart,
        range.endRow
      );
    } else {
      // Scrolling up: new content appears at the top
      ctx.fillRect(0, 0, clientWidth, exposedHeight);
      const renderEnd = Math.min(range.endRow, range.startRow + rowsToRender);
      this.renderVisibleRange(
        ctx,
        range,
        layout,
        sequence,
        aminoSequence,
        viewMode,
        diffSequence,
        diffEnabled,
        diffMask,
        range.startRow,
        renderEnd
      );
    }

    this.needsFullRedraw = false;
    return true;
  }

  private gcd(a: number, b: number): number {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y !== 0) {
      const t = y;
      y = x % y;
      x = t;
    }
    return x || 1;
  }

  /**
   * Render scanline overlay effect
   */
  private renderScanlines(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
    const { width, height } = this.getViewportSize();

    this.ensureScanlinePattern(ctx);
    if (this.scanlinePattern) {
      ctx.fillStyle = this.scanlinePattern;
      ctx.fillRect(0, 0, width, height);
      return;
    }

    // Fallback: draw individual scanlines (should be rare).
    ctx.fillStyle = 'rgba(0, 0, 0, 0.015)';
    for (let y = 0; y < height; y += 2) {
      ctx.fillRect(0, y, width, 1);
    }
  }

  private ensureScanlinePattern(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
    if (this.scanlinePattern && this.scanlinePatternCtx === ctx) return;
    const patternCanvas = typeof document !== 'undefined'
      ? document.createElement('canvas')
      : typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 2)
        : null;
    if (!patternCanvas) return;
    patternCanvas.width = 1;
    patternCanvas.height = 2;
    const patternCtx = patternCanvas.getContext('2d');
    if (!patternCtx) return;

    patternCtx.clearRect(0, 0, 1, 2);
    patternCtx.fillStyle = 'rgba(0, 0, 0, 0.015)';
    patternCtx.fillRect(0, 0, 1, 1);

    this.scanlinePattern = ctx.createPattern(patternCanvas, 'repeat');
    this.scanlinePatternCtx = ctx;
  }

  /**
   * Mark a region as dirty (needs redraw)
   */
  markDirty(region?: DOMRect): void {
    if (region) {
      this.dirtyRegions.push(region);
    } else {
      this.needsFullRedraw = true;
    }
    this.scheduleRender();
  }

  /**
   * Handle wheel events
   */
  handleWheel(event: WheelEvent): void {
    this.scroller.handleWheel(event);
  }

  /**
   * Handle wheel deltas (worker-safe)
   */
  handleWheelDelta(deltaX: number, deltaY: number, deltaMode: 0 | 1 | 2 = 0): void {
    this.scroller.handleWheelDelta(deltaX, deltaY, deltaMode);
  }

  /**
   * Handle touch start (for mobile scrolling or pinch-to-zoom)
   */
  handleTouchStart(event: TouchEvent): void {
    // Two fingers = pinch-to-zoom
    if (event.touches.length === 2) {
      this.handlePinchStart(event);
      return;
    }
    // One finger = scroll
    if (event.touches.length === 1) {
      this.scroller.handleTouchStart(event);
    }
  }

  /**
   * Handle touch start with points (worker-safe)
   */
  handleTouchStartPoints(points: Array<{ x: number; y: number }>): void {
    if (points.length === 2) {
      this.isPinching = true;
      this.pinchStartScale = this.zoomScale;
      this.pinchStartDistance = this.getPointDistance(points[0], points[1]);
      this.scroller.stopMomentum();
      return;
    }
    if (points.length === 1) {
      this.scroller.handleTouchStartPoint(points[0].x, points[0].y);
    }
  }

  /**
   * Handle touch move (for mobile scrolling or pinch-to-zoom)
   */
  handleTouchMove(event: TouchEvent): void {
    // Handle pinch
    if (this.isPinching && event.touches.length === 2) {
      this.handlePinchMove(event);
      return;
    }
    // Handle scroll
    if (!this.isPinching && event.touches.length === 1) {
      this.scroller.handleTouchMove(event);
      this.scheduleRender();
    }
  }

  /**
   * Handle touch move with points (worker-safe)
   */
  handleTouchMovePoints(points: Array<{ x: number; y: number }>): void {
    if (this.isPinching && points.length === 2) {
      const currentDistance = this.getPointDistance(points[0], points[1]);
      const scaleRatio = currentDistance / Math.max(1, this.pinchStartDistance);
      const newScale = this.pinchStartScale * scaleRatio;
      this.setZoomScale(newScale);
      return;
    }
    if (!this.isPinching && points.length === 1) {
      this.scroller.handleTouchMovePoint(points[0].x, points[0].y);
      this.scheduleRender();
    }
  }

  /**
   * Handle touch end (for mobile momentum or end pinch)
   */
  handleTouchEnd(event: TouchEvent): void {
    void event; // Parameter required by interface but not used internally
    if (this.isPinching) {
      this.handlePinchEnd();
      return;
    }
    this.scroller.handleTouchEnd();
  }

  /**
   * Handle touch end (worker-safe)
   */
  handleTouchEndPoints(): void {
    if (this.isPinching) {
      this.handlePinchEnd();
      return;
    }
    this.scroller.handleTouchEnd();
  }

  private getPointDistance(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Scroll to a specific position in the sequence
   */
  scrollToPosition(position: number, center: boolean = true): void {
    this.scroller.scrollToIndex(position, center);
  }

  /**
   * Scroll to start
   */
  scrollToStart(): void {
    this.scroller.scrollToStart();
  }

  /**
   * Scroll to end
   */
  scrollToEnd(): void {
    this.scroller.scrollToEnd();
  }

  /**
   * Get the index at viewport coordinates
   */
  getIndexAtPoint(x: number, y: number): number | null {
    return this.scroller.getIndexAtPoint(x, y);
  }

  /**
   * Get current scroll position
   */
  getScrollPosition(): number {
    const state = this.scroller.getScrollState();
    const layout = this.scroller.getLayout();
    const rowHeight = Math.max(1, this.rowHeight);
    const row = Math.floor(state.scrollY / rowHeight);
    return row * layout.cols;
  }

  /**
   * Get visible range info
   */
  getVisibleRange(): VisibleRange {
    return this.scroller.getVisibleRange();
  }

  /**
   * Get layout info
   */
  getLayout(): { cols: number; rows: number; totalHeight: number; totalWidth: number } {
    return this.scroller.getLayout();
  }

  /**
   * Get current cell metrics
   */
  getCellMetrics(): { cellWidth: number; cellHeight: number; rowHeight: number } {
    return {
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      rowHeight: this.rowHeight,
    };
  }

  /**
   * Cleanup
   */
  dispose(): void {
    if (this.animationFrameId !== null) {
      this.cancelRaf(this.animationFrameId);
    }
    if (this.scrollEndTimer !== null) {
      clearTimeout(this.scrollEndTimer);
    }
    this.scroller.dispose();
  }

  private requestRaf(callback: FrameRequestCallback): number {
    if (this.useNativeRaf) {
      return globalThis.requestAnimationFrame(callback);
    }
    return globalThis.setTimeout(() => callback(performance.now()), 16);
  }

  private cancelRaf(handle: number): void {
    if (this.useNativeRaf) {
      globalThis.cancelAnimationFrame(handle);
      return;
    }
    globalThis.clearTimeout(handle);
  }

  private getViewportSize(widthOverride?: number, heightOverride?: number): { width: number; height: number } {
    const width = widthOverride ?? (this.viewportWidth ?? 0);
    const height = heightOverride ?? (this.viewportHeight ?? 0);

    if (width && height) {
      return { width, height };
    }

    if (this.isDomCanvas()) {
      const rect = this.canvas.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }

    return {
      width: (this.canvas.width ?? 0) / Math.max(1, this.dpr),
      height: (this.canvas.height ?? 0) / Math.max(1, this.dpr),
    };
  }

  private isDomCanvas(): this is { canvas: HTMLCanvasElement } {
    return typeof (this.canvas as HTMLCanvasElement).getBoundingClientRect === 'function';
  }
}

export default CanvasSequenceGridRenderer;
