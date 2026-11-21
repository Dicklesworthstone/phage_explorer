import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as Comlink from 'comlink';
import type { SearchFeature, SearchOptions, SearchRequest, SearchWorkerAPI } from './types';

let worker: Worker, api: Comlink.Remote<SearchWorkerAPI>;
beforeAll(async () => {
  worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  api = Comlink.wrap<SearchWorkerAPI>(worker);
  expect(await api.ping()).toBe(true);
});
afterAll(() => { api?.[Comlink.releaseProxy](); worker?.terminate(); });

const search = (mode: SearchRequest['mode'], sequence: string, query: string,
  options: SearchOptions = {}, features: SearchFeature[] = []) =>
  api.runSearch({ mode, sequence, query, features, options });
const positions = (result: Awaited<ReturnType<typeof search>>) => result.hits.map(hit => [hit.position, hit.end, hit.strand]);

describe('real search worker motif enumeration', () => {
  it('returns every overlapping occurrence on each requested strand, with forward coordinates', async () => {
    expect(positions(await search('motif', 'AAAAA', 'AAA', { strand: '+' }))).toEqual([
      [0, 3, '+'], [1, 4, '+'], [2, 5, '+'],
    ]);
    expect(positions(await search('motif', 'TTTT', 'AAA', { strand: '-' }))).toEqual([
      [1, 4, '-'], [0, 3, '-'],
    ]);
    expect(positions(await search('motif', 'AAATTT', 'AAA'))).toEqual([[0, 3, '+'], [3, 6, '-']]);
  });

  it('expands IUPAC queries against resolved bases and honors case without losing overlaps', async () => {
    expect(positions(await search('motif', 'AAAGAG', 'AR', { strand: '+' }))).toEqual([
      [0, 2, '+'], [1, 3, '+'], [2, 4, '+'], [4, 6, '+'],
    ]);
    expect(positions(await search('motif', 'aaAAaA', 'aN', { strand: '+', caseSensitive: true })))
      .toEqual([[1, 3, '+'], [4, 6, '+']]);
    expect((await search('motif', 'aaAAaA', 'aN', { strand: '+' })).hits).toHaveLength(5);
    expect((await search('motif', 'NNN', 'NN', { strand: '+' })).hits).toHaveLength(0);
  });

  it('caps occurrences deterministically and preserves literal sequence search', async () => {
    expect(positions(await search('motif', 'AAAAA', 'AA', { strand: '+', maxResults: 2 })))
      .toEqual([[0, 2, '+'], [1, 3, '+']]);
    expect(positions(await search('sequence', 'AAAAA', 'AAA', { strand: '+' })))
      .toEqual([[0, 3, '+'], [1, 4, '+'], [2, 5, '+']]);
    expect(positions(await search('sequence', 'ACTA', 'ACG', { strand: '+', mismatches: 1 })))
      .toEqual([[0, 3, '+']]);
  });

  it('propagates unsupported motifs and invalid limits instead of reporting a successful empty result', async () => {
    await expect(search('motif', 'AAAA', 'A.*A')).rejects.toThrow('IUPAC DNA');
    for (const maxResults of [0, -1, 1.5, NaN, Infinity, 2001]) {
      await expect(search('sequence', 'AAAA', 'A', { maxResults })).rejects.toThrow('Search result limit');
    }
    await expect(search('sequence', 'AAAA', 'A', { mismatches: 0.5 })).rejects.toThrow('Search mismatches');
    // A rejected request must not kill the worker or poison later valid work.
    expect((await search('sequence', 'ACGT', 'CG', { strand: '+' })).hits).toHaveLength(1);
  });
});

