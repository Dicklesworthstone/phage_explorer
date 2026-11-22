import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../../core/src/genome-import';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { createCodonReferenceCorpus } from '../../../core/src/analysis/codon-reference-corpus';
import { replayReferenceCodonExperiment } from '../../../core/src/analysis/codon-reference';
import { parseSpacerLibrary, type ReferenceSpacerHit } from '../../../core/src/analysis/spacer-reference';
import { ActionIds } from '../../../web/src/keyboard/actionRegistry';
import { type ResearchReferenceCodonParameters, type ResearchSpacerParameters } from '../../../web/src/keyboard/ResearchWorkflow';
import { TerminalResearchSession, type TerminalResearchStep } from '../terminal-research-session';
import { ReferenceStepEditor } from './ReferenceStepEditor';

const query = 'ATGGCTGCCTAAATGAAAAAGTAA';
const annotated = { name: 'query.gb', text: 'LOCUS       QUERY 24 bp DNA linear\nACCESSION   QUERY\nFEATURES             Location/Qualifiers\n'
  + '     CDS             1..12\n                     /gene="alpha"\n                     /transl_table=11\n'
  + '     CDS             13..24\n                     /gene="beta"\n                     /transl_table=11\n'
  + `ORIGIN\n        1 ${query}\n//\n` };
const countText = JSON.stringify({ format: 'phage-explorer-codon-reference', version: 1,
  name: 'Hand-counted alanine reference', organism: 'Synthetic control', geneticCode: 11,
  source: { citation: 'Four GCT and one GCC; explicit other synonymous zeros', version: '1' },
  counts: { GCT: 4, GCC: 1, GCA: 0, GCG: 0 } });
const spacer = 'ACGTACGATCGTTAACCGTA';
const spacerText = JSON.stringify({ format: 'phage-explorer-spacer-library', version: 1, name: 'Exact sequence control',
  source: { kind: 'local', reference: 'Hand-defined reference; no immunity claim', version: '1', license: 'CC0', scope: 'Two named control hosts' },
  hosts: [{ id: 'positive', name: 'Known spacer host', strain: 'fixture', accession: 'HOST1' },
    { id: 'empty', name: 'Host without supplied spacers', strain: 'fixture', accession: 'HOST2' }],
  spacers: [{ id: 'guide1', hostId: 'positive', arrayAccession: 'ARRAY1', sequence: spacer, system: null,
    target: 'DNA', orientation: 'guide-equivalent', pam: { side: '3prime', motif: 'NGG', reference: 'Explicit control motif' },
    seed: { start: 0, end: 8, maxMismatches: 0, reference: 'Explicit control interval' } }] });
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
async function waitFor(predicate: () => boolean, details: () => string = () => '') {
  const end = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Reference editor did not reach its expected state. ' + details());
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function terminal(props: React.ComponentProps<typeof ReferenceStepEditor>) {
  let output = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }), { columns: 120, rows: 30 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => { ready = true; }, ref() {}, unref() {} });
  const ui = render(<ReferenceStepEditor {...props} />, { stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false });
  return { ui, output: () => output, ready: () => ready, input: (value: string) => stdin.write(value),
    async press(key: string, expected: string) {
      const start = output.length; stdin.write(key);
      await waitFor(() => output.slice(start).includes(expected), () => output.slice(-1600));
    },
    rerender: (next: React.ComponentProps<typeof ReferenceStepEditor>) => ui.rerender(<ReferenceStepEditor {...next} />) };
}
async function sessionFrom(input = annotated) {
  const imported = await importLocalGenomes(input), session = new TerminalResearchSession();
  assert(await session.createDraft('Reference authoring', exportLocalGenomeBundle(imported.genomes)));
  return { session, imported, draft: session.getSnapshot().draft! };
}

