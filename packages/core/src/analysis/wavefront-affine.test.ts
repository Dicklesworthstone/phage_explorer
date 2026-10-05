import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { alignAffineWavefront, resolveAffinePenalties, type AffinePenalties } from './wavefront-alignment';

// Independent full-coordinate Gotoh DP. No wavefront, furthest offsets or traceback reuse.
function gotoh(a: string, b: string, p: AffinePenalties): number {
  const n = b.length + 1, size = (a.length + 1) * n;
  const m = new Float64Array(size).fill(Infinity), d = m.slice(), ins = m.slice();
  m[0] = 0;
  for (let x = 0; x <= a.length; x++) for (let y = 0; y <= b.length; y++) {
    const at = x * n + y;
    if (x) d[at] = Math.min(m[at - n] + p.gapOpen + p.gapExtend, d[at - n] + p.gapExtend);
    if (y) ins[at] = Math.min(m[at - 1] + p.gapOpen + p.gapExtend, ins[at - 1] + p.gapExtend);
    const diagonal = x && y ? m[at - n - 1] + (a[x - 1] === b[y - 1] ? 0 : p.mismatch) : Infinity;
    if (x || y) m[at] = Math.min(diagonal, d[at], ins[at]);
  }
  return m[size - 1];
}
function check(a: string, b: string, p: AffinePenalties) {
  const out = alignAffineWavefront(a, b, { penalties: p });
  assert.equal(out.reference.replaceAll('-', ''), a);
  assert.equal(out.query.replaceAll('-', ''), b);
  assert.equal(out.reference.length, out.query.length);
  let score = 0, previous = '';
  for (let i = 0; i < out.reference.length; i++) {
    const x = out.reference[i], y = out.query[i];
    assert(x !== '-' || y !== '-');
    const kind = x === '-' ? 'I' : y === '-' ? 'D' : '';
    score += kind ? p.gapExtend + (kind === previous ? 0 : p.gapOpen) : x === y ? 0 : p.mismatch;
    previous = kind;
  }
  assert.equal(out.score, score, 'trace cost');
  assert.equal(out.score, gotoh(a, b, p), `optimal cost for ${a}/${b}`);
  return out;
}

