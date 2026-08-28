import { describe, expect, test, beforeEach } from 'bun:test';
import { SharedSequencePool, decodeSequence } from './SharedSequencePool';

describe('SharedSequencePool', () => {
  beforeEach(() => {
    SharedSequencePool.resetInstance();
  });

  test('returns the same buffer for the same phage id and sequence', () => {
    const pool = SharedSequencePool.getInstance();
    const first = pool.getOrCreate(1, 'ACGTACGT');
    const second = pool.getOrCreate(1, 'ACGTACGT');
    expect(second.sab).toBe(first.sab);
    expect(decodeSequence(second.view, second.length)).toBe('ACGTACGT');
  });

  test('replaces a stale genome stored under the same phage id', () => {
    const pool = SharedSequencePool.getInstance();
    pool.getOrCreate(7, 'AAAAAAAA');
    const replaced = pool.getOrCreate(7, 'CCCCCCCC');
    expect(decodeSequence(replaced.view, replaced.length)).toBe('CCCCCCCC');
    expect(pool.get(7)?.length).toBe(8);
  });
});
