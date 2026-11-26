import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createRegionComparisonExperiment, replayRegionComparisonExperiment, exportRegionComparisonFasta,
  exportRegionComparisonTsv, REGION_COMPARISON_LIMITS, REGION_COMPARISON_METHOD,
  type RegionComparisonOptions, type RegionComparisonResult, type RegionInterval,
} from './region-comparison-experiment';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { exportCatalogGenomeSnapshot, importLocalGenomes, type GenomeInput } from '../../core/src/genome-import';

const fasta = (sequence: string, accession = 'PRIVATE'): GenomeInput => ({ name: accession + '.fa', text: '>' + accession + '\n' + sequence + '\n' });
function genbank(sequence: string, features: Array<{ location: string; type?: string; qualifiers?: string }>): GenomeInput {
  return { name: 'private.gb', text: 'LOCUS       PRIVATE ' + sequence.length + ' bp DNA circular\nACCESSION   PRIVATE\nFEATURES             Location/Qualifiers\n'
    + features.map(feature => '     ' + (feature.type ?? 'CDS').padEnd(16) + feature.location
      + '\n                     /locus_tag="duplicate"\n' + (feature.qualifiers ?? '')).join('')
    + 'ORIGIN\n        1 ' + sequence.toLowerCase() + '\n//\n' };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const region = (start: number, end: number, strand: '+' | '-' = '+'): RegionInterval => ({ start, end, strand });
const options = (left: RegionInterval, right = left): RegionComparisonOptions => ({ regionA: { ...left }, regionB: { ...right } });
const forwardA = fasta('TTTACGTAAGGG', 'LEFT'), forwardB = fasta('GGGACGCTAATT', 'RIGHT');
const forwardOptions = () => options(region(3, 9), region(3, 10));
function readFasta(content: string) {
  return content.trim().split(/^>/m).slice(1).map(part => {
    const [header, ...sequence] = part.split('\n');
    return { id: header.split(' ')[0], header, sequence: sequence.join('') };
  });
}
/** Independent O(n*m) distance oracle is used only for tiny fixtures. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    }
    previous = next;
  }
  return previous[b.length];
}
async function rehashed(record: AnalysisRecord): Promise<string> {
  const { format: _format, version: _version, cacheKey: _cache, resultId: _result, ...settings } = record;
  return serializeAnalysisRecord(await createAnalysisRecord(settings));
}

describe('source-owned exact interval and strand comparisons', () => {
  it('retains original genomes and exact forward edit coordinates with complete portable exports', async () => {
    const experiment = await createRegionComparisonExperiment(forwardA, forwardB, forwardOptions());
    const { result, record } = experiment;
    assert.deepEqual(result.stats, { lengthA: 6, lengthB: 7, alignmentColumns: 7, matches: 6,
      substitutions: 0, insertions: 1, deletions: 0, distance: 1, ambiguousColumns: 0, identity: 100 * 6 / 7 });
    assert.equal(result.alignedA, 'ACG-TAA');
    assert.equal(result.alignedB, 'ACGCTAA');
    assert.deepEqual(result.runs, [
      { operation: 'match', startA: 0, endA: 3, startB: 0, endB: 3, sourceStartA: 3, sourceEndA: 6, sourceStartB: 3, sourceEndB: 6 },
      { operation: 'insertion', startA: 3, endA: 3, startB: 3, endB: 4, sourceStartA: 6, sourceEndA: 6, sourceStartB: 6, sourceEndB: 7 },
      { operation: 'match', startA: 3, endA: 6, startB: 4, endB: 7, sourceStartA: 6, sourceEndA: 9, sourceStartB: 7, sourceEndB: 10 },
    ]);
    assert.equal(result.sourceA.sequenceSha256, hash('TTTACGTAAGGG'));
    assert.equal(result.sourceB.sequenceSha256, hash('GGGACGCTAATT'));
    assert.equal(result.sourceA.genomeLength, 12); assert.equal(result.sourceB.genomeLength, 12);
    assert.deepEqual(record.inputs.map(input => input.data), [forwardA, forwardB]);
    assert.deepEqual(record.fields.comparison.coverage, { available: 13, total: 24, unit: 'bases' });
    assert.equal(record.method.id, REGION_COMPARISON_METHOD.id);
    assert.equal(record.fields.comparison.kind, 'sequence-score');
    assert.equal(experiment.options.recordA, result.sourceA.contentId);
    assert.equal(experiment.options.recordB, result.sourceB.contentId);
    const table = exportRegionComparisonTsv(experiment);
    assert.ok(table.includes('insertion\t3\t3\t3\t4\t6\t6\t+\t6\t7\t+\t1\n'));
    assert.equal(table.trim().split('\n').filter(line => !line.startsWith('#')).length, result.runs.length + 1);
    const aligned = readFasta(exportRegionComparisonFasta(experiment));
    assert.deepEqual(aligned.map(row => row.sequence), ['ACG-TAA', 'ACGCTAA']);
    assert.deepEqual(aligned.map(row => row.id), ['region-A', 'region-B']);
    assert.match(aligned[0].header, /source_interval_1based=4\.\.9 strand=\+/);
    assert.ok(aligned[0].header.includes('genome_sha256=' + result.sourceA.sequenceSha256));
    assert.ok(aligned[0].header.includes('input_sha256=' + record.inputs[0].sha256));
    assert.ok(aligned[0].header.includes('result_id=' + record.resultId));
    assert.deepEqual(await replayRegionComparisonExperiment('\uFEFF' + serializeAnalysisRecord(record)), experiment);
  });

  it('maps reverse-strand indels and terminal boundaries back to ascending original coordinates', async () => {
    const experiment = await createRegionComparisonExperiment(fasta('CCCTTACGTAAA'), fasta('GGGTTAGCGTTT'),
      options(region(3, 9, '-'), region(3, 10, '-')));
    assert.equal(experiment.result.alignedA, 'ACG-TAA'); assert.equal(experiment.result.alignedB, 'ACGCTAA');
    assert.deepEqual(experiment.result.runs.map(run => [run.sourceStartA, run.sourceEndA, run.sourceStartB, run.sourceEndB]), [
      [6, 9, 7, 10], [6, 6, 6, 7], [3, 6, 3, 6],
    ]);
    for (const [b, localBoundary, sourceBoundary] of [['ACGT', 3, 3], ['CACG', 0, 6]] as const) {
      const terminal = await createRegionComparisonExperiment(fasta('TTTCGTAAA'), fasta(b), options(region(3, 6, '-'), region(0, 4)));
      const insertion = terminal.result.runs.find(run => run.operation === 'insertion')!;
      assert.equal(insertion.startA, localBoundary); assert.equal(insertion.endA, localBoundary);
      assert.equal(insertion.sourceStartA, sourceBoundary); assert.equal(insertion.sourceEndA, sourceBoundary);
      assert.equal(terminal.result.stats.distance, 1);
    }
    const identity = await createRegionComparisonExperiment(fasta('TTACGTAACC', 'ALPHA'), fasta('GGTTACGTAA', 'BETA'),
      options(region(2, 8), region(2, 8, '-')));
    assert.equal(identity.result.alignedA, 'ACGTAA'); assert.equal(identity.result.alignedB, 'ACGTAA');
    assert.equal(identity.result.stats.distance, 0);
    assert.deepEqual(identity.result.runs.map(run => [run.sourceStartA, run.sourceEndA, run.sourceStartB, run.sourceEndB]), [[2, 8, 2, 8]]);
    assert.deepEqual(await replayRegionComparisonExperiment(serializeAnalysisRecord(experiment.record)), experiment);
  });

  it('supports two distinct loci in one original genome without inventing derivative source identities', async () => {
    const source = fasta('ACGTTTACG', 'SAME');
    const experiment = await createRegionComparisonExperiment(source, source, options(region(0, 3), region(6, 9)));
    assert.equal(experiment.result.stats.distance, 0);
    assert.equal(experiment.result.sourceA.contentId, experiment.result.sourceB.contentId);
    assert.equal(experiment.record.inputs[0].sha256, experiment.record.inputs[1].sha256);
    assert.deepEqual(experiment.record.inputs.map(input => input.id), ['genomeA', 'genomeB']);
    assert.deepEqual(experiment.result.runs.map(run => [run.sourceStartA, run.sourceEndA, run.sourceStartB, run.sourceEndB]), [[0, 3, 6, 9]]);
    assert.deepEqual(readFasta(exportRegionComparisonFasta(experiment)).map(row => row.id), ['region-A', 'region-B']);
  });

  it('selects short intervals from sources above the whole-alignment limit and binds bases outside those intervals', async () => {
    const sequence = 'A'.repeat(150000) + 'ACGTACGT' + 'T'.repeat(149992);
    const source = fasta(sequence, 'LARGE');
    const selection = options(region(150000, 150008));
    const first = await createRegionComparisonExperiment(source, source, selection);
    assert.equal(first.result.sourceA.genomeLength, 300000); assert.equal(first.result.stats.distance, 0);
    assert.equal(first.result.regionA.sequence, 'ACGTACGT');
    const edited = fasta('C' + sequence.slice(1), 'LARGE');
    const second = await createRegionComparisonExperiment(edited, source, selection);
    assert.deepEqual(second.result.stats, first.result.stats);
    assert.notEqual(second.result.sourceA.sequenceSha256, first.result.sourceA.sequenceSha256);
    assert.notEqual(second.options.recordA, first.options.recordA);
    assert.notEqual(second.record.cacheKey, first.record.cacheKey);
    assert.notEqual(second.record.resultId, first.record.resultId);
    assert.equal((await replayRegionComparisonExperiment(serializeAnalysisRecord(first.record))).inputA.text, source.text);
  });

  it('clips joined annotation segments in transcript order and flips strands without filling intervening gaps', async () => {
    const source = genbank('ATGAAACCTAA', [
      { location: 'join(1..6,9..11)', qualifiers: '                     /product="split capsid"\n' },
      { location: 'complement(4..6)', type: 'gene' },
    ]);
    const experiment = await createRegionComparisonExperiment(source, source, options(region(3, 10, '-')));
    assert.equal(experiment.result.annotationsA.length, 2);
    const [joined, reverse] = experiment.result.annotationsA;
    assert.equal(joined.gene.product, 'split capsid');
    assert.equal(joined.gene.qualifiers?._location, 'join(1..6,9..11)');
    assert.equal(joined.fullyContained, false);
    assert.deepEqual(joined.segments, [
      { sourceStart: 3, sourceEnd: 6, regionStart: 4, regionEnd: 7, sourceStrand: '+', regionStrand: '-' },
      { sourceStart: 8, sourceEnd: 10, regionStart: 0, regionEnd: 2, sourceStrand: '+', regionStrand: '-' },
    ]);
    assert.equal(reverse.fullyContained, true);
    assert.deepEqual(reverse.segments, [
      { sourceStart: 3, sourceEnd: 6, regionStart: 4, regionEnd: 7, sourceStrand: '-', regionStrand: '+' },
    ]);
    const gap = await createRegionComparisonExperiment(source, source, options(region(6, 8)));
    assert.deepEqual(gap.result.annotationsA, []); assert.deepEqual(gap.result.annotationsB, []);
    const tableRows = exportRegionComparisonTsv(experiment).trim().split('\n').filter(line => line.startsWith('# annotation_A\t'));
    assert.deepEqual(tableRows.map(line => JSON.parse(line.slice('# annotation_A\t'.length))), experiment.result.annotationsA);
    assert.deepEqual(await replayRegionComparisonExperiment(serializeAnalysisRecord(experiment.record)), experiment);
  });

  it('retains complete unsupported annotation evidence and captured catalog provenance without fabricated context', async () => {
    const original = genbank('ATGAAATAA', [
      { location: '1..9' }, { location: 'REMOTE.1:1..9' },
    ]);
    const local = await createRegionComparisonExperiment(original, original, options(region(0, 9)));
    assert.equal(local.result.annotationsA.length, 1);
    assert.match(local.result.annotationWarnings.join('\n'), /REMOTE\.1:1\.\.9/);
    assert.deepEqual(local.record.inputs[0].data, original);
    const parsed = (await importLocalGenomes(original)).genomes[0];
    const { localGenome: _local, ...phage } = parsed.phage;
    phage.id = 17; phage.slug = 'catalog-fixture'; phage.genes[0].id = 92;
    const snapshot = await exportCatalogGenomeSnapshot(phage, parsed.sequence, { contentVersion: 'a'.repeat(64) });
    const catalog = await createRegionComparisonExperiment(snapshot, original, options(region(0, 9)));
    assert.equal(catalog.result.sourceA.format, 'catalog-snapshot');
    assert.equal(catalog.result.annotationsA[0].gene.id, 92);
    assert.equal(JSON.parse(catalog.inputA.text).provenance.contentVersion, 'a'.repeat(64));
    assert.deepEqual(await replayRegionComparisonExperiment(serializeAnalysisRecord(catalog.record)), catalog);
    phage.genes[0].qualifiers = { _location: 'join(1..3,7..9)' };
    const incomplete = await exportCatalogGenomeSnapshot(phage, parsed.sequence);
    const omitted = await createRegionComparisonExperiment(incomplete, original, options(region(3, 6)));
    assert.deepEqual(omitted.result.annotationsA, []);
    assert.match(omitted.result.annotationWarnings.join('\n'), /inconsistent exact segments/);
    assert.equal(omitted.result.stats.distance, 0);
    assert.equal(JSON.parse(omitted.inputA.text).genome.genes[0].qualifiers._location, 'join(1..3,7..9)');
    phage.genes[0].qualifiers = { _location: 42 };
    const malformed = await exportCatalogGenomeSnapshot(phage, parsed.sequence);
    const unavailable = await createRegionComparisonExperiment(malformed, original, options(region(0, 9)));
    assert.deepEqual(unavailable.result.annotationsA, []);
    assert.match(unavailable.result.annotationWarnings.join('\n'), /inconsistent exact segments/);
  });

  it('requires explicit record selection and snapshots both source inputs and nested settings before yielding', async () => {
    const source = { name: 'both.fa', text: '>duplicate first\nACGT\n>duplicate second\nAGGT\n' };
    const genomes = (await importLocalGenomes(source)).genomes;
    await assert.rejects(createRegionComparisonExperiment(source, fasta('AGGT'), options(region(0, 4))), /exactly one/);
    await assert.rejects(createRegionComparisonExperiment(source, fasta('AGGT'), { ...options(region(0, 4)), recordA: 'duplicate' }), /exactly one/);
    const inputA = { ...source }, inputB = fasta('AGGT', 'OTHER');
    const requested = { ...options(region(0, 4)), recordA: genomes[1].phage.localGenome!.contentId, recordB: 'OTHER' };
    const expectedA = { ...inputA }, expectedB = { ...inputB };
    const pending = createRegionComparisonExperiment(inputA, inputB, requested);
    inputA.text = '>mutated\nAAAA'; inputA.name = 'mutatedA';
    inputB.text = '>mutated\nCCCC'; inputB.name = 'mutatedB';
    requested.regionA.start = 2; requested.regionB.strand = '-'; requested.recordA = 'changed'; requested.recordB = 'changed';
    const experiment = await pending;
    assert.deepEqual(experiment.inputA, expectedA); assert.deepEqual(experiment.inputB, expectedB);
    assert.equal(experiment.options.recordA, genomes[1].phage.localGenome!.contentId);
    assert.deepEqual(experiment.options.regionA, region(0, 4)); assert.deepEqual(experiment.options.regionB, region(0, 4));
    assert.equal(experiment.result.alignedA, 'AGGT'); assert.equal(experiment.result.stats.distance, 0);
    assert.deepEqual(await replayRegionComparisonExperiment(serializeAnalysisRecord(experiment.record)), experiment);
  });

  it('gives an exact content selector precedence over a different record with that accession', async () => {
    const first = fasta('ACGT', 'ORIGINAL');
    const contentId = (await importLocalGenomes(first)).genomes[0].phage.localGenome!.contentId;
    const combined = { name: 'collision.fa', text: first.text + '>' + contentId + '\nCCCC\n' };
    const experiment = await createRegionComparisonExperiment(combined, first, { ...options(region(0, 4)), recordA: contentId });
    assert.equal(experiment.options.recordA, contentId);
    assert.equal(experiment.result.sourceA.accession, 'ORIGINAL');
    assert.equal(experiment.result.stats.distance, 0);
  });

  it('agrees with independent edit-distance fixtures and treats ambiguity symbols literally', async () => {
    for (const [a, b] of [['ACG', 'AG'], ['A', 'CA'], ['AC', 'C'], ['ACGT', 'TCGA'], ['NN', 'NA'], ['ARY', 'AGY']]) {
      const experiment = await createRegionComparisonExperiment(fasta(a), fasta(b), options(region(0, a.length), region(0, b.length)));
      const { result } = experiment;
      assert.equal(result.stats.distance, editDistance(a, b));
      assert.equal(result.alignedA.replace(/-/g, ''), a); assert.equal(result.alignedB.replace(/-/g, ''), b);
      assert.equal(result.alignedA.length, result.alignedB.length);
      assert.equal(result.stats.alignmentColumns, result.alignedA.length);
      for (let i = 0; i < result.alignedA.length; i++) assert.ok(result.alignedA[i] !== '-' || result.alignedB[i] !== '-');
    }
    const ambiguous = await createRegionComparisonExperiment(fasta('NN'), fasta('NA'), options(region(0, 2)));
    assert.equal(ambiguous.result.stats.matches, 1); assert.equal(ambiguous.result.stats.distance, 1);
    assert.equal(ambiguous.result.stats.identity, 50); assert.equal(ambiguous.result.stats.ambiguousColumns, 2);
    const reverse = await createRegionComparisonExperiment(fasta('RYSWKMBDHVN'), fasta('NBDHVKMWSRY'),
      options(region(0, 11, '-'), region(0, 11)));
    assert.equal(reverse.result.stats.distance, 0);
    assert.equal(reverse.result.regionA.sequence, 'NBDHVKMWSRY');
  });

  it('rejects malformed, wrapping, out-of-range, over-limit and unsupported settings without clamping', async () => {
    const source = fasta('ACGT');
    for (const value of [
      { start: -1, end: 2, strand: '+' }, { start: 0, end: 0, strand: '+' }, { start: 3, end: 2, strand: '+' },
      { start: 0.5, end: 2, strand: '+' }, { start: 0, end: 5, strand: '+' }, { start: 0, end: 2 },
      { start: 0, end: 2, strand: '?' }, { start: 0, end: 2, strand: { toString: () => '+' } },
      { start: 0, end: 2, strand: '+', unknown: true },
      { start: 0, end: REGION_COMPARISON_LIMITS.regionBases + 1, strand: '+' },
    ]) {
      await assert.rejects(createRegionComparisonExperiment(source, source, { regionA: value, regionB: region(0, 2) } as RegionComparisonOptions));
    }
    for (const recordA of ['', 'missing', 42, 'ACGT\nother']) {
      await assert.rejects(createRegionComparisonExperiment(source, source, { ...options(region(0, 2)), recordA } as RegionComparisonOptions));
    }
    await assert.rejects(createRegionComparisonExperiment(source, source, { ...options(region(0, 2)), maxStates: 0 } as RegionComparisonOptions), /Unsupported/);
    await assert.rejects(createRegionComparisonExperiment({ ...source, altered: true } as GenomeInput, source, options(region(0, 2))), /complete named original/);
    await assert.rejects(createRegionComparisonExperiment(fasta('AC-U'), source, options(region(0, 2))), /IUPAC DNA/);
    await assert.rejects(createRegionComparisonExperiment({ name: 'huge', text: ' '.repeat(REGION_COMPARISON_LIMITS.inputBytes + 1) }, source, options(region(0, 2))), /10 MiB/);
  });

  it('refuses excessive annotation context instead of silently dropping rows or exact segments', async () => {
    const many = genbank('ACG', Array.from({ length: REGION_COMPARISON_LIMITS.annotationRows + 1 }, () => ({ location: '1..3' })));
    await assert.rejects(createRegionComparisonExperiment(many, fasta('ACG'), options(region(0, 3))), /12,000 rows or 50,000 segments/);
    const joined = 'join(' + Array.from({ length: 1000 }, () => '1..1').join(',') + ')';
    const segments = genbank('A', Array.from({ length: 51 }, () => ({ location: joined })));
    await assert.rejects(createRegionComparisonExperiment(segments, fasta('A'), options(region(0, 1))), /12,000 rows or 50,000 segments/);
  });

  it('refuses exhausted exact alignment work instead of publishing approximate or partial output', async () => {
    await assert.rejects(createRegionComparisonExperiment(fasta('A'.repeat(2100)), fasta('C'.repeat(2100)), options(region(0, 2100))),
      /Exact region alignment unavailable.*budget/);
  });

  it('recomputes original sources and rejects self-consistently rehashed result, interval and coordinate forgeries', async () => {
    const experiment = await createRegionComparisonExperiment(forwardA, forwardB, forwardOptions());
    const resultOf = (record: AnalysisRecord) => record.fields.comparison.value as unknown as RegionComparisonResult;
    for (const mutate of [
      (record: AnalysisRecord) => { resultOf(record).stats.distance = 0; },
      (record: AnalysisRecord) => { resultOf(record).alignedA = 'ACGCTAA'; },
      (record: AnalysisRecord) => { resultOf(record).runs[1].sourceStartA = 5; },
      (record: AnalysisRecord) => { resultOf(record).sourceA.sequenceSha256 = '0'.repeat(64); },
      (record: AnalysisRecord) => { resultOf(record).annotationWarnings = ['Invented annotation coverage']; },
      (record: AnalysisRecord) => { record.inputs[0].accession = 'RELABELLED'; },
      (record: AnalysisRecord) => { Object.assign(record.inputs[0], { extra: true }); },
      (record: AnalysisRecord) => { record.inputs.reverse(); },
      (record: AnalysisRecord) => { (record.inputs[0].data as unknown as GenomeInput).text = forwardA.text.replace('TTT', 'CTT'); },
      (record: AnalysisRecord) => { (record.parameters.regionA as unknown as RegionInterval).strand = '-'; },
      (record: AnalysisRecord) => { record.parameters.recordA = '0'.repeat(64); },
      (record: AnalysisRecord) => { record.parameters.unknown = true; },
      (record: AnalysisRecord) => { record.method.implementation = 'different'; },
      (record: AnalysisRecord) => { record.references[0].version = 'different'; },
      (record: AnalysisRecord) => { record.seed = 1; },
    ]) {
      const saved = structuredClone(experiment.record); mutate(saved);
      const content = await rehashed(saved);
      await parseAnalysisRecord(content); // Generic checksum validation intentionally does not establish recomputation.
      await assert.rejects(replayRegionComparisonExperiment(content));
    }
    const unsupported = { ...experiment.record, unboundMetadata: 'different instructions' };
    const extra = JSON.stringify(unsupported);
    await parseAnalysisRecord(extra); // The shared envelope allows extensions; this fixed scientific contract does not.
    await assert.rejects(replayRegionComparisonExperiment(extra), /supported contract/);
    const annotated = genbank('ATGAAATAA', [{ location: '1..9' }]);
    const context = await createRegionComparisonExperiment(annotated, annotated, options(region(0, 9)));
    const forged = structuredClone(context.record);
    resultOf(forged).annotationsA[0].segments[0].sourceEnd = 8;
    await assert.rejects(replayRegionComparisonExperiment(await rehashed(forged)), /Recomputed/);
  });

  it('exports every alignment run and annotation row with safe metadata, and bounds output expansion', async () => {
    const a = 'AAAAAC'.repeat(80), b = 'AAAATC'.repeat(80);
    const experiment = await createRegionComparisonExperiment(fasta(a, '=SUM(1)\tprivate'), fasta(b), options(region(0, a.length)));
    assert.ok(experiment.result.runs.length > 100);
    const table = exportRegionComparisonTsv(experiment);
    assert.equal(table.trim().split('\n').filter(line => !line.startsWith('#')).length, experiment.result.runs.length + 1);
    assert.ok(table.includes('\\tprivate')); // The literal source tab remains JSON-escaped inside a comment cell.
    const rows = readFasta(exportRegionComparisonFasta(experiment));
    assert.equal(rows.length, 2); assert.equal(rows[0].sequence, experiment.result.alignedA);
    assert.equal(rows[1].sequence, experiment.result.alignedB);
    assert.match(rows[0].header, /name=%3DSUM\(1\)%09private/);
    experiment.result.sourceA.name = 'α'.repeat(REGION_COMPARISON_LIMITS.outputBytes / 2);
    assert.throws(() => exportRegionComparisonFasta(experiment), /10 MiB/);
    assert.throws(() => exportRegionComparisonTsv(experiment), /10 MiB/);
  });

  it('publishes no partial experiment after pre-start or asynchronous cancellation', async () => {
    const already = new AbortController(); already.abort();
    await assert.rejects(createRegionComparisonExperiment(forwardA, forwardB, forwardOptions(), already.signal), { name: 'AbortError' });
    const active = new AbortController();
    const pending = createRegionComparisonExperiment(forwardA, forwardB, forwardOptions(), active.signal);
    active.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const experiment = await createRegionComparisonExperiment(forwardA, forwardB, forwardOptions());
    await assert.rejects(replayRegionComparisonExperiment(serializeAnalysisRecord(experiment.record), already.signal), { name: 'AbortError' });
  });
});

