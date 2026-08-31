import type { GeneInfo } from '@phage-explorer/core';

/**
 * Convert a genome coordinate into the scroll-space coordinate used by the current view mode.
 * DNA and dual views use base-pair positions; the amino-acid view uses codon positions.
 */
export function genePositionToScroll(pos: number, viewMode: 'dna' | 'aa' | 'dual'): number {
  return viewMode === 'aa' ? Math.floor(pos / 3) : pos;
}

/** Find the start position of the next gene strictly after the current scroll position. */
export function findNextGenePosition(
  genes: GeneInfo[],
  scrollPosition: number,
  viewMode: 'dna' | 'aa' | 'dual'
): number | null {
  const candidates = genes
    .map((g) => genePositionToScroll(g.startPos, viewMode))
    .filter((p) => p > scrollPosition);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/** Find the start position of the previous gene strictly before the current scroll position. */
export function findPreviousGenePosition(
  genes: GeneInfo[],
  scrollPosition: number,
  viewMode: 'dna' | 'aa' | 'dual'
): number | null {
  const candidates = genes
    .map((g) => genePositionToScroll(g.startPos, viewMode))
    .filter((p) => p < scrollPosition);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}
