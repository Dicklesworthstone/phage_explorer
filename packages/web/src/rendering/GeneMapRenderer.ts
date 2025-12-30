/**
 * GeneMapRenderer - Canvas Genome Overview
 *
 * Renders a horizontal gene map showing gene positions, strands,
 * and current position indicator. Used for navigation overview.
 */

import type { Theme, GeneInfo } from '@phage-explorer/core';

export interface GeneMapOptions {
  /** Canvas element to render to */
  canvas: HTMLCanvasElement;
  /** Theme for colors */
  theme: Theme;
  /** Height of the gene map in CSS pixels */
  height?: number;
  /** Show density histogram */
  showDensity?: boolean;
  /** Show gene labels */
  showLabels?: boolean;
}

export interface GeneMapState {
  /** Total genome length */
  genomeLength: number;
  /** List of genes */
  genes: GeneInfo[];
  /** Current viewport start position */
  viewportStart: number;
  /** Current viewport end position */
  viewportEnd: number;
  /** Highlighted gene index (optional) */
  highlightedGene?: number;
}

const DEFAULT_HEIGHT = 40;
const GENE_TRACK_HEIGHT = 16;
const POSITION_INDICATOR_WIDTH = 2;

export class GeneMapRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private theme: Theme;
  private height: number;
  private showDensity: boolean;
  private showLabels: boolean;
  private dpr: number;

  private state: GeneMapState | null = null;
  private animationFrameId: number | null = null;
  private disposed = false;

  constructor(options: GeneMapOptions) {
    this.canvas = options.canvas;
    this.theme = options.theme;
    this.height = options.height ?? DEFAULT_HEIGHT;
    this.showDensity = options.showDensity ?? true;
    this.showLabels = options.showLabels ?? false;
    this.dpr = window.devicePixelRatio || 1;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;

    this.resize();
  }

  /**
   * Resize canvas to match container
   */
  resize(): void {
    const width = this.canvas.clientWidth;

    // Set canvas size with DPI scaling
    this.canvas.width = width * this.dpr;
    this.canvas.height = this.height * this.dpr;

    // Scale context for DPI
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.scheduleRender();
  }

  /**
   * Update theme
   */
  setTheme(theme: Theme): void {
    this.theme = theme;
    this.scheduleRender();
  }

  /**
   * Update state and re-render
   */
  setState(state: GeneMapState): void {
    this.state = state;
    this.scheduleRender();
  }

  /**
   * Schedule render on next animation frame
   */
  private scheduleRender(): void {
    if (this.animationFrameId !== null || this.disposed) return;

    this.animationFrameId = requestAnimationFrame(() => {
      this.animationFrameId = null;
      if (!this.disposed) {
        this.render();
      }
    });
  }

  /**
   * Main render method
   */
  private render(): void {
    if (!this.state) return;

    const width = this.canvas.clientWidth;
    const height = this.height;
    const { genomeLength, genes, viewportStart, viewportEnd, highlightedGene } = this.state;

    // Guard against invalid genomeLength to prevent Infinity scale
    if (!genomeLength || genomeLength <= 0) return;

    // Clear
    this.ctx.fillStyle = this.theme.colors.background;
    this.ctx.fillRect(0, 0, width, height);

    // Draw border
    this.ctx.strokeStyle = this.theme.colors.border;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

    // Calculate scale
    const scale = width / genomeLength;

    // Draw density histogram if enabled
    if (this.showDensity) {
      this.renderDensityHistogram(genes, genomeLength, width);
    }

    // Draw gene tracks
    this.renderGeneTracks(genes, scale, highlightedGene);

    // Draw labels if enabled
    if (this.showLabels) {
      this.renderLabels(genes, scale);
    }

    // Draw viewport indicator
    this.renderViewportIndicator(viewportStart, viewportEnd, scale, height);
  }

  /**
   * Render density histogram
   */
  private renderDensityHistogram(
    genes: GeneInfo[],
    genomeLength: number,
    width: number
  ): void {
    const binCount = Math.min(100, Math.floor(width / 4));
    const binSize = genomeLength / binCount;
    const bins = new Array(binCount).fill(0);

    // Count genes in each bin
    for (const gene of genes) {
      const startBin = Math.floor(gene.startPos / binSize);
      const endBin = Math.floor(gene.endPos / binSize);
      for (let b = startBin; b <= endBin && b < binCount; b++) {
        bins[b]++;
      }
    }

    // Find max for normalization
    const maxCount = Math.max(...bins, 1);

    // Draw histogram
    const histHeight = 8;
    const histY = 2;
    const binWidth = width / binCount;

    for (let i = 0; i < binCount; i++) {
      const normalizedHeight = (bins[i] / maxCount) * histHeight;
      const x = i * binWidth;

      // Gradient color based on density
      const intensity = bins[i] / maxCount;
      this.ctx.fillStyle = this.interpolateColor(
        this.theme.colors.gradientLow,
        this.theme.colors.gradientHigh,
        intensity
      );
      this.ctx.fillRect(x, histY + histHeight - normalizedHeight, binWidth - 0.5, normalizedHeight);
    }
  }

  /**
   * Render gene labels with collision avoidance
   */
  private renderLabels(genes: GeneInfo[], scale: number): void {
    this.ctx.font = '10px monospace';
    this.ctx.fillStyle = this.theme.colors.textMuted;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';

    // Use multiple rows for labels to avoid collisions
    // Tracks: list of end X positions for each track
    const tracks: number[] = [];
    const trackHeight = 12;
    const labelYStart = 36; // Below gene tracks
    const maxTracks = Math.floor((this.height - labelYStart) / trackHeight);
    
    // Sort genes by position
    const sortedGenes = [...genes].sort((a, b) => a.startPos - b.startPos);

    for (const gene of sortedGenes) {
      // Skip tiny genes or unlabelled ones
      if (!gene.name && !gene.locusTag) continue;
      
      // Only label genes wider than a few pixels unless highlighted
      const pxWidth = (gene.endPos - gene.startPos) * scale;
      if (pxWidth < 5) continue;

      const label = (gene.name || gene.locusTag || '').trim();
      if (!label) continue;

      const centerPos = (gene.startPos + gene.endPos) / 2;
      const x = centerPos * scale;
      const textWidth = this.ctx.measureText(label).width;
      const pad = 4;
      const labelHalfWidth = textWidth / 2 + pad;
      const labelStart = x - labelHalfWidth;
      const labelEnd = x + labelHalfWidth;

      // Find a track that fits
      let trackIndex = -1;
      for (let i = 0; i < maxTracks; i++) {
        // Check if track is free at this position
        const trackEnd = tracks[i] || -Infinity;
        if (labelStart > trackEnd) {
          trackIndex = i;
          break;
        }
      }
      
      // If no existing track fits, use a new one if available
      if (trackIndex === -1 && tracks.length < maxTracks) {
        trackIndex = tracks.length;
      }

      if (trackIndex !== -1) {
        // Update track
        tracks[trackIndex] = labelEnd;
        
        const y = labelYStart + (trackIndex * trackHeight);
        
        // Tick mark connecting label to gene
        this.ctx.strokeStyle = this.theme.colors.border;
        this.ctx.beginPath();
        this.ctx.moveTo(x, y - 2);
        this.ctx.lineTo(x, y);
        this.ctx.stroke();

        // Label text
        this.ctx.fillStyle = this.theme.colors.textMuted;
        this.ctx.fillText(label, x, y);
      }
    }
  }

  /**
   * Render gene tracks
   */
  private renderGeneTracks(
    genes: GeneInfo[],
    scale: number,
    highlightedGene?: number
  ): void {
    const trackY = 14;
    const forwardY = trackY;
    const reverseY = trackY + GENE_TRACK_HEIGHT + 2;

    for (let i = 0; i < genes.length; i++) {
      const gene = genes[i];
      const x = gene.startPos * scale;
      const geneWidth = Math.max(1, (gene.endPos - gene.startPos) * scale);
      const y = gene.strand === '+' ? forwardY : reverseY;

      // Determine color
      let color: string;
      if (i === highlightedGene) {
        color = this.theme.colors.geneHighlight;
      } else if (gene.strand === '+') {
        color = this.theme.colors.geneForward;
      } else {
        color = this.theme.colors.geneReverse;
      }

      // Draw gene block
      this.ctx.fillStyle = color;
      this.ctx.fillRect(x, y, geneWidth, GENE_TRACK_HEIGHT / 2);

      // Draw direction arrow for larger genes
      if (geneWidth > 8) {
        this.ctx.fillStyle = this.theme.colors.background;
        const arrowSize = 3;
        const arrowY = y + GENE_TRACK_HEIGHT / 4;

        if (gene.strand === '+') {
          // Right-pointing arrow
          const arrowX = x + geneWidth - arrowSize - 2;
          this.ctx.beginPath();
          this.ctx.moveTo(arrowX, arrowY - arrowSize);
          this.ctx.lineTo(arrowX + arrowSize, arrowY);
          this.ctx.lineTo(arrowX, arrowY + arrowSize);
          this.ctx.fill();
        } else {
          // Left-pointing arrow
          const arrowX = x + 2;
          this.ctx.beginPath();
          this.ctx.moveTo(arrowX + arrowSize, arrowY - arrowSize);
          this.ctx.lineTo(arrowX, arrowY);
          this.ctx.lineTo(arrowX + arrowSize, arrowY + arrowSize);
          this.ctx.fill();
        }
      }
    }
  }

  /**
   * Render viewport position indicator
   */
  private renderViewportIndicator(
    viewportStart: number,
    viewportEnd: number,
    scale: number,
    height: number
  ): void {
    const x = viewportStart * scale;
    const endX = viewportEnd * scale;
    const viewWidth = Math.max(POSITION_INDICATOR_WIDTH, endX - x);

    // Semi-transparent overlay for viewport
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    this.ctx.fillRect(x, 0, viewWidth, height);

    // Bright border for viewport edges
    this.ctx.strokeStyle = this.theme.colors.accent;
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(x, 1, viewWidth, height - 2);
  }

  /**
   * Interpolate between two colors
   */
  private interpolateColor(color1: string, color2: string, t: number): string {
    const c1 = this.hexToRgb(color1);
    const c2 = this.hexToRgb(color2);

    if (!c1 || !c2) return color1;

    const r = Math.round(c1.r + (c2.r - c1.r) * t);
    const g = Math.round(c1.g + (c2.g - c1.g) * t);
    const b = Math.round(c1.b + (c2.b - c1.b) * t);

    return `rgb(${r}, ${g}, ${b})`;
  }

  /**
   * Convert hex color to RGB
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  }

  /**
   * Get gene at x coordinate
   */
  getGeneAtX(x: number): GeneInfo | null {
    if (!this.state || !this.state.genomeLength || this.state.genomeLength <= 0) return null;

    const width = this.canvas.clientWidth;
    const scale = width / this.state.genomeLength;
    const position = x / scale;

    for (const gene of this.state.genes) {
      if (position >= gene.startPos && position <= gene.endPos) {
        return gene;
      }
    }

    return null;
  }

  /**
   * Get genome position at x coordinate
   */
  getPositionAtX(x: number): number | null {
    if (!this.state || !this.state.genomeLength || this.state.genomeLength <= 0) return null;

    const width = this.canvas.clientWidth;
    const scale = width / this.state.genomeLength;
    return Math.floor(x / scale);
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.disposed = true;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
}

export default GeneMapRenderer;