/**
 * GlyphAtlas - Pre-rendered Character Sprites
 *
 * Creates a texture atlas of all nucleotides and amino acids for fast
 * canvas rendering. Instead of using fillText() for each character,
 * we drawImage() from this pre-rendered atlas, which is ~10x faster.
 */

import type { Theme, ColorPair } from '@phage-explorer/core';

// All nucleotides we need to render
const NUCLEOTIDES = ['A', 'C', 'G', 'T', 'N'] as const;
type Nucleotide = (typeof NUCLEOTIDES)[number];

// All amino acids we need to render
const AMINO_ACIDS = [
  'A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L',
  'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Y',
  'X', '*',
] as const;
type AminoAcid = (typeof AMINO_ACIDS)[number];

// Micro bitmap font definitions (packed bits per row, left-to-right)
// 4x6 for nucleotides (very small cells)
const MICRO_FONT_4x6: Record<Nucleotide, number[]> = {
  A: [0b0110, 0b1001, 0b1111, 0b1001, 0b1001, 0b0000],
  C: [0b0111, 0b1000, 0b1000, 0b1000, 0b0111, 0b0000],
  G: [0b0111, 0b1000, 0b1011, 0b1001, 0b0111, 0b0000],
  T: [0b1111, 0b0100, 0b0100, 0b0100, 0b0100, 0b0000],
  N: [0b1001, 0b1101, 0b1011, 0b1001, 0b1001, 0b0000],
};

// 5x7 pixel font for amino acids and misc symbols
const MICRO_FONT_5x7: Record<AminoAcid | Nucleotide | '*', number[]> = {
  A: [0b01110, 0b10001, 0b11111, 0b10001, 0b10001, 0b00000, 0b00000],
  B: [0b11110, 0b10001, 0b11110, 0b10001, 0b11110, 0b00000, 0b00000], // use for N as needed
  C: [0b01110, 0b10001, 0b10000, 0b10001, 0b01110, 0b00000, 0b00000],
  D: [0b11100, 0b10010, 0b10001, 0b10010, 0b11100, 0b00000, 0b00000],
  E: [0b11111, 0b10000, 0b11110, 0b10000, 0b11111, 0b00000, 0b00000],
  F: [0b11111, 0b10000, 0b11110, 0b10000, 0b10000, 0b00000, 0b00000],
  G: [0b01110, 0b10000, 0b10111, 0b10001, 0b01110, 0b00000, 0b00000],
  H: [0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b00000, 0b00000],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b11111, 0b00000, 0b00000],
  K: [0b10001, 0b10010, 0b11100, 0b10010, 0b10001, 0b00000, 0b00000],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b11111, 0b00000, 0b00000],
  M: [0b10001, 0b11011, 0b10101, 0b10001, 0b10001, 0b00000, 0b00000],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b00000, 0b00000],
  P: [0b11110, 0b10001, 0b11110, 0b10000, 0b10000, 0b00000, 0b00000],
  Q: [0b01110, 0b10001, 0b10001, 0b10101, 0b01110, 0b00100, 0b00000],
  R: [0b11110, 0b10001, 0b11110, 0b10010, 0b10001, 0b00000, 0b00000],
  S: [0b01111, 0b10000, 0b01110, 0b00001, 0b11110, 0b00000, 0b00000],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00000],
  V: [0b10001, 0b10001, 0b10001, 0b01010, 0b00100, 0b00000, 0b00000],
  W: [0b10001, 0b10001, 0b10101, 0b11011, 0b10001, 0b00000, 0b00000],
  Y: [0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00000, 0b00000],
  X: [0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b00000, 0b00000],
  '*': [0b00100, 0b10101, 0b01110, 0b10101, 0b00100, 0b00000, 0b00000],
  // Provide nucleotide variants for reuse in 5x7 sizes
  G5: [0b01110, 0b10000, 0b10111, 0b10001, 0b01110, 0b00000, 0b00000],
  C5: [0b01110, 0b10001, 0b10000, 0b10001, 0b01110, 0b00000, 0b00000],
  T5: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00000],
  A5: [0b01110, 0b10001, 0b11111, 0b10001, 0b10001, 0b00000, 0b00000],
  N5: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b00000, 0b00000],
};

