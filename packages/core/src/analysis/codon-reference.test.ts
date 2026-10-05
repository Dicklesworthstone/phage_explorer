import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { CODON_TABLE } from '../codons';
import { importLocalGenomes } from '../genome-import';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { buildCodonReferenceWeights, createReferenceCodonExperiment, parseCodonReference, referenceGenomeFromPhage,
  replayReferenceCodonExperiment, scoreCodonReferenceSequence, type CodonReference } from './codon-reference';

const reference = (counts: Record<string, number> = { AAA: 8, AAG: 2 }): CodonReference => ({
  format: 'phage-explorer-codon-reference', version: 1, name: 'Hand-counted validation set', organism: 'Synthetic test reference',
  geneticCode: 11, source: { citation: 'Literal test counts, not an experimental organism profile', version: 'fixture-1' }, counts,
});
const json = (counts?: Record<string, number>) => JSON.stringify(reference(counts));
const close = (actual: number | null, expected: number) => { assert.notEqual(actual, null); assert(Math.abs(actual! - expected) < 1e-12, `${actual} != ${expected}`); };
// RC(TTTG) + RC(CTT) = CAAA + AAG. /codon_start=2 -> AAA AAG.
const joinedGenBank = `LOCUS       REFERENCE_QUERY           11 bp DNA circular
ACCESSION   REFERENCE_QUERY
FEATURES             Location/Qualifiers
     CDS             complement(join(1..3,8..11))
                     /locus_tag="joined"
                     /codon_start=2
                     /transl_table=11
     CDS             1..3
                     /locus_tag="uncovered"
ORIGIN
        1 cttcccctttg
//
`;
async function input() {
  const imported = (await importLocalGenomes({ name: 'query.gb', text: joinedGenBank })).genomes[0];
  return { genome: referenceGenomeFromPhage(imported.phage), sequence: imported.sequence };
}

describe('reported codon-count references', () => {
  it('preserves explicit counts, source attribution and version', () => {
    assert.deepEqual(parseCodonReference(json()), reference());
  });
  it('rejects unsupported schemas, codes, missing attribution and hidden fields', () => {
    for (const change of [{ version: 2 }, { format: 'weights' }, { geneticCode: 4 }, { organism: '' }, { name: '\u001b[2J' },
      { source: { citation: '', version: '1' } }, { source: { citation: 'test', version: '' } }, { extra: 'unexpected' }]) {
      assert.throws(() => parseCodonReference(JSON.stringify({ ...reference(), ...change })));
    }
  });
  it('rejects frequencies, unsafe sums, empty data and unknown codon names', () => {
    for (const counts of [{ AAA: -1 }, { AAA: 1.2 }, { aaa: 1 }, { NNN: 1 }, { AAA: 0, AAG: 0 }, {},
      { AAA: Number.MAX_SAFE_INTEGER, AAG: 1 }, JSON.parse('{"__proto__":1,"AAA":2}')]) {
      assert.throws(() => parseCodonReference(json(counts)));
    }
    assert.throws(() => parseCodonReference(' '.repeat(128 * 1024 + 1)), /128 KiB/);
  });
  it('normalizes within each complete synonymous family, not across amino acids', () => {
    const weights = buildCodonReferenceWeights(reference({ AAA: 8, AAG: 2, TTT: 3, TTC: 1 }));
    assert.equal(weights.weights.AAA, 1); assert.equal(weights.weights.AAG, 0.25);
    assert.equal(weights.weights.TTT, 1); close(weights.weights.TTC, 1 / 3);
    assert.deepEqual(weights.coveredFamilies, ['F', 'K']);
    assert.equal(weights.weights.CTT, null);
  });
  it('distinguishes omitted counts, explicit zeros and completely unobserved families', () => {
    assert.equal(buildCodonReferenceWeights(reference({ AAA: 8 })).weights.AAA, null, 'AAG is not implicitly zero');
    close(buildCodonReferenceWeights(reference({ AAA: 8, AAG: 0 })).weights.AAG, 0.5 / 8);
    assert.equal(buildCodonReferenceWeights(reference({ AAA: 8, AAG: 0 }), 0).weights.AAG, 0);
    const missing = buildCodonReferenceWeights(reference({ AAA: 0, AAG: 0, TTT: 3, TTC: 1 }));
    assert.equal(missing.weights.AAA, null, 'all-zero family is not manufactured into weights of one');
    assert.equal(missing.weights.AAG, null);
    assert.throws(() => buildCodonReferenceWeights(reference(), 1 as 0), /0 or 0.5/);
  });
});

