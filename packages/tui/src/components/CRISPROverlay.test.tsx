import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { usePhageStore } from '@phage-explorer/state';
import { importLocalGenomes } from '../../../core/src/genome-import';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';
import { createLocalGenomeRepository } from '../../../db-runtime/src/local-genomes';
import type { SpacerRepository } from '../../../web/src/workers/SpacerReferenceSession';
import { CRISPROverlay } from './CRISPROverlay';

const guide = 'ACGATTCGGTACCTAGTGCA';
const sequence = 'TTTT' + guide + 'AGG' + 'GAT'.repeat(60);
const references = { format: 'phage-explorer-spacer-library', version: 1, name: 'Synthetic terminal references',
  source: { kind: 'demo', reference: 'Hand-constructed terminal controls', version: '1', license: 'CC0 synthetic', scope: 'Fixture hosts only' },
  hosts: [{ id: 'H1', name: 'Fixture host', strain: 'one', accession: 'synthetic:one' }],
  spacers: [{ id: 'S1', hostId: 'H1', arrayAccession: 'synthetic:array', sequence: guide, system: null, target: 'DNA',
    orientation: 'guide-equivalent', pam: { side: '3prime', motif: 'NGG', reference: 'Fixture rule' },
    seed: { start: 0, end: 5, maxMismatches: 0, reference: 'Fixture seed' } }] };
async function selection() {
  const { genomes } = await importLocalGenomes({ name: 'synthetic.gb', text:
    'LOCUS       SYNTHETIC                207 bp    DNA     linear\nDEFINITION  Synthetic terminal control.\nACCESSION   SYNTHETIC\nFEATURES             Location/Qualifiers\n     CDS             28..207\n                     /gene="acidic-control"\nORIGIN\n        1 ' + sequence.toLowerCase() + '\n//\n' });
  const phage = genomes[0].phage;
  usePhageStore.setState({ phages: [phage], currentPhage: phage, currentPhageIndex: 0,
    terminalCols: 80, terminalRows: 24, overlays: ['crispr'] });
  return { phage, repository: createLocalGenomeRepository(null, genomes) };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Spacer terminal did not reach the expected state.');
    await new Promise(done => setTimeout(done, 10));
  }
}
function terminal(repository: SpacerRepository) {
  let output = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }), { columns: 80, rows: 24 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { ready = true; }, ref() {}, unref() {} });
  const ui = render(<CRISPROverlay repository={repository} />, { stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false });
  return { ui, input: (value: string) => stdin.write(value), ready: () => ready,
    output: () => stripVTControlCharacters(output), clear: () => { output = ''; },
    frame: () => { const plain = stripVTControlCharacters(output); return plain.slice(plain.lastIndexOf('╭')).trimEnd(); } };
}
async function enterFile(test: ReturnType<typeof terminal>, key: string, prompt: string, path: string) {
  test.clear(); test.input(key); await waitFor(() => test.output().includes(prompt));
  test.input(path); await new Promise(done => setTimeout(done, 20)); test.input('\r');
}

