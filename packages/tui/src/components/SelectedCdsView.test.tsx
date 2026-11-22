import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import React from 'react';
import { render } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { importLocalGenomes, prepareSelectedCds, type SelectedCdsSource, type SelectedCdsResult } from '@phage-explorer/core';
import { TerminalGenomeSession } from '../local-genome-session';
import { LocalGenomeApp } from './LocalGenomeApp';
import { SelectedCdsView, saveSelectedCdsExport } from './SelectedCdsView';

const fixture = [
  'LOCUS       cds_fixture               18 bp    DNA     circular',
  'ACCESSION   CDSFIX.1',
  'FEATURES             Location/Qualifiers',
  '     CDS             join(1..6,13..18)',
  '                     /gene="forward_join"',
  '                     /product="joined capsid fixture"',
  '                     /transl_table=11',
  '     CDS             complement(join(1..6,13..18))',
  '                     /gene="reverse_join"',
  '     CDS             join(13..18,1..6)',
  '                     /gene="origin_join"',
  '     CDS             1..9',
  '                     /gene="unsupported_table"',
  '                     /transl_table=99',
  'ORIGIN',
  '        1 atgaaaccccccgggttt',
  '//', '',
].join('\n');
const dnaOf = (text: string) => text.split('\n').slice(1).join('');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function waitFor(predicate: () => boolean, diagnostic: () => string = () => '') {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('CDS terminal did not reach the expected state.\n' + diagnostic().slice(-2500));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function terminal(element: React.ReactElement) {
  let output = '', last = '', inputReady = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) {
    last = stripVTControlCharacters(chunk.toString()); output += last; done();
  } }), { columns: 100, rows: 30 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { inputReady = true; }, ref() {}, unref() {} });
  const ui = render(element, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  return { ui, stdout, input: (value: string) => stdin.write(value), output: () => output, last: () => last, ready: () => inputReady };
}
function resetStore() {
  usePhageStore.setState({ phages: [], currentPhage: null, currentPhageIndex: 0, selectedGeneId: null,
    experienceLevel: 'novice', overlays: [], overlayData: {}, error: null, isLoadingPhage: false,
    quitConfirmPending: false, show3DModel: false, model3DFullscreen: false, diffEnabled: false,
    viewMode: 'dna', readingFrame: 0, scrollPosition: 0 });
}
async function exportTo(test: ReturnType<typeof terminal>, key: string, path: string) {
  test.input(key); await waitFor(() => test.last().includes('destination:'), test.output);
  test.input(path); await pause(); test.input('\r');
  await waitFor(() => test.last().includes('Saved complete'), test.output);
  return readFile(path, 'utf8');
}
async function source(sequence: string, label = 'same'): Promise<SelectedCdsSource> {
  const imported = await importLocalGenomes({ name: 'source.fa', text: `>same\n${sequence}` });
  const phage = imported.genomes[0].phage;
  return { owner: {}, sequence, phage: { ...phage, id: 42, genes: [{ id: 7, name: label, locusTag: null,
    product: null, type: 'CDS', startPos: 0, endPos: sequence.length, strand: '+' }] } };
}