describe('reference-relative CDS scores', () => {
  it('matches the hand-derived geometric mean and excludes Met, Trp and the terminal stop', () => {
    // w(AAA)=1, w(AAG)=1/4 => sqrt(1/4)=1/2, not an arithmetic average or 0.01 floor.
    const score = scoreCodonReferenceSequence('atgAAAAAGtggtaa', reference());
    close(score.cai, 0.5);
    assert.equal(score.completeCodons, 5); assert.equal(score.eligibleCodons, 2);
    assert.equal(score.scoredCodons, 2); assert.equal(score.singleCodonAminoAcids, 2); assert.equal(score.stopCodons, 1);
  });
  it('supports reported-zero replacement as a recorded method choice', () => {
    close(scoreCodonReferenceSequence('AAAAAG', reference({ AAA: 8, AAG: 0 })).cai, 0.25);
    const zero = scoreCodonReferenceSequence('AAAAAG', reference({ AAA: 8, AAG: 0 }), 0);
    assert.equal(zero.cai, 0); assert.equal(zero.zeroWeightCodons, 1);
  });
  it('never substitutes scores for unknown triplets, partial codons or internal stops', () => {
    for (const sequence of ['AAANNNAAG', 'AAAßAAG', 'AAAAAGC', 'AAATAAAAG', 'NNNNNN', 'ATGTGGTAA', '']) {
      const score = scoreCodonReferenceSequence(sequence, reference());
      assert.equal(score.cai, null); assert(score.reasons.length > 0);
    }
    const mixed = scoreCodonReferenceSequence('AAANNNAAG', reference());
    assert.equal(mixed.ambiguousCodons, 1); assert.equal(mixed.scoredCodons, 2);
    assert.equal(scoreCodonReferenceSequence('AAATAAAAG', reference()).internalStops, 1);
  });
  it('reports missing reference coverage instead of computing a biased observed-only gene score', () => {
    const score = scoreCodonReferenceSequence('AAAAAGTTT', reference());
    assert.equal(score.cai, null); assert.equal(score.scoredCodons, 2); assert.equal(score.eligibleCodons, 3);
    assert.deepEqual(score.missingReferenceCodons, { TTT: 1 });
  });
  it('agrees with direct products for all 256 eight-codon Lys sequences', () => {
    for (let mask = 0; mask < 256; mask++) {
      let sequence = '', product = 1;
      for (let i = 0; i < 8; i++) {
        const rare = (mask & (1 << i)) !== 0;
        sequence += rare ? 'AAG' : 'AAA'; product *= rare ? 0.25 : 1;
      }
      close(scoreCodonReferenceSequence(sequence, reference()).cai, Math.pow(product, 1 / 8));
    }
  });
  it('uses finite values without early rounding across long CDS', () => {
    const counts = { AAA: 1_000_000, AAG: 1 };
    close(scoreCodonReferenceSequence('AAAAAG'.repeat(10000), reference(counts)).cai, 0.001);
    assert.throws(() => scoreCodonReferenceSequence('A'.repeat(5_000_001), reference()), /5,000,000/);
  });
  it('normalizes six-fold families together rather than splitting Leu/Ser/Arg subfamilies', () => {
    const counts = Object.fromEntries(Object.keys(CODON_TABLE).map(codon => [codon, 2]));
    counts.CTG = 8;
    const weights = buildCodonReferenceWeights(reference(counts));
    assert.equal(weights.coveredFamilies.length, 18);
    for (const codon of ['TTA', 'TTG', 'CTT', 'CTC', 'CTA']) assert.equal(weights.weights[codon], 0.25);
    close(scoreCodonReferenceSequence('TTACTG', reference(counts)).cai, 0.5);
  });
});

