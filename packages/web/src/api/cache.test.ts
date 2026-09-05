import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCached,
  setCache,
  removeCache,
  clearCache,
  generateCacheKey,
  BUILD_CACHE_VERSION,
  setDatabaseCacheVersion,
  withCache,
} from './cache';

/**
 * Cache versioning.
 *
 * The defect: a cache entry outlives the code that produced it. `getCached`
 * validated only the TTL, and two overlays cached an analysis under
 * `{ source: 'real', result }` with a 24 hour TTL. A user who opened the
 * previous build within that window had the NEW build read back the OLD
 * analysis and render it beneath a green "REAL DATA" banner. What was being
 * replayed was exactly the fabricated output the new build exists to remove,
 * so every fix was invisible to that user for a day.
 *
 * These tests exist to make that unrepeatable. The important one is not "a
 * different version misses" on its own -- a cache that never returns anything
 * would pass that. It is that pair with the same-version hit below it.
 */

// ---------------------------------------------------------------------------
// Minimal localStorage. The module reads `window.localStorage` and iterates it
// by index, so `length` and `key(i)` have to behave, not just get/set.
// ---------------------------------------------------------------------------
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  /** Test-only view, so assertions can inspect what physically landed. */
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

const storage = new MemoryStorage();
const originalWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = { localStorage: storage };

afterAll(() => {
  setDatabaseCacheVersion(null);
  (globalThis as { window?: unknown }).window = originalWindow;
});

beforeEach(() => {
  storage.clear();
  setDatabaseCacheVersion(null);
});

describe('a changed version cannot read the previous version', () => {
  it('does not cache an in-flight result under a newly opened dataset', async () => {
    setDatabaseCacheVersion('a'.repeat(64));
    let finish!: (value: number) => void;
    const pending = withCache(() => new Promise<number>(resolve => { finish = resolve; }), () => 'pending')();
    setDatabaseCacheVersion('b'.repeat(64));
    setCache('pending', 43);
    finish(42);
    expect(await pending).toBe(42);
    expect(getCached<number>('pending')).toBe(43);
  });
  it('isolates analysis results when only the loaded dataset changes', () => {
    const first = 'a'.repeat(64);
    setDatabaseCacheVersion(first);
    setCache('analysis', { result: 42 });
    expect(getCached<{ result: number }>('analysis')).toEqual({ result: 42 });
    setDatabaseCacheVersion(first);
    expect(getCached<{ result: number }>('analysis')).toEqual({ result: 42 });
    setDatabaseCacheVersion('b'.repeat(64));
    expect(getCached('analysis')).toBeNull();
    setCache('analysis', { result: 43 });
    expect(getCached<{ result: number }>('analysis')).toEqual({ result: 43 });
    expect(() => setDatabaseCacheVersion('invalid')).toThrow('Invalid database');
  });
  it('misses when the version differs', () => {
    setCache('k', { source: 'real', value: 42 }, { version: 'build-1' });
    expect(getCached('k', { version: 'build-2' })).toBeNull();
  });

  it('hits when the version is unchanged', () => {
    // The planted negative. Without this, the test above passes just as well
    // against a cache that stores nothing at all, and would keep passing if
    // someone broke writes entirely.
    setCache('k', { source: 'real', value: 42 }, { version: 'build-1' });
    expect(getCached<{ source: string; value: number }>('k', { version: 'build-1' })).toEqual({
      source: 'real',
      value: 42,
    });
  });

  it('does not resurrect the old value when the version changes back', () => {
    // Guards the sweep: after writing under build-2, the build-1 entry must be
    // gone from storage rather than merely unreachable, or a rollback would
    // republish stale analysis.
    setCache('k', { generation: 1 }, { version: 'build-1' });
    setCache('k', { generation: 2 }, { version: 'build-2' });
    expect(getCached('k', { version: 'build-1' })).toBeNull();
  });

  it('physically removes entries belonging to other versions', () => {
    setCache('a', { n: 1 }, { version: 'build-1' });
    setCache('b', { n: 2 }, { version: 'build-1' });
    expect(storage.keys().filter(k => k.includes('build-1')).length).toBe(2);

    setCache('c', { n: 3 }, { version: 'build-2' });

    // Unreachable entries must not linger; they consume the user's quota
    // forever otherwise.
    expect(storage.keys().filter(k => k.includes('build-1')).length).toBe(0);
    expect(storage.keys().filter(k => k.includes('build-2')).length).toBe(1);
  });

  it('keeps two versions from colliding on the same key', () => {
    setCache('same-key', { which: 'one' }, { version: 'v1' });
    // Writing v2 sweeps v1, so read v2 back and confirm it is v2's value and
    // not v1's leaking through a shared storage slot.
    setCache('same-key', { which: 'two' }, { version: 'v2' });
    expect(getCached<{ which: string }>('same-key', { version: 'v2' })).toEqual({ which: 'two' });
  });
});

