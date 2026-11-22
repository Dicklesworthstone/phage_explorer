import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usePhageStore } from '@phage-explorer/state';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { createLocalGenomeRepository } from '../../db-runtime/src/local-genomes';
import type { PhageRepository } from '../../db-runtime/src/types';
import type { PhageFull } from '../../core/src/types';
import { TerminalNavigationSession, parseTerminalViews, serializeTerminalViews, TERMINAL_VIEW_LIMITS } from './terminal-navigation-session';

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
const joined = [
  'LOCUS       specimen                  18 bp    DNA     linear',
  'ACCESSION   PRIVATE.1', 'FEATURES             Location/Qualifiers',
  '     CDS             complement(join(1..6,13..18))', '                     /gene="reverse_join"',
  'ORIGIN', '        1 atgaaacccgggtttcat', '//', '',
].join('\n');
async function fixture(catalog = false, runtime: ConstructorParameters<typeof TerminalNavigationSession>[1] = {}, autoLoad = true) {
  const previous = usePhageStore.getState();
  const imported = await importLocalGenomes({ name: 'inputs.json', text: JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1,
    inputs: [{ name: 'private.gb', text: joined }, { name: 'other.fa', text: '>other\nAACCGGTTAACCGGTTAA' }] }) });
  const genomes = imported.genomes.map((genome, index) => catalog ? { ...genome,
    phage: { ...genome.phage, localGenome: undefined, id: index + 7, slug: `catalog-${index}` } } : genome);
  let repository = createLocalGenomeRepository(null, imported.genomes);
  if (catalog) repository = new Proxy(repository, { get(target, key) {
    if (key === 'getPhageById') return async (id: number) => genomes.find(genome => genome.phage.id === id)?.phage ?? null;
    if (key === 'getFullGenomeLength') return async (id: number) => genomes.find(genome => genome.phage.id === id)?.sequence.length ?? 0;
    if (key === 'getSequenceWindow') return async (id: number, start: number, end: number) => genomes.find(genome => genome.phage.id === id)?.sequence.slice(start, end) ?? '';
    return Reflect.get(target, key);
  } });
  const phages = genomes.map(genome => genome.phage);
  usePhageStore.setState({ phages, currentPhageIndex: 0, currentPhage: phages[0], isLoadingPhage: false,
    viewMode: 'dna', readingFrame: 0, scrollPosition: 0, selectedGeneId: null, overlays: [], error: null });
  const session = new TerminalNavigationSession(() => repository, runtime), disconnect = session.connect();
  const accept = async (index: number) => {
    const genome = genomes[index];
    usePhageStore.setState({ currentPhageIndex: index, currentPhage: genome.phage, isLoadingPhage: false, scrollPosition: 0, selectedGeneId: null });
    session.acceptSource({ repository, phages: usePhageStore.getState().phages, index, phage: genome.phage, sequence: genome.sequence });
    await tick();
  };
  const loader = usePhageStore.subscribe(state => {
    if (!autoLoad) return;
    if (!state.isLoadingPhage || state.currentPhage !== null) return;
    const prepared = session.takePreparedSource(repository, state.phages, state.currentPhageIndex);
    if (!prepared) return;
    queueMicrotask(() => {
      if (session.takePreparedSource(repository, state.phages, state.currentPhageIndex) !== prepared) return;
      usePhageStore.setState({ currentPhage: prepared.phage });
      session.acceptSource(prepared);
    });
  });
  await accept(0);
  return { session, genomes, imported, accept, repository: () => repository,
    replaceRepository: (value: PhageRepository) => { repository = value; },
    close: async () => { loader(); disconnect(); await repository.close(); usePhageStore.setState(previous); } };
}

