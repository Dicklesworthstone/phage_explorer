import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { scanExactRepeatPairs, createExactRepeatRecord, replayExactRepeatRecord, exportExactRepeatPairsTsv,
  exactRepeatArmSegments, resolveExactRepeatOptions, type ExactRepeatPair, type ExactRepeatOptions } from './exact-repeat-pairs';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';

const complements: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
const rc = (s: string) => s.split('').reverse().map(c => complements[c]).join('');
// Independent literal substring enumeration, without an index or rolling state.
function oracle(sequence: string, length: number, gap: number): ExactRepeatPair[] {
  const seq = sequence.toUpperCase(), pairs: ExactRepeatPair[] = [];
  for (let right = length; right + length <= seq.length; right++) for (const type of ['direct', 'inverted'] as const) {
    for (let left = 0; left + length <= right; left++) {
      if (right - left - length > gap) continue;
      const a = seq.slice(left, left + length), b = seq.slice(right, right + length);
      if (/[^ACGT]/.test(a + b) || a !== (type === 'direct' ? b : rc(b))) continue;
      pairs.push({ type, leftStart: left, leftEnd: left + length, rightStart: right, rightEnd: right + length, gap: right - left - length });
    }
  }
  return pairs;
}
const randomDna = (length: number, initial: number, alphabet = 'ACGT') => {
  let seed = initial;
  return Array.from({ length }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return alphabet[(seed >>> 0) % alphabet.length]; }).join('');
};

