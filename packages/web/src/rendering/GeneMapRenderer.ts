/**
 * GeneMapRenderer - Canvas Genome Overview
 *
 * Renders a horizontal gene map showing gene positions, strands,
 * and current position indicator. Used for navigation overview.
 */

import type { Theme, GeneInfo } from '@phage-explorer/core';
import { classifyGeneStrand, type GeneStrandDirection } from '../utils/gene-strand';

export interface GeneMapOptions {
  canvas: HTMLCanvasElement;
  theme: Theme;
  height?: number;
  showDensity?: boolean;
  showLabels?: boolean;
}

export interface GeneMapState {
  genomeLength: number;
  genes: GeneInfo[];
  viewportStart: number;
  viewportEnd: number;
  highlightedGene?: number;
}

export interface OrderedGeneBounds {
  start: number;
  end: number;
}

const DEFAULT_HEIGHT = 40;
const POSITION_INDICATOR_WIDTH = 2;
const GENE_TRACK_START_Y = 12;
const GENE_TRACK_HEIGHT = 6;
const GENE_TRACK_GAP = 2;

export function getOrderedGeneBounds(
  gene: Pick<GeneInfo, 'startPos' | 'endPos'>
): OrderedGeneBounds {
  return {
    start: Math.min(gene.startPos, gene.endPos),
    end: Math.max(gene.startPos, gene.endPos),
  };
}

export function getGenomePositionAtCanvasX(
  x: number,
  width: number,
  genomeLength: number
): number | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(width) ||
    !Number.isFinite(genomeLength) ||
    width <= 0 ||
    genomeLength <= 0 ||
    x < 0 ||
    x > width
  ) {
    return null;
  }

  const position = Math.floor((x / width) * genomeLength);
  return Math.min(genomeLength - 1, Math.max(0, position));
}

export function findGeneAtGenomePosition(
  genes: readonly GeneInfo[],
  position: number
): GeneInfo | null {
  if (!Number.isFinite(position) || position < 0) return null;

  for (const gene of genes) {
    const bounds = getOrderedGeneBounds(gene);
    if (position >= bounds.start && position < bounds.end) return gene;
  }

  return null;
}

