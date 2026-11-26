import { afterEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageFull } from '@phage-explorer/core';
import { importLocalGenomes } from '../../../core/src/genome-import';
import { parseSavedViews, serializeSavedViews } from '../../../core/src/saved-views';
import { terminalViewSource, parseTerminalViews, serializeTerminalViews } from '../../../tui/src/terminal-navigation-session';
import type { PhageRepository } from '../db/types';
import { PhageSelectionSession } from './PhageSelectionSession';
import { BrowserNavigationSession, browserViewSource, readSavedViewsFile, type BrowserNavigationRuntime } from './BrowserNavigationSession';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await tick();
  assert.ok(check(), 'Expected the navigation session to settle.');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(runtime: BrowserNavigationRuntime = {}, local = false) {
  const previous = usePhageStore.getState();
  const sequences = ['ACGT'.repeat(30), 'TTGGCCAA'.repeat(15)];
  let phages: PhageFull[] = sequences.map((sequence, index) => ({
    id: index + 1, slug: `view-${index + 1}`, name: `View source ${index + 1}`, accession: `VIEW_${index + 1}`,
    family: null, host: null, genomeLength: sequence.length, gcContent: null, morphology: null, lifecycle: null,
    description: null, baltimoreGroup: null, genomeType: null, pdbIds: [], codonUsage: null, hasModel: false,
    genes: [{ id: 7, name: 'original', locusTag: null, product: null, type: 'CDS', startPos: 0, endPos: 18, strand: '-' }],
  }));
  if (local) phages = (await importLocalGenomes({ name: 'views.fasta', text: sequences.map((sequence, index) => `>VIEW_${index + 1}\n${sequence}`).join('\n') })).genomes.map(genome => genome.phage);
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected repository access.'); };
  const repository: PhageRepository = {
    listPhages: async () => phages,
    getPhageByIndex: async index => phages[index] ?? null,
    getFullGenomeLength: async id => sequences[phages.findIndex(phage => phage.id === id)]?.length ?? 0,
    getSequenceWindow: async (id, start, end) => sequences[phages.findIndex(phage => phage.id === id)]?.slice(start, end) ?? '',
    prefetchAround: async () => {}, getPhageById: unexpected, getPhageBySlug: unexpected, getGenes: unexpected,
    getCodonUsage: unexpected, hasModel: unexpected, getModelFrames: unexpected, searchPhages: unexpected,
    getPreference: unexpected, setPreference: unexpected, close: async () => {},
  };
  usePhageStore.setState({ phages, currentPhage: null, currentPhageIndex: 0, isLoadingPhage: false,
    viewMode: 'dna', readingFrame: 0, scrollPosition: 0, selectedGeneId: null, error: null });
  const selection = new PhageSelectionSession((next, prior) => usePhageStore.setState({
    currentPhage: next.selection?.phage ?? null, currentPhageIndex: next.selection?.index ?? 0,
    isLoadingPhage: next.pendingIndex !== null, error: next.error?.message ?? null,
    ...(next.selection !== prior.selection ? { scrollPosition: 0, selectedGeneId: null } : {}),
  }));
  selection.setRepository(repository);
  const session = new BrowserNavigationSession(selection, runtime), disconnect = session.connect();
  cleanups.push(() => { disconnect(); selection.cancel(); usePhageStore.setState(previous); });
  const select = async (index: number) => {
    assert.equal(await selection.select(index, phages[index].id), true);
    await until(() => session.getSnapshot().ready);
  };
  await select(0);
  return { session, selection, repository, phages, sequences, select };
}