describe('unsampled exact repeat pairs', () => {
  it('matches an independent enumerator for every 12-base binary sequence and three gap limits', () => {
    for (let code = 0; code < 4096; code++) {
      const sequence = Array.from({ length: 12 }, (_, i) => code & (1 << i) ? 'T' : 'A').join('');
      for (const maxGap of [0, 1, 4]) {
        const scan = scanExactRepeatPairs(sequence, { armLength: 4, maxGap, maxPairs: 20000 });
        assert.deepEqual(scan.pairs, oracle(sequence, 4, maxGap)); assert.equal(scan.search.complete, true);
      }
    }
  });
  it('matches random literal-window oracles, ambiguous spacers, lowercase and expiring/reused index slots', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const sequence = randomDna(50, seed, seed % 2 ? 'ACGTN' : 'ACGT').toLowerCase();
      const armLength = 4 + seed % 6, maxGap = seed % 20;
      assert.deepEqual(scanExactRepeatPairs(sequence, { armLength, maxGap }).pairs, oracle(sequence, armLength, maxGap));
    }
    const seq = 'aCgTNRYTacgt';
    assert.deepEqual(scanExactRepeatPairs(seq, { armLength: 4, maxGap: 4 }).pairs, oracle(seq, 4, 4));
    assert.equal(scanExactRepeatPairs(seq, { armLength: 4, maxGap: 3 }).pairs.length, 0);
  });
  it('counts both orientations for self-complementary arms and accepts the last base and zero gap', () => {
    assert.deepEqual(scanExactRepeatPairs('ACGTACGT', { armLength: 4, maxGap: 0 }).pairs.map(p => [p.type, p.leftStart, p.rightEnd]),
      [['direct', 0, 8], ['inverted', 0, 8]]);
    assert.equal(scanExactRepeatPairs('NNNNNNNNNNNN', { armLength: 4 }).search.resolvedBases, 0);
    assert.deepEqual(scanExactRepeatPairs('', {}).pairs, []);
    assert.equal(scanExactRepeatPairs('ACGT', {}).search.complete, true);
  });
  it('verifies the whole arm beyond its 15-base prefix and distinguishes suffix/reverse keys', () => {
    const arm = 'AAAACCCCGGGGTTTACGTACGTT';
    const seq = arm + 'NN' + arm.slice(0, 15) + 'C'.repeat(arm.length - 15) + 'N' + rc(arm) + 'N' + arm;
    assert.deepEqual(scanExactRepeatPairs(seq, { armLength: arm.length, maxGap: 100 }).pairs, oracle(seq, arm.length, 100));
    assert.equal(scanExactRepeatPairs(seq, { armLength: arm.length, maxGap: 100 }).pairs.filter(p => p.leftStart === 0).length, 2);
    const long = randomDna(256, 35); assert(scanExactRepeatPairs(long + 'NN' + rc(long), { armLength: 256 }).pairs.some(p => p.leftStart === 0 && p.rightStart === 258));
  });
  it('reports a deterministic prefix only after finding an extra match, including same-start orientation ties', () => {
    const seq = 'ACGTACGTACGTACGT', all = oracle(seq, 4, 100);
    for (let maxPairs = 1; maxPairs <= all.length + 1; maxPairs++) {
      const scan = scanExactRepeatPairs(seq, { armLength: 4, maxGap: 100, maxPairs });
      assert.deepEqual(scan.pairs, all.slice(0, maxPairs)); assert.equal(scan.search.complete, maxPairs >= all.length);
      assert.equal(scan.search.stoppedAtRightStart, maxPairs < all.length ? all[maxPairs].rightStart : null);
    }
  });
  it('throws on work exhaustion and malformed input/settings without returning partial evidence', () => {
    assert.throws(() => scanExactRepeatPairs('ACGTACGT', { armLength: 4 }, 3), /budget exhausted/);
    for (const sequence of ['ACGU', 'ACGT-', 'ACGT\n', 'ACGß', 'A'.repeat(5000001)]) assert.throws(() => scanExactRepeatPairs(sequence));
    for (const settings of [{ armLength: 3 }, { armLength: 257 }, { maxGap: -1 }, { maxGap: 100001 }, { maxPairs: 0 }, { maxPairs: Infinity }, { maxPairs: 20001 }, { maxGap: 0.5 }, { ignored: 3 }]) {
      assert.throws(() => scanExactRepeatPairs('ACGT', settings as ExactRepeatOptions));
    }
  });
  it('finds planted non-sampled starts in 250kb with exact direct and inverted partner coordinates', () => {
    const arm = randomDna(32, 991); let sequence = randomDna(250000, 912);
    for (const [start, part] of [[137, arm], [973, arm], [1589, rc(arm)]] as const) sequence = sequence.slice(0, start) + part + sequence.slice(start + part.length);
    const scan = scanExactRepeatPairs(sequence, { armLength: 32, maxGap: 2000 });
    assert(scan.pairs.some(p => p.type === 'direct' && p.leftStart === 137 && p.rightStart === 973));
    assert(scan.pairs.some(p => p.type === 'inverted' && p.leftStart === 137 && p.rightStart === 1589));
    assert.equal(scan.search.complete, true); assert.equal(scan.search.rightStartsVisited, 250000 - 64 + 1);
    for (const pair of scan.pairs) {
      const a = sequence.slice(pair.leftStart, pair.leftEnd), b = sequence.slice(pair.rightStart, pair.rightEnd);
      assert.equal(a, pair.type === 'direct' ? b : rc(b));
    }
  });
  it('binds portable exact evidence, original case and all coverage to fresh recomputation', async () => {
    const sequence = 'acgtNNacgtACGT', options = { armLength: 4, maxGap: 10, maxPairs: 2 };
    const record = await createExactRepeatRecord(sequence, options, { accession: 'LOCAL', source: 'local' });
    assert.deepEqual(await replayExactRepeatRecord(serializeAnalysisRecord(record)), record);
    assert.match(exportExactRepeatPairsTsv(record), /complete=false/);
    const changed = await createExactRepeatRecord(sequence, { ...options, maxPairs: 3 }, { accession: 'LOCAL', source: 'local' });
    assert.notEqual(changed.resultId, record.resultId);
    const uppercase = await createExactRepeatRecord(sequence.toUpperCase(), options, { accession: 'LOCAL', source: 'local' });
    assert.notEqual(uppercase.cacheKey, record.cacheKey); assert.deepEqual(uppercase.fields, record.fields);
    const { format: _f, version: _v, resultId: _r, cacheKey: _c, ...source } = record;
    source.fields.pairs.value = [];
    const forged = await createAnalysisRecord(source);
    await assert.rejects(replayExactRepeatRecord(serializeAnalysisRecord(forged)), /Recomputed/);
  });
});

