import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { alignNormalizedWavefront, mapNormalizedInterval, restoreSequence, transformSequence } from './sequence-normalization';
import { alignWavefront } from './wavefront-alignment';

const bases = 'ACGTRYSWKMBDHVN', complements = 'TGCAYRSWMKVHDBN';
const rc = (s: string) => s.split('').reverse().map(c => complements[bases.indexOf(c)]).join('');
const rotate = (s: string, n: number) => s.slice(n) + s.slice(0, n);
function dna(length: number, seed = 123456789): string {
  let x = seed;
  return Array.from({ length }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return 'ACGT'[(x >>> 0) % 4]; }).join('');
}
function distance(a: string, b: string): number {
  // Independent full edit DP, used only on short known fixtures.
  const matrix = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
  }
  return matrix[a.length][b.length];
}
function checkAlignment(reference: string, original: string, result: ReturnType<typeof alignNormalizedWavefront>): void {
  assert.equal(result.reference.replaceAll('-', ''), reference);
  const normalized = result.query.replaceAll('-', '');
  assert.equal(restoreSequence(normalized, result.transform), original);
  assert.equal(transformSequence(original, result.transform), normalized);
  assert.equal(result.reference.length, result.query.length);
  let edits = 0;
  for (let i = 0; i < result.reference.length; i++) {
    assert.notEqual(result.reference[i] + result.query[i], '--');
    edits += Number(result.reference[i] !== result.query[i]);
  }
  assert.equal(edits, result.distance);
}

