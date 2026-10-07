import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { SharedSequencePool, decodeSequence } from './SharedSequencePool';

describe('SharedSequencePool', () => {
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
  beforeEach(() => {
    SharedSequencePool.resetInstance();
  });
  afterEach(() => {
    SharedSequencePool.resetInstance();
    if (originalIsolation) Object.defineProperty(globalThis, 'crossOriginIsolated', originalIsolation);
    else Reflect.deleteProperty(globalThis, 'crossOriginIsolated');
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

  for (const shared of [false, true]) {
    test(`does not substitute a same-length FNV collision (${shared ? 'shared' : 'transferable'})`, () => {
      Object.defineProperty(globalThis, 'crossOriginIsolated', { configurable: true, value: shared });
      // Different 40-base genomes with the same FNV-1a hash (4049430960).
      // A fingerprint hit is not evidence that the requested bases are present.
      const firstSequence = 'GAACATTCATACCGCCGGCGAAGCCAAAAAATCAATACTT';
      const secondSequence = 'CGTTAATAGACTGATGGACTAGCTAATTCGACAAGTACTC';
      const pool = SharedSequencePool.getInstance();
      const first = pool.getOrCreateRef(17, firstSequence);
      const second = pool.getOrCreateRef(17, secondSequence);
      expect(first.ref.isShared).toBe(shared);
      expect(second.ref.isShared).toBe(shared);
      const firstBases = decodeSequence(new Uint8Array(first.ref.buffer), first.ref.length);
      const secondBases = decodeSequence(new Uint8Array(second.ref.buffer), second.ref.length);
      expect(firstBases).toBe(firstSequence);
      expect(secondBases).toBe(secondSequence);
      expect([...secondBases].filter(base => base === 'C' || base === 'G')).toHaveLength(16);
      expect(decodeSequence(pool.get(17)!.view)).toBe(secondSequence);
      // Replacing the entry must not overwrite a buffer already handed to a worker.
      expect(decodeSequence(new Uint8Array(first.ref.buffer))).toBe(firstSequence);
      const reusable = pool.getOrCreate(17, secondSequence);
      expect(pool.getOrCreate(17, secondSequence)).toBe(reusable);
    });
  }
});
