import { afterAll, describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { usePhageStore } from '@phage-explorer/state';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import { parseAnalysisRecord, proteinStructureResultFromRecord, type ProteinReferenceRepository } from '@phage-explorer/core';
import { TropismOverlay, TerminalProteinEvidenceView } from './TropismOverlay';

const catalog = new BunSqliteRepository(resolve(import.meta.dir, '../../../web/public/phage.db'), { readonly: true });
afterAll(() => catalog.close());
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Protein evidence terminal did not reach the expected state.');
    await new Promise(done => setTimeout(done, 10));
  }
}
function terminal(element: React.ReactElement, columns = 100, rows = 32) {
  let output = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }), { columns, rows });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { ready = true; }, ref() {}, unref() {} });
  const ui = render(element, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  return { ui, input: (text: string) => stdin.write(text), ready: () => ready,
    output: () => stripVTControlCharacters(output), clear: () => { output = ''; } };
}
async function selectLambda(selectedGeneId: number | null) {
  const phage = await catalog.getPhageById(1);
  assert(phage, 'The actual committed Lambda record is required.');
  usePhageStore.setState({ phages: [phage], currentPhage: phage, currentPhageIndex: 0, selectedGeneId,
    terminalCols: 100, terminalRows: 32, overlayData: {} });
  return phage;
}