describe('ordinary browser navigation and portable named views', () => {
  test('restores exact cross-genome AA/frame/gene views, undo/redo, and invalidates the forward branch on new navigation', async () => {
    const f = await fixture();
    usePhageStore.setState({ viewMode: 'aa', readingFrame: -2, scrollPosition: 17, selectedGeneId: 7 }); await tick();
    assert.equal(f.session.saveCurrent('Reverse frame'), true);
    await f.select(1);
    const count = f.session.getSnapshot().history.length;
    assert.equal(await f.session.moveHistory(-1), true);
    assert.equal(usePhageStore.getState().currentPhage?.accession, 'VIEW_1');
    assert.equal(usePhageStore.getState().viewMode, 'aa');
    assert.equal(usePhageStore.getState().readingFrame, -2);
    assert.equal(usePhageStore.getState().scrollPosition, 17);
    assert.equal(usePhageStore.getState().selectedGeneId, 7);
    assert.equal(f.session.getSnapshot().history.length, count);
    assert.equal(await f.session.moveHistory(1), true);
    assert.equal(usePhageStore.getState().currentPhage?.accession, 'VIEW_2');
    assert.equal(await f.session.restoreNamed('Reverse frame'), true);
    assert.equal(usePhageStore.getState().selectedGeneId, 7);
    assert.equal(await f.session.moveHistory(-1), true);
    usePhageStore.setState({ scrollPosition: 9 }); await tick();
    assert.equal(await f.session.moveHistory(1), false);
    assert.equal(usePhageStore.getState().scrollPosition, 9);
  });

  test('Back after restoring a named view returns to its departure in one step', async () => {
    const f = await fixture();
    usePhageStore.setState({ scrollPosition: 12 }); await tick();
    assert.equal(f.session.saveCurrent('Bookmarked'), true);
    await f.select(1);
    const departure = f.session.getSnapshot().historyIndex;
    assert.equal(await f.session.restoreNamed('Bookmarked'), true);
    assert.equal(usePhageStore.getState().scrollPosition, 12);
    assert.equal(await f.session.moveHistory(-1), true);
    assert.equal(f.session.getSnapshot().historyIndex, departure);
    assert.equal(usePhageStore.getState().currentPhage?.accession, 'VIEW_2');
    assert.equal(await f.session.moveHistory(1), true);
    assert.equal(usePhageStore.getState().scrollPosition, 12);
  });

  test('jumps past an unavailable intermediate source and rejects discarded history rows', async () => {
    const f = await fixture();
    usePhageStore.setState({ scrollPosition: 14 }); await tick();
    const earlier = f.session.getSnapshot().history.at(-1)!;
    await f.select(1);
    const intermediate = f.session.getSnapshot().history.at(-1)!;
    await f.select(0);
    const count = f.session.getSnapshot().history.length;
    f.sequences[1] = 'A'.repeat(120);
    assert.equal(await f.session.moveHistory(-1), false);
    assert.match(f.session.getSnapshot().error!, /bases or annotations have changed/);
    assert.equal(await f.session.restoreHistory(earlier), true);
    assert.equal(usePhageStore.getState().scrollPosition, 14);
    assert.equal(f.session.getSnapshot().history.length, count);
    assert.equal(f.session.getSnapshot().history[f.session.getSnapshot().historyIndex], earlier);
    usePhageStore.setState({ scrollPosition: 25 }); await tick();
    assert.equal(await f.session.restoreHistory(intermediate), false);
    assert.match(f.session.getSnapshot().error!, /no longer available/);
    assert.equal(usePhageStore.getState().scrollPosition, 25);
    assert.equal(usePhageStore.getState().currentPhage?.accession, 'VIEW_1');
  });

  test('coalesces scrolling while retaining the departure view and bounds history to 64 entries', async () => {
    let now = 0;
    const f = await fixture({ now: () => now });
    for (let position = 1; position <= 20; position++) {
      now += 10; usePhageStore.setState({ scrollPosition: position }); await tick();
    }
    assert.equal(f.session.getSnapshot().history.length, 2);
    assert.equal(f.session.getSnapshot().history[0].view.scrollPosition, 0);
    assert.equal(f.session.getSnapshot().history[1].view.scrollPosition, 20);
    for (let position = 21; position < 100; position++) {
      now += 400; usePhageStore.setState({ scrollPosition: position }); await tick();
    }
    assert.equal(f.session.getSnapshot().history.length, 64);
    assert.equal(f.session.getSnapshot().historyIndex, 63);
  });

  test('browser and terminal share byte-compatible files and sequence/annotation identities', async () => {
    const f = await fixture();
    const selected = f.selection.getSnapshot().selection!;
    assert.deepEqual(await browserViewSource(selected), terminalViewSource(selected.phage, selected.sequence));
    assert.equal(f.session.saveCurrent('Portable'), true);
    const content = f.session.export();
    assert.equal(serializeTerminalViews(parseTerminalViews(content).views), content);
    assert.equal(serializeSavedViews(parseSavedViews(content).views), content);
    assert.ok(!content.includes(f.sequences[0]));
    f.session.forget('Portable'); f.session.import(content); f.session.import(content);
    assert.equal(f.session.getSnapshot().saved.length, 1);
    assert.equal(f.session.rename('Portable', 'Renamed'), true);
    assert.equal(f.session.saveCurrent('Renamed'), false);
    assert.match(f.session.getSnapshot().error!, /already uses/);
  });

  test('requires exact local inputs and preserves selection on missing source or changed catalog bases/annotations', async () => {
    const local = await fixture({}, true);
    assert.equal(local.session.saveCurrent('Private'), true);
    const portable = local.session.export();
    const f = await fixture(); f.session.import(portable);
    const initial = f.selection.getSnapshot().selection;
    assert.equal(await f.session.restoreNamed('Private'), false);
    assert.match(f.session.getSnapshot().error!, /exact original local genome/);
    assert.equal(f.selection.getSnapshot().selection, initial);
    assert.equal(f.session.saveCurrent('Catalog'), true);
    await f.select(1);
    const departure = f.selection.getSnapshot().selection;
    f.sequences[0] = 'T' + f.sequences[0].slice(1);
    assert.equal(await f.session.restoreNamed('Catalog'), false);
    assert.match(f.session.getSnapshot().error!, /bases or annotations have changed/);
    assert.equal(f.selection.getSnapshot().selection, departure);
    f.sequences[0] = 'A' + f.sequences[0].slice(1);
    f.phages[0].genes[0].name = 'Changed annotation';
    assert.equal(await f.session.restoreNamed('Catalog'), false);
    assert.equal(f.selection.getSnapshot().selection, departure);
  });

  test('catalog renumbering is accepted through stable accession/slug while exact contents remain required', async () => {
    const f = await fixture(); f.session.saveCurrent('Original'); await f.select(1);
    f.phages[0] = { ...f.phages[0], id: 99 };
    usePhageStore.setState({ phages: [...f.phages] });
    assert.equal(await f.session.restoreNamed('Original'), true);
    assert.equal(usePhageStore.getState().currentPhage?.id, 99);
  });

  test('cancels a stalled restore on user navigation; a late source cannot overwrite the user view', async () => {
    const f = await fixture(); f.session.saveCurrent('Original'); await f.select(1);
    const departure = f.selection.getSnapshot().selection, read = deferred<PhageFull | null>();
    f.repository.getPhageByIndex = async () => read.promise;
    const restoring = f.session.restoreNamed('Original'); await tick();
    usePhageStore.setState({ scrollPosition: 22, readingFrame: -1 });
    assert.equal(await restoring, false);
    assert.equal(f.session.getSnapshot().busy, false);
    read.resolve(f.phages[0]); await tick();
    assert.equal(f.selection.getSnapshot().selection, departure);
    assert.equal(usePhageStore.getState().scrollPosition, 22);
    assert.equal(usePhageStore.getState().readingFrame, -1);
  });

  test('protects user position/frame/gene edits while the accepted selection is waiting for layout effects', async () => {
    for (const edit of [{ scrollPosition: 12 }, { readingFrame: -3 as const }, { selectedGeneId: 7 }, { viewMode: 'dual' as const }]) {
      const layout = deferred<void>();
      const f = await fixture({ settle: () => layout.promise });
      usePhageStore.setState({ viewMode: 'aa', scrollPosition: 5, readingFrame: -2, selectedGeneId: 7 }); await tick();
      f.session.saveCurrent('Original'); await f.select(1);
      const restoring = f.session.restoreNamed('Original');
      await until(() => f.selection.getSnapshot().selection?.phage.id === f.phages[0].id);
      usePhageStore.setState(edit);
      assert.equal(await restoring, false);
      layout.resolve(); await tick();
      for (const [key, value] of Object.entries(edit)) assert.equal(usePhageStore.getState()[key as keyof ReturnType<typeof usePhageStore.getState>], value);
      assert.equal(f.session.getSnapshot().busy, false);
    }
  });

  test('timeout and repository/list replacement settle ignored providers and leave the previous selection intact', async () => {
    for (const change of ['timeout', 'list', 'repository'] as const) {
      const f = await fixture({ timeoutMs: 15 }); f.session.saveCurrent('Original'); await f.select(1);
      const departure = f.selection.getSnapshot().selection;
      f.repository.getPhageByIndex = () => new Promise(() => {});
      const restoring = f.session.restoreNamed('Original');
      if (change === 'list') usePhageStore.setState({ phages: [...f.phages] });
      if (change === 'repository') f.selection.setRepository({ ...f.repository });
      assert.equal(await restoring, false);
      assert.equal(f.session.getSnapshot().busy, false);
      if (change !== 'repository') assert.equal(f.selection.getSnapshot().selection, departure);
      if (change === 'timeout') assert.match(f.session.getSnapshot().error!, /timed out/);
    }
  });

  test('rejects damaged collections and conflicting names atomically and bounds file reads before decoding', async () => {
    const f = await fixture(); f.session.saveCurrent('Original');
    const original = f.session.export(), changed = JSON.parse(original);
    changed.views[0].view.scrollPosition = 4;
    assert.throws(() => f.session.import(JSON.stringify(changed)), /existing name/);
    assert.equal(f.session.export(), original);
    changed.views[0].view.scrollPosition = 120;
    assert.throws(() => f.session.import(JSON.stringify(changed)), /outside/);
    changed.views[0].view.scrollPosition = 0; changed.views[0].view.geneId = 0;
    assert.throws(() => f.session.import(JSON.stringify(changed)), /outside/);
    changed.views[0].view.geneId = null; changed.views[0].extra = 'unsupported';
    assert.throws(() => f.session.import(JSON.stringify(changed)), /Unsupported/);
    const signal = new AbortController();
    await assert.rejects(readSavedViewsFile({ size: 1024 * 1024 + 1, arrayBuffer: async () => { throw new Error('Must not read'); } }, signal.signal), /1 MiB/);
    await assert.rejects(readSavedViewsFile({ size: 2, arrayBuffer: async () => Uint8Array.of(0xc3, 0x28).buffer }, signal.signal), /UTF-8/);
    const hanging = readSavedViewsFile({ size: 10, arrayBuffer: () => new Promise(() => {}) }, signal.signal);
    signal.abort(); await assert.rejects(hanging, { name: 'AbortError' });
  });
});
