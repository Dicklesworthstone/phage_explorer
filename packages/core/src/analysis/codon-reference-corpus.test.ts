import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createCodonReferenceCorpus, exportCodonCorpusReference, replayCodonReferenceCorpus,
  resolveCodonCorpusOptions, type CodonCorpusOptions } from './codon-reference-corpus';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { importLocalGenomes } from '../genome-import';

const metadata: CodonCorpusOptions = { name: 'Declared CDS set', organism: 'Synthetic count control',
  citation: 'Synthetic sequences with independently enumerated triplets; not a biological reference', version: 'test-1', geneticCode: 11 };
function gb(sequence: string, locations = [`1..${sequence.length}`], qualifiers: string[] = [], accession = 'REF', topology = 'linear'): string {
  return `LOCUS       ${accession} ${sequence.length} bp DNA ${topology}\nACCESSION   ${accession}\nFEATURES             Location/Qualifiers\n` +
    locations.map((location, i) => `     CDS             ${location}\n                     /locus_tag="g${i + 1}"\n                     /transl_table=11\n${qualifiers[i] ?? ''}`).join('') +
    `ORIGIN\n        1 ${sequence}\n//\n`;
}
const input = (text: string) => ({ name: 'reference.gb', text });
const nonzero = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n));
const rc = (value: string) => value.split('').reverse().map(base => ({ A: 'T', T: 'A', G: 'C', C: 'G' })[base]).join('');