describe('ordinary terminal navigation and durable named views', () => {
  it('restores a joined CDS and reverse AA view across genomes, with no restore loops and correct branching', async () => {
    const f = await fixture();
    try {
      usePhageStore.setState({ viewMode: 'aa', readingFrame: -2, scrollPosition: 3, selectedGeneId: f.genomes[0].phage.genes[0].id });
      await tick();
      const selected = usePhageStore.getState().selectedGeneId;
      await f.accept(1);
      const count = f.session.getSnapshot().history.length;
      assert.equal(await f.session.moveHistory(-1), true);
      const back = usePhageStore.getState();
      assert.equal(back.currentPhage?.accession, 'PRIVATE.1'); assert.equal(back.viewMode, 'aa');
      assert.equal(back.readingFrame, -2); assert.equal(back.scrollPosition, 3); assert.equal(back.selectedGeneId, selected);
      assert.deepEqual(back.currentPhage?.genes[0].qualifiers?._segments,
        [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }]);
      assert.equal(f.session.getSnapshot().history.length, count);
      assert.equal(await f.session.moveHistory(1), true);
      assert.equal(usePhageStore.getState().currentPhage?.name, 'other');
      assert.equal(f.session.getSnapshot().history.length, count);
      assert.equal(await f.session.moveHistory(-1), true);
      usePhageStore.setState({ scrollPosition: 1 }); await tick();
      assert.equal(await f.session.moveHistory(1), false);
      assert.match(f.session.getSnapshot().error!, /No later/);
      assert.equal(usePhageStore.getState().scrollPosition, 1);
    } finally { await f.close(); }
  });

  it('coalesces held-arrow scrolling while retaining the departure view and a bounded trail', async () => {
    let now = 1000; const f = await fixture(false, { now: () => now });
    try {
      for (const position of [1, 2, 3, 4]) { now += 20; usePhageStore.setState({ scrollPosition: position }); await tick(); }
      assert.equal(f.session.getSnapshot().history.length, 2);
      assert.equal(await f.session.moveHistory(-1), true); assert.equal(usePhageStore.getState().scrollPosition, 0);
      assert.equal(await f.session.moveHistory(1), true); assert.equal(usePhageStore.getState().scrollPosition, 4);
      for (let i = 0; i < 80; i++) {
        now += 500; usePhageStore.setState({ scrollPosition: i % 18 }); await tick();
      }
      assert.equal(f.session.getSnapshot().history.length, TERMINAL_VIEW_LIMITS.history);
      assert.equal(await f.session.moveHistory(-1), true);
      assert.equal(usePhageStore.getState().scrollPosition, 78 % 18);
    } finally { await f.close(); }
  });

  it('exports/reopens named views across sessions and requires the exact local input before restoration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phage-named-view-'));
    const destination = join(directory, 'views.json');
    const f = await fixture();
    let content = '', bundle = '';
    try {
      usePhageStore.setState({ viewMode: 'aa', readingFrame: -3, scrollPosition: 4, selectedGeneId: f.genomes[0].phage.genes[0].id });
      f.session.saveCurrent('Joined reverse CDS');
      assert.equal(await f.session.save(destination), true);
      content = await readFile(destination, 'utf8'); bundle = exportLocalGenomeBundle(f.imported.genomes);
      assert.ok(!content.includes(f.genomes[0].sequence), 'view files contain fingerprints, not private bases');
      assert.equal(await f.session.save(destination), false);
      assert.equal(await readFile(destination, 'utf8'), content, 'existing files must not be overwritten');
    } finally { await f.close(); }
    const fresh = await fixture();
    try {
      assert.equal(await fresh.session.open(destination), true);
      await fresh.accept(1);
      usePhageStore.setState({ phages: [fresh.genomes[1].phage], currentPhageIndex: 0 });
      assert.equal(await fresh.session.restoreSaved(0), false);
      assert.match(fresh.session.getSnapshot().error!, /Missing local genome.*original.*bundle/);
      assert.equal(usePhageStore.getState().currentPhage?.name, 'other');
      const reimported = await importLocalGenomes({ name: 'inputs.json', text: bundle });
      fresh.replaceRepository(createLocalGenomeRepository(null, reimported.genomes));
      usePhageStore.setState({ phages: reimported.genomes.map(genome => genome.phage), currentPhageIndex: 1 });
      assert.equal(await fresh.session.restoreSaved(0), true);
      const restored = usePhageStore.getState();
      assert.equal(restored.currentPhage?.localGenome?.contentId, reimported.genomes[0].phage.localGenome?.contentId);
      assert.equal(restored.selectedGeneId, reimported.genomes[0].phage.genes[0].id);
      assert.equal(restored.viewMode, 'aa'); assert.equal(restored.readingFrame, -3); assert.equal(restored.scrollPosition, 4);
    } finally { await fresh.close(); }
  });

  it('resolves a rebuilt catalog by stable identity, but rejects changed bases or annotations under the same accession', async () => {
    const f = await fixture(true);
    try {
      usePhageStore.setState({ scrollPosition: 4 }); f.session.saveCurrent('Catalog locus');
      await f.accept(1);
      f.genomes[0].phage = { ...f.genomes[0].phage, id: 70 };
      usePhageStore.setState({ phages: f.genomes.map(genome => genome.phage) });
      assert.equal(await f.session.restoreSaved(0), true);
      assert.equal(usePhageStore.getState().currentPhage?.id, 70);
      assert.equal(usePhageStore.getState().scrollPosition, 4);
      await f.accept(1);
      const original = f.genomes[0].sequence;
      f.genomes[0].sequence = 'C' + original.slice(1);
      assert.equal(await f.session.restoreSaved(0), false);
      assert.match(f.session.getSnapshot().error!, /bases or annotations changed/);
      assert.equal(usePhageStore.getState().currentPhage?.name, 'other');
      f.genomes[0].sequence = original;
      f.genomes[0].phage = { ...f.genomes[0].phage, genes: [{ ...f.genomes[0].phage.genes[0], product: 'changed annotation' }] };
      assert.equal(await f.session.restoreSaved(0), false);
      assert.match(f.session.getSnapshot().error!, /bases or annotations changed/);
    } finally { await f.close(); }
  });

  it('a later coordinate selection cancels a pending restore before any sequence read, and a late read cannot take control', async () => {
    const f = await fixture(true);
    try {
      f.session.saveCurrent('First'); await f.accept(1);
      let resolveLength!: (value: number) => void, sequenceReads = 0;
      const length = new Promise<number>(resolve => { resolveLength = resolve; }), original = f.repository();
      f.replaceRepository(new Proxy(original, { get(target, key) {
        if (key === 'getFullGenomeLength') return () => length;
        if (key === 'getSequenceWindow') return () => { sequenceReads++; return Promise.resolve(f.genomes[0].sequence); };
        return Reflect.get(target, key);
      } }));
      const pending = f.session.restoreSaved(0); await tick(); await tick();
      usePhageStore.setState({ scrollPosition: 5 });
      assert.equal(await pending, false);
      resolveLength(18); await tick(); await tick();
      assert.equal(sequenceReads, 0); assert.equal(usePhageStore.getState().scrollPosition, 5);
      assert.equal(usePhageStore.getState().currentPhage?.name, 'other');
      assert.match(f.session.getSnapshot().notice!, /Navigation changed/);
    } finally { await f.close(); }
  });

  it('same-ID list replacement and timeouts settle pending navigation without accepting a stale source', async () => {
    const f = await fixture(true, { timeoutMs: 30 });
    try {
      f.session.saveCurrent('First'); await f.accept(1);
      const original = f.repository();
      f.replaceRepository(new Proxy(original, { get(target, key) {
        if (key === 'getFullGenomeLength') return () => new Promise<number>(() => {});
        return Reflect.get(target, key);
      } }));
      const pending = f.session.restoreSaved(0); await tick();
      usePhageStore.setState({ phages: [...usePhageStore.getState().phages] });
      assert.equal(await pending, false); assert.equal(f.session.getSnapshot().busy, null);
      assert.equal(await f.session.restoreSaved(0), false);
      assert.match(f.session.getSnapshot().notice!, /timed out/);
      assert.equal(f.session.getSnapshot().busy, null);
      assert.equal(usePhageStore.getState().currentPhage?.name, 'other');
    } finally { await f.close(); }
  });

  it('cancels a prepared source before loader acknowledgement and restores the departure view', async () => {
    const f = await fixture(false, {}, false);
    try {
      usePhageStore.setState({ viewMode: 'aa', readingFrame: -2, scrollPosition: 3, selectedGeneId: f.genomes[0].phage.genes[0].id });
      f.session.saveCurrent('Joined reverse CDS');
      await f.accept(1);
      usePhageStore.setState({ viewMode: 'dual', readingFrame: 1, scrollPosition: 5 });
      await tick();
      const departure = usePhageStore.getState(), history = f.session.getSnapshot().history;
      const historyIndex = f.session.getSnapshot().historyIndex;
      const pending = f.session.restoreSaved(0);
      for (let attempt = 0; attempt < 20 && !usePhageStore.getState().isLoadingPhage; attempt++) await tick();
      const loading = usePhageStore.getState();
      const prepared = f.session.takePreparedSource(f.repository(), loading.phages, loading.currentPhageIndex);
      assert.ok(prepared, 'the complete target source is prepared but has not been acknowledged');
      assert.equal(loading.currentPhage, null);
      assert.equal(loading.currentPhageIndex, 0);
      f.session.cancel();
      assert.equal(await pending, false);
      assert.equal(f.session.getSnapshot().busy, null);
      const restored = usePhageStore.getState();
      assert.equal(restored.currentPhage, departure.currentPhage);
      assert.equal(restored.currentPhageIndex, 1);
      assert.equal(restored.isLoadingPhage, false);
      assert.equal(restored.viewMode, 'dual');
      assert.equal(restored.readingFrame, 1);
      assert.equal(restored.scrollPosition, 5);
      assert.equal(restored.selectedGeneId, null);
      assert.equal(f.session.takePreparedSource(f.repository(), loading.phages, 0), null);
      f.session.acceptSource(prepared);
      await tick();
      assert.equal(usePhageStore.getState().currentPhage, departure.currentPhage, 'a late acknowledgement cannot select its old target');
      assert.deepEqual(f.session.getSnapshot().history, history);
      assert.equal(f.session.getSnapshot().historyIndex, historyIndex);
    } finally { await f.close(); }
  });

  it('rejects incomplete source reads and unavailable genes before changing selection', async () => {
    const f = await fixture(true);
    try {
      f.session.saveCurrent('Catalog'); await f.accept(1);
      const original = f.repository();
      f.replaceRepository(new Proxy(original, { get(target, key) {
        if (key === 'getSequenceWindow') return async () => f.genomes[0].sequence.slice(1);
        return Reflect.get(target, key);
      } }));
      assert.equal(await f.session.restoreSaved(0), false);
      assert.match(f.session.getSnapshot().error!, /complete genome/);
      assert.equal(usePhageStore.getState().currentPhage?.name, 'other');
      f.replaceRepository(original);
      const collection = JSON.parse(serializeTerminalViews(f.session.getSnapshot().saved));
      collection.views[0].name = 'Missing gene'; collection.views[0].view.geneId = 49999;
      const directory = await mkdtemp(join(tmpdir(), 'phage-missing-feature-')), path = join(directory, 'views.json');
      await writeFile(path, JSON.stringify(collection));
      assert.equal(await f.session.open(path), true);
      assert.equal(await f.session.restoreSaved(1), false);
      assert.match(f.session.getSnapshot().error!, /saved gene is unavailable/);
      assert.equal(usePhageStore.getState().currentPhage?.name, 'other');
    } finally { await f.close(); }
  });

  it('validates all imported view schemas and preserves prior names on a conflicting import', async () => {
    const f = await fixture();
    try {
      f.session.saveCurrent('Saved');
      const original = serializeTerminalViews(f.session.getSnapshot().saved), parsed = JSON.parse(original);
      assert.deepEqual(parseTerminalViews(original).views, f.session.getSnapshot().saved);
      for (const change of [
        (v: any) => { v.version = 2; }, (v: any) => { v.views[0].view.viewMode = ['dna']; },
        (v: any) => { v.views[0].view.scrollPosition = 18; }, (v: any) => { v.views[0].view.readingFrame = '0'; },
        (v: any) => { v.views[0].source.kind = ['local']; }, (v: any) => { v.views[0].source.fingerprint = 'unknown'; },
        (v: any) => { v.views[0].name = '\u001b[2J'; }, (v: any) => { v.views[0].source.path = '/tmp/private'; },
      ]) { const altered = structuredClone(parsed); change(altered); assert.throws(() => parseTerminalViews(JSON.stringify(altered))); }
      assert.throws(() => parseTerminalViews(' '.repeat(TERMINAL_VIEW_LIMITS.bytes + 1)), /1 MiB/);
      const directory = await mkdtemp(join(tmpdir(), 'phage-view-conflict-')), path = join(directory, 'conflict.json');
      parsed.views[0].view.scrollPosition = 2; await writeFile(path, JSON.stringify(parsed));
      assert.equal(await f.session.open(path), false);
      assert.match(f.session.getSnapshot().error!, /different view is already named/);
      assert.equal(serializeTerminalViews(f.session.getSnapshot().saved), original);
      f.session.rename(0, 'Renamed'); assert.equal(f.session.getSnapshot().saved[0].name, 'Renamed');
    } finally { await f.close(); }
  });
});
