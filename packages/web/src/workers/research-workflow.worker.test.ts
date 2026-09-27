import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { serializeAnalysisRecord, parseAnalysisRecord } from '@phage-explorer/core';
import { executeResearchRequest } from './research-workflow.worker';

// Hand-checked transcript: reverse-complement(CCATGA) + reverse-complement(ACGTTT)
// = TCATGGAAACGT; codon_start=2 -> CAT GGA AAC GT -> three complete sense codons.
export const WORKFLOW_GENBANK = `LOCUS       WORKFLOW                  18 bp    DNA     linear
ACCESSION   WORKFLOW
FEATURES             Location/Qualifiers
     CDS             complement(join(1..6,13..18))
                     /locus_tag="joined"
                     /codon_start=2
     CDS             1..6
                     /locus_tag="other"
ORIGIN
        1 acgtttggggggccatga
//
`;

describe('research worker real CDS pipeline', () => {
  it('parses original GenBank and computes only the selected joined/complement transcript', async () => {
    const parsed = await executeResearchRequest({ type: 'parse', input: { name: 'private.gb', text: WORKFLOW_GENBANK } });
    assert.equal(parsed.type, 'parsed'); if (parsed.type !== 'parsed') throw new Error('Expected parse');
    const genome = parsed.result.genomes[0];
    assert.equal(genome.sequence, 'ACGTTTGGGGGGCCATGA');
    const response = await executeResearchRequest({ type: 'codons', genome, geneId: 1 });
    assert.equal(response.type, 'analysis'); if (response.type !== 'analysis') throw new Error('Expected analysis');
    const record = await parseAnalysisRecord(serializeAnalysisRecord(response.record));
    assert.deepEqual(record.fields.codingSequences.value, [{ geneId: 1, codonCount: 3, sequence: 'CATGGAAACGT' }]);
    assert.equal(record.fields.codingSequences.kind, 'sequence-score');
    assert.equal(record.fields.hostRankings.kind, 'demo', 'replay cannot upgrade illustrative host weights to observations');
    const annotations = record.inputs.find(i => i.id === 'annotations')!.data as { genes: Array<{ id: number }> };
    assert.deepEqual(annotations.genes.map(g => g.id), [1]);
    assert.equal(genome.phage.genes.length, 2, 'analysis must not mutate the imported annotations');
  });
  it('all-CDS and single-CDS commands bind different records while repeated commands are identical', async () => {
    const parsed = await executeResearchRequest({ type: 'parse', input: { name: 'private.gb', text: WORKFLOW_GENBANK } });
    if (parsed.type !== 'parsed') throw new Error('Expected parse');
    const one = await executeResearchRequest({ type: 'codons', genome: parsed.result.genomes[0], geneId: 1 });
    const same = await executeResearchRequest({ type: 'codons', genome: parsed.result.genomes[0], geneId: 1 });
    const all = await executeResearchRequest({ type: 'codons', genome: parsed.result.genomes[0], geneId: null });
    if (one.type !== 'analysis' || same.type !== 'analysis' || all.type !== 'analysis') throw new Error('Expected analyses');
    assert.equal(one.record.resultId, same.record.resultId);
    assert.notEqual(one.record.cacheKey, all.record.cacheKey);
    assert.equal((all.record.fields.codingSequences.value as unknown[]).length, 2);
  });
  it('rejects unsupported CDS and malformed input rather than creating a successful placeholder', async () => {
    const parsed = await executeResearchRequest({ type: 'parse', input: { name: 'private.fa', text: '>private\nACGTACGT' } });
    if (parsed.type !== 'parsed') throw new Error('Expected parse');
    await assert.rejects(executeResearchRequest({ type: 'codons', genome: parsed.result.genomes[0], geneId: null }), /No supported CDS/);
    await assert.rejects(executeResearchRequest({ type: 'parse', input: { name: 'bad.gb', text: 'not a genome' } }));
  });
});