describe('real search worker position semantics', () => {
  const features: SearchFeature[] = [
    { start: 0, end: 3, name: 'first', strand: '+' },
    { start: 3, end: 6, name: 'second', strand: '-' },
  ];
  const locate = (query: string) => search('position', 'ACGTACGT', query, {}, features);

  it('uses 0-based half-open feature and range boundaries', async () => {
    expect((await locate('3')).hits.map(hit => hit.label)).toEqual(['second']);
    expect((await locate('0-3')).hits.map(hit => hit.label)).toEqual(['first']);
    expect((await locate('3-0')).hits.map(hit => hit.label)).toEqual(['first']);
    expect(positions(await locate('6'))).toEqual([[6, 7, '+']]);
    expect(positions(await locate('7'))).toEqual([[7, 8, '+']]);
  });

  it('deduplicates overlapping queries and bounds positional markers', async () => {
    expect((await locate('0-3,1,3,4')).hits.map(hit => hit.label)).toEqual(['first', 'second']);
    expect(positions(await locate('7,7'))).toEqual([[7, 8, '+']]);
    expect((await search('position', 'A'.repeat(10), '0,1,2,3', { maxResults: 2 })).hits)
      .toHaveLength(2);
  });

  it('rejects the entire malformed or out-of-genome query before returning partial evidence', async () => {
    for (const query of ['8', '1.2', '-1', '1-4-6', '0-9', '0-0', '1,', '0,999999999999999999999']) {
      await expect(locate(query)).rejects.toThrow();
    }
  });
});

describe('request-owned annotation search', () => {
  const features: SearchFeature[] = [
    { start: 0, end: 3, name: 'AlphaBridgeCore', product: 'Example', type: 'CDS' },
    { start: 3, end: 6, name: 'alphabridgecore', product: 'example', type: 'gene' },
  ];

  it('keeps fuzzy subsequence recall and honors the requested case policy', async () => {
    expect((await search('gene', 'ACGTACGT', 'ABC', { fuzzy: true }, features)).hits).toHaveLength(2);
    expect((await search('gene', 'ACGTACGT', 'ABC', { fuzzy: true, caseSensitive: true }, features)).hits
      .map(hit => hit.label)).toEqual(['AlphaBridgeCore']);
    expect((await search('feature', 'ACGTACGT', 'CDS', { fuzzy: true, caseSensitive: true }, features)).hits
      .map(hit => hit.label)).toEqual(['CDS: AlphaBridgeCore']);
    expect((await search('feature', 'ACGTACGT', 'cds', { fuzzy: true, caseSensitive: true }, features)).hits).toHaveLength(0);
  });

  it('takes bases, coordinates and annotations from one request without an ID-index cache', async () => {
    const first = await search('gene', 'AAAAAAAA', 'Example', { fuzzy: true }, features);
    const second = await search('gene', 'CCCCCCCC', 'Example', { fuzzy: true }, [{ ...features[0], start: 4, end: 7 }]);
    const empty = await search('gene', 'GGGGGGGG', 'Example', { fuzzy: true }, []);
    expect(first.hits[0].context).toBe('AAAAAAAA');
    expect(second.hits[0]).toMatchObject({ position: 4, end: 7, context: 'CCCCCCCC' });
    expect(empty.hits).toEqual([]);
  });

  it('ranks before applying the result cap with deterministic coordinate ties', async () => {
    const ranked = await search('gene', 'A'.repeat(20), 'abc', { fuzzy: true, maxResults: 2 }, [
      { start: 9, end: 12, name: 'a longer b longer c' },
      { start: 6, end: 9, name: 'abc' },
      { start: 3, end: 6, name: 'abc' },
    ]);
    expect(ranked.hits.map(hit => hit.position)).toEqual([3, 6]);
  });

  it('bounds displayed context even when a matching feature spans the complete input', async () => {
    const result = await search('gene', 'A'.repeat(10000), 'large', { fuzzy: true, maxResults: 1 }, [
      { start: 0, end: 10000, name: 'large annotation' },
    ]);
    expect(result.hits[0]).toMatchObject({ position: 0, end: 10000 });
    expect(result.hits[0].context).toBe('A'.repeat(240) + '…');
  });
});
