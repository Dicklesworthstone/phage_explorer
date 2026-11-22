import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usePhageStore } from '@phage-explorer/state';
import { importLocalGenomes, exportLocalGenomeBundle, type GenomeImportResult } from '../../../core/src/genome-import';
import { TerminalGenomeSession } from '../local-genome-session';
import { captureTerminalCatalogGenome, currentTerminalResearchView, LocalGenomeApp, TerminalGenomeView } from './LocalGenomeApp';
import type { PhageRepository } from '../../../db-runtime/src/types';
import { initializeCommands } from '../commands/definitions';
import { getCommands } from '../commands/registry';

const waitFor = async (predicate: () => boolean) => {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Terminal view did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
function terminal(session: TerminalGenomeSession, onReturn: () => void, element?: React.ReactElement) {
  let output = '', inputReady = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }), { columns: 100, rows: 30 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true,
    setRawMode: (_raw: boolean) => { inputReady = true; }, ref() {}, unref() {} });
  const ui = render(element ?? <TerminalGenomeView session={session} onReturn={onReturn} />, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  return { ui, input: (value: string) => stdin.write(value), output: () => output, ready: () => inputReady };
}
describe('native Ink private-genome input and review', () => {
  it('captures catalog data with K, requires collision consent and restores the selected residue view', async () => {
    const previous = usePhageStore.getState();
    const imported = await importLocalGenomes({ name: 'source.gb', text: [
      'LOCUS       sample                    18 bp    DNA     linear',
      'ACCESSION   SAMPLE.1',
      'FEATURES             Location/Qualifiers',
      '     CDS             complement(join(1..6,13..18))',
      '                     /gene="reverse_join"',
      'ORIGIN',
      '        1 atgaaacccgggtttcat',
      '//',
      '',
    ].join('\n') });
    const original = imported.genomes[0], phage = { ...original.phage, id: 7, slug: 'catalog-sample', localGenome: undefined };
    const base = { listPhages: async () => [phage], getFullGenomeLength: async () => original.sequence.length,
      getSequenceWindow: async () => original.sequence, close: async () => {} } as unknown as PhageRepository;
    const session = new TerminalGenomeSession(base);
    usePhageStore.setState({ phages: [phage], currentPhage: phage, currentPhageIndex: 0, isLoadingPhage: false,
      viewMode: 'aa', readingFrame: -2, scrollPosition: 3, selectedGeneId: phage.genes[0].id });
    let returned = 0;
    const test = terminal(session, () => { returned++; });
    try {
      await waitFor(test.ready);
      assert.match(test.output(), /Capture selected catalog genome for research/);
      test.input('k'); await waitFor(() => session.getSnapshot().review !== null && !session.getSnapshot().busy);
      assert.equal(session.getSnapshot().localCount, 0);
      assert.strictEqual(usePhageStore.getState().currentPhage, phage);
      test.input('\r'); await waitFor(() => !!session.getSnapshot().error);
      assert.match(session.getSnapshot().error!, /Explicitly allow/);
      assert.equal(returned, 0);
      test.input('c'); await waitFor(() => test.output().includes('YES — keep both'));
      test.input('\r'); await waitFor(() => returned === 1);
      const accepted = usePhageStore.getState();
      assert.equal(accepted.phages.length, 2);
      assert.equal(accepted.currentPhage?.localGenome?.format, 'catalog-snapshot');
      assert.equal(accepted.viewMode, 'aa'); assert.equal(accepted.readingFrame, -2); assert.equal(accepted.scrollPosition, 3);
      assert.equal(accepted.selectedGeneId, phage.genes[0].id);
      assert.deepEqual(accepted.currentPhage?.genes[0].qualifiers?._segments,
        [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }]);
      const restored = await importLocalGenomes({ name: 'saved.json', text: session.exportBundle() });
      assert.equal(restored.genomes[0].sequence, original.sequence);
      assert.deepEqual(JSON.parse(restored.genomes[0].original.text).genome.genes, phage.genes);
    } finally { test.ui.unmount(); await session.close(); usePhageStore.setState(previous); }
  });
  it('rejects pending selections and prevents a late catalog capture from replacing a newer view', async () => {
    const previous = usePhageStore.getState(), imported = await importLocalGenomes({ name: 'source.fa', text: '>catalog\nACGTACGT' });
    const phage = { ...imported.genomes[0].phage, id: 8, localGenome: undefined };
    let sequenceReads = 0, resolveLength!: (length: number) => void;
    const length = new Promise<number>(resolve => { resolveLength = resolve; });
    const base = { getFullGenomeLength: () => length,
      getSequenceWindow: async () => { sequenceReads++; return 'ACGTACGT'; }, close: async () => {} } as unknown as PhageRepository;
    const session = new TerminalGenomeSession(base);
    try {
      usePhageStore.setState({ phages: [phage], currentPhage: phage, currentPhageIndex: 0,
        isLoadingPhage: true, viewMode: 'dna', readingFrame: 0, scrollPosition: 0, selectedGeneId: null });
      assert.throws(() => captureTerminalCatalogGenome(session), /still loading/);
      assert.equal(session.getSnapshot().busy, null);
      usePhageStore.setState({ isLoadingPhage: false });
      const pending = captureTerminalCatalogGenome(session);
      usePhageStore.setState({ scrollPosition: 2 });
      resolveLength(8);
      assert.equal(await pending, false);
      assert.match(session.getSnapshot().error!, /selected genome changed/);
      assert.equal(session.getSnapshot().review, null);
      assert.equal(sequenceReads, 0);
      assert.equal(usePhageStore.getState().scrollPosition, 2);
      let resolveReplacement!: (value: number) => void;
      const replacement = new Promise<number>(resolve => { resolveReplacement = resolve; });
      base.getFullGenomeLength = () => replacement;
      usePhageStore.setState({ scrollPosition: 0 });
      const staleCatalog = captureTerminalCatalogGenome(session);
      usePhageStore.setState({ phages: [{ ...phage }] });
      resolveReplacement(8);
      assert.equal(await staleCatalog, false);
      assert.match(session.getSnapshot().error!, /selected genome changed/);
      assert.equal(session.getSnapshot().review, null);
      assert.equal(sequenceReads, 0, 'same-ID catalog replacement invalidates the capture before sequence loading');
    } finally { await session.close(); usePhageStore.setState(previous); }
  });
  it('captures the accepted feature view and rejects a stale record during asynchronous navigation', async () => {
    const previous = usePhageStore.getState();
    const imported = await importLocalGenomes({ name: 'paired.fa', text: '>first\nACGTACGTACGT\n>second\nTTTTCCCCAAAA' });
    try {
      usePhageStore.setState({ phages: imported.genomes.map(genome => genome.phage), currentPhage: imported.genomes[0].phage,
        currentPhageIndex: 0, selectedGeneId: null, viewMode: 'aa', readingFrame: -2, scrollPosition: 2 });
      const captured = currentTerminalResearchView();
      assert.deepEqual(captured, { contentId: imported.genomes[0].phage.localGenome!.contentId,
        geneId: null, viewMode: 'aa', readingFrame: -2, scrollPosition: 2 });
      usePhageStore.setState({ currentPhageIndex: 1, scrollPosition: 0 });
      assert.throws(currentTerminalResearchView, /still loading/);
      assert.equal(captured?.scrollPosition, 2);
      usePhageStore.setState({ phages: [], currentPhage: null, currentPhageIndex: 0 });
      assert.equal(currentTerminalResearchView(), null);
    } finally { usePhageStore.setState(previous); }
  });
  it('imports without filename shortcuts, restores the exact view, and exports all accepted originals', async () => {
    const prior = usePhageStore.getState();
    const directory = await mkdtemp(join(tmpdir(), 'phage-ink-import-'));
    const parsed = await importLocalGenomes({ name: 'source.fa', text: '>quite-private\nATGAAACCCGGGTTTCAT' });
    const view = { contentId: parsed.genomes[0].phage.localGenome!.contentId, viewMode: 'aa' as const, readingFrame: -2 as const, scrollPosition: 3 };
    const inputPath = join(directory, 'quite private input.json'), outputPath = join(directory, 'saved.json');
    await writeFile(inputPath, exportLocalGenomeBundle(parsed.genomes, view));
    usePhageStore.setState({ phages: [], currentPhage: null, currentPhageIndex: 0 });
    const session = new TerminalGenomeSession(null);
    let returned = 0;
    const test = terminal(session, () => { returned++; });
    try {
      await waitFor(test.ready);
      test.input('i'); await waitFor(() => test.output().includes('FASTA, GenBank or portable bundle path'));
      test.input(inputPath); await new Promise(resolve => setTimeout(resolve, 30));
      test.input('\r');
      await waitFor(() => !!session.getSnapshot().review && !session.getSnapshot().busy);
      assert.equal(returned, 0, 'q in a filename must not quit or submit');
      assert.equal(usePhageStore.getState().phages.length, 0, 'review must not install');
      test.input('\r'); await waitFor(() => returned === 1);
      const state = usePhageStore.getState();
      assert.equal(state.viewMode, 'aa'); assert.equal(state.readingFrame, -2); assert.equal(state.scrollPosition, 3);
      assert.equal(state.currentPhage?.localGenome?.contentId, view.contentId);
      test.input('e'); await waitFor(() => test.output().includes('New portable bundle destination'));
      test.input(outputPath); await new Promise(resolve => setTimeout(resolve, 30));
      test.input('\r'); await waitFor(() => session.getSnapshot().notice?.startsWith('Saved the original') ?? false);
      const reopened = await importLocalGenomes({ name: 'saved.json', text: await readFile(outputPath, 'utf8') });
      assert.deepEqual(reopened.genomes, parsed.genomes); assert.deepEqual(reopened.view, view);
    } finally { test.ui.unmount(); await session.close(); usePhageStore.setState(prior); }
  });
  it('Escape cancels a pending import and discards review without navigating the accepted session', async () => {
    const prior = usePhageStore.getState();
    const parsed = await importLocalGenomes({ name: 'accepted.fa', text: '>accepted\nACGTACGT' });
    let resolve!: (result: GenomeImportResult) => void;
    const pending = new Promise<GenomeImportResult>(yes => { resolve = yes; });
    const session = new TerminalGenomeSession(null, parsed.genomes, () => pending);
    usePhageStore.setState({ phages: parsed.genomes.map(g => g.phage), currentPhage: parsed.genomes[0].phage, scrollPosition: 4 });
    let returned = 0;
    const test = terminal(session, () => { returned++; });
    try {
      await waitFor(test.ready);
      test.input('i'); await waitFor(() => test.output().includes('FASTA, GenBank or portable bundle path'));
      test.input('pending.fa'); await new Promise(resolve => setTimeout(resolve, 30)); test.input('\r');
      await waitFor(() => session.getSnapshot().busy === 'reading');
      test.input('\u001b'); await waitFor(() => session.getSnapshot().busy === null);
      resolve(await importLocalGenomes({ name: 'late.fa', text: '>late\nCCCCCCCC' }));
      await new Promise(done => setTimeout(done, 30));
      assert.equal(session.getSnapshot().review, null);
      assert.equal(session.getSnapshot().localCount, 1);
      assert.equal(usePhageStore.getState().scrollPosition, 4);
      assert.equal(returned, 0);
      test.input('\u001b'); await waitFor(() => returned === 1);
    } finally { test.ui.unmount(); await session.close(); usePhageStore.setState(prior); }
  });
});