const MICRO_NUCLEOTIDE_SIZE = { width: 4, height: 6 };
const MICRO_AMINO_SIZE = { width: 5, height: 7 };
// Allow micro-text for cells as small as 5px (down from 8px)
const MICRO_TEXT_MAX_CELL = 5;

export interface GlyphMetrics {
  width: number;
  height: number;
  ascent: number;
  descent: number;
}

export interface GlyphInfo {
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  colors: ColorPair;
}

export interface GlyphAtlasOptions {
  cellWidth: number;
  cellHeight: number;
  fontFamily: string;
  fontSize: number;
  devicePixelRatio?: number;
}

const DEFAULT_OPTIONS: GlyphAtlasOptions = {
  cellWidth: 16,
  cellHeight: 20,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
  fontSize: 14, // Will be auto-calculated if not specified
  devicePixelRatio: 1,
};

// Calculate optimal font size for given cell dimensions
// For tiny cells, we skip normal text and rely on micro-glyphs
function calculateOptimalFontSize(cellWidth: number, cellHeight: number): number {
  // For pixel-level cells (<=5px), don't bother with text
  if (cellWidth <= 5 || cellHeight <= 5) {
    return 0; // Signal to skip text rendering
  }
  // Use smaller of width-based or height-based calculation
  const heightBased = Math.floor(cellHeight * 0.7);
  const widthBased = Math.floor(cellWidth * 0.85);
  return Math.max(6, Math.min(heightBased, widthBased)); // Min 6px for any legibility
}

export class GlyphAtlas {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private options: GlyphAtlasOptions;
  private theme: Theme;
  private nucleotideGlyphs: Map<Nucleotide, GlyphInfo> = new Map();
  private aminoAcidGlyphs: Map<AminoAcid, GlyphInfo> = new Map();
  private metrics: GlyphMetrics;
  private dpr: number;
  private useMicroGlyphs: boolean;

  // Atlas layout constants
  private readonly COLS = 8; // Characters per row
  private atlasWidth: number;
  private atlasHeight: number;

  constructor(theme: Theme, options: Partial<GlyphAtlasOptions> = {}) {
    // Auto-calculate font size if not explicitly provided
    const cellWidth = options.cellWidth ?? DEFAULT_OPTIONS.cellWidth;
    const cellHeight = options.cellHeight ?? DEFAULT_OPTIONS.cellHeight;
    // Guard against zero-size canvases (can happen if canvas not yet sized)
    const safeWidth = Math.max(1, cellWidth);
    const safeHeight = Math.max(1, cellHeight);
    const microMode = cellWidth <= MICRO_TEXT_MAX_CELL || cellHeight <= MICRO_TEXT_MAX_CELL;
    const fontSize = microMode ? 0 : options.fontSize ?? calculateOptimalFontSize(safeWidth, safeHeight);

    this.options = { ...DEFAULT_OPTIONS, ...options, fontSize, cellWidth: safeWidth, cellHeight: safeHeight };
    this.theme = theme;
    this.dpr = options.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
    this.useMicroGlyphs = microMode;

    // Calculate atlas size
    const totalChars = NUCLEOTIDES.length + AMINO_ACIDS.length;
    const rows = Math.ceil(totalChars / this.COLS);
    this.atlasWidth = this.options.cellWidth * this.COLS * this.dpr;
    this.atlasHeight = this.options.cellHeight * rows * this.dpr;

    // Create canvas
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(this.atlasWidth, this.atlasHeight);
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.atlasWidth;
      this.canvas.height = this.atlasHeight;
    }

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;

    // Calculate metrics
    this.metrics = this.calculateMetrics();

