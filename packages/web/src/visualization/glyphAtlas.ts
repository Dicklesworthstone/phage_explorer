import type {
  GlyphAtlasBuild,
  GlyphAtlasOptions,
  GlyphEntry,
  GlyphMetrics,
  Nucleotide,
} from './types';

const NUCLEOTIDES: Nucleotide[] = ['A', 'C', 'G', 'T', 'N'];
const AMINO_ACIDS = [
  'A', 'R', 'N', 'D', 'C', 'E', 'Q', 'G', 'H', 'I',
  'L', 'K', 'M', 'F', 'P', 'S', 'T', 'W', 'Y', 'V', '*',
];

export class GlyphAtlas {
  private build: GlyphAtlasBuild | null = null;

  constructor(private options: GlyphAtlasOptions) {}

  async prepare(): Promise<void> {
    const { fontFamily, fontSize, lineHeight, devicePixelRatio } = this.options;
    const canvas = this.createCanvas();
    const context = this.getContext(canvas);

    context.scale(devicePixelRatio, devicePixelRatio);
    context.font = `${fontSize}px ${fontFamily}`;
    context.textBaseline = 'alphabetic';

    const metrics = this.measureGlyphMetrics(context, lineHeight);
    const entries = new Map<string, GlyphEntry>();

    // Layout all glyphs on a single row atlas
    const allChars = [...NUCLEOTIDES, ...AMINO_ACIDS];
    let x = 0;
    for (const char of allChars) {
      const color = this.getColorForGlyph(char);
      context.fillStyle = color;
      context.fillText(char, x, metrics.ascent);
      entries.set(char, {
        char,
        color,
        sx: x * devicePixelRatio,
        sy: 0,
        sw: metrics.width * devicePixelRatio,
        sh: metrics.height * devicePixelRatio,
      });
      x += metrics.width;
    }

    this.build = { canvas, context, metrics, entries };
  }

  getMetrics(): GlyphMetrics {
    if (!this.build) {
      throw new Error('GlyphAtlas not prepared');
    }
    return this.build.metrics;
  }

  getEntry(char: string): GlyphEntry {
    if (!this.build) {
      throw new Error('GlyphAtlas not prepared');
    }
    const entry = this.build.entries.get(char);
    if (!entry) {
      throw new Error(`Glyph not found in atlas: ${char}`);
    }
    return entry;
  }

  getAtlasCanvas(): HTMLCanvasElement | OffscreenCanvas {
    if (!this.build) {
      throw new Error('GlyphAtlas not prepared');
    }
    return this.build.canvas;
  }

  private createCanvas(): HTMLCanvasElement | OffscreenCanvas {
    const width = 512;
    const height = 64;
    if (typeof OffscreenCanvas !== 'undefined') {
      return new OffscreenCanvas(width, height);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  private getContext(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Unable to acquire 2D context for glyph atlas');
    }
    return ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  }

  private measureGlyphMetrics(
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    lineHeight: number
  ): GlyphMetrics {
    const metrics = context.measureText('M');
    const ascent = metrics.actualBoundingBoxAscent || lineHeight * 0.75;
    const descent = metrics.actualBoundingBoxDescent || lineHeight * 0.25;
    const height = Math.max(lineHeight, ascent + descent);
    const width = Math.ceil(metrics.width);
    return { width, height, ascent, descent };
  }

  private getColorForGlyph(char: string): string {
    const { theme } = this.options;
    // Access colors from theme.colors which contains nucleotide colors
    const colors = theme.colors as unknown as Record<string, string>;
    if (char === '*') return colors.error ?? '#e11d48';
    const upper = char.toUpperCase();
    if (upper === 'A') return colors.adenine ?? colors.primary ?? '#7dd3fc';
    if (upper === 'C') return colors.cytosine ?? colors.secondary ?? '#a5b4fc';
    if (upper === 'G') return colors.guanine ?? colors.accent ?? '#34d399';
    if (upper === 'T' || upper === 'U') return colors.thymine ?? '#fbbf24';
    if (upper === 'N') return colors.unknown ?? '#94a3b8';
    return colors.text ?? '#e2e8f0';
  }
}