describe('native protein alignment and structure workbench', () => {
  it('selects the verified CDS, runs the real worker, pages contacts and exports complete replayable evidence', async () => {
    const prior = usePhageStore.getState();
    await selectLambda(1);
    const directory = await mkdtemp(join(tmpdir(), 'phage-protein-ink-'));
    const test = terminal(<TropismOverlay repository={catalog} />);
    try {
      await waitFor(test.ready);
      test.input('p');
      await waitFor(() => test.output().includes('not the verified reference CDS'));
      assert(!test.output().includes('Entropy 1096/1132'));
      test.input('g');
      await waitFor(() => test.output().includes('Entropy 1096/1132'));
      assert.equal(usePhageStore.getState().selectedGeneId, 42);
      assert(test.output().includes('observed Cα 420/1132'));
      assert(test.output().includes('within chain 958'));
      assert(test.output().includes('mapped protein 713–1132'));
      test.input('v');
      await waitFor(() => test.output().includes('contacts 1–'));
      assert(test.output().includes('5.831'));
      const destinations = { j: join(directory, 'quite complete experiment.json'), t: join(directory, 'residues.tsv'), c: join(directory, 'contacts.tsv') };
      for (const [key, destination] of Object.entries(destinations)) {
        test.clear(); test.input(key);
        await waitFor(() => test.output().includes('destination (existing files are preserved'));
        test.input(destination); await new Promise(done => setTimeout(done, 30)); test.input('\r');
        await waitFor(() => test.output().includes('Saved '));
        assert.equal((await stat(destination)).mode & 0o777, 0o600);
      }
      const record = await parseAnalysisRecord(await readFile(destinations.j, 'utf8'));
      const produced = proteinStructureResultFromRecord(record);
      assert.equal(produced.residues.length, 1132); assert.equal(produced.contacts.length, 958);
      assert.equal((await readFile(destinations.t, 'utf8')).split('\n').filter(line => line && !line.startsWith('#')).length, 1133);
      assert.equal((await readFile(destinations.c, 'utf8')).split('\n').filter(line => line && !line.startsWith('#')).length, 959);
      test.clear(); test.input('s');
      await waitFor(() => test.output().includes('between supplied chains not compared'));
      test.clear(); test.input('a');
      await waitFor(() => test.output().includes('observed Cα 0/1132'));
      assert(test.output().includes('within chain unavailable'));
      assert(!test.output().includes('mapped protein 713–1132'));
      test.clear(); test.input('v');
      await waitFor(() => test.output().includes('contact geometry is unavailable'));
      assert(!test.output().includes('No Cα pairs meet'));
    } finally { test.ui.unmount(); usePhageStore.setState(prior); }
  });

  it('invalidates an identical numeric genome ID when its repository changes during reference loading', async () => {
    const prior = usePhageStore.getState();
    const phage = await selectLambda(42);
    const sequence = await catalog.getSequenceWindow(phage.id, 0, phage.genomeLength!);
    let resolveSequence!: (value: string) => void;
    let requested = false;
    const pending: ProteinReferenceRepository = { getPhageById: async () => phage,
      getSequenceWindow: () => { requested = true; return new Promise(yes => { resolveSequence = yes; }); } };
    const test = terminal(<TerminalProteinEvidenceView repository={pending} onReturn={() => {}} />);
    try {
      await waitFor(() => requested);
      const t4 = await catalog.getPhageById(2); assert(t4);
      const replacement: ProteinReferenceRepository = { getPhageById: async () => ({ ...t4, id: phage.id }),
        getSequenceWindow: async () => { throw new Error('An uncovered genome must not consume sequence.'); } };
      test.clear(); test.ui.rerender(<TerminalProteinEvidenceView repository={replacement} onReturn={() => {}} />);
      await waitFor(() => test.output().includes('No versioned protein reference'));
      resolveSequence(sequence); await new Promise(done => setTimeout(done, 40));
      assert(!test.output().includes('Entropy 1096/1132'));
      assert(!test.output().includes('within chain 958'));
      test.ui.rerender(<TerminalProteinEvidenceView repository={catalog} onReturn={() => {}} />);
      await waitFor(() => test.output().includes('within chain 958'));
      test.clear(); usePhageStore.getState().setSelectedGeneId(1);
      await waitFor(() => test.output().includes('not the verified reference CDS'));
      assert(!test.output().includes('within chain 958'));
    } finally { test.ui.unmount(); usePhageStore.setState(prior); }
  });

  it('returns to annotation hints while a source read is pending and discards its late completion', async () => {
    const prior = usePhageStore.getState();
    const phage = await selectLambda(42);
    const sequence = await catalog.getSequenceWindow(phage.id, 0, phage.genomeLength!);
    let finish!: (value: string) => void, requested = false;
    const repository: ProteinReferenceRepository = { getPhageById: async () => phage,
      getSequenceWindow: () => { requested = true; return new Promise(yes => { finish = yes; }); } };
    const test = terminal(<TropismOverlay repository={repository} />);
    try {
      await waitFor(test.ready); test.input('p'); await waitFor(() => requested);
      test.clear(); test.input('p');
      await waitFor(() => test.output().includes('Tail Fiber Tropism & Receptor Atlas'));
      finish(sequence); await new Promise(done => setTimeout(done, 40));
      assert(!test.output().includes('Entropy 1096/1132'));
      assert(!test.output().includes('Computing alignment diversity'));
    } finally { test.ui.unmount(); usePhageStore.setState(prior); }
  });

  it('keeps real results and export controls inside an 80 by 24 terminal', async () => {
    const prior = usePhageStore.getState();
    await selectLambda(42);
    usePhageStore.setState({ terminalCols: 80, terminalRows: 24 });
    const test = terminal(<TerminalProteinEvidenceView repository={catalog} onReturn={() => {}} />, 80, 24);
    try {
      await waitFor(() => test.output().includes('within chain 958'));
      const frame = test.output().slice(test.output().lastIndexOf('╭')).trimEnd();
      const lines = frame.split('\n');
      assert(lines.length <= 22, 'Leave two rows for the App overlay offset:\n' + frame);
      assert(lines.every(line => [...line].length <= 80), 'Terminal frame exceeded its width:\n' + frame);
      assert(frame.includes('[j] Replayable JSON'));
      assert(frame.includes('No SASA, affinity'));
    } finally { test.ui.unmount(); usePhageStore.setState(prior); }
  });
});
