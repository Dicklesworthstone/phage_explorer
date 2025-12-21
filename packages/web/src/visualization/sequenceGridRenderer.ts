import { translateCodon } from '@phage-explorer/core';
import type {
  GlyphMetrics,
  RenderFrameInput,
  SequenceGridRendererOptions,
  SequenceSource,
  SequenceWindow,
} from './types';
import { VirtualScroller } from './virtualScroller';
import type { GlyphAtlas } from './glyphAtlas';

import type { Theme } from '@phage-explorer/core';

export class SequenceGridRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly glyphAtlas: GlyphAtlas;
  private readonly dpr: number;
  private source: SequenceSource | null = null;
  private rowHeight: number;

  constructor(options: SequenceGridRendererOptions) {
    this.canvas = options.canvas;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context for sequence grid');
    }
    this.ctx = ctx;
    this.glyphAtlas = options.glyphAtlas;
    this.dpr = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    const metrics = this.glyphAtlas.getMetrics();
    this.rowHeight = metrics.height;
  }

  attachSource(source: SequenceSource) {
    this.source = source;
  }

  async setTheme(theme: Theme) {
    await this.glyphAtlas.updateTheme(theme);
  }

  async renderFrame(frame: RenderFrameInput): Promise<void> {
    if (!this.source) return;
    const total = await this.source.totalLength();
    const charsPerRow = this.getCharsPerRow(frame.viewportWidth);
    
    // Effective row height changes based on view mode
    const effectiveRowHeight = frame.viewMode === 'dual' ? this.rowHeight * 2 : this.rowHeight;
    
    // Calculate total VISUAL rows
    const totalDataRows = Math.ceil(total / charsPerRow);
    
    // We need to trick the scroller or use a new one. 
    // VirtualScroller is simple state-less logic usually? 
    // Checking VirtualScroller implementation would be good, but assuming standard:
    // It maps scrollTop (pixels) to item index.
    
    // Let's create a temporary scroller config for this frame or assume scroller handles dynamic height if we pass it?
    // The current scroller instance has fixed rowHeight.
    // Let's just do manual calculation here for the "Ultra" upgrade to avoid refactoring VirtualScroller yet.

    // scroller.compute handles the offset math, so instantiate a lightweight scroller for this frame.
    const scroller = new VirtualScroller({ rowHeight: effectiveRowHeight, overscan: frame.overscanRows });
    const scroll = scroller.compute(frame.scrollTop, frame.viewportHeight, totalDataRows);

    const windowData = await this.fetchWindow(scroll);
    this.resizeCanvas(frame.viewportWidth, frame.viewportHeight);
    this.draw(windowData, scroll, frame.viewportWidth, frame.viewMode, frame.readingFrame);
  }

  private async fetchWindow(scroll: { startRow: number; endRow: number }): Promise<SequenceWindow> {
    if (!this.source) {
      throw new Error('Sequence source not attached');
    }
    const charsPerRow = this.getCharsPerRow(this.canvas.clientWidth);
    const start = scroll.startRow * charsPerRow;
    const end = scroll.endRow * charsPerRow;
    return this.source.getWindow({ start, end });
  }

  private getCharsPerRow(viewportWidth: number): number {
    const metrics = this.glyphAtlas.getMetrics();
    const usableWidth = Math.max(1, viewportWidth - 80); // reserve sidebar space
    return Math.max(1, Math.floor(usableWidth / metrics.width));
  }

  private resizeCanvas(width: number, height: number) {
    if (this.canvas.width !== Math.floor(width * this.dpr) || this.canvas.height !== Math.floor(height * this.dpr)) {
      this.canvas.width = Math.floor(width * this.dpr);
      this.canvas.height = Math.floor(height * this.dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      if (typeof this.ctx.setTransform === 'function') {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      this.ctx.scale(this.dpr, this.dpr);
    }
  }

  private draw(
    windowData: SequenceWindow,
    scroll: { startRow: number; offsetY: number },
    viewportWidth: number,
    viewMode: 'dna' | 'aa' | 'dual',
    readingFrame: number
  ) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, viewportWidth, this.canvas.height);
    const metrics = this.glyphAtlas.getMetrics();
    const charsPerRow = this.getCharsPerRow(viewportWidth);
    
    // In dual mode, each data row takes 2 visual rows
    const visualRowHeight = viewMode === 'dual' ? metrics.height * 2 : metrics.height;
    
    let y = -scroll.offsetY;
    let absoluteIndex = windowData.start; // Approximate start index

    // Align absoluteIndex to the start of the visible window
    // windowData.start is (startRow * charsPerRow).
    
    for (let rowIndex = 0; rowIndex < windowData.rows.length; rowIndex++) {
      const row = windowData.rows[rowIndex];
      
      if (viewMode === 'dual') {
        // DNA Row
        this.drawRow(row, y + metrics.ascent, metrics, charsPerRow);
        
        // AA Row
        const aaY = y + metrics.height + metrics.ascent;
        this.drawRowAA(row, aaY, metrics, charsPerRow, absoluteIndex, readingFrame);
        
        y += visualRowHeight;
      } else if (viewMode === 'aa') {
        // AA Mode: We need to translate the *whole* row and draw it.
        // Issue: 'row' is DNA. 1 visual row of AA consumes 3 DNA rows worth of width?
        // No, usually in AA mode we show 1 AA per character slot (zoomed out) OR 1 AA per 3 slots (aligned).
        // TUI standard: AA mode replaces DNA chars with AA chars 1:1? No, that breaks length.
        // TUI standard: "AA mode - translate and display amino acids"
        // Let's assume for this grid renderer, AA mode means "Show AA sequence packed".
        // But SequenceSource returns DNA.
        
        // Let's implement Dual mode first as it's the "Ultra" target.
        // For 'aa' mode, let's just draw the translation for now.
        
        this.drawRowAA(row, y + metrics.ascent, metrics, charsPerRow, absoluteIndex, readingFrame);
        y += visualRowHeight;
      } else {
        // DNA Mode
        this.drawRow(row, y + metrics.ascent, metrics, charsPerRow);
        y += visualRowHeight;
      }
      
      absoluteIndex += row.length;
    }
  }

  private drawRowAA(
    dnaRow: string,
    y: number,
    metrics: GlyphMetrics,
    charsPerRow: number,
    absoluteStartIndex: number,
    readingFrame: number
  ) {
    // 1. Translate the row.
    // We need context from previous row to handle frame overlap, but for MVP we clip.
    // Ideally, SequenceSource should provide overlapping windows.
    
    // Simple translation logic:
    // DNA:  A T G C G C ...
    // idx:  0 1 2 3 4 5
    // Frame 0: [ATG] [CGC] -> M R
    // Frame 1: . [TGC] [GC.] -> C ?
    
    // We want to align AA char visually with the SECOND base of the codon (center).
    // ATG -> M is drawn at T.
    
    // Calculate offset into this specific row
    // Global: (absoluteStartIndex + i)
    // We want (Global - frame) % 3 == 0 to be start of codon.
    // (Global - frame) % 3 == 1 is center.
    
    const ctx = this.ctx;
    
    for (let i = 0; i < dnaRow.length && i < charsPerRow; i++) {
      const globalPos = absoluteStartIndex + i;
      const shifted = globalPos - readingFrame;
      
      // Check if this position is the CENTER of a codon (index 1 mod 3)
      // Modulo arithmetic in JS can be negative, so use helper or check range.
      // We assume positive indices for now.
      if (shifted % 3 === 1) {
        // This is the middle base. We need the codon at globalPos-1, globalPos, globalPos+1
        // Boundary check: i-1 and i+1 must exist in dnaRow.
        if (i > 0 && i < dnaRow.length - 1) {
          const codon = dnaRow.slice(i - 1, i + 2);
          const aa = translateCodon(codon);
          
          const entry = this.glyphAtlas.getEntry(aa);
          ctx.drawImage(
            this.glyphAtlas.getAtlasCanvas() as CanvasImageSource,
            entry.sx,
            entry.sy,
            entry.sw,
            entry.sh,
            i * metrics.width,
            y - metrics.ascent,
            metrics.width,
            metrics.height
          );
        }
      }
    }
  }

  private drawRow(row: string, y: number, metrics: GlyphMetrics, charsPerRow: number) {
    const ctx = this.ctx;
    for (let i = 0; i < row.length && i < charsPerRow; i++) {
      const char = row[i];
      const entry = this.glyphAtlas.getEntry(char);
      ctx.drawImage(
        this.glyphAtlas.getAtlasCanvas() as CanvasImageSource,
        entry.sx,
        entry.sy,
        entry.sw,
        entry.sh,
        i * metrics.width,
        y - metrics.ascent,
        metrics.width,
        metrics.height
      );
    }
  }
}