describe('native terminal CDS inspection and complete exports', () => {
  it('imports, discovers the novice command, selects joined/reverse/origin CDS and exports exact DNA, protein and qualifiers', async () => {
    const previous = usePhageStore.getState(), directory = await mkdtemp(join(tmpdir(), 'phage-cds-journey-'));
    const inputPath = join(directory, 'quite private annotations.gb'); await writeFile(inputPath, fixture);
    const session = new TerminalGenomeSession(null); resetStore();
    const test = terminal(<LocalGenomeApp session={session} initiallyOpen />);
    try {
      await waitFor(test.ready);
      test.input('i'); await waitFor(() => test.last().includes('FASTA, GenBank or portable bundle path'), test.output);
      test.input(inputPath); await pause(); test.input('\r');
      await waitFor(() => !!session.getSnapshot().review && !session.getSnapshot().busy, test.output);
      test.input('\r'); await waitFor(() => !!usePhageStore.getState().currentPhage && !usePhageStore.getState().isLoadingPhage
        && !!usePhageStore.getState().overlayData.tropism, test.output);
      test.input(':'); await waitFor(() => test.last().includes('COMMAND PALETTE'), test.output);
      test.input('Inspect CDS'); await pause(); test.input('\r');
      await waitFor(() => test.last().includes('[Summary]'), test.output);
      assert.equal(usePhageStore.getState().experienceLevel, 'novice');
      assert.match(test.last(), /CDS 1\/4: forward_join/);
      assert.match(test.last(), /1\.\.6\(\+\), 13\.\.18\(\+\)/);
      test.input('\t'); await waitFor(() => test.last().includes('ATGAAAGGGTTT'), test.output);
      const dnaPath = join(directory, 'quite complete joined.fna');
      const dna = await exportTo(test, 'd', dnaPath);
      assert.equal(dnaOf(dna), 'ATGAAAGGGTTT');
      assert.match(dna, /transl_table=11/);
      assert.match(dna, new RegExp('genome_sha256=' + digest('ATGAAACCCCCCGGGTTT')));
      assert.equal((await stat(dnaPath)).mode & 0o777, 0o600);

      test.input('\u001b[C'); await waitFor(() => test.last().includes('AAACCCTTTCAT'), test.output);
      assert.match(test.last(), /CDS 2\/4: reverse_join/);
      const protein = await exportTo(test, 'p', join(directory, 'reverse.faa'));
      assert.equal(dnaOf(protein), 'KPFH');
      const record: SelectedCdsResult = JSON.parse(await exportTo(test, 'j', join(directory, 'reverse.json')));
      assert.equal(record.cds, 'AAACCCTTTCAT'); assert.equal(record.protein, 'KPFH');
      assert.equal(record.source.kind, 'local');
      assert.equal(record.source.genomeSha256, digest('ATGAAACCCCCCGGGTTT'));
      assert.equal(record.cdsSha256, digest('AAACCCTTTCAT'));
      assert.deepEqual(record.segments, [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }]);
      assert.equal(record.gene.qualifiers?._location, 'complement(join(1..6,13..18))');
      assert.deepEqual(record.gene.qualifiers?._segments, record.segments);
      assert.equal(record.source.localContentId, usePhageStore.getState().currentPhage?.localGenome?.contentId);

      // A real output path cannot overwrite the earlier accepted export.
      test.input('d'); await waitFor(() => test.last().includes('destination:'), test.output);
      test.input(dnaPath); await pause(); test.input('\r');
      await waitFor(() => /EEXIST|exist/i.test(test.last()), test.output);
      assert.equal(await readFile(dnaPath, 'utf8'), dna);
      test.input('\u001b'); await waitFor(() => test.last().includes('[CDS DNA]'), test.output);

      test.input('\u001b[C'); await waitFor(() => test.last().includes('GGGTTTATGAAA'), test.output);
      const origin = await exportTo(test, 'd', join(directory, 'origin.fna'));
      assert.equal(dnaOf(origin), 'GGGTTTATGAAA');
      assert.match(origin, /location_1based=13\.\.18\(%2B\)%2C%201\.\.6\(%2B\)/);

      test.input('\u001b[C'); await waitFor(() => test.last().includes('CDS 4/4: unsupported_table'), test.output);
      await waitFor(() => test.last().includes('[CDS DNA]'), test.output);
      test.input('p'); await waitFor(() => test.last().includes('Protein export unavailable'), test.output);
      assert(!test.last().includes('destination:'));
      assert.equal(dnaOf(await exportTo(test, 'd', join(directory, 'unsupported.fna'))), 'ATGAAACCC');
      const unsupported: SelectedCdsResult = JSON.parse(await exportTo(test, 'j', join(directory, 'unsupported.json')));
      assert.equal(unsupported.protein, null); assert.equal(unsupported.proteinSha256, null);
      assert(unsupported.translationReasons.includes('Unsupported translation table.'));
      assert.equal(String(unsupported.gene.qualifiers?.transl_table), '99');
      assert.equal(usePhageStore.getState().viewMode, 'dna', 'filename characters and Tab do not change the genome view');
      assert.equal(usePhageStore.getState().readingFrame, 0);
      assert.equal(usePhageStore.getState().scrollPosition, 0, 'CDS arrows belong to the inspector, not sequence scrolling');
      assert.equal(usePhageStore.getState().show3DModel, false);
      assert.equal(usePhageStore.getState().error, null);
      test.input('g'); await waitFor(() => !usePhageStore.getState().overlays.includes('selectedCds'), test.output);
      assert.equal(usePhageStore.getState().selectedGeneId, unsupported.gene.id);
      assert.equal(usePhageStore.getState().scrollPosition, 0);
      assert.equal(usePhageStore.getState().quitConfirmPending, false, 'q in the path is not a global shortcut');
    } finally { test.ui.unmount(); await session.close(); usePhageStore.setState(previous); }
  }, 20000);

  it('pages long sequences after resize and writes every base and terminal stop', async () => {
    const previous = usePhageStore.getState(), directory = await mkdtemp(join(tmpdir(), 'phage-cds-long-'));
    resetStore(); const accepted = await source('ATG' + 'GCT'.repeat(600) + 'TAA');
    const test = terminal(<SelectedCdsView source={accepted} isCurrentSource={value => value === accepted} onClose={() => {}} />);
    try {
      await waitFor(() => test.last().includes('[Summary]'), test.output);
      test.stdout.columns = 80; test.stdout.rows = 24; test.stdout.emit('resize');
      test.input('\t'); await waitFor(() => test.last().includes('[CDS DNA]'), test.output);
      assert.match(test.last(), /\s1\s+ATGGCT/);
      test.input('\u001b[6~'); await pause();
      assert(!/\s1\s+ATGGCT/.test(test.last()), 'Page Down moves through the complete DNA');
      assert(test.last().split('\n').every(line => line.length <= 80), 'resized output fits 80 columns');
      const dna = await exportTo(test, 'd', join(directory, 'whole.fna'));
      const protein = await exportTo(test, 'p', join(directory, 'whole.faa'));
      assert.equal(dnaOf(dna), accepted.sequence);
      assert.equal(dnaOf(protein), 'M' + 'A'.repeat(600) + '*');
      assert(dna.split('\n').slice(1).every(line => line.length <= 80));
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });
});