describe('strand/origin-normalized genome alignment', () => {
  it('round trips every IUPAC base and maps all intervals on both strands across every origin', () => {
    for (const strand of ['+', '-'] as const) for (let offset = 0; offset < bases.length; offset++) {
      const transform = { strand, offset }, expected = rotate(strand === '+' ? bases : rc(bases), offset);
      assert.equal(transformSequence(bases, transform), expected);
      assert.equal(restoreSequence(expected, transform), bases);
      for (let start = 0; start <= bases.length; start++) for (let end = start; end <= bases.length; end++) {
        const segments = mapNormalizedInterval(bases.length, transform, start, end);
        const mapped = segments.map(segment => {
          const part = bases.slice(segment.start, segment.end);
          return segment.strand === '+' ? part : rc(part);
        }).join('');
        assert.equal(mapped, expected.slice(start, end));
        assert(segments.length <= 2);
        for (const segment of segments) assert(segment.start >= 0 && segment.start < segment.end && segment.end <= bases.length);
      }
    }
  });
  it('finds exact equivalence for all A/C/G/T words of length 1–4, all rotations and both strands', () => {
    for (let length = 1; length <= 4; length++) for (let value = 0; value < 4 ** length; value++) {
      let code = value, reference = '';
      for (let i = 0; i < length; i++) { reference += 'ACGT'[code % 4]; code = Math.floor(code / 4); }
      for (let offset = 0; offset < length; offset++) for (const reversed of [false, true]) {
        const original = rotate(reversed ? rc(reference) : reference, offset);
        const result = alignNormalizedWavefront(reference, original, 'circular');
        checkAlignment(reference, original, result);
        assert.equal(result.query, reference); assert.equal(result.distance, 0);
        assert.equal(result.normalization.method, 'exact-equivalence');
        const origins = (s: string) => Array.from({ length }, (_, i) => i).filter(i => rotate(s, i) === reference);
        const plus = origins(original), minus = origins(rc(original));
        assert.equal(result.normalization.equivalentForwardOrigins, plus.length);
        assert.equal(result.normalization.equivalentReverseOrigins, minus.length);
        assert.deepEqual(result.transform, { strand: plus.length ? '+' : '-', offset: (plus.length ? plus : minus)[0] });
      }
    }
  });
  it('makes repeat/palindrome ties explicit without inventing a biological origin', () => {
    const result = alignNormalizedWavefront('ATATAT', 'TATATA', 'circular');
    assert.deepEqual(result.transform, { strand: '+', offset: 1 });
    assert.equal(result.normalization.equivalentForwardOrigins, 3);
    assert.equal(result.normalization.equivalentReverseOrigins, 3);
    assert(result.normalization.limitations.some(text => text.includes('Multiple equivalent')));
    const ambiguous = alignNormalizedWavefront('NRYS', rc('NRYS'), 'strand');
    assert.equal(ambiguous.distance, 0); checkAlignment('NRYS', rc('NRYS'), ambiguous);
  });
  it('orients a mutated reverse-strand genome without rotating linear inputs', () => {
    const reference = dna(512), changed = reference.slice(0, 123) + (reference[123] === 'A' ? 'C' : 'A') + reference.slice(124);
    const original = rc(changed), result = alignNormalizedWavefront(reference, original, 'strand');
    checkAlignment(reference, original, result);
    assert.equal(result.query.replaceAll('-', ''), changed);
    assert.deepEqual(result.transform, { strand: '-', offset: 0 });
    assert.equal(result.distance, 1); assert(result.normalization.reverseSupport >= 3);
    assert.equal(result.normalization.forwardSupport, 0);
  });
  it('restores the original reference origin through insertions/deletions before the chosen anchor', () => {
    const reference = dna(300);
    const changed = reference.slice(0, 4) + 'AAA' + reference.slice(4, 180) + reference.slice(184);
    for (const reversed of [false, true]) for (const offset of [0, 1, 17, 145, changed.length - 1]) {
      const original = rotate(reversed ? rc(changed) : changed, offset);
      const result = alignNormalizedWavefront(reference, original, 'circular');
      checkAlignment(reference, original, result);
      assert.equal(result.query.replaceAll('-', ''), changed);
      assert.equal(result.distance, distance(reference, changed));
      assert.equal(result.normalization.method, 'unique-kmer-anchor');
      assert(result.normalization.anchor!.referenceStart > 0, 'the regression requires a nonzero reference anchor');
    }
  });
  it('normalizes a reverse-rotated 100 kb genome with a planted substitution and insertion', () => {
    const reference = dna(100000);
    const changed = reference.slice(0, 150) + 'GGC' + reference.slice(150, 30000)
      + (reference[30000] === 'A' ? 'C' : 'A') + reference.slice(30001);
    const original = rotate(rc(changed), 43123);
    assert.throws(() => alignWavefront(reference, original, { maxStates: 10000 }), /budget/);
    const result = alignNormalizedWavefront(reference, original, 'circular', { maxStates: 10000 });
    checkAlignment(reference, original, result);
    assert.equal(result.distance, 4); assert.equal(result.transform.strand, '-');
    assert.equal(result.query.replaceAll('-', ''), changed);
  });
  it('handles an indel spanning the reference origin without dropping or duplicating bases', () => {
    const reference = dna(400), changed = reference.slice(5, -7), original = rotate(rc(changed), 77);
    const result = alignNormalizedWavefront(reference, original, 'circular');
    checkAlignment(reference, original, result);
    // The removed reference origin has no unique surviving query counterpart.
    // Length difference proves 12 is a lower bound; this alignment attains it.
    // Verify circular sequence equivalence, not an arbitrary surviving origin.
    assert.equal(result.distance, reference.length - changed.length);
    assert((changed + changed).includes(result.query.replaceAll('-', '')));
  });
  it('refuses insufficient or competing anchor support rather than choosing a strand by label', () => {
    assert.throws(() => alignNormalizedWavefront('AAAACCCC', 'AAAAGCCC', 'circular'), /unique 15-mer/);
    const left = dna(400, 72), right = dna(400, 498);
    assert.throws(() => alignNormalizedWavefront(left + right, left + rc(right), 'strand'), /decisive/);
    assert.throws(() => alignNormalizedWavefront('A'.repeat(100), 'A'.repeat(99) + 'C', 'circular'), /decisive/);
  });
  it('never uses ambiguous bases as k-mer anchors and preserves them in aligned paths', () => {
    const sequence = dna(256), reference = 'NNNNNNNNNNNNNNNN' + sequence;
    const changed = 'RRRRNNNNNNNNNNNN' + sequence, original = rotate(rc(changed), 135);
    const result = alignNormalizedWavefront(reference, original, 'circular');
    checkAlignment(reference, original, result);
    assert.equal(result.distance, 4); assert(result.normalization.anchor!.referenceStart >= 16);
  });
  it('enforces input/coordinate validation and existing WFA budgets even on exact equivalents', () => {
    for (const sequence of ['', 'acgt', 'AC-GT', 'ACUT', 'A'.repeat(250001)]) {
      assert.throws(() => alignNormalizedWavefront(sequence, 'ACGT', 'strand'));
    }
    assert.throws(() => alignNormalizedWavefront('ACGT', 'ACGT', 'bad' as 'strand'), /mode/);
    assert.throws(() => alignNormalizedWavefront('ACGT', 'ACGT', 'circular', { maxStates: 0 }), /budget/);
    assert.throws(() => alignNormalizedWavefront('ACGT', 'ACGT', 'circular', { maxComparisons: 0 }), /budget/);
    for (const offset of [-1, 4, NaN, 0.5]) assert.throws(() => transformSequence('ACGT', { strand: '+', offset }));
    for (const [start, end] of [[-1, 1], [1, 5], [2, 1], [0, NaN], [0.5, 1]]) {
      assert.throws(() => mapNormalizedInterval(4, { strand: '+', offset: 0 }, start, end));
    }
  });
});
