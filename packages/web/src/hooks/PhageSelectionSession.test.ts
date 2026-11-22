import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../db/types';
import { PhageSelectionSession, type PhageSelectionSnapshot } from './PhageSelectionSession';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function fixture(sequences = ['ACGT', 'GGCC', 'TTAA']) {
  const phages: PhageFull[] = sequences.map((sequence, index) => ({
    id: index + 1, slug: `fixture-${index + 1}`, name: `Fixture ${index + 1}`, accession: `FIXTURE_${index + 1}`,
    family: null, host: null, genomeLength: sequence.length, gcContent: null, morphology: null, lifecycle: null,
    description: null, baltimoreGroup: null, genomeType: null, pdbIds: [], genes: [], codonUsage: null, hasModel: false,
  }));
  const unexpectedRead = async (): Promise<never> => { throw new Error('Unexpected repository access in selection test.'); };
  const repository: PhageRepository = {
    listPhages: async () => phages,
    getPhageByIndex: async (index: number) => phages[index] ?? null,
    getFullGenomeLength: async (id: number) => sequences[id - 1]?.length ?? 0,
    getSequenceWindow: async (id: number, start: number, end: number) => sequences[id - 1]?.slice(start, end) ?? '',
    prefetchAround: async () => {},
    getPhageById: unexpectedRead,
    getPhageBySlug: unexpectedRead,
    getGenes: unexpectedRead,
    getCodonUsage: unexpectedRead,
    hasModel: unexpectedRead,
    getModelFrames: unexpectedRead,
    searchPhages: unexpectedRead,
    getPreference: unexpectedRead,
    setPreference: unexpectedRead,
    close: unexpectedRead,
  };
  return { repository, phages, sequences };
}

