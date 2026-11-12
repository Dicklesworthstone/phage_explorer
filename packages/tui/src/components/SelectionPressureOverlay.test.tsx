import { describe, it, spyOn } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import { importLocalGenomes } from '../../../core/src/genome-import';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import type { CodonAlignmentInput, CodonSelectionResult } from '../../../core/src/analysis/codon-selection';
import { executeCodonSelectionRequest } from '../../../web/src/workers/CodonSelectionSession';
import * as codonCommands from '../commands/codon-selection';
import { SelectionPressureOverlay } from './SelectionPressureOverlay';

const fixture = (): CodonAlignmentInput => ({
  format: 'phage-explorer-codon-alignment', version: 1, name: 'Hand-derived terminal codons',
  source: { kind: 'demo', description: 'Ten alanine codons with defined changes', reference: 'Synthetic construction', license: 'CC0' },
  alignment: { fasta: '>ref\n' + 'GCT'.repeat(10) + '\n>mixed\nGCCGAT' + 'GCT'.repeat(8) + '\n>nonsyn\nGAT' + 'GCT'.repeat(9),
    homologousCodons: true, orientation: 'coding-5to3', frame: 0, geneticCode: 11,
    method: 'Hand-aligned coding sequences', reference: 'Known homologous columns by construction' },
});
async function selection() {
  const { genomes } = await importLocalGenomes({ name: 'unrelated.fasta', text: '>unrelated_one\n' + 'ATG'.repeat(10) + '\n>unrelated_two\n' + 'GCA'.repeat(10) });
  usePhageStore.setState({ phages: genomes.map(genome => genome.phage), currentPhage: genomes[0].phage,
    currentPhageIndex: 0, diffReferencePhageId: genomes[1].phage.id, terminalCols: 80, terminalRows: 24, overlays: ['selectionPressure'] });
  let reads = 0;
  const unexpectedRead = async () => { reads++; throw new Error('Raw genome repository must not be consulted for aligned CDS evidence.'); };
  const repository = { getFullGenomeLength: unexpectedRead, getSequenceWindow: unexpectedRead } as PhageRepository;
  return { genomes, repository, reads: () => reads };
}
async function waitFor(predicate: () => boolean, context: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Codon terminal did not reach the expected state.\n' + context());
    await new Promise(done => setTimeout(done, 10));
  }
}
function terminal(repository: PhageRepository) {
  let output = '', lastFrame = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) {
    const frame = chunk.toString(); output += frame;
    if (frame.includes('╭')) lastFrame = stripVTControlCharacters(frame).trimEnd();
    done();
  } }), { columns: 80, rows: 24 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { ready = true; }, ref() {}, unref() {} });
  const ui = render(<SelectionPressureOverlay repository={repository} />, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  return { ui, input: (value: string) => stdin.write(value), ready: () => ready,
    output: () => stripVTControlCharacters(output), clear: () => { output = ''; }, frame: () => lastFrame };
}
async function enter(test: ReturnType<typeof terminal>, key: string, prompt: string, value: string) {
  test.clear(); test.input(key); await waitFor(() => test.output().includes(prompt), test.frame);
  test.input(value); await new Promise(done => setTimeout(done, 25)); test.input('\r');
}
async function loadAndAnalyze(test: ReturnType<typeof terminal>, path: string) {
  await enter(test, 'l', 'Codon dataset JSON path', path);
  await waitFor(() => test.frame().includes('Coding alignment loaded'), test.frame);
  test.input('\r'); await waitFor(() => test.frame().includes('Conditional codon comparison complete'), test.frame);
}

