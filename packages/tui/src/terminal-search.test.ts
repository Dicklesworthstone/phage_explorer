import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PhageRepository } from '../../db-runtime/src/types';
import type { SearchRequest } from '../../web/src/workers/types';
import { loadTerminalSearchSource, runTerminalSearch } from './terminal-search';

const signal = () => new AbortController().signal;
const request = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({
  mode: 'sequence', sequence: 'AAAAATTT', query: 'AAA', features: [], options: { strand: 'both' }, ...overrides,
});
const positions = (result: Awaited<ReturnType<typeof runTerminalSearch>>) => result.hits.map(hit => [hit.position, hit.end, hit.strand]);

describe('native transport for the existing genomic search producer', () => {
  it('runs real workers for overlapping IUPAC motifs, reverse complements and bounded mismatches', async () => {
    assert.deepEqual(positions(await runTerminalSearch(request({ mode: 'motif' }), signal())),
      [[0, 3, '+'], [1, 4, '+'], [2, 5, '+'], [5, 8, '-']]);
    assert.deepEqual(positions(await runTerminalSearch(request({ mode: 'motif', sequence: 'AAAGAG', query: 'AR', options: { strand: '+' } }), signal())),
      [[0, 2, '+'], [1, 3, '+'], [2, 4, '+'], [4, 6, '+']]);
    assert.deepEqual(positions(await runTerminalSearch(request({ sequence: 'ACTATTT', query: 'ACG', options: { mismatches: 1, strand: '+' } }), signal())), [[0, 3, '+']]);
    await assert.rejects(runTerminalSearch(request({ mode: 'motif', query: 'A.*A' }), signal()), /IUPAC DNA/);
  });

  it('preserves feature identities and half-open position semantics through the native worker', async () => {
    const features = [{ id: 41, start: 0, end: 3, name: 'first', type: 'CDS' },
      { id: 42, start: 3, end: 6, name: 'terL', product: 'terminase', type: 'CDS', strand: '-' }];
    const gene = await runTerminalSearch(request({ mode: 'gene', query: 'trL', features, options: { fuzzy: true } }), signal());
    assert.deepEqual(gene.hits.map(hit => hit.feature?.id), [42]);
    assert.deepEqual(positions(gene), [[3, 6, '-']]);
    const feature = await runTerminalSearch(request({ mode: 'feature', query: 'CDS', features }), signal());
    assert.deepEqual(feature.hits.map(hit => hit.feature?.id), [41, 42]);
    const position = await runTerminalSearch(request({ mode: 'position', query: '3,7', features }), signal());
    assert.deepEqual(positions(position), [[3, 6, '-'], [7, 8, '+']]);
    assert.equal(position.hits[0].feature?.id, 42);
    await assert.rejects(runTerminalSearch(request({ mode: 'position', query: '8', features }), signal()), /within/);
  });

  it('caps results and rejects oversized input before creating any worker', async () => {
    const result = await runTerminalSearch(request({ sequence: 'A'.repeat(1000), query: 'A', options: { strand: '+' } }), signal());
    assert.equal(result.hits.length, 500); assert.equal(result.hits[499].position, 499);
    let workers = 0;
    const forbidden = () => { workers++; throw new Error('must not start'); };
    for (const invalid of [request({ query: '' }), request({ query: 'A'.repeat(10001) }),
      request({ sequence: 'A'.repeat(5000001) }), request({ options: { maxResults: 501 } })]) {
      await assert.rejects(runTerminalSearch(invalid, signal(), 100, forbidden));
    }
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(runTerminalSearch(request(), aborted.signal, 100, forbidden), { name: 'AbortError' });
    assert.equal(workers, 0);
  });

  it('rejects malformed real-worker replies and terminates stalled work on deadline or cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phage-search-transport-'));
    const malformed = join(directory, 'malformed.ts'), stalled = join(directory, 'stalled.ts');
    await writeFile(malformed, `import * as Comlink from ${JSON.stringify(import.meta.resolve('comlink'))}; Comlink.expose({ runSearch: async () => null });`, { flag: 'wx' });
    await writeFile(stalled, 'self.onmessage = () => {};', { flag: 'wx' });
    await assert.rejects(runTerminalSearch(request(), signal(), 2000,
      () => new Worker(pathToFileURL(malformed), { type: 'module' })), /mismatched or invalid/);
    let terminated = 0;
    const spawn = () => {
      const worker = new Worker(pathToFileURL(stalled), { type: 'module' }), terminate = worker.terminate.bind(worker);
      worker.terminate = () => { terminated++; terminate(); };
      return worker;
    };
    await assert.rejects(runTerminalSearch(request(), signal(), 25, spawn), /timed out/);
    const controller = new AbortController(), pending = runTerminalSearch(request(), controller.signal, 2000, spawn);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(terminated, 2);
  });
});

