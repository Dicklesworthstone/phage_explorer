import { describe, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import type { GeneInfo } from '@phage-explorer/core';
import { computeEmbeddingsForPhage as terminalFallback } from './App';
import { computeEmbeddingsForPhage as browserFallback } from '../../../web/src/components/overlays/FoldQuickviewOverlay';

const gene = (length: number, overrides: Partial<GeneInfo> = {}): GeneInfo => ({
  id: 1, name: 'fixture', locusTag: 'cds_1', startPos: 0, endPos: length,
  strand: '+', product: 'synthetic test protein', type: 'CDS', ...overrides,
});

for (const [name, prepare] of [['terminal', terminalFallback], ['browser', browserFallback]] as const) {
  const compute = (sequence: string, annotation: GeneInfo) => prepare({
    phageId: 7, model: 'test-k3',
    repository: {
      getFullGenomeLength: async () => sequence.length,
      getSequenceWindow: async () => sequence,
      getGenes: async () => [annotation],
    } as unknown as Parameters<typeof prepare>[0]['repository'],
  });

  describe(name + ' fallback embeddings from exact CDS', () => {
    test('equivalent contiguous, joined, reverse and offset transcripts retain one protein vector and residue length', async () => {
      const expected = await compute('ATGAAAGCTTAA', gene(12));
      assert.equal(expected.length, 1);
      assert.equal(expected[0].length, 3); // MKA; terminal stop is not a residue.
      assert.equal(expected[0].vector.filter(value => value !== 0).length, 1);
      assert.equal(expected[0].vector.reduce((sum, value) => sum + value * value, 0), 1);
      const fixtures: Array<[string, GeneInfo]> = [
        ['ATGAAACCGCTTAA', gene(14, { qualifiers: { _segments: [
          { start: 0, end: 6, strand: '+' }, { start: 8, end: 14, strand: '+' },
        ] } })],
        ['TTAAGCGGTTTCAT', gene(14, { strand: '-', qualifiers: { _segments: [
          { start: 8, end: 14, strand: '-' }, { start: 0, end: 6, strand: '-' },
        ] } })],
        ['AATGAAAGCTTAA', gene(13, { qualifiers: { codon_start: 2 } })],
        ['AAAGCTTAACCATG', gene(14, { qualifiers: { _segments: [
          { start: 11, end: 14, strand: '+' }, { start: 0, end: 9, strand: '+' },
        ] } })],
      ];
      for (const [sequence, annotation] of fixtures) {
        const actual = await compute(sequence, annotation);
        assert.deepEqual(actual, expected);
      }
    });

    test('recoded translation tables and their initiation rules produce the correct protein embedding', async () => {
      // Compare each recoded transcript with independently specified standard-code
      // codons for the same protein, rather than using translation as the oracle.
      for (const [table, source, equivalent] of [
        [4, 'TTATGAGCTTAA', 'ATGTGGGCTTAA'], // MWA; table 4 TTA initiator and TGA = W.
        [15, 'ATGTAGGCTTAA', 'ATGCAAGCTTAA'], // MQA; table 15 TAG = Q.
        [25, 'GTGTGAGCTTAA', 'ATGGGTGCTTAA'], // MGA; table 25 GTG initiator and TGA = G.
      ] as const) {
        const actual = await compute(source, gene(12, { qualifiers: { transl_table: table } }));
        assert.deepEqual(actual, await compute(equivalent, gene(12)));
        assert.equal(actual[0].length, 3);
      }
    });

    test('rejects unsupported and inconsistent CDS inputs and proteins with no complete 3-mer', async () => {
      const fixtures: Array<[string, GeneInfo]> = [
        ['ATGAAAGCTTAA', gene(12, { type: 'gene' })],
        ['ATGAAAGCTTAA', gene(12, { qualifiers: { transl_table: 2 } })],
        ['ATGAAAGCTTAA', gene(12, { qualifiers: { pseudo: '' } })],
        ['ATGAAAGCTTAA', gene(12, { qualifiers: { transl_except: '(pos:1..3,aa:Sec)' } })],
        ['ATGAAAGCTTAA', gene(12, { qualifiers: { translation: 'WRONG' } })],
        ['ATGNNNGCTTAA', gene(12)],
        ['ATGTAGGCTTAA', gene(12)],
        ['ATGAAAGCTTA', gene(11)],
        ['ATGAAATAA', gene(9)], // MK; a stop must not fabricate a third residue.
      ];
      for (const [sequence, annotation] of fixtures) assert.deepEqual(await compute(sequence, annotation), []);
    });
  });
}
