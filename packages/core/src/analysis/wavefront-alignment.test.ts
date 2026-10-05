import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { alignWavefront, WAVEFRONT_LIMITS, type WavefrontAlignment } from './wavefront-alignment';

// Independent full-matrix Wagner-Fischer oracle, intentionally not furthest-reaching.
function distance(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return matrix[a.length][b.length];
}
function check(a: string, b: string, result: WavefrontAlignment, expected: number): void {
  assert.equal(result.reference.replaceAll('-', ''), a);
  assert.equal(result.query.replaceAll('-', ''), b);
  assert.equal(result.reference.length, result.query.length);
  let edits = 0;
  for (let i = 0; i < result.reference.length; i++) {
    assert(!(result.reference[i] === '-' && result.query[i] === '-'));
    if (result.reference[i] !== result.query[i]) edits++;
  }
  assert.equal(edits, expected); assert.equal(result.distance, expected);
  assert(result.states <= WAVEFRONT_LIMITS.states);
  assert(result.comparisons <= WAVEFRONT_LIMITS.comparisons);
}
function words(alphabet: string, depth: number): string[] {
  let layer = ['']; const result = [...layer];
  for (let i = 0; i < depth; i++) { layer = layer.flatMap(s => [...alphabet].map(c => s + c)); result.push(...layer); }
  return result;
}

describe('exact unit-edit wavefront alignment', () => {
  it('agrees with a full DP oracle on every pair of A/C/N strings through length four (14,641 pairs)', () => {
    const sequences = words('ACN', 4);
    assert.equal(sequences.length ** 2, 14641);
    for (const a of sequences) for (const b of sequences) check(a, b, alignWavefront(a, b), distance(a, b));
  });
  it('agrees on variable-length and ambiguity-rich deterministic controls', () => {
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let i = 0; i < 250; i++) {
      const a = Array.from({ length: random() % 71 }, () => 'ACGTNRY'[(random() >>> 16) % 7]).join('');
      const b = Array.from({ length: random() % 71 }, () => 'ACGTNRY'[(random() >>> 16) % 7]).join('');
      check(a, b, alignWavefront(a, b), distance(a, b));
      assert.equal(alignWavefront(b, a).distance, distance(a, b));
    }
  });
  it('aligns a 250,000-base sequence with a known substitution without quadratic allocation', () => {
    const a = 'ACGT'.repeat(62500), b = a.slice(0, 123456) + 'T' + a.slice(123457);
    const result = alignWavefront(a, b);
    check(a, b, result, 1);
    assert.equal(result.states, 4);
    assert(result.comparisons < 3 * a.length);
  });
  it('recovers insertion and deletion paths with 1,000-base length differences', () => {
    const a = 'ACGT'.repeat(5000), b = a.slice(0, 10000) + 'N'.repeat(1000) + a.slice(10000);
    check(a, b, alignWavefront(a, b), 1000);
    check(b, a, alignWavefront(b, a), 1000);
  });
  it('has deterministic optimal ties in repeats, including changes at both ends', () => {
    for (const [a, b] of [['AAAA', 'AAA'], ['ACACAC', 'CACACA'], ['TACGT', 'ACGTA'], ['A', 'TTTT']]) {
      const result = alignWavefront(a, b);
      check(a, b, result, distance(a, b));
      assert.deepEqual(alignWavefront(a, b), result);
    }
  });
  it('never returns a partial alignment when state/comparison budgets are exhausted', () => {
    assert.throws(() => alignWavefront('AAAA', 'TTTT', { maxStates: 4 }), /state budget/);
    assert.throws(() => alignWavefront('A'.repeat(100), 'A'.repeat(100), { maxComparisons: 99 }), /comparison budget/);
    check('A'.repeat(100), 'A'.repeat(100), alignWavefront('A'.repeat(100), 'A'.repeat(100), { maxComparisons: 100 }), 0);
    assert.throws(() => alignWavefront('A', 'AAAA', { maxStates: 15 }), /state budget/);
    assert.throws(() => alignWavefront('A', 'A', { maxStates: 0 }), /state budget/);
    check('', 'ACGT', alignWavefront('', 'ACGT', { maxStates: 0, maxComparisons: 0 }), 4);
  });
  it('rejects invalid input and attempts to exceed the hard budgets', () => {
    for (const a of ['a', 'A-C', 'AU', '?', '🧬', 'A'.repeat(250001)]) assert.throws(() => alignWavefront(a, 'A'), /uppercase ungapped/);
    for (const maxStates of [-1, 1.5, NaN, Infinity, 4000001]) assert.throws(() => alignWavefront('A', 'A', { maxStates }), /budget/);
    for (const maxComparisons of [-1, NaN, Infinity, 50000001]) assert.throws(() => alignWavefront('A', 'A', { maxComparisons }), /budget/);
    assert.throws(() => alignWavefront('A', 'A', { unexpected: true } as never), /Unsupported/);
  });
});

