import { describe, expect, test } from 'bun:test';
import { searchNavigationTarget } from './search-navigation';

describe('search result navigation', () => {
  test('DNA and dual views use the forward base coordinate unchanged', () => {
    for (const mode of ['dna', 'dual'] as const) {
      expect(searchNavigationTarget(7, 10, mode, -3)).toEqual({ viewMode: mode, position: 7 });
    }
  });

  test('jumps to the displayed residue using complete codons from the selected strand', () => {
    // Each string labels the display residue covering each of ten forward bases.
    for (const [frame, cells] of [
      [0, '000111222.'], [1, '.000111222'], [2, '..000111..'],
      [-1, '.000111222'], [-2, '000111222.'], [-3, '..000111..'],
    ] as const) {
      for (let base = 0; base < cells.length; base++) {
        const cell = cells[base];
        expect(searchNavigationTarget(base, cells.length, 'aa', frame)).toEqual(
          cell === '.' ? { viewMode: 'dna', position: base } : { viewMode: 'aa', position: Number(cell) },
        );
      }
    }
  });

  test('a genome without a complete codon opens at the requested base', () => {
    expect(searchNavigationTarget(1, 2, 'aa', -3)).toEqual({ viewMode: 'dna', position: 1 });
  });
});
