/**
 * CanvasSequenceGridRenderer - Main Rendering Engine
 *
 * High-performance canvas renderer for genome sequence grids.
 * Features: double-buffering, dirty region tracking, color batching,
 * high-DPI support, and 60fps target rendering.
 */

import type { Theme, ViewMode, ReadingFrame } from '@phage-explorer/core';
import { GlyphAtlas } from './GlyphAtlas';
import { VirtualScroller, type VisibleRange } from './VirtualScroller';
import { PostProcessPipeline, type PostProcessOptions } from './PostProcessPipeline';

export interface SequenceGridOptions {
  /** Canvas element to render to */
  canvas: HTMLCanvasElement;
  /** Initial theme */
  theme: Theme;
  /** Cell width in CSS pixels */
  cellWidth?: number;
  /** Cell height in CSS pixels */
  cellHeight?: number;
  /** Enable scanline effect */
  scanlines?: boolean;
  /** Enable glow effect */
  glow?: boolean;
  /** Optional post-processing pipeline */
  postProcess?: PostProcessPipeline;
  /** Reduced motion flag */
  reducedMotion?: boolean;
}

export interface GridRenderState {
  sequence: string;
  viewMode: ViewMode;
  readingFrame: ReadingFrame;
  diffSequence: string | null;
  diffEnabled: boolean;
}

const DEFAULT_CELL_WIDTH = 16;
const DEFAULT_CELL_HEIGHT = 20;

