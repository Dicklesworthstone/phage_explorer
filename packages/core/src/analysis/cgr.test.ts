import { describe, expect, it } from 'bun:test';
import { computeCGR, getKmerCoordinates } from './cgr';

describe('CGR', () => {
  it('computeCGR > empty sequence yields zero points and zero entropy', () => {
    const result = computeCGR('', 2);
    expect(result.resolution).toBe(4);
    expect(result.totalPoints).toBe(0);
    expect(result.maxCount).toBe(0);
    expect(result.entropy).toBe(0);
    expect(result.grid.every((v) => v === 0)).toBe(true);
  });

  it('computeCGR > counts points after transient removal (i >= k-1)', () => {
    const seq = 'AAAAAA';
    const k = 3;
    const result = computeCGR(seq, k);
    expect(result.totalPoints).toBe(seq.length - (k - 1));
    expect(result.maxCount).toBe(result.totalPoints);
  });

  it('computeCGR > skips non-ACGT characters', () => {
    const result = computeCGR('A N N T'.replace(/\s/g, ''), 1);
    expect(result.totalPoints).toBe(2);
  });

  it('getKmerCoordinates > maps single bases to quadrant centers', () => {
    expect(getKmerCoordinates('A')).toEqual({ x: 0.25, y: 0.25 });
    expect(getKmerCoordinates('T')).toEqual({ x: 0.75, y: 0.25 });
    expect(getKmerCoordinates('C')).toEqual({ x: 0.25, y: 0.75 });
    expect(getKmerCoordinates('G')).toEqual({ x: 0.75, y: 0.75 });
  });

  it('getKmerCoordinates > subdivides recursively for longer kmers', () => {
    expect(getKmerCoordinates('AA')).toEqual({ x: 0.125, y: 0.125 });
    expect(getKmerCoordinates('GG')).toEqual({ x: 0.875, y: 0.875 });
  });
});

