import { describe, expect, it } from 'bun:test';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { createRestrictionDigestRecord } from '../../../core/src/analysis/restriction-digest';
import { executeResearchRequest } from './research-workflow.worker';

describe('Restriction experiments through the research worker', () => {
  it('uses the same exact producer for private and catalog inputs', async () => {
    for (const source of ['local', 'catalog'] as const) {
      const options = { enzymes: ['EcoRI', 'MboI'], topology: 'circular' as const };
      const context = { accession: 'source-accession', source };
      const response = await executeResearchRequest({ type: 'restriction-digest', sequence: 'gaattcGATC', options, context });
      if (response.type !== 'analysis') throw new Error('Expected digest analysis.');
      expect(response.record.resultId).toBe((await createRestrictionDigestRecord('gaattcGATC', options, context)).resultId);
      expect(response.record.inputs[0].source).toBe(source);
      const replay = await executeResearchRequest({ type: 'restriction-digest-replay', content: serializeAnalysisRecord(response.record) });
      if (replay.type !== 'analysis') throw new Error('Expected digest replay.');
      expect(replay.record.resultId).toBe(response.record.resultId);
    }
  });

  it('does not accept a checksum-valid invented cut set during replay', async () => {
    const original = await createRestrictionDigestRecord('GAATTC', { enzymes: ['EcoRI'], topology: 'linear' });
    original.fields.cutSites.value = [4];
    const changed = await createAnalysisRecord(original);
    await expect(executeResearchRequest({ type: 'restriction-digest-replay', content: serializeAnalysisRecord(changed) })).rejects.toThrow('Recomputed restriction');
  });

  it('propagates invalid DNA and enzyme errors instead of producing partial evidence', async () => {
    await expect(executeResearchRequest({ type: 'restriction-digest', sequence: 'GAA TTC',
      options: { enzymes: ['EcoRI'], topology: 'linear' }, context: { accession: null, source: 'local' } })).rejects.toThrow('IUPAC DNA');
    await expect(executeResearchRequest({ type: 'restriction-digest', sequence: 'GAATTC',
      options: { enzymes: ['not-a-catalog-enzyme'], topology: 'linear' }, context: { accession: null, source: 'local' } })).rejects.toThrow('restriction catalog');
  });
});
