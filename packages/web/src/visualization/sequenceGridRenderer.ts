import type {
  GlyphMetrics,
  RenderFrameInput,
  SequenceGridRendererOptions,
  SequenceSource,
  SequenceWindow,
} from './types';
import { VirtualScroller } from './virtualScroller';
import type { GlyphAtlas } from './glyphAtlas';

export class SequenceGridRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly glyphAtlas: GlyphAtlas;
  private readonly dpr: number;
  private readonly scroller: VirtualScroller;
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
    this.scroller = new VirtualScroller({ rowHeight: this.rowHeight, overscan: 10 });
  }

  attachSource(source: SequenceSource) {
    this.source = source;
  }

  async renderFrame(frame: RenderFrameInput): Promise<void> {
    if (!this.source) return;
    const total = await this.source.totalLength();
    const totalRows = Math.ceil(total / this.getCharsPerRow(frame.viewportWidth));
    const scroll = this.scroller.compute(frame.scrollTop, frame.viewportHeight, totalRows);
    const windowData = await this.fetchWindow(scroll);
    this.resizeCanvas(frame.viewportWidth, frame.viewportHeight);
    this.draw(windowData, scroll, frame.viewportWidth);
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

  private draw(windowData: SequenceWindow, scroll: { startRow: number; offsetY: number }, viewportWidth: number) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, viewportWidth, this.canvas.height);
    const metrics = this.glyphAtlas.getMetrics();
    const charsPerRow = this.getCharsPerRow(viewportWidth);
    let y = -scroll.offsetY;
    for (let rowIndex = 0; rowIndex < windowData.rows.length; rowIndex++) {
      const row = windowData.rows[rowIndex];
      this.drawRow(row, y + metrics.ascent, metrics, charsPerRow);
      y += metrics.height;
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
