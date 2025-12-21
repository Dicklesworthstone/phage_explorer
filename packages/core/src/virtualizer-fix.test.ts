import { describe, expect, test } from 'bun:test';
import { applyDiff, buildGrid, type GridBuilderConfig } from './virtualizer';

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
  });
});