describe('complete native search inputs', () => {
  it('reads annotations and complete bases from the repository, preserving their exact IDs', async () => {
    const calls: unknown[][] = [];
    const repository = {
      getFullGenomeLength: async (id: number) => { calls.push(['length', id]); return 8; },
      getSequenceWindow: async (...args: unknown[]) => { calls.push(['sequence', ...args]); return 'AAAAATTT'; },
      getGenes: async (id: number) => { calls.push(['genes', id]); return [{ id: 29, name: 'capsidA', locusTag: 'LOC_29',
        product: 'capsid', startPos: 3, endPos: 6, strand: '-', type: 'CDS' }]; },
    } as unknown as PhageRepository;
    const source = await loadTerminalSearchSource(repository, -12, signal());
    assert.deepEqual(calls, [['length', -12], ['sequence', -12, 0, 8], ['genes', -12]]);
    assert.deepEqual(source, { sequence: 'AAAAATTT', features: [{ id: 29, name: 'capsidA (LOC_29)', product: 'capsid',
      start: 3, end: 6, strand: '-', type: 'CDS' }] });
    const byLocus = await runTerminalSearch(request({ ...source, mode: 'gene', query: 'LOC_29' }), signal());
    assert.deepEqual(byLocus.hits.map(hit => hit.feature?.id), [29]);
  });

  it('rejects missing, oversized and incomplete inputs without reporting successful empty search', async () => {
    let sequenceReads = 0;
    const repository = { getFullGenomeLength: async () => 0,
      getSequenceWindow: async () => { sequenceReads++; return 'AAA'; }, getGenes: async () => [] } as unknown as PhageRepository;
    for (const length of [0, -1, 5000001, 8.5]) {
      repository.getFullGenomeLength = async () => length;
      await assert.rejects(loadTerminalSearchSource(repository, 1, signal()), /complete genome/);
    }
    assert.equal(sequenceReads, 0);
    repository.getFullGenomeLength = async () => 8;
    await assert.rejects(loadTerminalSearchSource(repository, 1, signal()), /complete genome could not be read/);
  });

  it('cancels pending repository reads promptly and never starts a late sequence read', async () => {
    let finish!: (length: number) => void, sequenceReads = 0;
    const waiting = new Promise<number>(resolve => { finish = resolve; });
    const repository = { getFullGenomeLength: () => waiting,
      getSequenceWindow: async () => { sequenceReads++; return 'AAAAATTT'; }, getGenes: async () => [] } as unknown as PhageRepository;
    const controller = new AbortController(), pending = loadTerminalSearchSource(repository, 1, controller.signal);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    finish(8); await Promise.resolve(); assert.equal(sequenceReads, 0);
    repository.getFullGenomeLength = () => new Promise(() => {});
    await assert.rejects(loadTerminalSearchSource(repository, 1, signal(), 20), /timed out/);
    assert.equal(sequenceReads, 0);
  });
});
