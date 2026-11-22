import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import { buildSyntenyHeatmap } from '../../../comparison/src/synteny';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import type { SyntenyExperimentInput } from '../../../comparison/src/synteny-experiment';
import { executeSyntenyRequest } from './synteny-worker';

function gene(partial: Partial<GeneInfo>): GeneInfo {
  return { id: 1, name: null, locusTag: null, startPos: 0, endPos: 10, strand: '+', product: null, type: 'CDS', ...partial };
}
describe('synteny worker and shared annotation matrix', () => {
  it('uses informative products before names and excludes locus-tag-only matches', () => {
    const named = gene({ product: 'Tail fiber', name: 'Holin', locusTag: 'L1' });
    expect([...buildSyntenyHeatmap([named], [gene({ product: 'Tail fiber' }), gene({ name: 'Holin' })]).values]).toEqual([1, 0]);
    expect([...buildSyntenyHeatmap([gene({ name: 'Holin' })], [gene({ name: 'Holin' })]).values]).toEqual([1]);
    expect([...buildSyntenyHeatmap([gene({ locusTag: 'Gp23' })], [gene({ locusTag: 'Gp23' })]).values]).toEqual([0]);
    expect([...buildSyntenyHeatmap([gene({ product: 'hypothetical protein' })], [gene({ product: 'hypothetical protein' })]).values]).toEqual([0]);
  });

  it('scores informative products on the diagonal and retains an empty matrix as empty', () => {
    const genes = [gene({ id: 1, product: 'Major capsid' }), gene({ id: 2, product: 'Holin' })];
    const heatmap = buildSyntenyHeatmap(genes, genes);
    expect(heatmap.rows).toBe(2); expect(heatmap.cols).toBe(2);
    expect([...heatmap.values]).toEqual([1, 0, 0, 1]);
    expect(buildSyntenyHeatmap([], [])).toEqual({ rows: 0, cols: 0, values: new Float32Array(), min: 0, max: 0 });
  });

  it('runs both producer and replay operations through the worker request boundary', async () => {
    const input: SyntenyExperimentInput = {
      query: { id: 1, name: 'A', accession: 'A', length: 20, source: 'local', contentId: 'A', annotationMetadata: null },
      reference: { id: 2, name: 'B', accession: 'B', length: 20, source: 'local', contentId: 'B', annotationMetadata: null },
      genesQuery: [gene({ name: 'capsid' })], genesReference: [gene({ name: 'capsid' })],
    };
    const phases: string[] = [];
    const first = await executeSyntenyRequest({ kind: 'analyze', input }, phase => phases.push(phase));
    const replay = await executeSyntenyRequest({ kind: 'replay', content: serializeAnalysisRecord(first.record) }, phase => phases.push(phase));
    expect(first.result.stats.globalScore).toBe(1);
    expect(replay.record.resultId).toBe(first.record.resultId);
    expect(phases.some(phase => phase.includes('recomputing'))).toBe(true);
    await expect(executeSyntenyRequest({ kind: 'unknown' } as never)).rejects.toThrow('Unsupported');
    await expect(executeSyntenyRequest({ kind: 'replay', content: 'not JSON' })).rejects.toThrow();
  });
});