export class CanvasSequenceGridRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private backBuffer: OffscreenCanvas | null = null;
  private backCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  private theme: Theme;
  private glyphAtlas: GlyphAtlas;
  private scroller: VirtualScroller;

  private cellWidth: number;
  private cellHeight: number;
  private dpr: number;

  private currentState: GridRenderState | null = null;
  private dirtyRegions: DOMRect[] = [];
  private needsFullRedraw = true;

  private scanlines: boolean;
  private glow: boolean;
  private animationFrameId: number | null = null;
  private isRendering = false;
  private postProcess?: PostProcessPipeline;
  private reducedMotion: boolean;

  constructor(options: SequenceGridOptions) {
    this.canvas = options.canvas;
    this.theme = options.theme;
    this.cellWidth = options.cellWidth ?? DEFAULT_CELL_WIDTH;
    this.cellHeight = options.cellHeight ?? DEFAULT_CELL_HEIGHT;
    this.scanlines = options.scanlines ?? true;
    this.glow = options.glow ?? false;
    this.postProcess = options.postProcess;
    this.reducedMotion = options.reducedMotion ?? false;

    // Get device pixel ratio for high-DPI
    this.dpr = window.devicePixelRatio || 1;

    // Get context
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;

    // Create glyph atlas
    this.glyphAtlas = new GlyphAtlas(this.theme, {
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      devicePixelRatio: this.dpr,
    });

    // Create virtual scroller (will be configured when sequence is set)
    this.scroller = new VirtualScroller({
      totalItems: 0,
      itemWidth: this.cellWidth,
      itemHeight: this.cellHeight,
      viewportWidth: this.canvas.clientWidth,
      viewportHeight: this.canvas.clientHeight,
    });

    // Set up scroll callback
    this.scroller.onScroll(() => this.scheduleRender());

    // Initialize canvas size
    this.resize();
  }

  /**
   * Resize canvas to match container and handle DPI
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

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

    // Update scroller viewport
    this.scroller.updateOptions({
      viewportWidth: width,
      viewportHeight: height,
    });

    // Mark as needing full redraw
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Create double-buffer for smooth rendering
   */
  private createBackBuffer(width: number, height: number): void {
    if (typeof OffscreenCanvas !== 'undefined') {
      this.backBuffer = new OffscreenCanvas(width * this.dpr, height * this.dpr);
      const ctx = this.backBuffer.getContext('2d', { alpha: false });
      if (ctx) {
        this.backCtx = ctx;
        if (typeof ctx.setTransform === 'function') {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        ctx.scale(this.dpr, this.dpr);
      }
    }
  }

  /**
   * Set the sequence to render
   */
  setSequence(
    sequence: string,
    viewMode: ViewMode = 'dna',
    readingFrame: ReadingFrame = 0
  ): void {
    this.currentState = {
      sequence,
      viewMode,
      readingFrame,
      diffSequence: null,
      diffEnabled: false,
    };

    // Update scroller for new sequence length
    this.scroller.updateOptions({
      totalItems: sequence.length,
    });

    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Enable diff mode with reference sequence
   */
  setDiffMode(refSequence: string | null, enabled: boolean): void {
    if (this.currentState) {
      this.currentState.diffSequence = refSequence;
      this.currentState.diffEnabled = enabled;
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
   * Update post-processing pipeline
   */
  setPostProcess(pipeline?: PostProcessPipeline): void {
    this.postProcess = pipeline;
    this.needsFullRedraw = true;
    this.scheduleRender();
  }

  /**
   * Schedule a render on next animation frame
   */
  scheduleRender(): void {
    if (this.animationFrameId !== null) return;

    this.animationFrameId = requestAnimationFrame(() => {
      this.animationFrameId = null;
      this.render();
    });
  }

  /**
   * Main render loop
   */
  private render(): void {
    if (this.isRendering || !this.currentState) return;
    this.isRendering = true;

    const startTime = performance.now();
    const ctx = this.backCtx ?? this.ctx;
    const { sequence, viewMode, diffSequence, diffEnabled } = this.currentState;

    // Get visible range from scroller
    const range = this.scroller.getVisibleRange();
    const layout = this.scroller.getLayout();

    // Clear or redraw only dirty regions
    if (this.needsFullRedraw) {
      ctx.fillStyle = this.theme.colors.background;
      ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
      this.needsFullRedraw = false;
    }

    // Render visible characters
    this.renderVisibleRange(ctx, range, layout, sequence, viewMode, diffSequence, diffEnabled);

    // Apply scanline effect
    if (this.scanlines && !this.reducedMotion) {
      this.renderScanlines(ctx);
    }

    // Post-processing hook (no-op if not provided)
    if (this.postProcess && !this.reducedMotion) {
      this.postProcess.process(this.canvas);
    }

    // Copy back buffer to main canvas
    if (this.backBuffer && this.backCtx) {
      this.ctx.drawImage(this.backBuffer, 0, 0);
    }

    // Performance tracking
    const endTime = performance.now();
    const frameTime = endTime - startTime;

    if (frameTime > 16.67) {
      console.warn(`Frame took ${frameTime.toFixed(2)}ms (target: 16.67ms)`);
    }

    this.isRendering = false;
  }

  /**
   * Render the visible range of characters
   */
  private renderVisibleRange(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    range: VisibleRange,
    layout: { cols: number; rows: number },
    sequence: string,
    viewMode: ViewMode,
    diffSequence: string | null,
    diffEnabled: boolean
  ): void {
    const { cellWidth, cellHeight } = this;
    const { offsetY, startRow, endRow } = range;

    // Batch rendering by color for performance
    const drawMethod = viewMode === 'aa'
      ? this.glyphAtlas.drawAminoAcid.bind(this.glyphAtlas)
      : this.glyphAtlas.drawNucleotide.bind(this.glyphAtlas);

    // Render row by row
    for (let row = startRow; row < endRow; row++) {
      const rowY = (row - startRow) * cellHeight + offsetY;
      const rowStart = row * layout.cols;
      const rowEnd = Math.min(rowStart + layout.cols, sequence.length);

      for (let i = rowStart; i < rowEnd; i++) {
        const col = i - rowStart;
        const x = col * cellWidth;
        const char = sequence[i];

        // Check for diff highlighting
        const isDiff = diffEnabled && diffSequence && diffSequence[i] !== char;

        if (isDiff) {
          // Draw diff background
          ctx.fillStyle = this.theme.colors.diffHighlight;
          ctx.fillRect(x, rowY, cellWidth, cellHeight);

          // Draw character on diff background
          ctx.font = `bold ${14}px 'JetBrains Mono', monospace`;
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(char, x + cellWidth / 2, rowY + cellHeight / 2);
        } else {
          // Use glyph atlas for normal rendering
          drawMethod(ctx, char, x, rowY, cellWidth, cellHeight);
        }
      }
    }
  }

  /**
   * Render scanline overlay effect
   */
  private renderScanlines(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.03)';
    for (let y = 0; y < height; y += 2) {
      ctx.fillRect(0, y, width, 1);
    }
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
   * Scroll to a specific position in the sequence
   */
  scrollToPosition(position: number): void {
    this.scroller.scrollToIndex(position);
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
    const row = Math.floor(state.scrollY / this.cellHeight);
    return row * layout.cols;
  }

  /**
   * Get visible range info
   */
  getVisibleRange(): VisibleRange {
    return this.scroller.getVisibleRange();
  }

  /**
   * Cleanup
   */
  dispose(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.scroller.dispose();
  }
}

export default CanvasSequenceGridRenderer;
