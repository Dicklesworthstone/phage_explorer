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
import { currentTerminalResearchView, LocalGenomeApp, TerminalGenomeView } from './LocalGenomeApp';
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
