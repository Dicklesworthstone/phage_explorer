import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { buildAlignmentPangenome, createAlignmentPangenomeRecord, parsePangenomeInput, replayAlignmentPangenome,
  type AlignmentGraphOptions } from './alignment-pangenome';
import { exportPangenomeVcf, exportPangenomeReferenceFasta } from './pangenome-vcf';
import { serializeAnalysisRecord } from '../analysis-result';

function graph(rows: Record<string, string>, options: Partial<AlignmentGraphOptions> = {}) {
  return buildAlignmentPangenome(parsePangenomeInput(Object.entries(rows).map(([id, sequence]) => `>${id}\n${sequence}`).join('\n')),
    { referenceId: 'ref', alignment: 'provided', terminalGaps: 'alleles', ...options });
}
interface Row { pos: number; ref: string; alt: string[]; gt: Array<number | null> }
// This deliberately small independent decoder validates emitted VCF syntax and
// allele accounting; it is not an HTSlib/bcftools conformance test.
function read(text: string): { samples: string[]; rows: Row[] } {
  assert(text.startsWith('##fileformat=VCFv4.3\n')); assert(text.endsWith('\n'));
  const lines = text.trimEnd().split('\n');
  const header = lines.find(line => line.startsWith('#CHROM\t'))!.split('\t');
  assert.deepEqual(header.slice(0, 9), ['#CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO', 'FORMAT']);
  const samples = header.slice(9); assert.equal(new Set(samples).size, samples.length);
  let previousEnd = 0;
  const rows = lines.filter(line => !line.startsWith('#')).map(line => {
    const fields = line.split('\t'); assert.equal(fields.length, 9 + samples.length);
    const [chrom, position, id, ref, alternatives, quality, filter, info, format, ...calls] = fields;
    assert.equal(chrom, 'reference'); assert.equal(id, '.'); assert.equal(quality, '.'); assert.equal(filter, '.'); assert.equal(format, 'GT');
    assert(/^[1-9][0-9]*$/.test(position)); const pos = Number(position);
    assert(pos - 1 >= previousEnd); previousEnd = pos - 1 + ref.length;
    const alt = alternatives.split(','); assert(/^[ACGT]+$/.test(ref));
    assert(alt.every(a => /^[ACGT]+$/.test(a) && a !== ref)); assert.equal(new Set(alt).size, alt.length);
    assert(calls.every(g => /^(\.|0|[1-9][0-9]*)$/.test(g)));
    const gt = calls.map(g => g === '.' ? null : Number(g));
    assert(gt.every(g => g === null || g <= alt.length));
    const values = Object.fromEntries(info.split(';').map(item => item.split('=')));
    assert.deepEqual(values.AC.split(',').map(Number), alt.map((_, a) => gt.filter(g => g === a + 1).length));
    assert.equal(Number(values.AN), gt.filter(g => g !== null).length);
    return { pos, ref, alt, gt };
  });
  return { samples, rows };
}
function spell(reference: string, records: Row[], query: number): string {
  let offset = 0, sequence = '';
  for (const row of records) {
    const start = row.pos - 1;
    assert.equal(reference.slice(start, start + row.ref.length), row.ref);
    assert.notEqual(row.gt[query], null);
    sequence += reference.slice(offset, start) + (row.gt[query] === 0 ? row.ref : row.alt[row.gt[query]! - 1]);
    offset = start + row.ref.length;
  }
  return sequence + reference.slice(offset);
}

