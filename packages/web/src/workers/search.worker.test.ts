import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as Comlink from 'comlink';
import { isSearchResponse, type SearchFeature, type SearchOptions, type SearchRequest, type SearchWorkerAPI } from './types';

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

// Bun's .rejects matcher can deadlock when invoked from a prior Worker reply
// continuation (https://github.com/oven-sh/bun/issues/37189). Await the rejection normally, then make the
// same assertions synchronously so the worker message loop remains available.
async function expectSearchFailure(promise: PromiseLike<unknown>, message?: string): Promise<void> {
  let rejected = false;
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    failure = error;
  }
  expect(rejected).toBe(true);
  expect(failure).toBeInstanceOf(Error);
  if (message !== undefined) expect((failure as Error).message).toContain(message);
}

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
    await expectSearchFailure(search('motif', 'AAAA', 'A.*A'), 'IUPAC DNA');
    for (const maxResults of [0, -1, 1.5, NaN, Infinity, 2001]) {
      await expectSearchFailure(search('sequence', 'AAAA', 'A', { maxResults }), 'Search result limit');
    }
    await expectSearchFailure(search('sequence', 'AAAA', 'A', { mismatches: 0.5 }), 'Search mismatches');
    // A rejected request must not kill the worker or poison later valid work.
    expect((await search('sequence', 'ACGT', 'CG', { strand: '+' })).hits).toHaveLength(1);
  });
});