describe('interactive terminal aligned-CDS evidence', () => {
  it('runs the native method, preserves accepted settings through drafts, exports complete results and replays with the browser', async () => {
    const prior = usePhageStore.getState(), selected = await selection();
    const directory = await mkdtemp(join(tmpdir(), 'phage-codon-ink-'));
    const path = join(directory, 'quite private codon source.json'); await writeFile(path, JSON.stringify(fixture()));
    const test = terminal(selected.repository);
    try {
      await waitFor(test.ready);
      assert(test.output().includes('No genome sequence has been read'));
      assert.equal(selected.reads(), 0);
      await loadAndAnalyze(test, path);
      assert.deepEqual(usePhageStore.getState().overlays, ['selectionPressure'], 'Filename shortcut letters must belong only to the path input.');
      assert(test.frame().includes('Accepted: 2 pairs; pairwise; window 50.'));
      assert(test.frame().includes('ALIGNED CDS · CONDITIONAL dN/dS · SYNTHETIC'));
      // Hand-counted pooled opportunities: 29/3 synonymous, 61/3 nonsynonymous;
      // one synonymous and one nonsynonymous difference, separate JC69 corrections.
      const jc = (p: number) => -0.75 * Math.log(1 - 4 * p / 3);
      const expected = jc(3 / 61) / jc(3 / 29);
      assert(test.frame().includes('ω ' + expected.toPrecision(6)));
      test.input('\u001b[F'); await waitFor(() => test.frame().includes('No synonymous changes'), test.frame);
      assert(test.frame().includes('ω Unavailable'));
      assert(!test.output().includes('Hotspots (Positive Selection)'));
      assert(!test.output().includes('Global ω'));
      assert.equal(selected.reads(), 0);

      await enter(test, 'w', 'Window size in codons', '2');
      await waitFor(() => test.frame().includes('Draft changed'), test.frame);
      const outputs = { e: join(directory, 'result.json'), t: join(directory, 'pairs.tsv'),
        u: join(directory, 'windows.tsv'), b: join(directory, 'dataset.json') };
      const names = { e: 'json', t: 'pairs', u: 'windows', b: 'dataset' };
      for (const [key, destination] of Object.entries(outputs)) {
        await enter(test, key, 'New ', destination);
        await waitFor(() => test.frame().includes('Saved ' + names[key as keyof typeof names] + ' to '), test.frame);
        assert.equal((await stat(destination)).mode & 0o777, 0o600);
      }
      const record = await parseAnalysisRecord(await readFile(outputs.e, 'utf8'));
      const result = record.fields.comparisons.value as unknown as CodonSelectionResult;
      assert.equal(result.options.windowCodons, 50, 'An unapplied draft cannot relabel a saved result.');
      assert(Math.abs(result.pairs[0].overall.omega! - expected) < 1e-12);
      assert.equal(result.pairs[1].overall.omega, null);
      assert.equal((await readFile(outputs.t, 'utf8')).trimEnd().split('\n').length, 4);
      assert.equal((await readFile(outputs.u, 'utf8')).trimEnd().split('\n').length, 4);
      assert.deepEqual(JSON.parse(await readFile(outputs.b, 'utf8')), fixture());
      const browser = await executeCodonSelectionRequest({ kind: 'import', content: await readFile(outputs.e, 'utf8') });
      assert.equal(browser.verified, true); assert.equal(browser.record!.resultId, record.resultId);

      await enter(test, 'e', 'New replayable codon JSON path', outputs.e);
      await waitFor(() => test.frame().includes('EEXIST'), test.frame);
      assert.equal((await parseAnalysisRecord(await readFile(outputs.e, 'utf8'))).resultId, record.resultId);
      usePhageStore.setState({ currentPhage: selected.genomes[1].phage, diffReferencePhageId: selected.genomes[0].phage.id });
      test.ui.rerender(<SelectionPressureOverlay repository={{ ...selected.repository }} />);
      await enter(test, 'r', 'Saved codon comparison JSON path', outputs.e);
      await waitFor(() => test.frame().includes('Replay verified.'), test.frame);
      assert(test.frame().includes('window 50. Replay verified.'));
      assert(!test.frame().includes('unrelated_two'));
      const frame = test.frame(), lines = frame.split('\n');
      assert(lines.length <= 22, 'Leave room for the App offset:\n' + frame);
      assert(lines.every(line => [...line].length <= 80), 'Terminal width overflow:\n' + frame);
      assert(frame.includes('no selection test or significance'));
      assert(frame.includes('[e] JSON [t] Pair TSV [u] Window TSV [b] Dataset'));
      test.input('\u001b'); await waitFor(() => !usePhageStore.getState().overlays.includes('selectionPressure'));
    } finally { test.ui.unmount(); usePhageStore.setState(prior); }
  });

  it('applies explicit pair, reference, missingness, window and coordinate settings without dropping rows', async () => {
    const prior = usePhageStore.getState(), selected = await selection();
    const directory = await mkdtemp(join(tmpdir(), 'phage-codon-controls-'));
    const path = join(directory, 'data.json'); await writeFile(path, JSON.stringify(fixture()));
    const test = terminal(selected.repository);
    try {
      await waitFor(test.ready); await loadAndAnalyze(test, path);
      await enter(test, 'w', 'Window size in codons', '2');
      await waitFor(() => test.frame().includes('window 2'), test.frame);
      await enter(test, 'g', 'Alignment codon range', '1,8');
      await waitFor(() => test.frame().includes('codons [1,8)'), test.frame);
      test.input('a'); await waitFor(() => test.frame().includes('all-pairs;'), test.frame);
      test.input('m'); await waitFor(() => test.frame().includes('all-pairs; complete;'), test.frame);
      test.input('\r'); await waitFor(() => test.frame().includes('Accepted: 3 pairs; complete; window 2.'), test.frame);
      test.input('2'); await waitFor(() => test.frame().includes('Window 1: codons [1,3)'), test.frame);
      test.input('\u001b[C'); await waitFor(() => test.frame().includes('Pair 2: ref vs nonsyn'), test.frame);
      test.input('\u001b[F'); await waitFor(() => test.frame().includes('Window 4: codons [7,8)'), test.frame);
      const destination = join(directory, 'all-windows.tsv');
      await enter(test, 'u', 'New complete window TSV path', destination);
      await waitFor(() => test.frame().includes('Saved windows to '), test.frame);
      assert.equal((await readFile(destination, 'utf8')).trimEnd().split('\n').length, 14, 'All 3 pairs × 4 windows plus comment/header must be exported.');
      test.input('f'); await waitFor(() => test.frame().includes('ref; complete;'), test.frame);
      test.input('f'); await waitFor(() => test.frame().includes('mixed; complete;'), test.frame);
      test.input('\r'); await waitFor(() => test.frame().includes('Pair 1: mixed vs ref'), test.frame);
      assert(test.frame().includes('Accepted: 2 pairs; complete; window 2.'));
      const parameters = join(directory, 'params.json'); await writeFile(parameters, JSON.stringify({
        comparison: 'reference', referenceId: 'nonsyn', startCodon: 0, endCodon: 10, windowCodons: 3, missing: 'pairwise',
      }));
      await enter(test, 'p', 'Codon parameter JSON path', parameters);
      await waitFor(() => test.frame().includes('nonsyn; pairwise; codons [0,10); window 3'), test.frame);
      test.input('\r'); await waitFor(() => test.frame().includes('Pair 1: nonsyn vs ref'), test.frame);
      assert.equal(selected.reads(), 0);
    } finally { test.ui.unmount(); usePhageStore.setState(prior); }
  });

  it('preserves accepted evidence on cancellation, malformed imports and rehashed fabricated results', async () => {
    const prior = usePhageStore.getState(), selected = await selection();
    const directory = await mkdtemp(join(tmpdir(), 'phage-codon-refusal-'));
    const path = join(directory, 'data.json'); await writeFile(path, JSON.stringify(fixture()));
    const test = terminal(selected.repository);
    try {
      await waitFor(test.ready); await loadAndAnalyze(test, path);
      const output = await codonCommands.executeCodonSelectionJob({ operation: 'analyze', input: { name: 'control', text: JSON.stringify(fixture()) } });
      let signal: AbortSignal | undefined, finish!: (value: codonCommands.CodonSelectionJobResult) => void;
      // Control completion timing for the UI ownership race. The other journeys
      // and separate abort check below exercise the real native worker.
      const delayed = spyOn(codonCommands, 'runCodonSelectionJob').mockImplementation((_job, ownedSignal) => {
        signal = ownedSignal; return new Promise(resolve => { finish = resolve; });
      });
      try {
        test.clear(); test.input('\r'); await waitFor(() => signal !== undefined, test.frame);
        test.input('c'); await waitFor(() => test.frame().includes('Codon work cancelled'), test.frame);
        assert.equal(signal!.aborted, true);
        finish(output); await new Promise(done => setTimeout(done, 60));
        assert(test.frame().includes('Accepted: 2 pairs; pairwise; window 50.'));
        assert(!test.output().includes('Conditional codon comparison complete'));
      } finally { delayed.mockRestore(); }
      const destination = join(directory, 'accepted.json');
      await enter(test, 'e', 'New replayable codon JSON path', destination);
      await waitFor(() => test.frame().includes('Saved json to '), test.frame);
      const record = await parseAnalysisRecord(await readFile(destination, 'utf8'));
      const modified = structuredClone(record);
      (modified.fields.comparisons.value as unknown as CodonSelectionResult).pairs[0].overall.omega = 99;
      const forged = await createAnalysisRecord({ ...modified, inputs: modified.inputs.map(({ sha256: _sha, ...value }) => value) });
      const forgedPath = join(directory, 'forged.json'); await writeFile(forgedPath, serializeAnalysisRecord(forged));
      await enter(test, 'r', 'Saved codon comparison JSON path', forgedPath);
      await waitFor(() => test.frame().includes('Fresh codon comparison differs'), test.frame);
      assert(test.frame().includes('Accepted: 2 pairs; pairwise; window 50.'));
      assert(!test.frame().includes('ω 99'));
      const bad = fixture(); bad.alignment.homologousCodons = false as true;
      const badPath = join(directory, 'unaligned.json'); await writeFile(badPath, JSON.stringify(bad));
      await enter(test, 'l', 'Codon dataset JSON path', badPath);
      await waitFor(() => test.frame().includes('Declare homologous codons'), test.frame);
      assert(test.frame().includes('Accepted: 2 pairs; pairwise; window 50.'));
      const invalidUtf8 = join(directory, 'invalid-utf8.json'); await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe]));
      await enter(test, 'l', 'Codon dataset JSON path', invalidUtf8);
      await waitFor(() => !test.frame().includes('Codon dataset JSON path') && /encoded|encoding/i.test(test.frame()), test.frame);
      const after = join(directory, 'after-failures.json'); await enter(test, 'e', 'New replayable codon JSON path', after);
      await waitFor(() => test.frame().includes('Saved json to '), test.frame);
      assert.equal((await parseAnalysisRecord(await readFile(after, 'utf8'))).resultId, record.resultId);
      test.clear(); test.input('\r'); test.ui.unmount();
      await new Promise(done => setTimeout(done, 60));
      assert(!test.output().includes('Conditional codon comparison complete'));
      assert.equal(selected.reads(), 0);
    } finally { test.ui.unmount(); usePhageStore.setState(prior); }
  });

  it('terminates an actual native codon operation when its owner cancels', async () => {
    const controller = new AbortController();
    const pending = codonCommands.runCodonSelectionJob({ operation: 'analyze',
      input: { name: 'native cancellation control', text: JSON.stringify(fixture()) } }, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });
});