describe('immediate terminal research access', () => {
  for (const [binding, key, query, title] of [
    ['colon', ':', 'Local genomes', 'LOCAL GENOMES — PRIVATE SESSION'],
    ['Ctrl+P', '\u0010', 'Research workflows', 'RESEARCH WORKFLOWS — AUTHOR AND REPLAY'],
  ] as const) {
    it('opens ' + query + ' through ' + binding + ' in a fresh novice session', async () => {
      const prior = usePhageStore.getState();
      const parsed = await importLocalGenomes({ name: 'private.fa', text: '>private\nATGAAACCCGGGTTTCAT' });
      const session = new TerminalGenomeSession(null, parsed.genomes);
      usePhageStore.setState({
        phages: [], currentPhage: null, currentPhageIndex: 0, selectedGeneId: null,
        experienceLevel: 'novice', overlays: [], overlayData: {}, error: null,
        isLoadingPhage: false, quitConfirmPending: false, show3DModel: false,
        model3DFullscreen: false, diffEnabled: false, viewMode: 'dna', readingFrame: 0, scrollPosition: 0,
      });
      const test = terminal(session, () => {}, <LocalGenomeApp session={session} />);
      try {
        await waitFor(() => test.ready() && usePhageStore.getState().currentPhage !== null
          && !usePhageStore.getState().isLoadingPhage);
        test.input(key);
        await waitFor(() => usePhageStore.getState().overlays.includes('commandPalette')
          && test.output().includes('COMMAND PALETTE'));
        assert.equal(usePhageStore.getState().experienceLevel, 'novice', 'opening commands must not force an expertise change');
        assert.equal(usePhageStore.getState().error, null);
        test.input(query);
        await new Promise(resolve => setTimeout(resolve, 30));
        test.input('\r');
        await waitFor(() => test.output().includes(title));
        assert.equal(usePhageStore.getState().experienceLevel, 'novice');
        assert.equal(usePhageStore.getState().error, null);
        assert.equal(session.getSnapshot().localCount, 1, 'opening a workspace preserves accepted private input');
      } finally { test.ui.unmount(); await session.close(); usePhageStore.setState(prior); }
    });
  }

  it('lets novice and intermediate users explicitly unlock all tools without an error or a timer downgrade', () => {
    const prior = usePhageStore.getState();
    initializeCommands();
    const palette = getCommands().find(command => command.id === 'command-palette');
    const unlock = getCommands().find(command => command.id === 'unlock-advanced');
    assert(palette); assert(unlock);
    try {
      assert.equal(palette.minLevel, undefined);
      assert.equal(unlock.maxLevel, 'intermediate', 'intermediate users still need a route to power tools');
      for (const level of ['novice', 'intermediate'] as const) {
        usePhageStore.setState({ experienceLevel: level, error: null, scrollPosition: 7 });
        unlock.action();
        assert.equal(usePhageStore.getState().experienceLevel, 'power');
        assert.equal(usePhageStore.getState().error, null);
        assert.equal(usePhageStore.getState().scrollPosition, 7);
        usePhageStore.getState().promoteExperienceLevel('intermediate');
        assert.equal(usePhageStore.getState().experienceLevel, 'power');
      }
    } finally { usePhageStore.setState(prior); }
  });
});
