import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { serializeAnalysisRecord, parseAnalysisRecord, createAnalysisRecord } from '@phage-explorer/core';
import { executeResearchRequest } from './research-workflow.worker';
import { replaySpacerRecord, type SpacerGenome, type SpacerLibrary, type ReferenceSpacerHit } from '../../../core/src/analysis/spacer-reference';

// Independently located 20-base targets: forward [4,24), reverse [34,54).
// Both have guide-oriented 3-prime AGG; the reverse genomic flank is CCT.
const spacerGenome: SpacerGenome = { name: 'Private workflow query', accession: 'WORKFLOW_SPACERS', source: 'local', topology: 'linear',
  sequence: 'TTTTACGATTCGGTACCTAGTGCAAGGNNNNCCTTGCACTAGGTACCGAATCGTAAAA' };
const spacerLibrary: SpacerLibrary = { format: 'phage-explorer-spacer-library', version: 1, name: 'Private test references',
  source: { kind: 'local', reference: 'Hand-constructed numerical controls, not biological evidence', version: 'test-1', license: 'CC0', scope: 'Three synthetic hosts' },
  hosts: [{ id: 'matched', name: 'Host one', strain: 'one', accession: 'synthetic:one' },
    { id: 'empty', name: 'No records', strain: 'two', accession: 'synthetic:two' },
    { id: 'rna', name: 'RNA only', strain: 'three', accession: 'synthetic:three' }],
  spacers: [{ id: 'guide', hostId: 'matched', arrayAccession: 'synthetic:array', sequence: 'ACGATTCGGTACCTAGTGCA', system: null,
    target: 'DNA', orientation: 'guide-equivalent', pam: { side: '3prime', motif: 'NGG', reference: 'Explicit fixture PAM' },
    seed: { start: 0, end: 4, maxMismatches: 0, reference: 'Explicit fixture seed' } },
  { id: 'excluded-rna', hostId: 'rna', arrayAccession: 'synthetic:rna', sequence: 'ACGATTCGGTACCTAGTGCA', system: 'VI', target: 'RNA', orientation: 'guide-equivalent', pam: null, seed: null }] };

describe('recordable sourced spacer worker', () => {
  it('carries both-strand matches and supplied constraints through the real producer and standalone replay', async () => {
    const before = structuredClone(spacerLibrary);
    const output = await executeResearchRequest({ type: 'spacers', genome: spacerGenome, library: spacerLibrary, options: { hostId: null, maxMismatches: 0 } });
    if (output.type !== 'analysis') throw new Error('Expected spacer analysis');
    const record = await parseAnalysisRecord(serializeAnalysisRecord(output.record));
    const hits = record.fields.matches.value as unknown as ReferenceSpacerHit[];
    assert.deepEqual(hits.map(hit => [hit.start, hit.end, hit.strand, hit.pam.sequence, hit.pam.status, hit.seed.status]),
      [[4, 24, '+', 'AGG', 'matched', 'matched'], [34, 54, '-', 'AGG', 'matched', 'matched']]);
    assert.equal(record.fields.matches.kind, 'sequence-score');
    assert.deepEqual(record.parameters, { hostId: null, maxMismatches: 0 });
    assert.deepEqual(record.inputs.map(input => input.data), [spacerGenome, spacerLibrary]);
    assert.deepEqual(record.fields.matches.coverage, { available: 1, total: 2, unit: 'records' });
    const coverage = record.fields.coverage.value as { excluded: Array<{ spacerId: string }> };
    assert.equal(coverage.excluded[0].spacerId, 'excluded-rna');
    assert.equal((await replaySpacerRecord(serializeAnalysisRecord(record), spacerGenome)).record.resultId, record.resultId);
    assert.deepEqual(spacerLibrary, before, 'Worker calculations must not mutate the supplied library');
  });

  it('keeps missing, excluded, unsearchable and no-match states separate and preserves demo evidence', async () => {
    for (const [hostId, sequence, expected] of [
      ['empty', spacerGenome.sequence, 'no-spacer-data'],
      ['rna', spacerGenome.sequence, 'unsupported-references'],
      ['matched', 'N'.repeat(60), 'no-usable-windows'],
      ['matched', 'A'.repeat(60), 'no-sequence-match'],
    ]) {
      const output = await executeResearchRequest({ type: 'spacers', genome: { ...spacerGenome, sequence }, library: spacerLibrary,
        options: { hostId, maxMismatches: 0 } });
      if (output.type !== 'analysis') throw new Error('Expected spacer analysis');
      assert.equal((output.record.fields.coverage.value as { status: string }).status, expected);
      assert.deepEqual(output.record.fields.matches.value, []);
    }
    const demo = await executeResearchRequest({ type: 'spacers', genome: spacerGenome,
      library: { ...spacerLibrary, source: { ...spacerLibrary.source, kind: 'demo' } }, options: { hostId: 'matched', maxMismatches: 0 } });
    if (demo.type !== 'analysis') throw new Error('Expected spacer analysis');
    assert.equal(demo.record.fields.matches.kind, 'demo'); assert.equal(demo.record.fields.coverage.kind, 'demo');
    assert.equal(demo.record.inputs[1].source, 'demo');
  });

  it('refuses an unknown host or invalid mismatch policy instead of substituting a supported scope', async () => {
    for (const options of [{ hostId: 'missing', maxMismatches: 0 }, { hostId: null, maxMismatches: 6 }, { hostId: null, maxMismatches: 0.5 }]) {
      await assert.rejects(executeResearchRequest({ type: 'spacers', genome: spacerGenome, library: spacerLibrary, options }));
    }
  });
});

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
  it('counts private GC windows and verifies a portable experiment using freshly recomputed evidence', async () => {
    const parsed = await executeResearchRequest({ type: 'parse', input: { name: 'private.fa', text: '>GC_FIXTURE\nNNNNGGCCGGGG' } });
    if (parsed.type !== 'parsed') throw new Error('Expected genomes');
    const output = await executeResearchRequest({ type: 'gc-skew', genome: parsed.result.genomes[0], options: { windowSize: 4, stepSize: 4 } });
    if (output.type !== 'analysis') throw new Error('Expected GC evidence');
    assert.deepEqual((output.record.fields.windows.value as unknown as Array<{ skew: number | null }>).map(row => row.skew), [null, 0, 1]);
    const replay = await executeResearchRequest({ type: 'gc-skew-replay', content: serializeAnalysisRecord(output.record) });
    assert.deepEqual(replay, output);
    const forged = structuredClone(output.record); forged.fields.originPosition.value = 7;
    await assert.rejects(executeResearchRequest({ type: 'gc-skew-replay', content: serializeAnalysisRecord(await createAnalysisRecord(forged)) }), /differ/);
  });
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
