import type { Theme } from '@phage-explorer/core';
import type { GlyphAtlas } from './glyphAtlas';

export type Nucleotide = 'A' | 'C' | 'G' | 'T' | 'N';

export interface GlyphAtlasOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  theme: Theme;
  devicePixelRatio: number;
}

export interface GlyphMetrics {
  width: number;
  height: number;
  ascent: number;
  descent: number;
}

export interface GlyphEntry {
  char: string;
  color: string;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface GlyphAtlasBuild {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  metrics: GlyphMetrics;
  entries: Map<string, GlyphEntry>;
}

export type ReadingFrame = 0 | 1 | 2 | -1 | -2 | -3;
export type ViewMode = 'dna' | 'aa' | 'dual';

export interface RenderFrameInput {
  scrollTop: number;
  viewportHeight: number;
  viewportWidth: number;
  overscanRows: number;
  viewMode: ViewMode;
  readingFrame: ReadingFrame;
}

export interface SequenceWindow {
  start: number;
  end: number;
  rows: string[];
}

export interface SequenceSource {
  getWindow(request: { start: number; end: number }): Promise<SequenceWindow>;
  totalLength(): Promise<number>;
}

export interface SequenceGridRendererOptions {
  canvas: HTMLCanvasElement;
  glyphAtlas: GlyphAtlas;
  theme: Theme;
  devicePixelRatio?: number;
}

export interface VirtualScrollResult {
  startRow: number;
  endRow: number;
  offsetY: number;
}

export interface VirtualScrollerOptions {
  rowHeight: number;
  overscan: number;
}