describe('complete, repository-owned genome selection', () => {
  test('publishes annotations, index and complete bases together, retaining the accepted genome while reading', async () => {
    const { repository, phages } = fixture();
    const events: PhageSelectionSnapshot[] = [];
    const session = new PhageSelectionSession(snapshot => events.push(snapshot));
    session.setRepository(repository);
    assert.equal(await session.select(0, 1), true);
    const accepted = session.getSnapshot().selection;
    const bases = deferred<string>();
    repository.getSequenceWindow = async () => bases.promise;
    const loading = session.select(1, 2);
    await tick();
    assert.equal(session.getSnapshot().selection, accepted);
    assert.equal(session.getSnapshot().pendingIndex, 1);
    assert.equal(session.navigationIndex(), 1);
    assert.ok(!events.some(event => event.selection?.phage.id === 2));
    bases.resolve('GGCC');
    assert.equal(await loading, true);
    assert.deepEqual(session.getSnapshot().selection, { index: 1, phage: phages[1], sequence: 'GGCC' });
    assert.equal(session.getSnapshot().pendingIndex, null);
    assert.equal(session.getSnapshot().error, null);
    assert.equal(events.filter(event => event.selection?.phage.id === 2).length, 1);
  });

  test('a missing target is an explicit failure; retry replaces the previous selection only after success', async () => {
    const { repository, phages } = fixture(); const session = new PhageSelectionSession();
    session.setRepository(repository); await session.select(0, 1);
    const accepted = session.getSnapshot().selection;
    repository.getPhageByIndex = async () => null;
    assert.equal(await session.select(1, 2), false);
    assert.equal(session.getSnapshot().selection, accepted);
    assert.equal(session.getSnapshot().pendingIndex, null);
    assert.equal(session.navigationIndex(), 0);
    assert.equal(session.getSnapshot().error?.index, 1);
    assert.match(session.getSnapshot().error!.message, /unavailable/);
    repository.getPhageByIndex = async index => phages[index] ?? null;
    assert.equal(await session.select(session.getSnapshot().error!.index, 2), true);
    assert.equal(session.getSnapshot().selection?.sequence, 'GGCC');
    assert.equal(session.getSnapshot().error, null);
  });

  test('offline reads preserve the exact accepted selection, including annotations and sequence', async () => {
    const { repository } = fixture(); const session = new PhageSelectionSession();
    session.setRepository(repository); await session.select(0, 1);
    const accepted = session.getSnapshot().selection;
    repository.getSequenceWindow = async () => { throw new Error('This genome has not been saved offline.'); };
    assert.equal(await session.select(1, 2), false);
    assert.equal(session.getSnapshot().selection, accepted);
    assert.equal(session.getSnapshot().pendingIndex, null);
    assert.match(session.getSnapshot().error!.message, /saved offline/);
  });

  test('never publishes truncated, overlong or invalid bases', async () => {
    for (const sequence of ['', 'AG', 'ACGTA', 'A?GT']) {
      const { repository } = fixture(); const session = new PhageSelectionSession();
      session.setRepository(repository); await session.select(0, 1);
      const accepted = session.getSnapshot().selection;
      repository.getSequenceWindow = async () => sequence;
      assert.equal(await session.select(1, 2), false);
      assert.equal(session.getSnapshot().selection, accepted);
      assert.equal(session.getSnapshot().pendingIndex, null);
      assert.match(session.getSnapshot().error!.message, /complete genome/);
    }
  });

  test('requires annotations to agree with the repository length and requested catalog identity', async () => {
    for (const length of [0, -1, 3, 4.5, Number.NaN]) {
      const { repository } = fixture(); const session = new PhageSelectionSession();
      session.setRepository(repository);
      repository.getFullGenomeLength = async () => length;
      let sequenceReads = 0;
      repository.getSequenceWindow = async () => { sequenceReads++; return 'ACGT'; };
      assert.equal(await session.select(0, 1), false);
      assert.equal(sequenceReads, 0);
      assert.equal(session.getSnapshot().selection, null);
      assert.match(session.getSnapshot().error!.message, /length disagree/);
    }
    const { repository } = fixture(); const session = new PhageSelectionSession();
    session.setRepository(repository);
    assert.equal(await session.select(0, 2), false);
    assert.match(session.getSnapshot().error!.message, /no longer matches/);
  });

  test('accepts ambiguity codes without changing the exact supplied sequence', async () => {
    const sequence = 'ACGTRYSWKMBDHVNacgt'; const { repository } = fixture([sequence]);
    const session = new PhageSelectionSession(); session.setRepository(repository);
    assert.equal(await session.select(0, 1), true);
    assert.equal(session.getSnapshot().selection?.sequence, sequence);
  });

  test('derives missing summary length from complete repository data without mutating cached annotations', async () => {
    const { repository, phages } = fixture(['ACGT']);
    phages[0].genomeLength = null;
    const session = new PhageSelectionSession(); session.setRepository(repository);
    assert.equal(await session.select(0, 1), true);
    assert.equal(session.getSnapshot().selection?.phage.genomeLength, 4);
    assert.equal(session.getSnapshot().selection?.sequence, 'ACGT');
    assert.equal(phages[0].genomeLength, null);
  });

  test('latest selection wins and superseded metadata reads settle even if the repository never answers', async () => {
    const { repository, phages } = fixture(); const stale = deferred<PhageFull | null>();
    const session = new PhageSelectionSession(); session.setRepository(repository);
    repository.getPhageByIndex = async index => index === 1 ? stale.promise : phages[index] ?? null;
    const first = session.select(1, 2);
    const last = session.select(2, 3);
    assert.equal(await first, false);
    assert.equal(await last, true);
    const accepted = session.getSnapshot().selection;
    stale.resolve(phages[1]); await tick();
    assert.equal(session.getSnapshot().selection, accepted);
    assert.equal(accepted?.index, 2);
    assert.equal(accepted?.sequence, 'TTAA');
  });

  test('replacing a repository invalidates its pending reads before the next catalog has loaded', async () => {
    const original = fixture(), replacement = fixture(['CCCC', 'AAAA', 'GGGG']);
    const delayed = deferred<string>(); const session = new PhageSelectionSession();
    session.setRepository(original.repository); await session.select(0, 1);
    original.repository.getSequenceWindow = async () => delayed.promise;
    const previous = session.select(1, 2); await tick();
    session.setRepository(replacement.repository);
    assert.equal(await previous, false);
    assert.equal(session.getSnapshot().selection, null);
    assert.equal(session.getSnapshot().pendingIndex, null);
    assert.equal(session.getSnapshot().error, null);
    assert.equal(await session.select(1, 2), true);
    const accepted = session.getSnapshot().selection;
    delayed.resolve('GGCC'); await tick();
    assert.equal(session.getSnapshot().selection, accepted);
    assert.equal(accepted?.sequence, 'AAAA');
  });

  test('late failure cannot erase a more recent accepted selection or display its error', async () => {
    const { repository, phages } = fixture(); const delayed = deferred<PhageFull | null>();
    const session = new PhageSelectionSession(); session.setRepository(repository);
    repository.getPhageByIndex = async index => index === 1 ? delayed.promise : phages[index] ?? null;
    const previous = session.select(1, 2);
    assert.equal(await session.select(2, 3), true);
    const accepted = session.getSnapshot().selection;
    delayed.reject(new Error('old request failed'));
    assert.equal(await previous, false); await tick();
    assert.equal(session.getSnapshot().selection, accepted);
    assert.equal(session.getSnapshot().error, null);
  });

  test('cancellation settles a stalled request and clears loading without discarding the displayed genome', async () => {
    const { repository } = fixture(); const session = new PhageSelectionSession();
    session.setRepository(repository); await session.select(0, 1);
    const accepted = session.getSnapshot().selection;
    repository.getFullGenomeLength = async () => new Promise<number>(() => {});
    const pending = session.select(1, 2); await tick(); session.cancel();
    assert.equal(await pending, false);
    assert.equal(session.getSnapshot().selection, accepted);
    assert.equal(session.getSnapshot().pendingIndex, null);
    session.setRepository(null);
    assert.equal(await session.select(0, 1), false);
    assert.equal(session.getSnapshot().selection, null);
  });

  test('annotation objects are captured before asynchronous sequence reads', async () => {
    const { repository, phages } = fixture(); const bases = deferred<string>();
    const session = new PhageSelectionSession(); session.setRepository(repository);
    repository.getSequenceWindow = async () => bases.promise;
    const pending = session.select(0, 1); await tick();
    phages[0].name = 'Mutated cache entry';
    phages[0].genes.push({ id: 42, name: null, locusTag: null, product: null, type: 'CDS', startPos: 0, endPos: 3, strand: '+' });
    bases.resolve('ACGT'); assert.equal(await pending, true);
    assert.equal(session.getSnapshot().selection?.phage.name, 'Fixture 1');
    assert.deepEqual(session.getSnapshot().selection?.phage.genes, []);
  });

  test('optional prefetch failures do not turn successful selections into errors', async () => {
    const { repository } = fixture(); const session = new PhageSelectionSession();
    repository.prefetchAround = async () => { throw new Error('neighbor is offline'); };
    session.setRepository(repository); assert.equal(await session.select(0, 1), true);
    await tick(); assert.equal(session.getSnapshot().error, null);
    assert.equal(session.getSnapshot().selection?.sequence, 'ACGT');
  });
});