describe('native CRISPR reference workbench', () => {
  it('runs independent Acr hints and real references, inspects rules, exports and verifies replay inside 80 by 24', async () => {
    const prior = usePhageStore.getState(), { repository: base } = await selection();
    let sequenceReads = 0;
    const repository: SpacerRepository = { getFullGenomeLength: id => base.getFullGenomeLength(id),
      getSequenceWindow: (id, start, length) => { sequenceReads++; return base.getSequenceWindow(id, start, length); } };
    const directory = await mkdtemp(join(tmpdir(), 'phage-crispr-ink-'));
    const input = join(directory, 'quite private reference.json'); await writeFile(input, JSON.stringify(references));
    const test = terminal(repository);
    try {
      await waitFor(test.ready); test.input('A');
      await waitFor(() => test.output().includes('shortlist complete'));
      assert(test.output().includes('HEURISTIC ONLY')); assert(test.output().includes('heuristic score 60'));
      assert(test.output().includes('[27,207)')); assert.equal(sequenceReads, 1);
      assert(!test.output().includes('Max Pressure'));
      await enterFile(test, 'l', 'Spacer library JSON path', input);
      await waitFor(() => test.output().includes('Spacer library loaded'));
      assert.deepEqual(usePhageStore.getState().overlays, ['crispr'], 'Shortcut letters in a filename must not close the panel.');
      assert.equal(sequenceReads, 1, 'Reference import does not read genome DNA.');
      test.clear(); test.input('\r');
      await waitFor(() => test.output().includes('1/1 searched; 1 hit rows.'));
      test.input('1'); await waitFor(() => test.output().includes('S1 / H1: + [4,24)'));
      assert(test.output().includes('PAM matched (AGG); seed matched'));
      assert.equal(sequenceReads, 2);
      const destinations = { e: join(directory, 'quite.json'), t: join(directory, 'hits.tsv'), b: join(directory, 'library.json') };
      for (const [key, path] of Object.entries(destinations)) {
        await enterFile(test, key, 'New ', path);
        const action = key === 'e' ? 'json' : key === 't' ? 'tsv' : 'library-export';
        await waitFor(() => test.frame().includes('Saved ' + action + ' to '));
        assert.equal((await stat(path)).mode & 0o777, 0o600);
      }
      const record = await parseAnalysisRecord(await readFile(destinations.e, 'utf8'));
      assert.equal((record.inputs[0].data as { sequence: string }).sequence, sequence);
      assert.equal((await readFile(destinations.t, 'utf8')).trimEnd().split('\n').length, 3);
      assert.deepEqual(JSON.parse(await readFile(destinations.b, 'utf8')), references);
      await enterFile(test, 'e', 'New replayable evidence JSON path', destinations.e);
      await waitFor(() => test.output().includes('EEXIST'));
      assert.equal((await parseAnalysisRecord(await readFile(destinations.e, 'utf8'))).resultId, record.resultId);
      test.clear(); test.input('h'); await waitFor(() => test.frame().includes('Host: H1'));
      test.input('+'); await waitFor(() => test.frame().includes('Mismatches: 1'));
      assert(test.frame().includes('Draft changed'));
      await enterFile(test, 'r', 'Saved spacer analysis path', destinations.e);
      await waitFor(() => test.output().includes('Replay verified.'));
      assert(test.output().includes('Accepted: all hosts, 0 substitutions, linear.'));
      const readsBeforeAcr = sequenceReads;
      test.clear(); test.input('A'); await waitFor(() => test.output().includes('shortlist complete'));
      assert.equal(sequenceReads, readsBeforeAcr, 'Acr uses the accepted exact DNA snapshot when one exists.');
      assert(test.output().includes('heuristic score 60'));
      const frame = test.frame(), lines = frame.split('\n');
      assert(lines.length <= 22, 'Leave two rows for App offset:\n' + frame);
      assert(lines.every(line => [...line].length <= 80), 'Frame width overflow:\n' + frame);
      assert(frame.includes('[5] Acr')); assert(frame.includes('HEURISTIC ONLY'));
      test.clear(); test.input('o');
      await waitFor(() => test.output().includes('Imported topology is linear'));
    } finally { test.ui.unmount(); usePhageStore.setState(prior); }
  });

  it('cancels pending Acr reads and rejects late completion after an identical-ID repository replacement', async () => {
    const prior = usePhageStore.getState(), { phage } = await selection();
    const lengths: Array<(value: number) => void> = []; let sequenceReads = 0;
    const repository: SpacerRepository = { getFullGenomeLength: () => new Promise(resolve => { lengths.push(resolve); }),
      getSequenceWindow: async () => { sequenceReads++; return sequence; } };
    const test = terminal(repository);
    try {
      await waitFor(test.ready); test.input('A'); await waitFor(() => lengths.length === 1);
      test.clear(); test.input('c'); await waitFor(() => test.output().includes('Acr heuristic cancelled'));
      lengths[0](sequence.length); await new Promise(done => setTimeout(done, 30));
      assert.equal(sequenceReads, 0); assert(!test.output().includes('heuristic score 60'));
      test.clear(); test.input('A'); await waitFor(() => lengths.length === 2);
      const replacement: SpacerRepository = { getFullGenomeLength: async id => { assert.equal(id, phage.id); return sequence.length; },
        getSequenceWindow: async () => 'C'.repeat(sequence.length) };
      test.ui.rerender(<CRISPROverlay repository={replacement} />);
      await waitFor(() => test.output().includes('Press A to score'));
      lengths[1](sequence.length); await new Promise(done => setTimeout(done, 30));
      assert.equal(sequenceReads, 0); assert(!test.output().includes('heuristic score 60'));
      test.clear(); test.input('A'); await waitFor(() => test.output().includes('shortlist complete'));
      assert(test.output().includes('1/1 annotations eligible; 0 size/charge candidates.'));
      test.input('\u001b'); await waitFor(() => !usePhageStore.getState().overlays.includes('crispr'));
    } finally { test.ui.unmount(); usePhageStore.setState(prior); }
  });
});