describe('versioning does not break the rest of the cache contract', () => {
  it('still expires on TTL within one version', () => {
    setCache('k', { n: 1 }, { version: 'v1', ttl: -1 });
    expect(getCached('k', { version: 'v1' })).toBeNull();
  });

  it('still honours removeCache', () => {
    setCache('k', { n: 1 }, { version: 'v1' });
    removeCache('k', { version: 'v1' });
    expect(getCached('k', { version: 'v1' })).toBeNull();
  });

  it('still honours clearCache', () => {
    setCache('a', { n: 1 }, { version: 'v1' });
    setCache('b', { n: 2 }, { version: 'v1' });
    clearCache({ version: 'v1' });
    expect(getCached('a', { version: 'v1' })).toBeNull();
    expect(getCached('b', { version: 'v1' })).toBeNull();
  });

  it('still evicts oldest entries past the limit', () => {
    for (let i = 0; i < 5; i++) setCache(`k${i}`, { i }, { version: 'v1', maxEntries: 3 });
    const live = storage.keys().filter(k => k.includes('_v1_'));
    expect(live.length).toBeLessThanOrEqual(3);
  });

  it('defaults to the build version when none is given', () => {
    setCache('k', { n: 1 });
    expect(getCached<{ n: number }>('k')).toEqual({ n: 1 });
    expect(getCached('k', { version: `${BUILD_CACHE_VERSION}-other` })).toBeNull();
  });
});

/**
 * The version has to reach EVERY call site, not just the two overlays whose
 * defect prompted this. It does so by living in the storage key prefix rather
 * than in each caller's key string, so a new overlay gets it for free.
 *
 * This test enforces that structurally: it reads the source and fails if any
 * caller has started hand-rolling a version into its key, which would mean the
 * discipline burden came back.
 */
describe('every caller is covered without having to opt in', () => {
  const webSrc = join(import.meta.dir, '..');

  const callSites = [
    'components/overlays/EnvironmentalProvenanceOverlay.tsx',
    'components/overlays/PhylodynamicsOverlay.tsx',
  ];

  it('has call sites that pass no version of their own', () => {
    for (const rel of callSites) {
      const src = readFileSync(join(webSrc, rel), 'utf8');
      expect(src).toContain('generateCacheKey(');
      // A caller embedding its own version string is the failure mode this
      // design avoids: it works until someone forgets to bump it.
      expect(src).not.toContain('SCHEMA_VERSION');
      expect(src).not.toContain('CACHE_VERSION');
    }
  });

  it('puts the version in the storage key, not in the caller key', () => {
    // generateCacheKey is a pure function of endpoint and params, so two
    // versions produce the SAME logical key; separation happens in storage.
    const a = generateCacheKey('provenance', { phageKey: '1' });
    const b = generateCacheKey('provenance', { phageKey: '1' });
    expect(a).toBe(b);

    setCache(a, { v: 'old' }, { version: 'v1' });
    expect(getCached(b, { version: 'v2' })).toBeNull();
  });

  it('builds a version into the physical storage key', () => {
    setCache('probe', { n: 1 }, { version: 'stamped' });
    expect(storage.keys().some(k => k.includes('stamped'))).toBe(true);
  });
});