describe('source-derived codon reference corpus', () => {
  it('counts the transcript across joined, reverse and circular-origin segments rather than genomic spans', async () => {
    const text = gb('ATGAAAGGGGAAGTAA', ['join(1..6,11..16)'], [], 'JOIN') +
      gb('TTATTTCAT', ['complement(1..9)'], [], 'REVERSE') +
      gb('AAATAAGGGGATG', ['join(11..13,1..6)'], [], 'CIRCLE', 'circular');
    const result = await createCodonReferenceCorpus(input(text), metadata);
    assert.deepEqual(nonzero(result.reference.counts), { AAA: 3, AAG: 1, ATG: 3, TAA: 3 });
    assert.equal(Object.keys(result.reference.counts).length, 64);
    assert.equal(result.summary.codons, 10); assert.equal(result.summary.terminalStops, 3);
    assert.equal(result.summary.countedCds, 3); assert.equal(result.summary.excludedMappedCds, 0);
    assert(result.genes.some(g => g.segments[0].strand === '-'));
    assert.equal(result.record.inputs[0].data && (result.record.inputs[0].data as { text: string }).text, text);
  });
  it('applies codon_start once after joining and retains the DNA identity of alternative initiators', async () => {
    const text = gb('AAGGGTGAAATAA', ['join(1..2,6..13)'], ['                     /codon_start=2\n'], 'FRAME') +
      gb('GTGAAATAA', undefined, ['                     /translation="MK"\n'], 'START');
    const result = await createCodonReferenceCorpus(input(text), metadata);
    // Transcript before phase removal is AATGAAATAA, then ATG AAA TAA.
    assert.deepEqual(nonzero(result.reference.counts), { AAA: 2, ATG: 1, GTG: 1, TAA: 2 });
  });
  it('matches independent codon multiplicities for every sense codon on both strands', async () => {
    const stop = new Set(['TAA', 'TAG', 'TGA']);
    const alphabet = 'ACGT', expected: Record<string, number> = {};
    const triplets: string[] = [];
    for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) {
      const codon = a + b + c; expected[codon] = 0;
      if (!stop.has(codon)) { triplets.push(codon, codon, codon); expected[codon] = 6; }
    }
    const sequence = triplets.join('') + 'TGA'; expected.TGA = 2;
    const result = await createCodonReferenceCorpus(input(gb(sequence, undefined, [], 'PLUS') +
      gb(rc(sequence), [`complement(1..${sequence.length})`], [], 'MINUS')), metadata);
    assert.deepEqual(result.reference.counts, Object.fromEntries(Object.entries(expected).sort()));
    assert.equal(result.summary.codons, 368);
  });
  it('rejects unsupported selected CDS by default and excludes whole transcripts only by explicit policy', async () => {
    const valid = gb('ATGAAATAA', undefined, [], 'GOOD');
    const invalid = [
      gb('ATGNNNTAA', undefined, [], 'UNKNOWN'), gb('ATGTAATAA', undefined, [], 'INTERNAL'),
      gb('ATGAAATA', undefined, [], 'PARTIAL'), gb('ATGAAATAA', undefined, ['                     /pseudo\n'], 'PSEUDO'),
      gb('ATGAAATAA', undefined, ['                     /ribosomal_slippage\n'], 'SLIPPAGE'),
      gb('ATGAAATAA', undefined, ['                     /translation="MP"\n'], 'TRANSLATION'),
    ];
    for (const text of invalid) {
      await assert.rejects(createCodonReferenceCorpus(input(valid + text), metadata), /cannot be counted/);
      const result = await createCodonReferenceCorpus(input(valid + text), { ...metadata, unavailable: 'exclude' });
      assert.deepEqual(nonzero(result.reference.counts), { AAA: 1, ATG: 1, TAA: 1 });
      assert.equal(result.summary.countedCds, 1); assert.equal(result.summary.excludedMappedCds, 1);
      assert(result.genes.some(g => g.status === 'excluded' && g.codons === 0 && g.reasons.length > 0));
      await assert.rejects(createCodonReferenceCorpus(input(text), { ...metadata, unavailable: 'exclude' }), /No valid/);
    }
  });
  it('does not substitute the chosen genetic code for an absent or different annotation table', async () => {
    const standard = gb('ATGAAATAA').replace('                     /transl_table=11\n', '');
    await assert.rejects(createCodonReferenceCorpus(input(standard), metadata), /genetic code differs/);
    assert.equal((await createCodonReferenceCorpus(input(standard), { ...metadata, geneticCode: 1 })).summary.codons, 3);
    await assert.rejects(createCodonReferenceCorpus(input(standard), { ...metadata, geneticCode: 4 as 11 }), /code 1 or 11/);
  });
  it('requires unique record selectors and scopes numeric CDS IDs to one exact record', async () => {
    const source = input(gb('ATGAAATAA', undefined, [], 'DUP') + gb('ATGAAGTAA', undefined, [], 'DUP'));
    await assert.rejects(createCodonReferenceCorpus(source, { ...metadata, record: 'DUP' }), /uniquely/);
    await assert.rejects(createCodonReferenceCorpus(source, { ...metadata, geneIds: [1] }), /single selected record/);
    const parsed = await importLocalGenomes(source);
    const selected = parsed.genomes[0].phage.localGenome!.contentId;
    const result = await createCodonReferenceCorpus(source, { ...metadata, record: selected, geneIds: [1] });
    assert.deepEqual(nonzero(result.reference.counts), { AAA: 1, ATG: 1, TAA: 1 });
    assert.equal(result.sources[0].contentId, selected);
    await assert.rejects(createCodonReferenceCorpus(source, { ...metadata, record: selected, geneIds: [999] }), /missing/);
    await assert.rejects(createCodonReferenceCorpus(source, { ...metadata, record: 'absent' }), /uniquely/);
    await assert.rejects(createCodonReferenceCorpus(input('>query\nATGAAATAA'), metadata), /GenBank CDS/);
  });
  it('separates parser-unmapped annotations from counted and excluded mapped CDS', async () => {
    const source = input(gb('ATGAAATAA', ['1..9', '<1..9']));
    await assert.rejects(createCodonReferenceCorpus(source, metadata), /unmapped CDS/);
    const result = await createCodonReferenceCorpus(source, { ...metadata, unavailable: 'exclude' });
    assert.equal(result.summary.unmappedCds, 1); assert.equal(result.summary.selectedMappedCds, 1);
    assert.equal(result.summary.countedCds, 1); assert.equal(result.sources[0].warnings.length, 1);
    assert.equal((await createCodonReferenceCorpus(source, { ...metadata, geneIds: [1] })).summary.codons, 3);
    const repeated = input(gb('ATGAAATAA', undefined, ['                     /codon_start=1\n                     /codon_start=2\n']));
    await assert.rejects(createCodonReferenceCorpus(repeated, { ...metadata, unavailable: 'exclude' }), /Repeated CDS qualifiers/);
  });
  it('prevents duplicated annotations from inflating counts without collapsing distinct identical loci', async () => {
    const source = input(gb('ATGAAATAAATGAAATAA', ['1..9', '1..9', '10..18']));
    await assert.rejects(createCodonReferenceCorpus(source, metadata), /Duplicate transcript/);
    const result = await createCodonReferenceCorpus(source, { ...metadata, unavailable: 'exclude' });
    assert.equal(result.summary.countedCds, 2); assert.equal(result.summary.excludedMappedCds, 1);
    assert.deepEqual(nonzero(result.reference.counts), { AAA: 2, ATG: 2, TAA: 2 });
    const pseudoFirst = input(gb('ATGAAATAA', ['1..9', '1..9'], ['                     /pseudo\n']));
    assert.equal((await createCodonReferenceCorpus(pseudoFirst, { ...metadata, unavailable: 'exclude' })).summary.countedCds, 1);
  });
  it('captures the source and selection before asynchronous parsing and preserves raw spelling', async () => {
    const source = input(gb('atgaaataa')), settings = { ...metadata, geneIds: [1] };
    const original = source.text, task = createCodonReferenceCorpus(source, settings);
    source.text = 'changed'; settings.geneIds.push(2); settings.name = 'changed';
    const result = await task;
    assert.equal(result.reference.name, metadata.name);
    assert.equal((result.record.inputs[0].data as { text: string }).text, original);
    assert.deepEqual(result.record.parameters.geneIds, [1]);
  });
  it('fresh replay rejects rehashed fabricated counts, coverage and selection', async () => {
    const result = await createCodonReferenceCorpus(input(gb('ATGAAATAA')), metadata);
    const replay = await replayCodonReferenceCorpus(serializeAnalysisRecord(result.record));
    assert.deepEqual(replay, result);
    for (const kind of ['count', 'coverage', 'selection']) {
      const { format: _f, version: _v, resultId: _r, cacheKey: _k, ...data } = structuredClone(result.record);
      if (kind === 'count') (data.fields.reference.value as unknown as { counts: Record<string, number> }).counts.AAA = 800;
      if (kind === 'coverage') (data.fields.summary.value as { codons: number }).codons = 800;
      if (kind === 'selection') data.parameters.geneIds = [999];
      const forged = await createAnalysisRecord(data);
      await assert.rejects(replayCodonReferenceCorpus(serializeAnalysisRecord(forged)), /Recomputed|missing/);
    }
    const exported = JSON.parse(exportCodonCorpusReference(result));
    assert.deepEqual(exported.counts, result.reference.counts);
    assert.deepEqual(Object.keys(exported).sort(), ['counts', 'format', 'geneticCode', 'name', 'organism', 'source', 'version']);
    assert(exported.source.version.endsWith(result.record.resultId));
    assert.equal(result.reference.source.version, metadata.version, 'export must not mutate accepted evidence');
  });
  it('enforces the aggregate extraction budget before allocating repeated transcripts', async () => {
    const sequence = 'ATG'.repeat(20000), source = input(gb(sequence, Array(418).fill('1..60000')));
    await assert.rejects(createCodonReferenceCorpus(source, { ...metadata, unavailable: 'exclude' }), /25,000,000/);
  });
  it('rejects unsupported options and nonfinite/duplicate selections', () => {
    for (const changes of [{ name: '' }, { citation: 'bad\u001b' }, { version: 'v'.repeat(201) }, { geneIds: [] },
      { geneIds: [1, 1] }, { geneIds: [NaN] }, { geneIds: [-1] }, { unavailable: 'guess' }, { ignored: true }]) {
      assert.throws(() => resolveCodonCorpusOptions({ ...metadata, ...changes } as CodonCorpusOptions));
    }
  });
});