describe('terminal CDS source ownership and cancellation', () => {
  it('retires a late same-ID source and exports only the replacement annotation and sequence', async () => {
    const previous = usePhageStore.getState(), directory = await mkdtemp(join(tmpdir(), 'phage-cds-replacement-'));
    resetStore(); const first = await source('ATGAAATAA', 'old'), second = await source('AATGGGGTAA', 'replacement');
    second.phage.genes[0].qualifiers = { codon_start: 2, note: 'exact replacement annotation' };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepare = async (accepted: SelectedCdsSource, gene: typeof first.phage.genes[number]) => {
      const result = prepareSelectedCds(accepted, gene);
      if (accepted === first) await gate;
      return result;
    };
    let live = first;
    const isCurrent = (value: SelectedCdsSource) => value === live;
    const test = terminal(<SelectedCdsView source={first} isCurrentSource={isCurrent} onClose={() => {}} prepare={prepare} />);
    try {
      await waitFor(() => test.last().includes('Preparing the exact selected CDS'), test.output);
      live = second;
      test.ui.rerender(<SelectedCdsView source={second} isCurrentSource={isCurrent} onClose={() => {}} prepare={prepare} />);
      await waitFor(() => test.last().includes('[Summary]') && test.last().includes('replacement'), test.output);
      release(); await pause();
      const record: SelectedCdsResult = JSON.parse(await exportTo(test, 'j', join(directory, 'replacement.json')));
      assert.equal(record.gene.id, 7); assert.equal(record.source.phageId, 42);
      assert.equal(record.gene.name, 'replacement'); assert.equal(record.codonStart, 2);
      assert.equal(record.cds, 'ATGGGGTAA'); assert.equal(record.protein, 'MG*');
      assert.deepEqual(record.segments, [{ start: 1, end: 10, strand: '+' }]);
      assert.equal(record.gene.qualifiers?.note, 'exact replacement annotation');
      assert.equal(record.source.genomeSha256, digest(second.sequence));
    } finally { release(); test.ui.unmount(); usePhageStore.setState(previous); }
  });

  it('discards an old output form on source change and refuses stale exports before creating files', async () => {
    const previous = usePhageStore.getState(), directory = await mkdtemp(join(tmpdir(), 'phage-cds-form-'));
    resetStore(); const first = await source('ATGAAATAA'), second = await source('ATGGGGTAA');
    let live = first; const isCurrent = (value: SelectedCdsSource) => value === live;
    const test = terminal(<SelectedCdsView source={first} isCurrentSource={isCurrent} onClose={() => {}} />);
    const abandoned = join(directory, 'abandoned.fna');
    try {
      await waitFor(() => test.last().includes('[Summary]'), test.output);
      test.input('d'); await waitFor(() => test.last().includes('destination:'), test.output);
      test.input(abandoned); await pause();
      live = second;
      // The synchronous source guard wins even before a replacement render.
      test.input('\r'); await pause();
      await assert.rejects(stat(abandoned), /ENOENT/);
      test.ui.rerender(<SelectedCdsView source={second} isCurrentSource={isCurrent} onClose={() => {}} />);
      await waitFor(() => test.last().includes('[Summary]'), test.output);
      test.input('\r'); await pause(); await assert.rejects(stat(abandoned), /ENOENT/);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(saveSelectedCdsExport(abandoned, { content: 'old payload', filename: 'old', mimeType: 'text/plain' }, controller.signal, () => true), /cancelled/);
      await assert.rejects(stat(abandoned), /ENOENT/);
      await assert.rejects(saveSelectedCdsExport(abandoned, { content: 'old payload', filename: 'old', mimeType: 'text/plain' }, new AbortController().signal, () => false), /changed/);
      await assert.rejects(stat(abandoned), /ENOENT/);
      assert.equal(dnaOf(await exportTo(test, 'd', join(directory, 'current.fna'))), second.sequence);
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });

  it('lets Escape cancel pending inspection and leaves unannotated FASTA without an inferred protein', async () => {
    const previous = usePhageStore.getState(); resetStore(); const accepted = await source('ATGAAATAA');
    let returned = 0, release!: (value: SelectedCdsResult) => void;
    const pending = new Promise<SelectedCdsResult>(resolve => { release = resolve; });
    const test = terminal(<SelectedCdsView source={accepted} isCurrentSource={() => true} onClose={() => { returned++; }} prepare={() => pending} />);
    try {
      await waitFor(test.ready);
      test.input('\u001b'); await waitFor(() => returned === 1);
      test.ui.unmount(); release(await prepareSelectedCds(accepted, accepted.phage.genes[0])); await pause();
      const empty = { ...accepted, phage: { ...accepted.phage, genes: [] } };
      const unannotated = terminal(<SelectedCdsView source={empty} isCurrentSource={() => true} onClose={() => {}} />);
      try {
        await waitFor(() => unannotated.last().includes('No annotated CDS is available'), unannotated.output);
        unannotated.input('p'); await pause(); assert(!unannotated.last().includes('destination:'));
        assert.match(unannotated.last(), /No protein has been inferred/);
      } finally { unannotated.ui.unmount(); }
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });
});