    // Render the atlas
    this.render();
  }

  /**
   * Calculate font metrics
   */
  private calculateMetrics(): GlyphMetrics {
    this.ctx.font = `${this.options.fontSize * this.dpr}px ${this.options.fontFamily}`;
    const textMetrics = this.ctx.measureText('M');

    return {
      width: this.options.cellWidth * this.dpr,
      height: this.options.cellHeight * this.dpr,
      ascent: textMetrics.actualBoundingBoxAscent || this.options.fontSize * 0.8 * this.dpr,
      descent: textMetrics.actualBoundingBoxDescent || this.options.fontSize * 0.2 * this.dpr,
    };
  }

  /**
   * Render all glyphs to the atlas
   */
  private render(): void {
    this.ctx.clearRect(0, 0, this.atlasWidth, this.atlasHeight);

    let index = 0;

    // Render nucleotides
    for (const char of NUCLEOTIDES) {
      const colors = this.theme.nucleotides[char];
      this.renderGlyph(char, colors, index, 'nucleotide');
      this.nucleotideGlyphs.set(char, this.getGlyphInfo(char, colors, index));
      index++;
    }

    // Render amino acids
    for (const char of AMINO_ACIDS) {
      const colors = this.theme.aminoAcids[char as keyof typeof this.theme.aminoAcids];
      this.renderGlyph(char, colors, index, 'amino');
      this.aminoAcidGlyphs.set(char, this.getGlyphInfo(char, colors, index));
      index++;
    }
  }

  /**
   * Render a single glyph at the given index position
   */
  private renderGlyph(char: string, colors: ColorPair, index: number, type: 'nucleotide' | 'amino'): void {
    const col = index % this.COLS;
    const row = Math.floor(index / this.COLS);
    const x = col * this.options.cellWidth * this.dpr;
    const y = row * this.options.cellHeight * this.dpr;
    const width = this.options.cellWidth * this.dpr;
    const height = this.options.cellHeight * this.dpr;

    // Draw background (always - this is the primary visual for tiny cells)
    this.ctx.fillStyle = colors.bg;
    this.ctx.fillRect(x, y, width, height);

    if (this.useMicroGlyphs) {
      this.renderMicroGlyph(char, colors, x, y, width, height, type);
      return;
    }

    // Only draw character if fontSize > 0 (skip for pixel-level cells)
    if (this.options.fontSize > 0) {
      this.ctx.font = `bold ${this.options.fontSize * this.dpr}px ${this.options.fontFamily}`;
      this.ctx.fillStyle = colors.fg;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(char, x + width / 2, y + height / 2);
    }
  }

  /**
   * Get glyph info for a character at the given index
   */
  private getGlyphInfo(char: string, colors: ColorPair, index: number): GlyphInfo {
    const col = index % this.COLS;
    const row = Math.floor(index / this.COLS);

    return {
      char,
      x: col * this.options.cellWidth * this.dpr,
      y: row * this.options.cellHeight * this.dpr,
      width: this.options.cellWidth * this.dpr,
      height: this.options.cellHeight * this.dpr,
      colors,
    };
  }

  /**
   * Render bitmap glyph for micro text mode
   */
  private renderMicroGlyph(
    char: string,
    colors: ColorPair,
    x: number,
    y: number,
    width: number,
    height: number,
    type: 'nucleotide' | 'amino'
  ): void {
    // Get the glyph bitmap rows (array of row bitmasks)
    const glyphRows =
      (type === 'nucleotide'
        ? MICRO_FONT_4x6[char as Nucleotide]
        : MICRO_FONT_5x7[char as AminoAcid]) ??
      (type === 'nucleotide' ? MICRO_FONT_4x6.N : MICRO_FONT_5x7.X);

    if (!glyphRows) return;

    // Get the size constants for this glyph type
    const glyphSize = type === 'nucleotide' ? MICRO_NUCLEOTIDE_SIZE : MICRO_AMINO_SIZE;

    const scaleX = Math.max(1, Math.floor(width / glyphSize.width));
    const scaleY = Math.max(1, Math.floor(height / glyphSize.height));
    const offsetX = x + Math.floor((width - glyphSize.width * scaleX) / 2);
    const offsetY = y + Math.floor((height - glyphSize.height * scaleY) / 2);

    const ctx = this.ctx;
    const smoothingFlag = (ctx as CanvasRenderingContext2D).imageSmoothingEnabled;
    if ('imageSmoothingEnabled' in ctx) {
      (ctx as CanvasRenderingContext2D).imageSmoothingEnabled = false;
    }

    ctx.fillStyle = colors.fg;

    for (let rowIdx = 0; rowIdx < glyphSize.height; rowIdx++) {
      const rowBits = glyphRows[rowIdx] ?? 0;
      for (let bit = 0; bit < glyphSize.width; bit++) {
        if (rowBits & (1 << (glyphSize.width - 1 - bit))) {
          const px = offsetX + bit * scaleX;
          const py = offsetY + rowIdx * scaleY;
          ctx.fillRect(px, py, scaleX, scaleY);
        }
      }
    }

    if ('imageSmoothingEnabled' in ctx) {
      (ctx as CanvasRenderingContext2D).imageSmoothingEnabled = smoothingFlag;
    }
  }

  /**
   * Draw a nucleotide to the destination canvas
   */
  drawNucleotide(
    destCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    char: string,
    destX: number,
    destY: number,
    destWidth?: number,
    destHeight?: number
  ): void {
    const glyph = this.nucleotideGlyphs.get(char as Nucleotide);
    if (!glyph) {
      // Fall back to 'N' for unknown
      const fallback = this.nucleotideGlyphs.get('N');
      if (!fallback) return;
      this.drawGlyph(destCtx, fallback, destX, destY, destWidth, destHeight);
      return;
    }
    this.drawGlyph(destCtx, glyph, destX, destY, destWidth, destHeight);
  }

  /**
   * Draw an amino acid to the destination canvas
   */
  drawAminoAcid(
    destCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    char: string,
    destX: number,
    destY: number,
    destWidth?: number,
    destHeight?: number
  ): void {
    const glyph = this.aminoAcidGlyphs.get(char as AminoAcid);
    if (!glyph) {
      // Fall back to 'X' for unknown
      const fallback = this.aminoAcidGlyphs.get('X');
      if (!fallback) return;
      this.drawGlyph(destCtx, fallback, destX, destY, destWidth, destHeight);
      return;
    }
    this.drawGlyph(destCtx, glyph, destX, destY, destWidth, destHeight);
  }

  /**
   * Draw a glyph from the atlas to the destination canvas
   */
  private drawGlyph(
    destCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    glyph: GlyphInfo,
    destX: number,
    destY: number,
    destWidth?: number,
    destHeight?: number
  ): void {
    // Use uniform scaling to avoid distorting letterforms when cells are rectangular.
    const dw = destWidth ?? this.options.cellWidth;
    const dh = destHeight ?? this.options.cellHeight;
    const scale = Math.min(dw / glyph.width, dh / glyph.height);
    const targetW = glyph.width * scale;
    const targetH = glyph.height * scale;
    const offsetX = destX + (dw - targetW) / 2;
    const offsetY = destY + (dh - targetH) / 2;

    // Paint background to cover the full cell area, then render the glyph centered.
    destCtx.fillStyle = glyph.colors.bg;
    destCtx.fillRect(destX, destY, dw, dh);

    destCtx.drawImage(
      this.canvas as CanvasImageSource,
      glyph.x,
      glyph.y,
      glyph.width,
      glyph.height,
      offsetX,
      offsetY,
      targetW,
      targetH
    );
  }

  /**
   * Get the cell dimensions (for layout calculations)
   */
  getCellSize(): { width: number; height: number } {
    return {
      width: this.options.cellWidth,
      height: this.options.cellHeight,
    };
  }

  /**
   * Get the underlying canvas (for debugging/inspection)
   */
  getCanvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.canvas;
  }

  /**
   * Get nucleotide glyph info
   */
  getNucleotideGlyph(char: string): GlyphInfo | undefined {
    return this.nucleotideGlyphs.get(char as Nucleotide);
  }

  /**
   * Get amino acid glyph info
   */
  getAminoAcidGlyph(char: string): GlyphInfo | undefined {
    return this.aminoAcidGlyphs.get(char as AminoAcid);
  }

  /**
   * Update theme (requires re-rendering atlas)
   */
  setTheme(theme: Theme): void {
    this.theme = theme;
    this.render();
  }

  /**
   * Create a new atlas with different options
   */
  static create(
    theme: Theme,
    options?: Partial<GlyphAtlasOptions>
  ): GlyphAtlas {
    return new GlyphAtlas(theme, options);
  }
}

export default GlyphAtlas;
