import type { VirtualWindow, GridCell, GridRow, ViewMode, ReadingFrame } from './types';
import { translateSequence, translateCodon, reverseComplement } from './codons';

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
  totalLength?: number;
  contextBefore?: string;
}

// Build grid from sequence data
export function buildGrid(
  sequence: string,
  startIndex: number,
  config: GridBuilderConfig
): GridRow[] {
  const { viewportCols, viewportRows, mode, frame, contextBefore } = config;
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
          
          const offset = (absolutePos - forwardFrame);
          // Handle negative modulo correctly
          const mod = ((offset % 3) + 3) % 3;
          
          if (mod === 1) {
            // This is the middle base. Translate the codon surrounding it.
            // Codon is at seqIndex-1, seqIndex, seqIndex+1
            
            let codon = '';
            if (seqIndex > 0) {
              codon += sequence[seqIndex - 1];
            } else if (contextBefore && contextBefore.length > 0) {
              codon += contextBefore.slice(-1);
            }

            codon += sequence[seqIndex];

            if (seqIndex + 1 < sequence.length) {
              codon += sequence[seqIndex + 1];
            }

            if (codon.length === 3) {
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
    let aaSequence: string;
    
    if (frame >= 0) {
      const forwardFrame = frame as 0 | 1 | 2;
      // Align to global reading frame
      // We want (startIndex + offset - frame) % 3 == 0
      const offset = ((forwardFrame - startIndex) % 3 + 3) % 3;
      aaSequence = translateSequence(sequence, offset as 0 | 1 | 2);
    } else {
      // Reverse frame (Translate RC)
      const rcFrame = (Math.abs(frame) - 1) as 0 | 1 | 2;
      const totalLen = config.totalLength ?? (startIndex + sequence.length); // Fallback
      
      // Calculate start index on Reverse Strand corresponding to end of this chunk
      // RC_Start = TotalLen - (startIndex + seqLen)
      const globalRcStart = totalLen - startIndex - sequence.length;
      
      // We want (GlobalRcIndex + offset - rcFrame) % 3 == 0
      const offset = ((rcFrame - globalRcStart) % 3 + 3) % 3;
      
      const rc = reverseComplement(sequence);
      const trans = translateSequence(rc, offset as 0 | 1 | 2);
      // Reverse to map N->C (Reverse) to Left->Right (Spatial)
      // Since Reverse strand runs R->L, its protein N->C runs R->L.
      aaSequence = trans.split('').reverse().join('');
    }

    for (let row = 0; row < viewportRows; row++) {
      const rowStart = row * viewportCols;
      const cells: GridCell[] = [];

      for (let col = 0; col < viewportCols; col++) {
        const aaIndex = rowStart + col;
        if (aaIndex >= aaSequence.length) break;

        // Calculate DNA position
        let dnaPos: number;
        if (frame >= 0) {
          // Forward: startIndex + offset + index*3
          const forwardFrame = frame as 0 | 1 | 2;
          const offset = ((forwardFrame - startIndex) % 3 + 3) % 3;
          dnaPos = startIndex + offset + aaIndex * 3;
        } else {
          // Reverse: Left-aligned AA starts after the "remainder" gap at the start of Forward string
          // (which corresponds to the end of the translated RC string)
          const rcFrame = (Math.abs(frame) - 1) as 0 | 1 | 2;
          const totalLen = config.totalLength ?? (startIndex + sequence.length);
          const globalRcStart = totalLen - startIndex - sequence.length;
          const offset = ((rcFrame - globalRcStart) % 3 + 3) % 3;
          
          // Gap is the unused bases at the END of RC (Start of Forward)
          // 3N = length of translated part * 3
          // usedLen = sequence.length - offset
          // gap = usedLen % 3
          const gap = ((sequence.length - offset) % 3 + 3) % 3;
          dnaPos = startIndex + gap + aaIndex * 3;
        }
        
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
  frame: ReadingFrame,
  startIndex: number = 0
): GridRow[] {
  const forwardFrame: 0 | 1 | 2 = frame >= 0
    ? (frame as 0 | 1 | 2)
    : ((Math.abs(frame) - 1) as 0 | 1 | 2);
    
  let refToCompare: string;
  
  if (mode === 'aa') {
    // Calculate local offset into the reference chunk that aligns with global frame
    // We want (startIndex + offset - forwardFrame) % 3 == 0
    const offset = ((forwardFrame - startIndex) % 3 + 3) % 3;
    refToCompare = translateSequence(referenceSequence, offset as 0 | 1 | 2);
  } else {
    refToCompare = referenceSequence;
  }

  return grid.map(row => ({
    ...row,
    cells: row.cells.map(cell => {
      // Calculate the index in the reference to compare
      let refIndex: number;
      if (mode === 'aa') {
        // Calculate AA index relative to the start of this chunk's translation
        // Absolute AA index = (cell.position - forwardFrame) / 3
        // Start AA index of chunk = (startIndex + offset - forwardFrame) / 3
        // relative index = Absolute - Start
        // Or simpler: mapping the grid cell back to the refToCompare string
        
        // cell.position is absolute DNA index of the codon start (or middle?)
        // In buildGrid AA mode: cell.position is DNA pos (start of codon? no, buildGrid uses slightly diff logic for dual vs aa)
        // In 'aa' mode, buildGrid sets cell.position to:
        // Forward: startIndex + offset + index*3. 
        // This is the DNA start index of the codon represented by this AA.
        
        // So we want to find which AA in refToCompare corresponds to this DNA position.
        // refToCompare[0] corresponds to DNA at (startIndex + offset).
        // refToCompare[k] corresponds to DNA at (startIndex + offset + k*3).
        
        // cell.position = startIndex + offset + k*3
        // k = (cell.position - (startIndex + offset)) / 3
        
        const offset = ((forwardFrame - startIndex) % 3 + 3) % 3;
        const alignStart = startIndex + offset;
        
        // Only valid if cell.position is aligned to the frame grid (which it should be from buildGrid)
        refIndex = Math.floor((cell.position - alignStart) / 3);
        
      } else {
        // DNA mode: cell.position is absolute.
        // referenceSequence starts at startIndex.
        refIndex = cell.position - startIndex;
      }

      // Bounds check
      if (refIndex < 0 || refIndex >= refToCompare.length) {
        return cell; // No diff info available
      }

      const refChar = refToCompare[refIndex];
      // Compare (case-insensitive for DNA just in case, though usually uppercase)
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