export function buildGeneDensityBins(
  genes: readonly GeneInfo[],
  genomeLength: number,
  requestedBinCount: number
): number[] {
  if (!Number.isFinite(genomeLength) || genomeLength <= 0) return [];

  const binCount = Math.max(1, Math.floor(requestedBinCount));
  const binSize = genomeLength / binCount;
  const bins = new Array<number>(binCount).fill(0);

  for (const gene of genes) {
    const bounds = getOrderedGeneBounds(gene);
    const start = Math.min(genomeLength, Math.max(0, bounds.start));
    const end = Math.min(genomeLength, Math.max(0, bounds.end));
    if (end <= start) continue;

    const startBin = Math.min(binCount - 1, Math.max(0, Math.floor(start / binSize)));
    const endBin = Math.min(
      binCount - 1,
      Math.max(startBin, Math.ceil(end / binSize) - 1)
    );

    for (let bin = startBin; bin <= endBin; bin += 1) bins[bin] += 1;
  }

  return bins;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function getTrackY(direction: GeneStrandDirection): number {
  switch (direction) {
    case 'forward':
      return GENE_TRACK_START_Y;
    case 'reverse':
      return GENE_TRACK_START_Y + GENE_TRACK_HEIGHT + GENE_TRACK_GAP;
    case 'unknown':
      return GENE_TRACK_START_Y + (GENE_TRACK_HEIGHT + GENE_TRACK_GAP) * 2;
  }
}

export class GeneMapRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private theme: Theme;
  private readonly height: number;
  private readonly showDensity: boolean;
  private readonly showLabels: boolean;
  private dpr = 1;
  private state: GeneMapState | null = null;
  private animationFrameId: number | null = null;
  private disposed = false;

  constructor(options: GeneMapOptions) {
    this.canvas = options.canvas;
    this.theme = options.theme;
    this.height = options.height ?? DEFAULT_HEIGHT;
    this.showDensity = options.showDensity ?? true;
    this.showLabels = options.showLabels ?? false;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;

    this.resize();
  }

  resize(): void {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssWidth = Math.max(1, this.canvas.clientWidth);
    const cssHeight = Math.max(1, this.height);
    const pixelWidth = Math.max(1, Math.round(cssWidth * this.dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * this.dpr));

    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.ctx.setTransform(pixelWidth / cssWidth, 0, 0, pixelHeight / cssHeight, 0, 0);
    this.scheduleRender();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.scheduleRender();
  }

  setState(state: GeneMapState): void {
    this.state = state;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.animationFrameId !== null || this.disposed) return;

    this.animationFrameId = requestAnimationFrame(() => {
      this.animationFrameId = null;
      if (!this.disposed) this.render();
    });
  }

  private render(): void {
    if (!this.state) return;

    const width = this.canvas.clientWidth;
    const height = this.height;
    if (width <= 0 || height <= 0) return;

    const { genomeLength, genes, viewportStart, viewportEnd, highlightedGene } = this.state;

    this.ctx.fillStyle = this.theme.colors.background;
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.strokeStyle = this.theme.colors.border;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, height - 1));

    if (!Number.isFinite(genomeLength) || genomeLength <= 0) {
      this.ctx.fillStyle = this.theme.colors.textMuted;
      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText('Genome length not reported', width / 2, height / 2);
      return;
    }

    const scale = width / genomeLength;
    if (this.showDensity) this.renderDensityHistogram(genes, genomeLength, width);
    this.renderGeneTracks(genes, genomeLength, scale, highlightedGene);
    if (this.showLabels) this.renderLabels(genes, genomeLength, scale);
    this.renderViewportIndicator(
      viewportStart,
      viewportEnd,
      genomeLength,
      scale,
      width,
      height
    );
  }

  private renderDensityHistogram(
    genes: readonly GeneInfo[],
    genomeLength: number,
    width: number
  ): void {
    const binCount = Math.max(1, Math.min(100, Math.floor(width / 4)));
    const bins = buildGeneDensityBins(genes, genomeLength, binCount);
    const maxCount = Math.max(...bins, 1);
    const histogramHeight = 8;
    const histogramY = 2;
    const binWidth = width / binCount;

    for (let index = 0; index < binCount; index += 1) {
      const normalizedHeight = (bins[index] / maxCount) * histogramHeight;
      const x = index * binWidth;
      const intensity = bins[index] / maxCount;
      this.ctx.fillStyle = this.interpolateColor(
        this.theme.colors.gradientLow,
        this.theme.colors.gradientHigh,
        intensity
      );
      this.ctx.fillRect(
        x,
        histogramY + histogramHeight - normalizedHeight,
        Math.max(0, binWidth - 0.5),
        normalizedHeight
      );
    }
  }

  private renderLabels(
    genes: readonly GeneInfo[],
    genomeLength: number,
    scale: number
  ): void {
    this.ctx.font = '10px monospace';
    this.ctx.fillStyle = this.theme.colors.textMuted;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';

    const tracks: number[] = [];
    const trackHeight = 12;
    const labelYStart = GENE_TRACK_START_Y + (GENE_TRACK_HEIGHT + GENE_TRACK_GAP) * 3 + 2;
    const maxTracks = Math.max(0, Math.floor((this.height - labelYStart) / trackHeight));
    const sortedGenes = genes.slice().sort((left, right) =>
      getOrderedGeneBounds(left).start - getOrderedGeneBounds(right).start
    );

    for (const gene of sortedGenes) {
      const label = (gene.locusTag || gene.name || '').trim();
      if (!label) continue;

      const bounds = getOrderedGeneBounds(gene);
      const start = clamp(bounds.start, 0, genomeLength);
      const end = clamp(bounds.end, 0, genomeLength);
      if (end <= start || (end - start) * scale < 5) continue;

      const x = ((start + end) / 2) * scale;
      const textWidth = this.ctx.measureText(label).width;
      const labelHalfWidth = textWidth / 2 + 4;
      const labelStart = x - labelHalfWidth;
      const labelEnd = x + labelHalfWidth;
      let trackIndex = -1;

      for (let index = 0; index < maxTracks; index += 1) {
        if (labelStart > (tracks[index] ?? Number.NEGATIVE_INFINITY)) {
          trackIndex = index;
          break;
        }
      }

      if (trackIndex === -1 && tracks.length < maxTracks) trackIndex = tracks.length;
      if (trackIndex === -1) continue;

      tracks[trackIndex] = labelEnd;
      const y = labelYStart + trackIndex * trackHeight;
      this.ctx.strokeStyle = this.theme.colors.border;
      this.ctx.beginPath();
      this.ctx.moveTo(x, y - 2);
      this.ctx.lineTo(x, y);
      this.ctx.stroke();
      this.ctx.fillStyle = this.theme.colors.textMuted;
      this.ctx.fillText(label, x, y);
    }
  }

  private renderGeneTracks(
    genes: readonly GeneInfo[],
    genomeLength: number,
    scale: number,
    highlightedGene?: number
  ): void {
    for (let index = 0; index < genes.length; index += 1) {
      const gene = genes[index];
      const bounds = getOrderedGeneBounds(gene);
      const start = clamp(bounds.start, 0, genomeLength);
      const end = clamp(bounds.end, 0, genomeLength);
      if (end <= start) continue;

      const x = start * scale;
      const geneWidth = Math.max(1, (end - start) * scale);
      const direction = classifyGeneStrand(gene.strand);
      const y = getTrackY(direction);

      let color: string;
      if (index === highlightedGene) color = this.theme.colors.geneHighlight;
      else if (direction === 'forward') color = this.theme.colors.geneForward;
      else if (direction === 'reverse') color = this.theme.colors.geneReverse;
      else color = this.theme.colors.textMuted;

      this.ctx.fillStyle = color;
      this.ctx.fillRect(x, y, geneWidth, GENE_TRACK_HEIGHT);

      if (geneWidth <= 8 || direction === 'unknown') continue;

      this.ctx.fillStyle = this.theme.colors.background;
      const arrowSize = 3;
      const arrowY = y + GENE_TRACK_HEIGHT / 2;

      if (direction === 'forward') {
        const arrowX = x + geneWidth - arrowSize - 2;
        this.ctx.beginPath();
        this.ctx.moveTo(arrowX, arrowY - arrowSize);
        this.ctx.lineTo(arrowX + arrowSize, arrowY);
        this.ctx.lineTo(arrowX, arrowY + arrowSize);
        this.ctx.fill();
      } else {
        const arrowX = x + 2;
        this.ctx.beginPath();
        this.ctx.moveTo(arrowX + arrowSize, arrowY - arrowSize);
        this.ctx.lineTo(arrowX, arrowY);
        this.ctx.lineTo(arrowX + arrowSize, arrowY + arrowSize);
        this.ctx.fill();
      }
    }
  }

  private renderViewportIndicator(
    viewportStart: number,
    viewportEnd: number,
    genomeLength: number,
    scale: number,
    width: number,
    height: number
  ): void {
    const start = clamp(Math.min(viewportStart, viewportEnd), 0, genomeLength - 1);
    const end = clamp(Math.max(viewportStart, viewportEnd), start + 1, genomeLength);
    const rawX = start * scale;
    const x = Math.min(Math.max(0, width - POSITION_INDICATOR_WIDTH), rawX);
    const requestedWidth = Math.max(POSITION_INDICATOR_WIDTH, end * scale - rawX);
    const viewportWidth = Math.min(Math.max(POSITION_INDICATOR_WIDTH, width - x), requestedWidth);

    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    this.ctx.fillRect(x, 0, viewportWidth, height);
    this.ctx.strokeStyle = this.theme.colors.accent;
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(x, 1, viewportWidth, Math.max(0, height - 2));
  }

  private interpolateColor(color1: string, color2: string, t: number): string {
    const first = this.hexToRgb(color1);
    const second = this.hexToRgb(color2);
    if (!first || !second) return color1;

    const amount = clamp(t, 0, 1);
    const red = Math.round(first.r + (second.r - first.r) * amount);
    const green = Math.round(first.g + (second.g - first.g) * amount);
    const blue = Math.round(first.b + (second.b - first.b) * amount);
    return `rgb(${red}, ${green}, ${blue})`;
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: Number.parseInt(result[1], 16),
          g: Number.parseInt(result[2], 16),
          b: Number.parseInt(result[3], 16),
        }
      : null;
  }

  getGeneAtX(x: number): GeneInfo | null {
    if (!this.state) return null;
    const position = getGenomePositionAtCanvasX(
      x,
      this.canvas.clientWidth,
      this.state.genomeLength
    );
    return position === null ? null : findGeneAtGenomePosition(this.state.genes, position);
  }

  getPositionAtX(x: number): number | null {
    if (!this.state) return null;
    return getGenomePositionAtCanvasX(x, this.canvas.clientWidth, this.state.genomeLength);
  }

  dispose(): void {
    this.disposed = true;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
}

export default GeneMapRenderer;
