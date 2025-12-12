import type { VirtualWindow, GridCell, GridRow, ViewMode, ReadingFrame } from './types';
import { translateSequence } from './codons';

// Sequence virtualizer for efficient rendering of large genomes
export class SequenceVirtualizer {
  constructor(
    readonly totalLength: number,
    readonly viewportSize: number,
    readonly overscan: number = 500
  ) {}

  // Get the window of indices to fetch/render
  getWindow(scrollPosition: number): VirtualWindow {
    const startIndex = Math.max(0, scrollPosition - this.overscan);
    const endIndex = Math.min(
      this.totalLength,
      scrollPosition + this.viewportSize + this.overscan
    );
    return { startIndex, endIndex, overscan: this.overscan };
  }

  // Get the visible portion within the fetched window
  getVisibleRange(scrollPosition: number): { start: number; end: number } {
    return {
      start: scrollPosition,
      end: Math.min(this.totalLength, scrollPosition + this.viewportSize),
    };
  }
}

// Grid builder configuration
export interface GridBuilderConfig {
  viewportCols: number;
  viewportRows: number;
  mode: ViewMode;
  frame: ReadingFrame;
}

// Build grid from sequence data
export function buildGrid(
  sequence: string,
  startIndex: number,
  config: GridBuilderConfig
): GridRow[] {
  const { viewportCols, viewportRows, mode, frame } = config;
  const rows: GridRow[] = [];

  if (mode === 'dna') {
    // DNA mode - one character per nucleotide
    for (let row = 0; row < viewportRows; row++) {
      const rowStart = row * viewportCols;
      const cells: GridCell[] = [];

      for (let col = 0; col < viewportCols; col++) {
        const seqIndex = rowStart + col;
        if (seqIndex >= sequence.length) break;

        const absolutePos = startIndex + seqIndex;
        cells.push({
          char: sequence[seqIndex],
          position: absolutePos,
        });
      }

      if (cells.length > 0) {
        rows.push({ rowIndex: row, cells });
      }
    }
  } else {
    // AA mode - translate and display amino acids
    const forwardFrame: 0 | 1 | 2 = frame >= 0
      ? (frame as 0 | 1 | 2)
      : ((Math.abs(frame) - 1) as 0 | 1 | 2);
    const aaSequence = translateSequence(sequence, forwardFrame);

    for (let row = 0; row < viewportRows; row++) {
      const rowStart = row * viewportCols;
      const cells: GridCell[] = [];

      for (let col = 0; col < viewportCols; col++) {
        const aaIndex = rowStart + col;
        if (aaIndex >= aaSequence.length) break;

        // Calculate the DNA position for this AA
        const dnaPos = startIndex + forwardFrame + aaIndex * 3;
        cells.push({
          char: aaSequence[aaIndex],
          position: dnaPos,
        });
      }

      if (cells.length > 0) {
        rows.push({ rowIndex: row, cells });
      }
    }
  }

  return rows;
}

// Apply diff highlighting to grid
export function applyDiff(
  grid: GridRow[],
  referenceSequence: string,
  mode: ViewMode,
  frame: ReadingFrame
): GridRow[] {
  const forwardFrame: 0 | 1 | 2 = frame >= 0
    ? (frame as 0 | 1 | 2)
    : ((Math.abs(frame) - 1) as 0 | 1 | 2);
  const refToCompare = mode === 'aa' ? translateSequence(referenceSequence, forwardFrame) : referenceSequence;

  return grid.map(row => ({
    ...row,
    cells: row.cells.map(cell => {
      // Calculate the index in the reference to compare
      let refIndex: number;
      if (mode === 'aa') {
        refIndex = Math.floor((cell.position - forwardFrame) / 3);
      } else {
        refIndex = cell.position;
      }

      const refChar = refToCompare[refIndex];
      const diff: GridCell['diff'] = refChar === cell.char ? 'same' : 'different';

      return { ...cell, diff };
    }),
  }));
}

// Calculate viewport metrics
export interface ViewportMetrics {
  gridCols: number;
  gridRows: number;
  totalBasesOnScreen: number;
  totalAAsOnScreen: number;
}

export function calculateViewportMetrics(
  terminalCols: number,
  terminalRows: number,
  sidebarWidth: number,
  hudHeight: number,
  footerHeight: number,
  geneMapHeight: number,
  model3DHeight: number = 0
): ViewportMetrics {
  const gridCols = Math.max(1, terminalCols - sidebarWidth - 2); // -2 for borders
  const gridRows = Math.max(1, terminalRows - hudHeight - footerHeight - geneMapHeight - model3DHeight - 2);

  return {
    gridCols,
    gridRows,
    totalBasesOnScreen: gridCols * gridRows,
    totalAAsOnScreen: gridCols * gridRows,
  };
}

// Calculate scroll limits
export function calculateScrollLimits(
  totalLength: number,
  viewportSize: number,
  mode: ViewMode
): { min: number; max: number } {
  const effectiveLength = mode === 'aa' ? Math.floor(totalLength / 3) : totalLength;
  return {
    min: 0,
    max: Math.max(0, effectiveLength - viewportSize),
  };
}

// Snap scroll position to gene boundary
export function snapToGeneBoundary(
  scrollPosition: number,
  genes: Array<{ startPos: number; endPos: number }>,
  direction: 'prev' | 'next'
): number {
  if (genes.length === 0) return scrollPosition;

  const sortedGenes = [...genes].sort((a, b) => a.startPos - b.startPos);

  if (direction === 'next') {
    // Find first gene that starts after current position
    const nextGene = sortedGenes.find(g => g.startPos > scrollPosition);
    return nextGene?.startPos ?? scrollPosition;
  } else {
    // Find last gene that starts before current position
    const prevGenes = sortedGenes.filter(g => g.startPos < scrollPosition);
    return prevGenes.length > 0 ? prevGenes[prevGenes.length - 1].startPos : scrollPosition;
  }
}

// Find gene at position
export function findGeneAtPosition(
  position: number,
  genes: Array<{ startPos: number; endPos: number; name: string | null }>
): { startPos: number; endPos: number; name: string | null } | null {
  return genes.find(g => position >= g.startPos && position <= g.endPos) ?? null;
}