describe('complete circular sequence and motif search', () => {
  it('finds exact origin-spanning matches on both strands in forward coordinates', async () => {
    const forward = await search('sequence', 'GAAATTC', 'TCG', { topology: 'circular', strand: '+' });
    const reverse = await search('sequence', 'GAAATTC', 'CGA', { topology: 'circular', strand: '-' });
    expect(positions(forward)).toEqual([[5, 8, '+']]);
    expect(positions(reverse)).toEqual([[5, 8, '-']]);
    for (const result of [forward, reverse]) {
      expect(result.hits[0]).toMatchObject({ wrapsOrigin: true,
        segments: [{ start: 5, end: 7 }, { start: 0, end: 1 }], context: 'ATTC | GAA' });
    }
    // The default and an explicit linear interval do not manufacture a junction.
    expect((await search('sequence', 'GAAATTC', 'TCG', { strand: '+' })).hits).toEqual([]);
    expect((await search('sequence', 'GAAATTC', 'CGA', { topology: 'linear', strand: '-' })).hits).toEqual([]);
  });

  it('applies IUPAC, case and bounded mismatches at the origin using the ordinary matching rules', async () => {
    expect(positions(await search('motif', 'GAAATTC', 'YCG', { topology: 'circular', strand: '+' })))
      .toEqual([[5, 8, '+']]);
    expect(positions(await search('motif', 'GAAATTC', 'CGW', { topology: 'circular', strand: '-' })))
      .toEqual([[5, 8, '-']]);
    for (const mode of ['sequence', 'motif'] as const) {
      expect(positions(await search(mode, 'gAAATtc', 'tcg', { topology: 'circular', strand: '+', caseSensitive: true })))
        .toEqual([[5, 8, '+']]);
      expect(positions(await search(mode, 'gAAATtc', 'cga', { topology: 'circular', strand: '-', caseSensitive: true })))
        .toEqual([[5, 8, '-']]);
      expect((await search(mode, 'gAAATtc', 'TCG', { topology: 'circular', strand: '+', caseSensitive: true })).hits).toEqual([]);
    }
    const mismatch = await search('sequence', 'GAAATTC', 'TCA', { topology: 'circular', strand: '+', mismatches: 1 });
    expect(positions(mismatch)).toEqual([[5, 8, '+']]);
    expect(mismatch.hits[0].score).toBeCloseTo(2 / 3, 12);
    expect((await search('motif', 'AN', 'NN', { topology: 'circular', strand: '+' })).hits).toEqual([]);
    expect(positions(await search('sequence', 'AN', 'NA', { topology: 'circular', strand: '+' })))
      .toEqual([[1, 3, '+']]);
  });

  it('visits each start once, preserves result limits and permits a single complete traversal', async () => {
    for (const mode of ['sequence', 'motif'] as const) {
      expect(positions(await search(mode, 'AAAA', 'AAA', { topology: 'circular', strand: '+' })))
        .toEqual([[0, 3, '+'], [1, 4, '+'], [2, 5, '+'], [3, 6, '+']]);
      expect(positions(await search(mode, 'AAAA', 'AAAA', { topology: 'circular', strand: '+' })))
        .toEqual([[0, 4, '+'], [1, 5, '+'], [2, 6, '+'], [3, 7, '+']]);
      expect(positions(await search(mode, 'AAAA', 'AAA', { topology: 'circular', strand: 'both', maxResults: 2 })))
        .toEqual([[0, 3, '+'], [1, 4, '+']]);
      expect(positions(await search(mode, 'A', 'A', { topology: 'circular', strand: 'both' }))).toEqual([[0, 1, '+']]);
      await expectSearchFailure(search(mode, 'AAAA', 'AAAAA', { topology: 'circular' }), 'at most once');
    }
    await expectSearchFailure(search('sequence', 'ACGT', 'A', { topology: 'unknown' as SearchOptions['topology'] }),
      'Search topology');
    // Case expansion cannot turn a two-symbol query into two full traversals.
    for (const topology of ['linear', 'circular'] as const) {
      await expectSearchFailure(search('sequence', 'SS', 'ßß', { topology, strand: '+' }), 'IUPAC DNA');
      await expectSearchFailure(search('sequence', 'ß', 'S', { topology, strand: '+' }), 'IUPAC DNA');
      await expectSearchFailure(search('motif', 'ß', 'S', { topology, strand: '+' }), 'IUPAC DNA');
    }
    const long = await search('sequence', 'A'.repeat(1000), 'A'.repeat(500), { topology: 'circular', strand: '+', maxResults: 1 });
    expect(long.hits[0].context).toBe('A'.repeat(240) + '…');
  });

  it('agrees with an independent modular-coordinate oracle after every origin rotation', async () => {
    const original = 'GAAATTC';
    const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
    const order = (rows: unknown[][]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    for (let rotation = 0; rotation < original.length; rotation++) {
      const sequence = original.slice(rotation) + original.slice(0, rotation);
      for (const query of ['TCG', 'CGA']) {
        const expected: unknown[][] = [];
        for (let start = 0; start < sequence.length; start++) {
          const bases = Array.from({ length: query.length }, (_, j) => sequence[(start + j) % sequence.length]).join('');
          if (bases === query) expected.push([start, start + query.length, '+']);
          if ([...bases].reverse().map(base => complement[base]).join('') === query) expected.push([start, start + query.length, '-']);
        }
        for (const mode of ['sequence', 'motif'] as const) {
          const actual = await search(mode, sequence, query, { topology: 'circular' });
          expect(order(positions(actual))).toEqual(order(expected));
          for (const hit of actual.hits) {
            expect(Boolean(hit.wrapsOrigin)).toBe(hit.end! > sequence.length);
            if (hit.segments) expect(hit.segments.map(segment => sequence.slice(segment.start, segment.end)).join(''))
              .toBe(Array.from({ length: query.length }, (_, j) => sequence[(hit.position + j) % sequence.length]).join(''));
          }
        }
      }
    }
  });

  it('checks wrapped and ordinary intervals before either frontend can render or navigate them', async () => {
    const request: SearchRequest = { mode: 'sequence', sequence: 'GAAATTC', query: 'TCG', features: [],
      options: { topology: 'circular', strand: '+' } };
    const result = await api.runSearch(request);
    expect(isSearchResponse(request, result)).toBe(true);
    expect(isSearchResponse(request, { ...result, hits: new Array(1) })).toBe(false);
    for (const changes of [
      { segments: 'bad' }, { segments: [{ start: 4, end: 7 }, { start: 0, end: 1 }] },
      { position: -1 }, { position: 7 }, { end: 9 }, { wrapsOrigin: false }, { context: {} }, { score: NaN },
      { strand: '-' }, { strand: 'both' },
      // Correct-looking in-range coordinates still cannot shorten the query.
      { position: 0, end: 1, wrapsOrigin: undefined, segments: undefined },
    ]) expect(isSearchResponse(request, { ...result, hits: [{ ...result.hits[0], ...changes }] })).toBe(false);
    expect(isSearchResponse({ ...request, options: { topology: 'linear' } }, result)).toBe(false);
    const linear: SearchRequest = { ...request, query: 'GAA', options: { topology: 'linear', strand: '+' } };
    expect(isSearchResponse(linear, await api.runSearch(linear))).toBe(true);
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
      await expectSearchFailure(locate(query));
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