describe('alignment-derived haploid VCF', () => {
  it('emits multiallelic haploid calls, missingness and independent AC/AN counts', () => {
    const value = graph({ ref: 'ACGT', a: 'ATGT', b: 'AGGT', c: 'ACGT', d: 'ANGT' });
    const result = read(exportPangenomeVcf(value, 'a'.repeat(64)));
    assert.deepEqual(result.samples, ['query1', 'query2', 'query3', 'query4']);
    assert.deepEqual(result.rows, [{ pos: 2, ref: 'C', alt: ['G', 'T'], gt: [2, 1, 0, null] }]);
    assert(exportPangenomeVcf(value, 'a'.repeat(64)).includes('##phage_explorer_result=' + 'a'.repeat(64)));
  });
  it('pads insertions and deletions correctly at either end and does not split an internal indel', () => {
    const examples = [
      ['--ACGT', 'TTACGT', 1, 'A', 'TTA'], ['ACGT--', 'ACGTTT', 4, 'T', 'TTT'],
      ['ACGT', '--GT', 1, 'ACG', 'G'], ['ACGT', 'AC--', 2, 'CGT', 'C'],
      ['AC--GT', 'ACTTGT', 2, 'C', 'CTT'], ['ACCCGT', 'A---GT', 1, 'ACCC', 'A'],
    ] as const;
    for (const [ref, query, pos, expectedRef, alternate] of examples) {
      const value = graph({ ref, query });
      const rows = read(exportPangenomeVcf(value)).rows;
      assert.deepEqual(rows, [{ pos, ref: expectedRef, alt: [alternate], gt: [1] }]);
      assert.equal(spell(ref.replaceAll('-', ''), rows, 0), query.replaceAll('-', ''));
    }
  });
  it('combines overlapping padded deletions, insertions and SNVs into one faithful locus', () => {
    const value = graph({ ref: 'AC--GTT', a: 'ATGGGTT', b: 'A----TT', c: 'AC--GTT' });
    const rows = read(exportPangenomeVcf(value)).rows;
    assert.deepEqual(rows, [{ pos: 1, ref: 'ACG', alt: ['A', 'ATGGG'], gt: [2, 1, 0] }]);
    for (let q = 0; q < 3; q++) assert.equal(spell('ACGTT', rows, q), ['ATGGGTT', 'ATT', 'ACGTT'][q]);
  });
  it('keeps adjacent SNVs separate when missingness differs between samples', () => {
    const rows = read(exportPangenomeVcf(graph({ ref: 'AC', a: 'TN', b: 'NG' }))).rows;
    assert.deepEqual(rows, [
      { pos: 1, ref: 'A', alt: ['T'], gt: [1, null] },
      { pos: 2, ref: 'C', alt: ['G'], gt: [null, 1] },
    ]);
  });
  it('does not call terminal missing sequence as deletion and requires coverage over padding', () => {
    const value = graph({ ref: 'AACGTT', a: 'AATGTT', b: '---GTT', c: 'NACGTT' }, { terminalGaps: 'missing' });
    assert.deepEqual(read(exportPangenomeVcf(value)).rows, [{ pos: 3, ref: 'C', alt: ['T'], gt: [1, null, 0] }]);
    assert.equal(read(exportPangenomeVcf(graph({ ref: 'AACGTT', query: '--CG--' }, { terminalGaps: 'missing' }))).rows.length, 0);
    const padded = graph({ ref: 'AC--GT', a: 'ACTTGT', b: 'AN--GT' });
    assert.deepEqual(read(exportPangenomeVcf(padded)).rows, [{ pos: 2, ref: 'C', alt: ['CTT'], gt: [1, null] }]);
  });
  it('does not invent reference alleles at IUPAC sites and refuses unresolved padding', () => {
    assert.equal(read(exportPangenomeVcf(graph({ ref: 'ANGT', a: 'ACGT' }))).rows.length, 0);
    assert.throws(() => exportPangenomeVcf(graph({ ref: 'AN-GT', a: 'ANAGT' })), /unresolved reference/);
    assert.throws(() => exportPangenomeVcf(graph({ ref: 'ACGT', a: 'AN-T', b: 'ACNT' })), /no fully observed/);
  });
  it('preserves all-gap columns, separates sample IDs from unsafe original names and retains reference FASTA', () => {
    const value = graph({ ref: 'A-C--GT', 'quote";é': 'A-T--GT', 'query1': 'A-C--GT' });
    const text = exportPangenomeVcf(value), result = read(text);
    assert.equal(result.rows[0].pos, 2);
    assert(text.includes('quote%22%3B%C3%A9'));
    assert.equal(exportPangenomeReferenceFasta(value), '>reference original_id_uri=ref\nACGT\n');
    assert.equal(value.alignment.find(s => s.id === 'ref')!.sequence, 'A-C--GT');
  });
  it('reconstructs every fully resolved query for exhaustive small gapped pairs and random multisample alignments', () => {
    const words: string[] = [];
    for (let code = 0; code < 81; code++) {
      let n = code, word = '';
      for (let i = 0; i < 4; i++) { word += 'AC-'[n % 3]; n = Math.floor(n / 3); }
      if (/[AC]/.test(word)) words.push(word);
    }
    let checked = 0;
    for (const reference of words) for (const query of words) {
      const value = graph({ ref: reference, a: query });
      const rows = read(exportPangenomeVcf(value)).rows;
      assert.equal(spell(reference.replaceAll('-', ''), rows, 0), query.replaceAll('-', ''), reference + ':' + query);
      checked++;
    }
    assert.equal(checked, 6400);
    let seed = 789123;
    const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return seed >>> 0; };
    for (let test = 0; test < 300; test++) {
      const dna = () => 'A' + Array.from({ length: 25 }, () => 'ACGT--'[random() % 6]).join('') + 'T';
      const rows = { ref: dna(), a: dna(), b: dna(), c: dna() }, value = graph(rows);
      const called = read(exportPangenomeVcf(value)).rows;
      [rows.a, rows.b, rows.c].forEach((query, q) => assert.equal(spell(rows.ref.replaceAll('-', ''), called, q), query.replaceAll('-', '')));
    }
  });
  it('uses normalized query paths but the original submitted reference coordinates and survives experiment replay', async () => {
    let seed = 3123;
    const reference = Array.from({ length: 500 }, () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return 'ACGT'[(seed >>> 16) % 4]; }).join('');
    const alt = reference[150] === 'A' ? 'C' : 'A', changed = reference.slice(0, 150) + alt + reference.slice(151);
    const reverse = changed.split('').reverse().map(b => ({ A: 'T', C: 'G', G: 'C', T: 'A' })[b]).join('');
    const input = parsePangenomeInput(`>ref\n${reference}\n>a\n${reverse.slice(127) + reverse.slice(0, 127)}`);
    const value = buildAlignmentPangenome(input, { referenceId: 'ref', alignment: 'affine', normalization: 'circular', terminalGaps: 'alleles' });
    const record = await createAlignmentPangenomeRecord(input, value);
    const text = exportPangenomeVcf(value, record.resultId), rows = read(text).rows;
    assert.deepEqual(rows, [{ pos: 151, ref: reference[150], alt: [alt], gt: [1] }]);
    assert.equal(spell(reference, rows, 0), changed);
    const replay = await replayAlignmentPangenome(serializeAnalysisRecord(record));
    assert.equal(exportPangenomeVcf(replay.graph, replay.record.resultId), text);
    assert.equal(exportPangenomeReferenceFasta(replay.graph).split('\n').slice(1).join(''), reference);
  });
  it('exports a long affine indel without splitting it into per-base deletions', () => {
    let seed = 10231;
    const reference = Array.from({ length: 80000 }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return 'ACGT'[(seed >>> 0) % 4]; }).join('');
    const query = reference.slice(0, 40000) + 'C'.repeat(12000) + reference.slice(40000);
    const value = graph({ ref: reference, a: query }, { alignment: 'affine' });
    const rows = read(exportPangenomeVcf(value)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].alt[0].length - rows[0].ref.length, 12000);
    assert.equal(spell(reference, rows, 0), query);
  });
  it('does not mutate inputs or change export ordering when alignment rows are reordered', () => {
    const value = graph({ ref: 'AC--GT', z: 'ACTTGT', a: 'ACGGGT' });
    const before = JSON.stringify(value), output = exportPangenomeVcf(value);
    assert.equal(JSON.stringify(value), before);
    value.alignment.reverse();
    assert.equal(exportPangenomeVcf(value), output);
    assert.equal(read(exportPangenomeVcf(graph({ ref: '-AAA', a: 'A---' }))).rows[0].ref, 'AAA');
    assert.equal(read(exportPangenomeVcf(graph({ ref: 'A-A', a: '-AA' }))).rows.length, 0, 'gap placements spelling the reference are not a variant');
  });
  it('fails the explicit output-size limit rather than returning a truncated VCF', () => {
    const value = graph({ ref: 'A'.repeat(250000), a: 'C'.repeat(250000), b: 'G'.repeat(250000), c: 'T'.repeat(250000) });
    assert.throws(() => exportPangenomeVcf(value), /exceeds 10 MiB/);
  });
  it('rejects malformed aligned input and metadata instead of emitting a misleading file', () => {
    const value = graph({ ref: 'ACGT', a: 'ATGT' });
    assert.throws(() => exportPangenomeVcf(value, 'not-an-identity'), /SHA-256/);
    value.referenceLength = 99;
    assert.throws(() => exportPangenomeVcf(value), /metadata/);
    value.referenceLength = 4; value.alignment[0].sequence = 'ACG';
    assert.throws(() => exportPangenomeVcf(value), /equal-column/);
  });
});
