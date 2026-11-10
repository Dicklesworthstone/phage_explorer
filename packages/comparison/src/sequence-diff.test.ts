import { describe, expect, it } from 'bun:test';
import { computeSequenceDiff, type SequenceDiffResult } from './sequence-diff';

function complete(a: string, b: string): Extract<SequenceDiffResult, { status: 'complete' }> {
  const result = computeSequenceDiff(a, b);
  if (result.status !== 'complete') throw new Error(result.reason);
  return result;
}

/** Independent full-matrix Levenshtein oracle, deliberately not the wavefront. */
function distance(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1,
      matrix[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
  }
  return matrix[a.length][b.length];
}

describe('exact bounded sequence diff', () => {
  it('matches an independent DP oracle and reconstructs every short input through contiguous runs', () => {
    let generation = ['']; const sequences = [''];
    for (let n = 1; n <= 3; n++) {
      generation = generation.flatMap(prefix => ['A', 'C', 'N'].map(base => prefix + base));
      sequences.push(...generation);
    }
    for (const a of sequences) for (const b of sequences) {
      const result = complete(a, b);
      expect(result.stats.distance).toBe(distance(a, b));
      expect(result.stats.insertions + result.stats.deletions + result.stats.substitutions).toBe(result.stats.distance);
      expect(result.stats.matches + result.stats.substitutions + result.stats.deletions).toBe(a.length);
      expect(result.stats.matches + result.stats.substitutions + result.stats.insertions).toBe(b.length);
      let atA = 0, atB = 0, recoveredA = '', recoveredB = '', edits = 0;
      for (const run of result.runs) {
        expect([run.startA, run.startB]).toEqual([atA, atB]);
        const left = a.slice(run.startA, run.endA), right = b.slice(run.startB, run.endB);
        if (run.operation === 'match') expect(left).toBe(right);
        else if (run.operation === 'insertion') { expect(left).toBe(''); edits += right.length; }
        else if (run.operation === 'deletion') { expect(right).toBe(''); edits += left.length; }
        else { expect(left.length).toBe(right.length); expect([...left].every((x, i) => x !== right[i])).toBe(true); edits += left.length; }
        recoveredA += left; recoveredB += right; atA = run.endA; atB = run.endB;
      }
      expect([recoveredA, recoveredB, edits]).toEqual([a, b, result.stats.distance]);
      expect(result.positions).toEqual([...result.mask].flatMap((value, i) => value ? [i] : []));
    }
  });

  it('aligns equal-length shifted strings instead of calling every position a substitution', () => {
    const result = complete('ACGT', 'CGTA');
    expect(result.stats).toMatchObject({ distance: 2, insertions: 1, deletions: 1, substitutions: 0, matches: 3, alignmentColumns: 5, identity: 60 });
    expect(result.runs.filter(run => run.operation !== 'match')).toEqual([
      { operation: 'deletion', startA: 0, endA: 1, startB: 0, endB: 0 },
      { operation: 'insertion', startA: 4, endA: 4, startB: 3, endB: 4 },
    ]);
    expect([...result.mask]).toEqual([3, 0, 0, 2]);
  });

  it('finds separated insertions beyond the former 4,000-base heuristic cutoff', () => {
    const a = 'ACGT'.repeat(1500);
    const b = a.slice(0, 1000) + 'GG' + a.slice(1000, 4000) + 'T' + a.slice(4000);
    const result = complete(a, b);
    expect(result.stats).toMatchObject({ distance: 3, insertions: 3, deletions: 0, substitutions: 0, matches: 6000 });
    expect(result.runs.filter(run => run.operation === 'insertion')).toHaveLength(2);
  });

  it('cancels exact common ends before solving a long isolated insertion', () => {
    const a = 'ACGT'.repeat(1000), b = a.slice(0, 2000) + 'G'.repeat(5000) + a.slice(2000);
    const result = complete(a, b);
    expect(result.stats).toMatchObject({ distance: 5000, insertions: 5000, deletions: 0, substitutions: 0, matches: 4000 });
    expect(result.states).toBe(0);
  });

  it('reports budget exhaustion without numeric or navigation results', () => {
    const result = computeSequenceDiff('A'.repeat(3000), 'C'.repeat(3001));
    expect(result.status).toBe('unavailable');
    expect(result).not.toHaveProperty('stats'); expect(result).not.toHaveProperty('mask'); expect(result).not.toHaveProperty('positions');
    if (result.status === 'unavailable') expect(result.reason).toContain('budget');
    expect(computeSequenceDiff('ACGT', 'ACGT', { maxComparisons: 0 }).status).toBe('unavailable');
    expect(computeSequenceDiff('A', 'C', { maxStates: 0 }).status).toBe('unavailable');
  });

  it('distinguishes zero edits from empty reference navigation and retains literal ambiguity', () => {
    expect(complete('acnt', 'ACNT').stats).toMatchObject({ distance: 0, matches: 4, ambiguousColumns: 1, identity: 100 });
    const inserted = complete('', 'ACGT');
    expect(inserted.positions).toEqual([]); expect(inserted.stats.distance).toBe(4); expect(inserted.stats.identity).toBe(0);
    expect(complete('', '').stats.distance).toBe(0);
  });

  it('refuses invalid symbols, oversized inputs and invalid work budgets explicitly', () => {
    expect(computeSequenceDiff('ACGT-', 'ACGT').status).toBe('unavailable');
    expect(computeSequenceDiff('A'.repeat(250001), 'A').status).toBe('unavailable');
    expect(() => computeSequenceDiff('A', 'C', { maxStates: -1 })).toThrow('budget');
  });

  it('rejects Unicode case expansions before they can alter original coordinates', () => {
    for (const [source, expanded] of [['ß', 'SS'], ['\uFB05', 'ST'], ['ſ', 'S']]) {
      const result = computeSequenceDiff(source, expanded);
      expect(result.status).toBe('unavailable'); expect(result).not.toHaveProperty('runs');
      expect(computeSequenceDiff(expanded, source).status).toBe('unavailable');
    }
    expect(complete('acgtryswkmbdhvn', 'ACGTRYSWKMBDHVN').stats).toMatchObject({ distance: 0, lengthA: 15, lengthB: 15 });
  });
});
