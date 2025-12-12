import type { VirtualWindow, GridCell, GridRow, ViewMode, ReadingFrame } from './types';
import { translateSequence, translateCodon } from './codons';

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
  const forwardFrame: 0 | 1 | 2 = frame >= 0
    ? (frame as 0 | 1 | 2)
    : ((Math.abs(frame) - 1) as 0 | 1 | 2);

  if (mode === 'dual') {
    // Dual mode - Interleaved DNA and AA rows
    // Row 0: DNA, Row 1: AA, Row 2: DNA...
    // We consume viewportCols bases per PAIR of rows.
    // So logical rows = viewportRows / 2.
    
    for (let row = 0; row < viewportRows; row++) {
      const isAaRow = row % 2 !== 0;
      const logicalRow = Math.floor(row / 2);
      const rowStart = logicalRow * viewportCols;
      const cells: GridCell[] = [];

      for (let col = 0; col < viewportCols; col++) {
        const seqIndex = rowStart + col;
        if (seqIndex >= sequence.length) break;

        const absolutePos = startIndex + seqIndex;

        if (!isAaRow) {
          // DNA Row
          cells.push({
            char: sequence[seqIndex],
            position: absolutePos,
          });
        } else {
          // AA Row - Align to center of codon (frame + 1, frame + 4...)
          // Codon starts at p where (p - frame) % 3 == 0
          // Middle is p + 1. So (p + 1 - frame) % 3 == 1 => (p - frame) % 3 == 0.
          // Wait. 0,1,2. Middle is 1.
          // If frame=0. Codon 0,1,2. Middle is 1. (1-0)%3 = 1.
          // If frame=1. Codon 1,2,3. Middle is 2. (2-1)%3 = 1.
          // So we check if (absolutePos - forwardFrame) % 3 === 1.
          
          const offset = (absolutePos - forwardFrame);
          // Handle negative modulo correctly
          const mod = ((offset % 3) + 3) % 3;
          
          if (mod === 1) {
            // This is the middle base. Translate the codon surrounding it.
            // Codon is at seqIndex-1, seqIndex, seqIndex+1
            if (seqIndex > 0 && seqIndex + 1 < sequence.length) {
              const codon = sequence.substring(seqIndex - 1, seqIndex + 2);
              const aa = translateCodon(codon);
              cells.push({
                char: aa,
                position: absolutePos, // Associate with middle base
              });
            } else {
              cells.push({ char: ' ', position: absolutePos });
            }
          } else {
            cells.push({ char: ' ', position: absolutePos });
          }
        }
      }

      if (cells.length > 0) {
        rows.push({ 
          rowIndex: row, 
          cells, 
          type: isAaRow ? 'aa' : 'dna' 
        });
      }
    }

  } else if (mode === 'dna') {
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
        rows.push({ rowIndex: row, cells, type: 'dna' });
      }
    }
  } else {
    // AA mode - translate and display amino acids
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
        rows.push({ rowIndex: row, cells, type: 'aa' });
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