import { buildAlignmentPangenome, createAlignmentPangenomeRecord, exportAlignmentGfa, exportPangenomeAlignment,
  parsePangenomeInput, replayAlignmentPangenome, type AlignmentPangenome, type PangenomeInput } from './alignment-pangenome';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';

function spellsInputs(input: PangenomeInput, graph: AlignmentPangenome): void {
  const nodes = new Map(graph.nodes.map(n => [n.id, n.sequence]));
  for (const path of graph.paths) {
    assert.equal(path.nodes.map(id => nodes.get(id)).join(''), input.sequences.find(s => s.id === path.sequenceId)!.sequence.replaceAll('-', ''));
  }
  // Independently parse the exported GFA, including its path segment orientation.
  const segments = new Map<string, string>(); const paths = new Map<string, string[]>();
  for (const line of exportAlignmentGfa(graph).split('\n')) {
    const fields = line.split('\t');
    if (fields[0] === 'S') segments.set(fields[1], fields[2]);
    if (fields[0] === 'P') paths.set(fields[1], fields[2].split(','));
  }
  for (const path of graph.paths) {
    const pieces = paths.get(path.id)!.map(segment => { assert(segment.endsWith('+')); return segments.get(segment.slice(0, -1)); });
    assert.equal(pieces.join(''), input.sequences.find(s => s.id === path.sequenceId)!.sequence.replaceAll('-', ''));
  }
  const exported = parsePangenomeInput(exportPangenomeAlignment(graph));
  assert.deepEqual(exported.sequences.map(s => s.sequence), graph.alignment.map(s => s.sequence));
}
function applyVariants(reference: string, graph: AlignmentPangenome, sequenceId: string): string {
  const path = graph.paths.find(p => p.sequenceId === sequenceId)!;
  let result = '', at = 0;
  for (const variant of graph.variants.filter(v => v.pathIds.includes(path.id))) {
    assert(variant.referenceStart >= at);
    assert.equal(reference.slice(variant.referenceStart, variant.referenceEnd), variant.reference);
    result += reference.slice(at, variant.referenceStart) + variant.alternate; at = variant.referenceEnd;
  }
  return result + reference.slice(at);
}

