import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { scanExactRepeatPairs, createExactRepeatRecord, replayExactRepeatRecord, exportExactRepeatPairsTsv,
  type ExactRepeatPair, type ExactRepeatOptions } from './exact-repeat-pairs';
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
