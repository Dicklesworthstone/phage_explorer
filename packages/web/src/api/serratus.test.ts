import { afterEach, describe, expect, it } from 'bun:test';
import { getSRARunsForFamily } from './serratus';

describe('getSRARunsForFamily', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses run IDs from the JSON body (does not reference an unbound data variable)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ value: [{ run_id: 'SRR1' }, { run_id: '' }, { run_id: 'SRR2' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const result = await getSRARunsForFamily('Siphoviridae');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(['SRR1', 'SRR2']);
    }
  });

  it('returns an HTTP error without reading a missing JSON body', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 503 })) as unknown as typeof fetch;

    const result = await getSRARunsForFamily('Siphoviridae');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HTTP_503');
    }
  });
});