// Deliberately enumerate unordered genomic start pairs, construct occupied-base
// sets, and choose between the two physical arcs. No rolling/FIFO state is shared
// with production. Sort only after all pairs are independently established.
function circularOracle(sequence: string, length: number, maxGap: number): ExactRepeatPair[] {
  const seq = sequence.toUpperCase(), n = seq.length, pairs: ExactRepeatPair[] = [];
  const arm = (start: number) => Array.from({ length }, (_, i) => seq[(start + i) % n]).join('');
  if (2 * length > n) return pairs;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const occupied = new Set(Array.from({ length }, (_, i) => (a + i) % n));
    if (Array.from({ length }, (_, i) => (b + i) % n).some(p => occupied.has(p))) continue;
    const firstGap = b - a - length, otherGap = n - (b - a) - length;
    const [left, right, gap] = firstGap <= otherGap ? [a, b, firstGap] : [b, a, otherGap];
    if (gap > maxGap) continue;
    const first = arm(left), second = arm(right);
    if (/[^ACGT]/.test(first + second)) continue;
    for (const type of ['direct', 'inverted'] as const) if (first === (type === 'direct' ? second : rc(second))) {
      pairs.push({ type, leftStart: left, leftEnd: left + length, rightStart: right, rightEnd: right + length, gap });
    }
  }
  return pairs.sort((a, b) => a.rightStart - b.rightStart || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || b.gap - a.gap);
}
const circular = { topology: 'circular' as const, armLength: 4, maxGap: 100, maxPairs: 20000 };
describe('complete-circle exact repeat pairs', () => {
  it('matches independent physical-pair enumeration for every binary circle of lengths 8–12 and three gap limits', () => {
    for (let n = 8; n <= 12; n++) for (let code = 0; code < 2 ** n; code++) {
      const sequence = Array.from({ length: n }, (_, i) => code & (1 << i) ? 'T' : 'A').join('');
      for (const maxGap of [0, 1, 100]) {
        const scan = scanExactRepeatPairs(sequence, { ...circular, maxGap });
        assert.deepEqual(scan.pairs, circularOracle(sequence, 4, maxGap));
        assert.equal(scan.search.complete, true); assert.equal(scan.search.rightStartsVisited, n);
      }
    }
  });
  it('returns origin-crossing direct/inverted arms without converting ambiguity into evidence', () => {
    for (const [partner, type] of [['ACGA', 'direct'], ['TCGT', 'inverted']] as const) {
      const sequence = 'GA' + 'N'.repeat(4) + partner + 'N'.repeat(8) + 'AC';
      const scan = scanExactRepeatPairs(sequence.toLowerCase(), { ...circular, maxGap: 4 });
      assert.deepEqual(scan.pairs, [{ type, leftStart: 18, leftEnd: 22, rightStart: 6, rightEnd: 10, gap: 4 }]);
      assert.equal(scan.search.resolvedBases, 8);
      assert.deepEqual(scanExactRepeatPairs(sequence, { armLength: 4, maxGap: 4 }).pairs, []);
      assert.deepEqual(exactRepeatArmSegments(20, 18, 22), [{ start: 18, end: 20 }, { start: 0, end: 2 }]);
      assert.equal(exactRepeatArmSegments(20, 18, 22).map(s => sequence.slice(s.start, s.end)).join(''), 'ACGA');
      assert.deepEqual(scanExactRepeatPairs(sequence, { ...circular, maxGap: 3 }).pairs, []);
    }
  });
  it('deduplicates equal arcs, retains both orientations, and never allows overlapping or self pairs', () => {
    const all = scanExactRepeatPairs('AAAAAAAA', circular);
    assert.equal(all.pairs.length, 4);
    assert.deepEqual(all.pairs.map(p => [p.leftStart, p.rightStart, p.gap]), [[0, 4, 0], [1, 5, 0], [2, 6, 0], [3, 7, 0]]);
    const both = scanExactRepeatPairs('ACGTACGT', circular).pairs.filter(p => p.leftStart === 0 && p.rightStart === 4);
    assert.deepEqual(both.map(p => p.type), ['direct', 'inverted']);
    assert.deepEqual(scanExactRepeatPairs('AAAAAAA', circular).pairs, []);
    assert.deepEqual(scanExactRepeatPairs('NNNNNNNN', circular).pairs, []);
  });
  it('agrees on ambiguous/random circles and long arms whose index prefixes agree but full arms differ', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const sequence = randomDna(35 + seed % 15, seed, seed % 2 ? 'ACGTN' : 'ACGT').toLowerCase();
      const armLength = 4 + seed % 7, maxGap = seed % 11;
      assert.deepEqual(scanExactRepeatPairs(sequence, { ...circular, armLength, maxGap }).pairs, circularOracle(sequence, armLength, maxGap));
    }
    const arm = randomDna(24, 32), raw = arm + 'NN' + arm.slice(0, 15) + 'C'.repeat(9) + 'NN' + rc(arm);
    const sequence = raw.slice(12) + raw.slice(0, 12);
    assert.deepEqual(scanExactRepeatPairs(sequence, { ...circular, armLength: 24 }).pairs, circularOracle(sequence, 24, 100));
    const long = randomDna(256, 35), shifted = (long + 'NN' + rc(long)).slice(127) + (long + 'NN' + rc(long)).slice(0, 127);
    assert(scanExactRepeatPairs(shifted, { ...circular, armLength: 256 }).pairs.some(p => p.type === 'inverted' && (p.leftEnd > shifted.length || p.rightEnd > shifted.length)));
  });
  it('preserves the complete physical pair set under every rotation and reverse complement', () => {
    const source = 'ACGTACGTACGTAACGT', n = source.length;
    const normalize = (pairs: ExactRepeatPair[], map: (start: number) => number) => pairs.map(p => `${p.type}:${[map(p.leftStart), map(p.rightStart)].sort((a, b) => a - b).join(':')}`).sort();
    const expected = normalize(scanExactRepeatPairs(source, circular).pairs, p => p);
    for (let offset = 0; offset < n; offset++) for (const reverse of [false, true]) {
      const oriented = reverse ? rc(source) : source, sequence = oriented.slice(offset) + oriented.slice(0, offset);
      const map = (p: number) => reverse ? (n - ((p + offset) % n) - 4 + n) % n : (p + offset) % n;
      assert.deepEqual(normalize(scanExactRepeatPairs(sequence, circular).pairs, map), expected);
    }
  });
  it('truncates only for an additional canonical match and bounds comparisons including wrapped candidates', () => {
    const sequence = 'ACGTACGTACGT', expected = circularOracle(sequence, 4, 100);
    for (let maxPairs = 1; maxPairs <= expected.length + 1; maxPairs++) {
      const scan = scanExactRepeatPairs(sequence, { ...circular, maxPairs });
      assert.deepEqual(scan.pairs, expected.slice(0, maxPairs));
      assert.equal(scan.search.complete, maxPairs >= expected.length);
      assert.equal(scan.search.stoppedAtRightStart, maxPairs < expected.length ? expected[maxPairs].rightStart : null);
    }
    assert.equal(scanExactRepeatPairs('AAAAAAAA', { ...circular, maxPairs: 4 }, 16).search.complete, true);
    assert.throws(() => scanExactRepeatPairs('AAAAAAAA', circular, 15), /budget exhausted/);
    assert.equal(scanExactRepeatPairs('NNNNNNNN', circular, 0).search.comparedBases, 0);
  });
  it('rejects unsupported topology and invalid wrapped coordinates without changing the linear default', () => {
    for (const topology of ['auto', null, false, 0]) assert.throws(() => scanExactRepeatPairs('ACGTACGT', { ...circular, topology } as never), /topology/);
    assert.throws(() => scanExactRepeatPairs('', circular), /at least one base/);
    assert.deepEqual(resolveExactRepeatOptions({ topology: 'linear' }), resolveExactRepeatOptions({}));
    for (const args of [[0, 0, 1], [10, -1, 3], [10, 10, 12], [10, 2, 2], [10, 2, 13], [10, 1.5, 4]]) {
      assert.throws(() => exactRepeatArmSegments(args[0], args[1], args[2]));
    }
    assert.deepEqual(exactRepeatArmSegments(10, 6, 10), [{ start: 6, end: 10 }]);
  });
  it('exports wrapped segments, binds topology and recomputes v2 evidence instead of trusting rehashed values', async () => {
    const sequence = 'GA' + 'N'.repeat(4) + 'ACGA' + 'N'.repeat(8) + 'AC';
    const record = await createExactRepeatRecord(sequence, circular, { accession: 'circle', source: 'local' });
    assert.equal(record.method.version, '2'); assert.equal(record.parameters.topology, 'circular');
    assert.deepEqual(await replayExactRepeatRecord(serializeAnalysisRecord(record)), record);
    const tsv = exportExactRepeatPairsTsv(record);
    assert.match(tsv, /topology=circular; sequenceLength=20; complete=true/);
    assert.match(tsv, /direct\t18\t22\t6\t10\t4\t\[18,20\);\[0,2\)\t\[6,10\)/);
    const linear = await createExactRepeatRecord(sequence, { ...circular, topology: 'linear' }, { accession: 'circle', source: 'local' });
    assert.equal(linear.method.version, '1'); assert.notEqual(linear.cacheKey, record.cacheKey);
    assert.deepEqual(await replayExactRepeatRecord(serializeAnalysisRecord(linear)), linear);
    const { format: _f, version: _v, resultId: _r, cacheKey: _c, ...source } = structuredClone(record);
    source.fields.pairs.value = [];
    await assert.rejects(replayExactRepeatRecord(serializeAnalysisRecord(await createAnalysisRecord(source))), /Recomputed/);
    source.fields = record.fields; source.parameters.topology = 'linear';
    await assert.rejects(replayExactRepeatRecord(serializeAnalysisRecord(await createAnalysisRecord(source))), /Recomputed/);
  });
  it('finds a unique origin-crossing pair in a 250kb circle and independently reconstructs its arms', () => {
    const arm = randomDna(32, 177), n = 250000, origin = n - 12, other = 713;
    const bases = randomDna(n, 922).split('');
    for (const start of [origin, other]) for (let i = 0; i < arm.length; i++) bases[(start + i) % n] = arm[i];
    const sequence = bases.join(''), scan = scanExactRepeatPairs(sequence, { ...circular, armLength: 32, maxGap: 2000 });
    assert(scan.pairs.some(p => p.type === 'direct' && p.leftStart === origin && p.leftEnd === n + 20 && p.rightStart === other && p.gap === 693));
    assert.equal(scan.search.complete, true); assert.equal(scan.search.rightStartsVisited, n);
    for (const p of scan.pairs) {
      const a = exactRepeatArmSegments(n, p.leftStart, p.leftEnd).map(s => sequence.slice(s.start, s.end)).join('');
      const b = exactRepeatArmSegments(n, p.rightStart, p.rightEnd).map(s => sequence.slice(s.start, s.end)).join('');
      assert.equal(a, p.type === 'direct' ? b : rc(b));
    }
  });
});