describe('exact affine wavefront', () => {
  it('agrees with independent Gotoh scores and reconstructs every small binary pair under six scoring regimes', () => {
    const words = [''];
    for (let n = 1; n <= 4; n++) for (let i = 0; i < 2 ** n; i++) words.push(i.toString(2).padStart(n, '0').replaceAll('0', 'A').replaceAll('1', 'C'));
    for (const p of [
      { mismatch: 4, gapOpen: 6, gapExtend: 1 }, { mismatch: 1, gapOpen: 0, gapExtend: 1 },
      { mismatch: 9, gapOpen: 0, gapExtend: 2 }, { mismatch: 3, gapOpen: 2, gapExtend: 2 },
      { mismatch: 12, gapOpen: 8, gapExtend: 4 }, { mismatch: 1, gapOpen: 64, gapExtend: 64 },
    ]) for (const a of words) for (const b of words) check(a, b, p);
  });
  it('handles multiple gaps, both boundaries, ambiguity, long matches and adversarial penalties', () => {
    let seed = 777;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const sequence = (length: number) => Array.from({ length }, () => 'ACGTNRY'[random() % 7]).join('');
    for (let i = 0; i < 400; i++) check(sequence(random() % 24), sequence(random() % 24),
      { mismatch: 1 + random() % 12, gapOpen: random() % 9, gapExtend: 1 + random() % 5 });
    check('AACCGGTTAACCGGTT', 'TTAACCGGAAACCGGTTAA', { mismatch: 5, gapOpen: 3, gapExtend: 1 });
  });
  it('charges opening plus extension for the first gap base, not opening alone', () => {
    assert.equal(check('ACT', 'ACGT', { mismatch: 4, gapOpen: 6, gapExtend: 2 }).score, 8);
    assert.equal(check('', 'ACGT', { mismatch: 4, gapOpen: 6, gapExtend: 2 }).score, 14);
    assert.equal(check('', '', { mismatch: 4, gapOpen: 6, gapExtend: 2 }).score, 0);
  });
  it('accepts long single indels by attaining a proven score lower bound, without quadratic trace allocation', () => {
    const a = 'ACGT'.repeat(20000), b = a.slice(0, 40000) + 'N'.repeat(12000) + a.slice(40000);
    for (const [reference, query] of [[a, b], [b, a]]) {
      const out = alignAffineWavefront(reference, query);
      assert.equal(out.score, 12006); assert.equal(out.states, 0);
      assert.equal(out.reference.replaceAll('-', ''), reference);
      assert.equal(out.query.replaceAll('-', ''), query);
    }
  });
  it('rejects invalid inputs, unsafe budgets and ambiguous penalty contracts', () => {
    for (const p of [null, [], {}, { mismatch: 4, gapOpen: 6 }, { mismatch: 0, gapOpen: 1, gapExtend: 1 },
      { mismatch: 4, gapOpen: -1, gapExtend: 1 }, { mismatch: 4, gapOpen: 6, gapExtend: 0 },
      { mismatch: 65, gapOpen: 1, gapExtend: 1 }, { mismatch: 4, gapOpen: 1, gapExtend: 1.5 },
      { mismatch: 4, gapOpen: 1, gapExtend: NaN }, { mismatch: 4, gapOpen: 1, gapExtend: 1, hidden: 2 }]) {
      assert.throws(() => resolveAffinePenalties(p));
    }
    assert.throws(() => alignAffineWavefront('a', 'A'));
    assert.throws(() => alignAffineWavefront('AC-G', 'ACG'));
    assert.throws(() => alignAffineWavefront('A'.repeat(250001), 'A'));
    for (const option of [{ maxStates: -1 }, { maxStates: 4000001 }, { maxComparisons: NaN }, { maxScoreLayers: Infinity }]) assert.throws(() => alignAffineWavefront('AC', 'GT', option));
  });
  it('fails each exhausted budget instead of returning a partial or different scoring result', () => {
    for (const option of [{ maxStates: 0 }, { maxComparisons: 0 }, { maxScoreLayers: 0 }]) {
      assert.throws(() => alignAffineWavefront('ACTG', 'ACCG', option), /budget/);
    }
    const result = alignAffineWavefront('ACGTAACCGG', 'ATTGTACCTGG');
    assert.throws(() => alignAffineWavefront('ACGTAACCGG', 'ATTGTACCTGG', { maxStates: result.states - 1 }), /state budget/);
    assert.throws(() => alignAffineWavefront('ACGTAACCGG', 'ATTGTACCTGG', { maxComparisons: result.comparisons - 1 }), /comparison budget/);
    assert.deepEqual(alignAffineWavefront('ACGTAACCGG', 'ATTGTACCTGG', { maxStates: result.states, maxComparisons: result.comparisons }), result);
  });
  it('retains deterministic ties and rescales equivalent penalty sets without extra search layers', () => {
    const a = alignAffineWavefront('ACCGTAC', 'AGTCCGA', { penalties: { mismatch: 3, gapOpen: 2, gapExtend: 1 } });
    const b = alignAffineWavefront('ACCGTAC', 'AGTCCGA', { penalties: { mismatch: 12, gapOpen: 8, gapExtend: 4 } });
    assert.equal(a.reference, b.reference); assert.equal(a.query, b.query); assert.equal(b.score, 4 * a.score);
    assert.equal(a.states, b.states); assert.equal(a.scoreLayers, b.scoreLayers);
    assert.deepEqual(alignAffineWavefront('ACCGTAC', 'AGTCCGA', { penalties: a.penalties }), a);
  });
});
