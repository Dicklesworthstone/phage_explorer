import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usePhageStore } from '@phage-explorer/state';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../../core/src/genome-import';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';
import { ActionIds } from '../../../web/src/keyboard/actionRegistry';
import { recordResearchPlan, inspectResearchTape } from '../research-replay';
import { runTerminalResearchWorker } from '../../../../scripts/research-workflow';
import { TerminalGenomeSession } from '../local-genome-session';
import { TerminalResearchSession } from '../terminal-research-session';
import { installTerminalGenomes } from './LocalGenomeApp';
import { ResearchWorkflowView } from './ResearchWorkflowView';

async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Terminal research view did not reach its expected state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const imported = await importLocalGenomes({ name: 'private.gb',
    text: 'LOCUS       joined                    18 bp    DNA     linear\nACCESSION   joined\n'
      + 'FEATURES             Location/Qualifiers\n     CDS             complement(join(1..6,13..18))\n'
      + '                     /gene="joined"\nORIGIN\n        1 atgaaacccgggtttcat\n//\n' });
  const genome = imported.genomes[0], id = genome.phage.localGenome!.contentId;
  const view = { contentId: id, geneId: genome.phage.genes[0].id, viewMode: 'aa' as const, readingFrame: -2 as const, scrollPosition: 3 };
  const recorded = await recordResearchPlan(JSON.stringify({
    format: 'phage-explorer-command-plan', version: 1, name: 'Terminal replay fixture',
    context: { bundle: exportLocalGenomeBundle(imported.genomes) },
    commands: [
      { actionId: ActionIds.OverlayGCSkew, parameters: { contentId: id, windowSize: 4, stepSize: 4 } },
      { actionId: ActionIds.NavGoto, parameters: view },
    ],
  }));
  const directory = await mkdtemp(join(tmpdir(), 'phage-ink-workflow-'));
  const file = join(directory, 'quite private replay.json'), output = join(directory, 'selected.json');
  await writeFile(file, recorded.tapeJson, { flag: 'wx', mode: 0o600 });
  return { file, output, tape: recorded.tapeJson, view };
}
function terminal(session: TerminalResearchSession, genomes: TerminalGenomeSession, onReturn: () => void, onReviewGenomes: () => void) {
  let output = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }), { columns: 100, rows: 30 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (_raw: boolean) => { ready = true; }, ref() {}, unref() {} });
  const ui = render(<ResearchWorkflowView session={session} genomes={genomes} onReturn={onReturn} onReviewGenomes={onReviewGenomes} />, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  return { ui, input: (value: string) => stdin.write(value), output: () => output, ready: () => ready,
    resize: (rows: number) => { stdout.rows = rows; stdout.emit('resize'); } };
}
describe('Ink research workflow workspace', () => {
  it('opens without filename shortcuts, replays, inspects and exports a result, then stages the final view', async () => {
    const previous = usePhageStore.getState(), f = await fixture();
    usePhageStore.setState({ phages: [], currentPhage: null, currentPhageIndex: 0, selectedGeneId: null });
    const session = new TerminalResearchSession(), genomes = new TerminalGenomeSession(null);
    let returned = 0, review = 0;
    const test = terminal(session, genomes, () => { returned++; }, () => { review++; });
    try {
      await waitFor(test.ready);
      test.input('o'); await waitFor(() => test.output().includes('Workflow or complete archive path:'));
      test.input(f.file); await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(returned, 0); assert.equal(session.getSnapshot().completedRun, null);
      test.input('\r');
      await waitFor(() => session.getSnapshot().document !== null && session.getSnapshot().busy === null);
      await waitFor(() => test.output().includes('supported for terminal replay'));
      assert.equal(usePhageStore.getState().currentPhage, null);
      test.input('r');
      await waitFor(() => session.getSnapshot().completedRun !== null && session.getSnapshot().busy === null);
      await waitFor(() => test.output().includes('Ordered results'));
      assert.equal(session.entries()[1].analysis, null);
      assert.equal(genomes.getSnapshot().localCount, 0);
      test.input('\r'); await waitFor(() => test.output().includes('result fields'));
      assert(test.output().includes('sequence-gc-skew'));
      test.resize(18); await waitFor(() => test.output().includes('Lines 1–3'));
      test.input('e'); await waitFor(() => test.output().includes('New analysis destination (execution 1)'));
      test.input(f.output); await new Promise(resolve => setTimeout(resolve, 30)); test.input('\r');
      await waitFor(() => session.getSnapshot().notice?.startsWith('Saved the analysis') ?? false);
      assert.equal((await parseAnalysisRecord(await readFile(f.output, 'utf8'))).resultId, session.analysis(1).resultId);
      test.input('g'); await waitFor(() => review === 1);
      assert.equal(returned, 0); assert.equal(genomes.getSnapshot().localCount, 0);
      assert.equal(usePhageStore.getState().currentPhage, null);
      assert.equal(genomes.getSnapshot().reviewGeneId, f.view.geneId);
      assert.equal(await genomes.accept(false, installTerminalGenomes), true);
      const installed = usePhageStore.getState();
      assert.equal(installed.currentPhage?.localGenome?.contentId, f.view.contentId);
      assert.equal(installed.selectedGeneId, f.view.geneId);
      assert.equal(installed.viewMode, 'aa'); assert.equal(installed.readingFrame, -2); assert.equal(installed.scrollPosition, 3);
    } finally { test.ui.unmount(); session.cancel(); await genomes.close(); usePhageStore.setState(previous); }
  });

  it('Escape cancels an outstanding replay before a second Escape returns, and late work cannot publish', async () => {
    const f = await fixture(), genomes = new TerminalGenomeSession(null);
    let deliver!: (value: Awaited<ReturnType<typeof runTerminalResearchWorker>>) => void;
    let pending = false;
    const session = new TerminalResearchSession({ run: (...args) => {
      if (args[0].type === 'replay') { pending = true; return new Promise(resolve => { deliver = resolve; }); }
      return runTerminalResearchWorker(...args);
    } });
    assert(await session.load(f.file));
    let returned = 0;
    const test = terminal(session, genomes, () => { returned++; }, () => assert.fail('cancelled replay cannot stage inputs'));
    try {
      await waitFor(test.ready);
      test.input('r'); await waitFor(() => pending && session.getSnapshot().busy === 'replaying');
      test.input('\u001b'); await waitFor(() => session.getSnapshot().busy === null);
      assert.equal(returned, 0);
      deliver({ type: 'inspection', inspection: await inspectResearchTape(f.tape) });
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(session.getSnapshot().completedRun, null);
      assert.equal(genomes.getSnapshot().review, null);
      test.input('\u001b'); await waitFor(() => returned === 1);
    } finally { test.ui.unmount(); session.cancel(); await genomes.close(); }
  });
});