describe('terminal reference-backed workflow editors', () => {
  it('authors count and source-corpus CAI, embeds inputs, and freshly records and replays the hand-calculated score', async () => {
    const source = 'ATG' + 'GCT'.repeat(4) + 'GCC' + 'TAA';
    const corpus = await createCodonReferenceCorpus({ name: 'reference.gb', text:
      `LOCUS       REFERENCE ${source.length} bp DNA linear\nACCESSION   REFERENCE\nFEATURES             Location/Qualifiers\n`
      + `     CDS             1..${source.length}\n                     /transl_table=11\nORIGIN\n        1 ${source}\n//\n` },
    { name: 'Recounted alanine reference', organism: 'Synthetic control', geneticCode: 11, version: '1', citation: 'Four GCT and one GCC' });
    for (const text of [countText, serializeAnalysisRecord(corpus.record)]) {
      const f = await sessionFrom(), directory = await mkdtemp(join(tmpdir(), 'phage-reference-editor-'));
      const input = join(directory, 'reference.json'), archive = join(directory, 'results.json');
      await writeFile(input, text, { flag: 'wx', mode: 0o600 });
      const saved: { step: TerminalResearchStep | null } = { step: null };
      const view = terminal({ kind: 'reference-codons', draft: f.draft, initial: null, rows: 30,
        onSave: step => { f.session.setStep(step); saved.step = step; }, onCancel: () => assert.fail('unexpected cancellation') });
      try {
        await waitFor(view.ready);
        await view.press('\r', 'Load a codon reference or source corpus');
        view.input(input); await pause(); await view.press('\r', 'Choose CDS for reference-relative CAI');
        view.input('\u001b[B'); await pause(); view.input(' '); await pause();
        await view.press('\r', 'Choose the explicit zero-count policy');
        view.input('\u001b[B'); await pause(); view.input('\r'); await waitFor(() => saved.step !== null, view.output);
        const parameters = saved.step!.parameters as unknown as ResearchReferenceCodonParameters;
        assert.equal(saved.step!.actionId, ActionIds.OverlayCodonAdaptation);
        assert.deepEqual(parameters.geneIds, [f.imported.genomes[0].phage.genes[0].id]);
        assert.equal(parameters.referenceText, text); assert.equal(parameters.zeroCountReplacement, 0.5);
        assert.equal(f.session.getSnapshot().document, null, 'editing must not compute a result');
        assert(!view.output().includes(query)); assert(!view.output().includes(source));
        // The filename is not a future data dependency: the embedded reference
        // must still yield sqrt(1 * 1/4) even after the original file changes.
        await writeFile(input, '{}');
        assert(await f.session.recordDraft(), f.session.getSnapshot().error ?? '');
        const analysis = await replayReferenceCodonExperiment(serializeAnalysisRecord(f.session.analysis(1)!));
        assert.equal(analysis.analysis.summary.cai, 0.5);
        assert.equal(analysis.analysis.genes.length, 1);
        assert.equal(analysis.record.inputs.find(item => item.id === 'reference')!.data, text);
        assert(await f.session.save(archive), f.session.getSnapshot().error ?? '');
        const restored = new TerminalResearchSession(); assert(await restored.load(archive));
        assert(await restored.replay(), restored.getSnapshot().error ?? '');
        assert.equal(restored.analysis(1)!.resultId, analysis.record.resultId);
      } finally { view.ui.unmount(); f.session.cancel(); }
    }
  });

  it('edits an embedded reference and exact CDS selection without reading any original path', async () => {
    const f = await sessionFrom();
    const initial: TerminalResearchStep = { actionId: ActionIds.OverlayCodonAdaptation,
      parameters: { method: 'reference-cai', contentId: f.draft.sources[0].contentId, referenceText: countText,
        geneIds: [f.draft.sources[0].genes[0].id], zeroCountReplacement: 0.5 } };
    const saved: { step: TerminalResearchStep | null } = { step: null };
    const view = terminal({ kind: 'reference-codons', draft: f.draft, initial, rows: 30,
      onSave: step => { saved.step = step; }, onCancel: () => assert.fail('unexpected cancellation'),
      readReference: async () => assert.fail('An embedded reference must not reread a file.') });
    try {
      await waitFor(view.ready); await view.press('\r', 'Enter keeps the embedded reference');
      await view.press('\r', 'Choose CDS for reference-relative CAI');
      assert(view.output().includes('[x] alpha'));
      await view.press('\r', 'Choose the explicit zero-count policy');
      view.input('\r'); await waitFor(() => saved.step !== null);
      assert.deepEqual(saved.step, initial);
    } finally { view.ui.unmount(); }
  });

  it('authors an explicit host/PAM/seed spacer search and retains the exact library through native replay', async () => {
    const sequence = 'GG' + spacer + 'AGGTT', f = await sessionFrom({ name: 'query.fa', text: '>QUERY\n' + sequence });
    const directory = await mkdtemp(join(tmpdir(), 'phage-spacer-editor-')), input = join(directory, 'spacers.json');
    await writeFile(input, spacerText, { flag: 'wx', mode: 0o600 });
    const saved: { step: TerminalResearchStep | null } = { step: null };
    const view = terminal({ kind: 'spacers', draft: f.draft, initial: null, rows: 30,
      onSave: step => { f.session.setStep(step); saved.step = step; }, onCancel: () => assert.fail('unexpected cancellation') });
    try {
      await waitFor(view.ready); await view.press('\r', 'Load a sourced spacer library');
      view.input(input); await pause(); await view.press('\r', 'Choose reference-library hosts');
      view.input('\u001b[B'); await pause(); await view.press('\r', 'Choose spacer-search topology');
      view.input('\u001b[B'); await pause(); await view.press('\r', 'Maximum spacer mismatches');
      view.input('\r'); await waitFor(() => saved.step !== null, view.output);
      const parameters = saved.step!.parameters as unknown as ResearchSpacerParameters;
      assert.equal(parameters.hostId, 'positive'); assert.equal(parameters.maxMismatches, 0);
      assert.equal(parameters.topology, 'linear'); assert.equal(parameters.libraryText, spacerText);
      assert(!view.output().includes(spacer)); assert(!view.output().includes(sequence));
      assert.equal(f.session.getSnapshot().document, null);
      assert(await f.session.recordDraft(), f.session.getSnapshot().error ?? '');
      const record = f.session.analysis(1)!;
      const hits = record.fields.matches.value as unknown as ReferenceSpacerHit[];
      const hit = hits.find(item => item.strand === '+' && item.start === 2)!;
      assert(hit); assert.equal(hit.end, 22); assert.equal(hit.protospacer, spacer);
      assert.equal(hit.pam.status, 'matched'); assert.equal(hit.pam.sequence, 'AGG');
      assert.equal(hit.seed.status, 'matched'); assert.equal(record.fields.matches.coverage?.total, 1);
      assert.deepEqual(record.inputs.find(item => item.id === 'spacerLibrary')!.data, parseSpacerLibrary(spacerText));
      assert(await f.session.replay()); assert.equal(f.session.analysis(1)!.resultId, record.resultId);
    } finally { view.ui.unmount(); f.session.cancel(); }
  });

  it('keeps the draft unchanged after an invalid reference and recovers only after a valid replacement', async () => {
    const f = await sessionFrom(); let calls = 0, saved = 0;
    const view = terminal({ kind: 'reference-codons', draft: f.draft, initial: null, rows: 30,
      onSave: () => { saved++; }, onCancel: () => assert.fail('unexpected cancellation'),
      readReference: async () => ++calls === 1 ? '{}' : countText });
    try {
      await waitFor(view.ready); await view.press('\r', 'Load a codon reference');
      view.input('chosen.json'); await pause(); await view.press('\r', 'Codon reference: unsupported or missing fields.');
      assert.equal(saved, 0); assert.equal(f.session.getSnapshot().draft, f.draft);
      await pause(); // Let the file input remount after the failed read settles.
      await view.press('\r', 'Choose CDS for reference-relative CAI');
      await view.press('\r', 'Choose the explicit zero-count policy');
      view.input('\r'); await waitFor(() => saved === 1);
      assert.equal(calls, 2);
    } finally { view.ui.unmount(); }
  });

  it('retires a file read when cancelled or when its captured draft is replaced', async () => {
    for (const replace of [false, true]) {
      const f = await sessionFrom(); let resolve!: (value: string) => void;
      const pending = new Promise<string>(yes => { resolve = yes; });
      const read: { signal: AbortSignal | null } = { signal: null };
      let cancelled = 0, saved = 0;
      const props: React.ComponentProps<typeof ReferenceStepEditor> = { kind: 'reference-codons', draft: f.draft,
        initial: null, rows: 30, onSave: () => { saved++; }, onCancel: () => { cancelled++; },
        readReference: async (_path, supplied) => { read.signal = supplied; return pending; } };
      const view = terminal(props);
      try {
        await waitFor(view.ready); await view.press('\r', 'Load a codon reference');
        view.input('delayed.json'); await pause(); view.input('\r'); await waitFor(() => read.signal !== null);
        if (replace) view.rerender({ ...props, draft: structuredClone(f.draft) });
        else view.input('\u001b');
        await waitFor(() => cancelled === 1); assert(read.signal!.aborted);
        view.ui.unmount(); resolve(countText); await pause();
        assert.equal(saved, 0); assert.equal(f.session.getSnapshot().draft, f.draft);
      } finally { view.ui.unmount(); resolve?.(countText); }
    }
  });
});