describe('reference experiments from original annotations', () => {
  it('imports joined/complement CDS and codon_start, reports incomplete coverage and replays original inputs', async () => {
    const { genome, sequence } = await input();
    const result = await createReferenceCodonExperiment(genome, sequence, json());
    close(result.analysis.genes[0].cai, 0.5); assert.equal(result.analysis.genes[0].scoredCodons, 2);
    assert.equal(result.analysis.genes[1].cai, null);
    assert.deepEqual(result.analysis.summary, { cai: 0.5, scoredGenes: 1, totalGenes: 2, scoredCodons: 2 });
    assert.equal(result.record.inputs.find(i => i.id === 'reference')!.data, json());
    assert.equal(result.record.inputs.find(i => i.id === 'genome')!.data, sequence);
    assert.equal(result.record.fields.pooledCai.kind, 'sequence-score');
    assert(!Object.values(result.record.fields).some(field => field.kind === 'demo'));
    const replay = await replayReferenceCodonExperiment(serializeAnalysisRecord(result.record));
    assert.deepEqual(replay, result);
  });
  it('selects one CDS explicitly and rejects a missing or non-coding selection', async () => {
    const { genome, sequence } = await input();
    const result = await createReferenceCodonExperiment(genome, sequence, json(), { geneIds: [1] });
    assert.equal(result.analysis.genes.length, 1); close(result.analysis.summary.cai, 0.5);
    for (const geneIds of [[], [999], [1, 1], [NaN]]) {
      await assert.rejects(createReferenceCodonExperiment(genome, sequence, json(), { geneIds }));
    }
    const noncoding = { ...genome, genes: [{ ...genome.genes[0], type: 'tRNA' }] };
    await assert.rejects(createReferenceCodonExperiment(noncoding, sequence, json(), { geneIds: [1] }), /missing|not a coding/);
  });
  it('calculates a codon-weighted pooled geometric mean, never an arithmetic gene average', async () => {
    const imported = (await importLocalGenomes({ name: 'weighted.gb', text: `LOCUS       WEIGHTED 9 bp DNA linear
FEATURES             Location/Qualifiers
     CDS             1..3
     CDS             4..9
ORIGIN
        1 aaaaagaag
//
` })).genomes[0];
    const result = await createReferenceCodonExperiment(referenceGenomeFromPhage(imported.phage), imported.sequence, json());
    close(result.analysis.genes[0].cai, 1); close(result.analysis.genes[1].cai, 0.25);
    close(result.analysis.summary.cai, Math.pow(1 * 0.25 * 0.25, 1 / 3));
    assert.equal(result.analysis.summary.scoredCodons, 3);
  });
  it('uses transcript order at the circular origin and does not score the intervening region', async () => {
    const imported = (await importLocalGenomes({ name: 'origin.gb', text: `LOCUS       ORIGIN_QUERY 9 bp DNA circular
FEATURES             Location/Qualifiers
     CDS             join(7..9,1..3)
ORIGIN
        1 aagnnnaaa
//
` })).genomes[0];
    const result = await createReferenceCodonExperiment(referenceGenomeFromPhage(imported.phage), imported.sequence, json());
    close(result.analysis.genes[0].cai, 0.5); assert.equal(result.analysis.genes[0].ambiguousCodons, 0);
  });
  it('keeps unsupported CDS and reference absence explicitly unavailable', async () => {
    const { genome, sequence } = await input();
    for (const qualifier of [{ transl_table: '4' }, { pseudo: '' }, { transl_except: '(pos:1..3,aa:Sec)' }, { codon_start: '4' }]) {
      const changed = { ...genome, genes: [{ ...genome.genes[0], qualifiers: { ...genome.genes[0].qualifiers, ...qualifier } }] };
      const result = await createReferenceCodonExperiment(changed, sequence, json());
      assert.equal(result.analysis.summary.cai, null); assert.equal(result.record.fields.pooledCai.kind, 'unavailable');
      assert(result.analysis.genes[0].reasons.length > 0);
    }
    await assert.rejects(createReferenceCodonExperiment({ ...genome, genes: [] }, sequence, json()), /No coding annotations/);
  });
  it('snapshots parameters and source annotations before asynchronous hashing', async () => {
    const { genome, sequence } = await input();
    const options = { geneIds: [1] };
    const pending = createReferenceCodonExperiment(genome, sequence, json(), options);
    genome.genes[0].qualifiers!.codon_start = '1'; options.geneIds.push(2);
    const result = await pending;
    close(result.analysis.genes[0].cai, 0.5); assert.equal(result.analysis.genes.length, 1);
    const replay = await replayReferenceCodonExperiment(serializeAnalysisRecord(result.record));
    assert.equal(replay.record.resultId, result.record.resultId);
  });
  it('binds reference counts, source version, zero policy and selected annotations to result identity', async () => {
    const { genome, sequence } = await input();
    const baseline = await createReferenceCodonExperiment(genome, sequence, json());
    const changedVersion = reference(); changedVersion.source.version = 'fixture-2';
    const changed = await Promise.all([
      createReferenceCodonExperiment(genome, sequence, json({ AAA: 4, AAG: 2 })),
      createReferenceCodonExperiment(genome, sequence, JSON.stringify(changedVersion)),
      createReferenceCodonExperiment(genome, sequence, json(), { zeroCountReplacement: 0 }),
      createReferenceCodonExperiment(genome, sequence, json(), { geneIds: [1] }),
    ]);
    for (const result of changed) assert.notEqual(result.record.cacheKey, baseline.record.cacheKey);
  });
  it('rejects changed inputs and rehashed forged outputs instead of merely trusting stored checksums', async () => {
    const { genome, sequence } = await input();
    const { record } = await createReferenceCodonExperiment(genome, sequence, json());
    const edited = structuredClone(record); edited.inputs.find(i => i.id === 'reference')!.data = json({ AAA: 4, AAG: 2 });
    await assert.rejects(replayReferenceCodonExperiment(serializeAnalysisRecord(edited)), /checksum/);
    const forged = await createAnalysisRecord({ ...record, inputs: record.inputs, fields: {
      ...record.fields, pooledCai: { ...record.fields.pooledCai, kind: 'sequence-score', units: 'fraction', value: 0.999 },
    } });
    await assert.rejects(replayReferenceCodonExperiment(serializeAnalysisRecord(forged)), /Recomputed/);
  });
  it('rejects pathological annotation expansion before building the transcript', async () => {
    const { genome } = await input();
    const sequence = 'AAA'.repeat(1_000_000);
    const expanded = { ...genome, genes: [{ ...genome.genes[0], qualifiers: { _segments:
      Array.from({ length: 9 }, () => ({ start: 0, end: sequence.length, strand: '+' })) } }] };
    await assert.rejects(createReferenceCodonExperiment(expanded, sequence, json()), /25,000,000/);
  });
});
