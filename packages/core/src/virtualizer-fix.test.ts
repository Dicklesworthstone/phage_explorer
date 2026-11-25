import { describe, expect, test } from 'bun:test';
import {
  applyDiff,
  buildGrid,
  aminoAcidIndexAtBase,
  SequenceVirtualizer,
  calculateViewportMetrics,
  calculateScrollLimits,
  snapToGeneBoundary,
  findGeneAtPosition,
  type GridBuilderConfig,
} from './virtualizer';

describe('virtualizer', () => {
  describe('buildGrid', () => {
    test('dual mode translates codon at left boundary using contextBefore', () => {
      const fullSeq = 'ATG';
      const startIndex = 1;
      const slice = fullSeq.substring(startIndex); // "TG"

      const config: GridBuilderConfig = {
        viewportCols: 2,
        viewportRows: 2, // Row 0=DNA, Row 1=AA
        mode: 'dual',
        frame: 0,
        contextBefore: 'A',
      };

      const grid = buildGrid(slice, startIndex, config);

      const dnaRow = grid.find(r => r.type === 'dna');
      expect(dnaRow?.cells.map(c => c.char).join('')).toBe('TG');

      const aaRow = grid.find(r => r.type === 'aa');
      expect(aaRow?.cells[0].char).toBe('M');
    });

    test('reverse AA mode aligns positions using computed gap', () => {
      const sequence = 'ATGAAAT'; // len=7, chosen to exercise non-zero gap
      const grid = buildGrid(sequence, 0, {
        viewportCols: 10,
        viewportRows: 1,
        mode: 'aa',
        frame: -1,
        totalLength: sequence.length,
      });

      expect(grid).toHaveLength(1);
      expect(grid[0].type).toBe('aa');
      expect(grid[0].cells.map(c => c.char).join('')).toBe('SI');
      expect(grid[0].cells.map(c => c.position)).toEqual([1, 4]);
    });

    test('search jumps put the requested base in the first displayed codon across viewport widths', () => {
      const sequence = 'ACGT'.repeat(16);
      for (const frame of [0, 1, 2, -1, -2, -3] as const) {
        const config = { mode: 'aa' as const, frame, totalLength: sequence.length, viewportRows: 1 };
        const fullGrid = buildGrid(sequence, 0, { ...config, viewportCols: sequence.length });
        for (let base = 0; base < sequence.length; base++) {
          const residue = aminoAcidIndexAtBase(base, sequence.length, frame);
          const expected = fullGrid[0].cells.findIndex(cell => base >= cell.position && base < cell.position + 3);
          expect(residue).toBe(expected < 0 ? null : expected);
          if (residue === null) continue;
          const start = residue * 3, offset = frame < 0 ? -frame - 1 : frame;
          for (const viewportCols of [1, 4, 12]) {
            const chunk = sequence.slice(start, start + viewportCols * 3 + offset + 3);
            const window = buildGrid(chunk, start, { ...config, viewportCols });
            expect(window[0].cells[0]).toEqual(fullGrid[0].cells[expected]);
          }
        }
      }
    });

    test('dual mode handles reverse frames correctly', () => {
      const sequence = 'TAC';
      const grid = buildGrid(sequence, 0, {
        viewportCols: 3,
        viewportRows: 2,
        mode: 'dual',
        frame: -1,
        totalLength: sequence.length,
      });

      const aaRow = grid.find(r => r.type === 'aa');
      if (!aaRow) {
        throw new Error('Expected an AA row');
      }

      const aaChar = aaRow.cells.find(c => c.char !== ' ')?.char;
      expect(aaChar).toBe('V');
    });
  });

  describe('applyDiff', () => {
    test('AA mode diff aligns to global frame and startIndex', () => {
      const grid = buildGrid('GTG', 0, {
        viewportCols: 3,
        viewportRows: 1,
        mode: 'aa',
        frame: 0,
      });

      const diffed = applyDiff(grid, 'ATG', 'aa', 0, 0);
      expect(diffed[0].cells[0].diff).toBe('different');

      const grid2 = buildGrid('GTG', 3, {
        viewportCols: 3,
        viewportRows: 1,
        mode: 'aa',
        frame: 0,
      });

      const diffed2 = applyDiff(grid2, 'GTG', 'aa', 0, 3);
      expect(diffed2[0].cells[0].diff).toBe('same');
    });

    test('AA mode diff aligns for reverse frames', () => {
      const sequence = 'ATGAAAT';
      const grid = buildGrid(sequence, 0, {
        viewportCols: 10,
        viewportRows: 1,
        mode: 'aa',
        frame: -1,
        totalLength: sequence.length,
      });

      const diffed = applyDiff(grid, sequence, 'aa', -1, 0, sequence.length);
      expect(diffed[0].cells.map(c => c.diff)).toEqual(['same', 'same']);
    });

    test('DNA mode diff is case-insensitive', () => {
      // Grid has uppercase 'A'
      const grid = buildGrid('A', 0, {
        viewportCols: 1,
        viewportRows: 1,
        mode: 'dna',
        frame: 0,
      });

      // Reference has lowercase 'a'
      const diffed = applyDiff(grid, 'a', 'dna', 0, 0);

      expect(diffed[0].cells[0].char).toBe('A');
      expect(diffed[0].cells[0].diff).toBe('same');
    });
  });

  describe('SequenceVirtualizer', () => {
    test('constructor sets properties correctly', () => {
      const virtualizer = new SequenceVirtualizer(10000, 500, 100);
      expect(virtualizer.totalLength).toBe(10000);
      expect(virtualizer.viewportSize).toBe(500);
      expect(virtualizer.overscan).toBe(100);
    });

    test('constructor uses default overscan of 500', () => {
      const virtualizer = new SequenceVirtualizer(10000, 500);
      expect(virtualizer.overscan).toBe(500);
    });

    test('getWindow returns correct indices at start', () => {
      const virtualizer = new SequenceVirtualizer(10000, 500, 100);
      const window = virtualizer.getWindow(0);

      expect(window.startIndex).toBe(0); // max(0, 0-100) = 0
      expect(window.endIndex).toBe(600); // min(10000, 0+500+100) = 600
      expect(window.overscan).toBe(100);
    });

    test('getWindow returns correct indices in middle', () => {
      const virtualizer = new SequenceVirtualizer(10000, 500, 100);
      const window = virtualizer.getWindow(5000);

      expect(window.startIndex).toBe(4900); // 5000 - 100
      expect(window.endIndex).toBe(5600); // 5000 + 500 + 100
      expect(window.overscan).toBe(100);
    });

    test('getWindow clamps to bounds at end', () => {
      const virtualizer = new SequenceVirtualizer(10000, 500, 100);
      const window = virtualizer.getWindow(9800);

      expect(window.startIndex).toBe(9700); // 9800 - 100
      expect(window.endIndex).toBe(10000); // clamped to totalLength
    });

    test('getVisibleRange returns correct range at start', () => {
      const virtualizer = new SequenceVirtualizer(10000, 500, 100);
      const range = virtualizer.getVisibleRange(0);

      expect(range.start).toBe(0);
      expect(range.end).toBe(500); // min(10000, 0+500)
    });

    test('getVisibleRange returns correct range in middle', () => {
      const virtualizer = new SequenceVirtualizer(10000, 500, 100);
      const range = virtualizer.getVisibleRange(3000);

      expect(range.start).toBe(3000);
      expect(range.end).toBe(3500);
    });

    test('getVisibleRange clamps end to totalLength', () => {
      const virtualizer = new SequenceVirtualizer(10000, 500, 100);
      const range = virtualizer.getVisibleRange(9800);

      expect(range.start).toBe(9800);
      expect(range.end).toBe(10000); // clamped
    });
  });

  describe('calculateViewportMetrics', () => {
    test('calculates correct metrics for standard terminal', () => {
      const metrics = calculateViewportMetrics(
        80, // terminalCols
        24, // terminalRows
        10, // sidebarWidth
        3,  // hudHeight
        2,  // footerHeight
        1   // geneMapHeight
      );

      // gridCols = max(1, 80 - 10 - 2) = 68
      expect(metrics.gridCols).toBe(68);
      // gridRows = max(1, 24 - 3 - 2 - 1 - 0 - 2) = 16
      expect(metrics.gridRows).toBe(16);
      expect(metrics.totalBasesOnScreen).toBe(68 * 16);
      expect(metrics.totalAAsOnScreen).toBe(68 * 16);
    });

    test('handles 3D model height', () => {
      const metrics = calculateViewportMetrics(
        100,
        40,
        15,
        4,
        3,
        2,
        10 // model3DHeight
      );

      // gridCols = 100 - 15 - 2 = 83
      expect(metrics.gridCols).toBe(83);
      // gridRows = 40 - 4 - 3 - 2 - 10 - 2 = 19
      expect(metrics.gridRows).toBe(19);
    });

    test('returns minimum of 1 for small terminals', () => {
      const metrics = calculateViewportMetrics(
        10, // very small terminal
        5,
        10,
        3,
        2,
        1
      );

      expect(metrics.gridCols).toBe(1); // max(1, 10-10-2) = max(1, -2) = 1
      expect(metrics.gridRows).toBe(1); // max(1, 5-3-2-1-0-2) = max(1, -3) = 1
    });
  });

  describe('calculateScrollLimits', () => {
    test('calculates limits for DNA mode', () => {
      const limits = calculateScrollLimits(10000, 500, 'dna');

      expect(limits.min).toBe(0);
      expect(limits.max).toBe(9500); // 10000 - 500
    });

    test('calculates limits for AA mode (divides by 3)', () => {
      const limits = calculateScrollLimits(9000, 500, 'aa');

      // effectiveLength = floor(9000/3) = 3000
      // max = 3000 - 500 = 2500
      expect(limits.min).toBe(0);
      expect(limits.max).toBe(2500);
    });

    test('returns max of 0 when viewport exceeds total', () => {
      const limits = calculateScrollLimits(100, 500, 'dna');

      expect(limits.min).toBe(0);
      expect(limits.max).toBe(0); // max(0, 100-500) = 0
    });

    test('handles dual mode same as DNA', () => {
      const limitsD = calculateScrollLimits(10000, 500, 'dna');
      const limitsDual = calculateScrollLimits(10000, 500, 'dual');

      expect(limitsDual.max).toBe(limitsD.max);
    });
  });

  describe('snapToGeneBoundary', () => {
    const genes = [
      { startPos: 100, endPos: 500 },
      { startPos: 600, endPos: 900 },
      { startPos: 1000, endPos: 1500 },
    ];

    test('snaps to next gene boundary', () => {
      const snapped = snapToGeneBoundary(200, genes, 'next');
      expect(snapped).toBe(600); // next gene after 200 starts at 600
    });

    test('snaps to previous gene boundary', () => {
      const snapped = snapToGeneBoundary(700, genes, 'prev');
      expect(snapped).toBe(600); // previous gene before 700 starts at 600
    });

    test('returns current position if no next gene', () => {
      const snapped = snapToGeneBoundary(1200, genes, 'next');
      expect(snapped).toBe(1200); // no gene starts after 1200
    });

    test('returns current position if no previous gene', () => {
      const snapped = snapToGeneBoundary(50, genes, 'prev');
      expect(snapped).toBe(50); // no gene starts before 50
    });

    test('returns current position for empty genes array', () => {
      const snapped = snapToGeneBoundary(500, [], 'next');
      expect(snapped).toBe(500);
    });

    test('handles unsorted genes array', () => {
      const unsorted = [
        { startPos: 1000, endPos: 1500 },
        { startPos: 100, endPos: 500 },
        { startPos: 600, endPos: 900 },
      ];
      const snapped = snapToGeneBoundary(200, unsorted, 'next');
      expect(snapped).toBe(600); // should still find correct next gene
    });

    test('finds next gene at exact boundary', () => {
      const snapped = snapToGeneBoundary(100, genes, 'next');
      expect(snapped).toBe(600); // should find gene starting AFTER 100
    });

    test('finds prev gene at exact boundary', () => {
      const snapped = snapToGeneBoundary(600, genes, 'prev');
      expect(snapped).toBe(100); // should find gene starting BEFORE 600
    });
  });

  describe('findGeneAtPosition', () => {
    const genes = [
      { startPos: 100, endPos: 500, name: 'geneA' },
      { startPos: 600, endPos: 900, name: 'geneB' },
      { startPos: 1000, endPos: 1500, name: null },
    ];

    test('finds gene containing position', () => {
      const gene = findGeneAtPosition(300, genes);
      expect(gene).not.toBeNull();
      expect(gene?.name).toBe('geneA');
    });

    test('finds gene at start boundary (inclusive)', () => {
      const gene = findGeneAtPosition(100, genes);
      expect(gene).not.toBeNull();
      expect(gene?.name).toBe('geneA');
    });

    test('returns null at end boundary (exclusive)', () => {
      const gene = findGeneAtPosition(500, genes);
      // 500 is the endPos, which is exclusive
      expect(gene).toBeNull();
    });

    test('returns null for position outside all genes', () => {
      const gene = findGeneAtPosition(50, genes);
      expect(gene).toBeNull();
    });

    test('returns null for position between genes', () => {
      const gene = findGeneAtPosition(550, genes);
      expect(gene).toBeNull();
    });

    test('returns gene with null name', () => {
      const gene = findGeneAtPosition(1200, genes);
      expect(gene).not.toBeNull();
      expect(gene?.name).toBeNull();
      expect(gene?.startPos).toBe(1000);
    });

    test('returns null for empty genes array', () => {
      const gene = findGeneAtPosition(300, []);
      expect(gene).toBeNull();
    });
  });
});