describe('genome-scale wavefront pangenome pipeline', () => {
  it('builds a real 20 kb graph and exact SNV where the bounded DP path refuses input', () => {
    const reference = 'ACGT'.repeat(5000), query = reference.slice(0, 10000) + 'T' + reference.slice(10001);
    const input = parsePangenomeInput(`>ref\n${reference}\n>query\n${query}`);
    assert.throws(() => buildAlignmentPangenome(input, { alignment: 'global', referenceId: 'ref' }), /DP-cell budget/);
    const graph = buildAlignmentPangenome(input, { alignment: 'wavefront', referenceId: 'ref', terminalGaps: 'alleles' });
    spellsInputs(input, graph);
    assert.deepEqual(graph.variants.map(v => [v.type, v.referenceStart, v.referenceEnd, v.reference, v.alternate]), [['snv', 10000, 10001, 'A', 'T']]);
    assert.equal(applyVariants(reference, graph, 'query'), query);
    assert.equal(graph.diagnostics.alignmentCells, 0);
    assert.equal(graph.diagnostics.wavefront!.states, 4);
  });
  it('reconstructs every input from paths AND reference-relative alleles across SNVs and indels', () => {
    const reference = 'ACGTCAGT';
    const input = parsePangenomeInput('>ref\nACGTCAGT\n>ins\nACGTGCAGT\n>del\nACGCAGT\n>snv\nATGTCAGT\n>same\nACGTCAGT');
    const graph = buildAlignmentPangenome(input, { alignment: 'wavefront', referenceId: 'ref', terminalGaps: 'alleles' });
    spellsInputs(input, graph);
    for (const row of input.sequences) assert.equal(applyVariants(reference, graph, row.id), row.sequence);
    assert.deepEqual(graph.variants.map(v => [v.type, v.referenceStart, v.referenceEnd, v.reference, v.alternate]), [
      ['snv', 1, 2, 'C', 'T'], ['deletion', 3, 4, 'T', ''], ['insertion', 4, 4, '', 'G'],
    ]);
    const samePath = graph.paths.find(p => p.sequenceId === 'same')!.id;
    assert(graph.variants.every(v => !v.pathIds.includes(samePath)));
    assert.deepEqual(buildAlignmentPangenome({ ...input, sequences: [...input.sequences].reverse() }, graph.options), graph);
  });
  it('preserves ambiguity and respects missing versus complete terminal coverage', () => {
    const input = parsePangenomeInput('>ref\nACGTNACGT\n>query\nACGTRACGTAA');
    const alleles = buildAlignmentPangenome(input, { alignment: 'wavefront', referenceId: 'ref', terminalGaps: 'alleles' });
    const missing = buildAlignmentPangenome(input, { alignment: 'wavefront', referenceId: 'ref', terminalGaps: 'missing' });
    spellsInputs(input, alleles); spellsInputs(input, missing);
    assert.equal(alleles.diagnostics.comparisons[0].ambiguousColumns, 1);
    assert.deepEqual(alleles.variants.map(v => [v.referenceStart, v.referenceEnd, v.reference, v.alternate]), [[9, 9, '', 'AA']]);
    assert.equal(missing.variants.length, 0);
    assert.equal(missing.diagnostics.comparisons[0].missingTerminalColumns, 2);
  });
  it('exports and freshly replays genome-sized results, while preserving the existing version-2 modes', async () => {
    const sequence = 'ACGT'.repeat(6000);
    const input = parsePangenomeInput(`>ref\n${sequence}\n>query\n${sequence.slice(0, 12000)}T${sequence.slice(12001)}`);
    const graph = buildAlignmentPangenome(input, { referenceId: 'ref', alignment: 'wavefront' });
    const record = await createAlignmentPangenomeRecord(input, graph);
    assert.equal(record.method.version, '3');
    assert.equal(record.fields.graph.kind, 'sequence-score');
    const replay = await replayAlignmentPangenome(serializeAnalysisRecord(record));
    assert.deepEqual(replay.graph, graph); assert.deepEqual(replay.record, record);
    for (const alignment of ['provided', 'global'] as const) {
      const small = parsePangenomeInput('>ref\nACGT\n>query\nACCT');
      const legacy = await createAlignmentPangenomeRecord(small, buildAlignmentPangenome(small, { referenceId: 'ref', alignment }));
      assert.equal(legacy.method.version, '2');
      assert.equal((await replayAlignmentPangenome(serializeAnalysisRecord(legacy))).record.resultId, legacy.resultId);
    }
  });
  it('refuses self-consistently rehashed forged scores or changed algorithm versions on replay', async () => {
    const input = parsePangenomeInput('>ref\nACGT\n>query\nACCT');
    const graph = buildAlignmentPangenome(input, { referenceId: 'ref', alignment: 'wavefront' });
    const record = await createAlignmentPangenomeRecord(input, graph);
    const fields = structuredClone(record.fields); fields.variants.value = [];
    const forged = await createAnalysisRecord({ ...record, fields });
    await parseAnalysisRecord(serializeAnalysisRecord(forged)); // Checksums alone are insufficient.
    await assert.rejects(replayAlignmentPangenome(serializeAnalysisRecord(forged)), /Recomputed/);
    const wrongVersion = await createAnalysisRecord({ ...record, method: { ...record.method, version: '2' } });
    await assert.rejects(replayAlignmentPangenome(serializeAnalysisRecord(wrongVersion)), /contract differs/);
  });
  it('enforces the aggregate work budget rather than resetting the full allowance for every pair', () => {
    const input = parsePangenomeInput('>ref\n' + 'A'.repeat(1300) + Array.from({ length: 8 }, (_, i) => `\n>q${i}\n${'C'.repeat(1300)}`).join(''));
    assert.throws(() => buildAlignmentPangenome(input, { alignment: 'wavefront', referenceId: 'ref' }), /state budget/);
    assert.throws(() => buildAlignmentPangenome(parsePangenomeInput('>a\nAC-G\n>b\nACTG'), { alignment: 'wavefront' }), /ungapped/);
  });
});
