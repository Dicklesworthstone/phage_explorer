import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { buildAlignmentPangenome, createAlignmentPangenomeRecord, createAnnotatedAlignmentPangenome,
  exportAlignmentGfa, exportPangenomeOriginalFasta, parsePangenomeInput, replayAlignmentPangenome,
  resolveAlignmentGraphOptions, type AlignmentGraphOptions } from './alignment-pangenome';
import { alignNormalizedAffineWavefront, restoreSequence, transformSequence } from './sequence-normalization';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { reverseComplement } from '../codons';

function dna(length: number): string {
  let state = 9273;
  return Array.from({ length }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return 'ACGT'[(state >>> 16) & 3]; }).join('');
}
const input = (r: string, q: string) => parsePangenomeInput(`>r\n${r}\n>q\n${q}`, 'Affine oracle input');
function fasta(content: string): Map<string, string> {
  const records = new Map<string, string>(); let name = '';
  for (const line of content.trim().split('\n')) {
    if (line.startsWith('>')) { name = line.slice(1).split(' ')[0]; records.set(name, ''); }
    else records.set(name, records.get(name)! + line);
  }
  return records;
}
function linearCost(a: string, b: string, x = 4, o = 6, e = 1): number {
  let total = 0, previous = '';
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-' && b[i] === '-') continue;
    const gap = a[i] === '-' ? 'I' : b[i] === '-' ? 'D' : '';
    total += gap ? e + (gap === previous ? 0 : o) : a[i] === b[i] ? 0 : x; previous = gap;
  }
  return total;
}
describe('affine pangenome producer', () => {
  it('records explicit penalties and model costs without relabeling them unit edit distances', async () => {
    const data = input('ACGT', 'AGGT');
    const graph = buildAlignmentPangenome(data, { referenceId: 'r', alignment: 'affine' });
    assert.deepEqual(graph.options.affinePenalties, { mismatch: 4, gapOpen: 6, gapExtend: 1 });
    assert.equal(graph.diagnostics.wavefront, undefined);
    assert.equal(graph.diagnostics.affine!.pairs[0].score, 4);
    assert.equal(graph.variants.length, 1);
    assert.deepEqual([graph.variants[0].referenceStart, graph.variants[0].reference, graph.variants[0].alternate], [1, 'C', 'G']);
    const record = await createAlignmentPangenomeRecord(data, graph);
    assert.equal(record.method.version, '6');
    const replay = await replayAlignmentPangenome(serializeAnalysisRecord(record));
    assert.deepEqual(replay.graph, graph); assert.equal(replay.record.resultId, record.resultId);
    const another = buildAlignmentPangenome(data, { referenceId: 'r', alignment: 'affine', affinePenalties: { mismatch: 2, gapOpen: 6, gapExtend: 1 } });
    const changed = await createAlignmentPangenomeRecord(data, another);
    assert.equal(another.diagnostics.affine!.pairs[0].score, 2); assert.notEqual(changed.cacheKey, record.cacheKey);
  });
  it('builds and reconstructs an 80kb synthetic input with a 12kb internal insertion beyond the unit-edit state budget', async () => {
    const r = dna(80000), position = 30000, insertion = 'T'.repeat(12000);
    // A single-gap lower bound is attainable. Use a non-T boundary for an exact coordinate oracle.
    const at = r.indexOf('ACG', position), q = r.slice(0, at) + insertion + r.slice(at);
    const data = input(r, q);
    assert.throws(() => buildAlignmentPangenome(data, { referenceId: 'r', alignment: 'wavefront', terminalGaps: 'alleles' }), /state budget/);
    const graph = buildAlignmentPangenome(data, { referenceId: 'r', alignment: 'affine', terminalGaps: 'alleles' });
    assert.equal(graph.diagnostics.affine!.pairs[0].score, 12006);
    assert.equal(graph.variants.length, 1);
    assert.deepEqual([graph.variants[0].type, graph.variants[0].referenceStart, graph.variants[0].alternate], ['insertion', at, insertion]);
    const gfa = exportAlignmentGfa(graph), nodes = new Map<string, string>(), paths = new Map<string, string>();
    for (const line of gfa.split('\n')) {
      const cells = line.split('\t');
      if (cells[0] === 'S') nodes.set(cells[1], cells[2]);
      if (cells[0] === 'P') paths.set(cells[1], cells[2].split(',').map(id => nodes.get(id.slice(0, -1))).join(''));
    }
    for (const path of graph.paths) assert.equal(paths.get(path.id), path.sequenceId === 'r' ? r : q);
    assert.deepEqual(fasta(exportPangenomeOriginalFasta(graph)), new Map([['q', q], ['r', r]]));
    const record = await createAlignmentPangenomeRecord(data, graph);
    assert.equal((await replayAlignmentPangenome(serializeAnalysisRecord(record))).record.resultId, record.resultId);
  });
  it('preserves reverse/circular input reconstruction and distinguishes anchored from rotated linear costs', () => {
    const r = dna(900);
    // Deleting across the submitted origin splits a single anchored gap into two terminal runs.
    const linear = r.slice(5, -7), rotated = linear.slice(311) + linear.slice(0, 311), q = reverseComplement(rotated);
    const pair = alignNormalizedAffineWavefront(r, q, 'circular');
    assert.equal(pair.score, 18);
    assert.equal(pair.representationScore, 24);
    assert.equal(pair.representationScore, linearCost(pair.reference, pair.query));
    assert.equal(pair.reference.replaceAll('-', ''), r);
    assert.equal(restoreSequence(pair.query.replaceAll('-', ''), pair.transform), q);
    const graph = buildAlignmentPangenome(input(r, q), { referenceId: 'r', alignment: 'affine', normalization: 'circular', terminalGaps: 'alleles' });
    assert.equal(graph.diagnostics.affine!.pairs[0].representationScore, 24);
    assert.equal(fasta(exportPangenomeOriginalFasta(graph)).get('q'), q);
  });
  it('replays normalized affine graphs and GenBank whole-haplotype coding evidence together', async () => {
    const r = dna(300) + 'ATGAAACCCGGGTAA' + dna(300);
    const changed = r.slice(0, 303) + 'AAGCCCCTAGGGTAA' + r.slice(315);
    const q = reverseComplement(changed.slice(143) + changed.slice(0, 143));
    const annotation = { name: 'r.gb', text: `LOCUS       R ${r.length} bp DNA circular\nFEATURES             Location/Qualifiers\n     CDS             301..315\n                     /gene="known"\nORIGIN\n        1 ${r.toLowerCase()}\n//\n` };
    const result = await createAnnotatedAlignmentPangenome(input(r, q), {
      referenceId: 'r', alignment: 'affine', normalization: 'circular', terminalGaps: 'alleles',
    }, annotation);
    assert.equal(result.cds.genes[0].protein, 'MKPG*');
    assert.equal(result.cds.consequences[0].queryProtein, 'MKPLG*');
    assert.equal(result.cds.consequences[0].insertedBases, 3);
    assert(result.cds.consequences[0].effects.includes('inframe-indel'));
    const replay = await replayAlignmentPangenome(serializeAnalysisRecord(result.record));
    assert.equal(replay.record.resultId, result.record.resultId); assert.deepEqual(replay.cds, result.cds);
    assert(result.record.references.some(ref => ref.id === 'sequence-graph-method' && ref.version === '6'));
  });
  it('rejects penalties on other modes, partial penalty objects and circular missing-coverage ambiguity', () => {
    const data = input('ATGCC', 'ATACC');
    for (const settings of [
      { alignment: 'global', affinePenalties: { mismatch: 4, gapOpen: 6, gapExtend: 1 } },
      { alignment: 'affine', affinePenalties: { mismatch: 4 } },
      { alignment: 'affine', normalization: 'circular', terminalGaps: 'missing' },
      { alignment: 'provided', normalization: 'strand' },
      { alignment: 'affine', affinePenalties: null },
    ]) assert.throws(() => resolveAlignmentGraphOptions(data, settings as Partial<AlignmentGraphOptions>));
    const penalties = { mismatch: 4, gapOpen: 6, gapExtend: 1 };
    const resolved = resolveAlignmentGraphOptions(data, { alignment: 'affine', affinePenalties: penalties });
    penalties.mismatch = 1; assert.equal(resolved.affinePenalties!.mismatch, 4);
  });
  it('refuses rehashed false scores and preserves ambiguity/missingness policies', async () => {
    const data = input('ACGTNACGT', 'ACGTAACGT');
    const graph = buildAlignmentPangenome(data, { referenceId: 'r', alignment: 'affine' });
    assert.equal(graph.variants.length, 0); assert.equal(graph.diagnostics.comparisons[0].ambiguousColumns, 1);
    const record = await createAlignmentPangenomeRecord(data, graph);
    const forged = structuredClone(record);
    (forged.fields.diagnostics.value as unknown as { affine: { pairs: Array<{ score: number }> } }).affine.pairs[0].score = 0;
    const rehashed = await createAnalysisRecord(forged);
    await assert.rejects(replayAlignmentPangenome(serializeAnalysisRecord(rehashed)), /differ/);
    const terminals = input('CCATGTT', 'ATG');
    const missing = buildAlignmentPangenome(terminals, { referenceId: 'r', alignment: 'affine' });
    const alleles = buildAlignmentPangenome(terminals, { referenceId: 'r', alignment: 'affine', terminalGaps: 'alleles' });
    assert.equal(missing.variants.length, 0); assert.equal(alleles.variants.length, 2);
    assert.equal(transformSequence('ATG', { strand: '-', offset: 0 }), 'CAT');
  });
});
