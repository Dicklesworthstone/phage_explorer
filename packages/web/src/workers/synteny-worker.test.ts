import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import { buildHeatmap, toLabel } from './synteny-worker';

function gene(partial: Partial<GeneInfo>): GeneInfo {
  return {
    id: 1,
    name: null,
    locusTag: null,
    startPos: 0,
    endPos: 10,
    strand: '+',
    product: null,
    type: 'CDS',
    ...partial,
  };
}

describe('synteny-worker gene labels', () => {
  it('prefers product, then name, then locus tag', () => {
    expect(toLabel(gene({ product: 'Tail fiber', name: 'tfb', locusTag: 'L1' }))).toBe('tail fiber');
    expect(toLabel(gene({ name: 'Holin', locusTag: 'L2' }))).toBe('holin');
    expect(toLabel(gene({ locusTag: 'Gp23' }))).toBe('gp23');
    expect(toLabel(undefined)).toBe('');
  });

  it('scores identical gene products as 1 on the heatmap diagonal', () => {
    const genes = [gene({ id: 1, product: 'Major capsid' }), gene({ id: 2, product: 'Holin' })];
    const heatmap = buildHeatmap(genes, genes);
    expect(heatmap.rows).toBe(2);
    expect(heatmap.cols).toBe(2);
    expect(heatmap.values[0]).toBe(1);
    expect(heatmap.values[3]).toBe(1);
    expect(heatmap.values[1]).toBe(0);
    expect(heatmap.values[2]).toBe(0);
  });
});
