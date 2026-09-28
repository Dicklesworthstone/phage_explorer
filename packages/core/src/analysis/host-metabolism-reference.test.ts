import { describe, it, expect } from 'bun:test';
import { ECOLI_CORE_REFERENCE, fetchHostMetabolismReference, getHostMetabolismReference, importHostMetabolismReference } from './host-metabolism-reference';

describe('published host-reference input boundary', () => {
  it('pins one named organism/model and retains the publisher license', () => {
    expect(getHostMetabolismReference('e-coli-core')).toBe(ECOLI_CORE_REFERENCE);
    expect(ECOLI_CORE_REFERENCE.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ECOLI_CORE_REFERENCE.license).toContain('commercial purposes should contact');
    expect(ECOLI_CORE_REFERENCE.license).toContain('Copyright © 2019 The Regents');
    expect(ECOLI_CORE_REFERENCE.license.length).toBeLessThanOrEqual(2000);
    expect(Object.isFrozen(ECOLI_CORE_REFERENCE)).toBe(true);
  });
  it('does not infer an unknown host or download an arbitrary identifier', async () => {
    let calls = 0;
    await expect(fetchHostMetabolismReference('unknown', { fetcher: async () => { calls++; return new Response('{}'); } })).rejects.toThrow('Unknown');
    expect(calls).toBe(0);
  });
  it('rejects a plausible renamed network before trusting its provenance', async () => {
    await expect(importHostMetabolismReference('{"id":"e_coli_core","metabolites":[],"reactions":[]}')).rejects.toThrow('checksum mismatch');
    await expect(importHostMetabolismReference('not JSON')).rejects.toThrow('checksum mismatch');
  });
  it('bounds local reference input before digesting or parsing', async () => {
    await expect(importHostMetabolismReference('x'.repeat(2 * 1024 * 1024 + 1))).rejects.toThrow('2 MiB');
  });
  it('makes only the explicit pinned request without credentials or redirects', async () => {
    let seen: [unknown, RequestInit | undefined] | null = null;
    await expect(fetchHostMetabolismReference('e-coli-core', { fetcher: async (url, init) => {
      seen = [url, init]; return new Response('{}');
    } })).rejects.toThrow('checksum mismatch');
    expect(seen![0]).toBe(ECOLI_CORE_REFERENCE.url);
    expect(seen![1]?.credentials).toBe('omit');
    expect(seen![1]?.redirect).toBe('error');
    expect(seen![1]?.referrerPolicy).toBe('no-referrer');
  });
  it('surfaces HTTP failures, not an empty teaching-model fallback', async () => {
    await expect(fetchHostMetabolismReference('e-coli-core', { fetcher: async () => new Response('', { status: 503 }) })).rejects.toThrow('HTTP 503');
  });
  it('rejects an oversized advertised body without reading it', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    await expect(fetchHostMetabolismReference('e-coli-core', { fetcher: async () => new Response(body, { headers: { 'content-length': '2097153' } }) })).rejects.toThrow('2 MiB');
    expect(cancelled).toBe(true);
  });
  it('enforces the streaming limit despite a false small content length', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)),
      cancel: () => { cancelled = true; },
    });
    await expect(fetchHostMetabolismReference('e-coli-core', { fetcher: async () => new Response(body, { headers: { 'content-length': '1' } }) })).rejects.toThrow('2 MiB');
    expect(cancelled).toBe(true);
  });
  it('rejects missing bodies and malformed UTF-8', async () => {
    await expect(fetchHostMetabolismReference('e-coli-core', { fetcher: async () => new Response(null) })).rejects.toThrow('no readable body');
    await expect(fetchHostMetabolismReference('e-coli-core', { fetcher: async () => new Response(new Uint8Array([0xff])) })).rejects.toThrow();
  });
  it('does not contact the publisher after an early cancellation', async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    await expect(fetchHostMetabolismReference('e-coli-core', { signal: controller.signal, fetcher: async () => { calls++; return new Response('{}'); } })).rejects.toHaveProperty('name', 'AbortError');
    expect(calls).toBe(0);
  });
  it('cancels a stalled body and leaves no accepted model', async () => {
    const controller = new AbortController(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const request = fetchHostMetabolismReference('e-coli-core', { signal: controller.signal, fetcher: async () => new Response(body) });
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
    await expect(request).rejects.toHaveProperty('name', 'AbortError');
    expect(cancelled).toBe(true);
  });
});
