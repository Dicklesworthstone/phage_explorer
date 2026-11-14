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
import { parseCommandPlan, parseCommandTape } from '../../../core/src/command-session';
import { parseWorkflowResults } from '../../../core/src/workflow-results';
import { ActionIds } from '../../../web/src/keyboard/actionRegistry';
import type { ResearchView } from '../../../web/src/keyboard/ResearchWorkflow';
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
  return { file, output, tape: recorded.tapeJson, view, imported, directory };
}
function terminal(session: TerminalResearchSession, genomes: TerminalGenomeSession, onReturn: () => void, onReviewGenomes: () => void,
  captureView?: () => ResearchView | null) {
  let output = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }), { columns: 100, rows: 30 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (_raw: boolean) => { ready = true; }, ref() {}, unref() {} });
  const ui = render(<ResearchWorkflowView session={session} genomes={genomes} onReturn={onReturn} onReviewGenomes={onReviewGenomes} captureView={captureView} />, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  return { ui, input: (value: string) => stdin.write(value), output: () => output, ready: () => ready,
    resize: (rows: number) => { stdout.rows = rows; stdout.emit('resize'); } };
}
describe('Ink research workflow workspace', () => {
  it('authors and edits captured inputs, records a baseline, exports every format, and independently verifies it', async () => {
    const f = await fixture();
    const second = await importLocalGenomes({ name: 'comparison.fa', text: '>comparison\nACGTACGTACGTACGTACGTACGT' });
    const genomes = new TerminalGenomeSession(null, [...f.imported.genomes, ...second.genomes]);
    const session = new TerminalResearchSession();
    let returned = 0;
    const currentView: ResearchView = { ...f.view };
    const test = terminal(session, genomes, () => { returned++; }, () => assert.fail('authoring cannot install genomes'), () => currentView);
    const press = async (key: string, expected: string) => {
      const start = test.output().length; test.input(key);
      await waitFor(() => test.output().slice(start).includes(expected));
    };
    const replace = async (before: string, value: string) => {
      for (const _character of before) { test.input('\u007f'); await new Promise(resolve => setTimeout(resolve, 10)); }
      test.input(value); await new Promise(resolve => setTimeout(resolve, 20));
    };
    try {
      await waitFor(test.ready);
      await press('n', 'New workflow draft name:');
      test.input('quite explicit research'); await new Promise(resolve => setTimeout(resolve, 30)); test.input('\r');
      await waitFor(() => !!session.getSnapshot().draft && !session.getSnapshot().busy);
      await waitFor(() => test.output().includes('Draft: quite explicit research'));
      assert.equal(returned, 0, 'draft names own shortcut letters');
      assert.equal(session.getSnapshot().document, null);
      assert.deepEqual(session.getSnapshot().draft!.initialView, f.view);
      currentView.scrollPosition = 0;

      await press('i', 'Choose a workflow action');
      test.input('\u001b[B'); await new Promise(resolve => setTimeout(resolve, 20));
      await press('\r', 'Choose a captured source genome');
      await press('\r', 'Window size (bases)');
      await replace('18', '4'); await press('\r', 'Step size (bases)');
      await replace('18', '4'); test.input('\r');
      await waitFor(() => session.getSnapshot().draft!.plan.commands.length === 2);
      await press('\r', 'Proposed command parameters');
      assert(test.output().includes('"windowSize": 4'));
      await press('\u001b', '[I] Add');
      test.input('['); await waitFor(() => session.getSnapshot().draft!.plan.commands[0].actionId === ActionIds.OverlayGCSkew);
      test.input(']'); await waitFor(() => session.getSnapshot().draft!.plan.commands[1].actionId === ActionIds.OverlayGCSkew);

      await press('e', 'Choose a workflow action');
      await press('\r', 'Choose a captured source genome');
      await press('\r', 'Window size (bases)');
      await replace('4', '6'); await press('\r', 'Step size (bases)');
      await replace('4', '3'); test.input('\r');
      await waitFor(() => (session.getSnapshot().draft!.plan.commands[1].parameters as Record<string, unknown>).windowSize === 6);
      assert.equal(session.getSnapshot().draft!.plan.commands.length, 2, 'editing replaces one selected command');

      await press('i', 'Choose a workflow action');
      for (let index = 0; index < 5; index++) { test.input('\u001b[B'); await new Promise(resolve => setTimeout(resolve, 10)); }
      await press('\r', 'Choose a captured source genome');
      await press('\r', 'Choose the ordered comparison genome');
      test.input('\u001b[B'); await new Promise(resolve => setTimeout(resolve, 10));
      test.input('\u001b[B'); await new Promise(resolve => setTimeout(resolve, 10));
      await press('\r', 'Display bins (1–256)');
      await replace('64', '8'); await press('\r', 'Comparison window');
      await replace('18', '4'); test.input('\r');
      await waitFor(() => session.getSnapshot().draft!.plan.commands.length === 3);
      assert.deepEqual(session.getSnapshot().draft!.plan.commands[2].parameters, {
        contentId: f.view.contentId, comparisonContentId: second.genomes[0].phage.localGenome!.contentId, bins: 8, window: 4,
      });
      await press('i', 'Choose a workflow action');
      test.input('q'); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(returned, 0, 'an owned editor cannot trigger explorer shortcuts');
      await press('\u001b', '[I] Add');
      assert.equal(session.getSnapshot().draft!.plan.commands.length, 3);
      // Remove the captured navigation step through the keyboard. The original
      // view stays in the source snapshot; no accepted explorer state changes.
      test.input('\u001b[A'); await new Promise(resolve => setTimeout(resolve, 10));
      test.input('\u001b[A'); await new Promise(resolve => setTimeout(resolve, 10));
      test.input('x'); await waitFor(() => session.getSnapshot().draft!.plan.commands.length === 2);
      assert.equal(session.getSnapshot().draft!.plan.commands[0].actionId, ActionIds.OverlayGCSkew);
      assert.deepEqual(session.getSnapshot().draft!.initialView, f.view);

      const planFile = join(f.directory, 'new plan.json'), tapeFile = join(f.directory, 'new tape.json'), archiveFile = join(f.directory, 'new archive.json');
      await press('p', 'New declarative plan destination:');
      test.input(planFile); await new Promise(resolve => setTimeout(resolve, 20)); test.input('\r');
      await waitFor(() => session.getSnapshot().notice?.startsWith('Saved the declarative') ?? false);
      const plan = parseCommandPlan(await readFile(planFile, 'utf8'));
      assert.equal(plan.name, 'quite explicit research'); assert.equal(plan.commands.length, 2);
      assert(plan.commands.every(command => !Object.hasOwn(command, 'expected')));
      test.input('c'); await waitFor(() => !!session.getSnapshot().document && !session.getSnapshot().busy);
      assert.equal(session.availableResults()?.provenance, 'recorded');
      assert.equal(session.getSnapshot().completedRun, null);
      assert.equal(genomes.getSnapshot().review, null);
      await waitFor(() => test.output().includes('New computed baseline; independent replay not run'));
      assert.equal(session.analysis(1).method.id, 'sequence-gc-skew');
      assert.deepEqual(session.analysis(1).parameters, { windowSize: 6, stepSize: 3 });
      assert.equal(session.availableResults()!.archive.records.length, 2);
      await press('t', 'New command recording destination:');
      test.input(tapeFile); await new Promise(resolve => setTimeout(resolve, 20)); test.input('\r');
      await waitFor(() => session.getSnapshot().notice?.startsWith('Saved the accepted command') ?? false);
      assert.equal(parseCommandTape(await readFile(tapeFile, 'utf8')).commands.length, 2);
      await press('a', 'New complete archive destination:');
      test.input(archiveFile); await new Promise(resolve => setTimeout(resolve, 20)); test.input('\r');
      await waitFor(() => session.getSnapshot().notice?.startsWith('Saved the complete') ?? false);
      assert.equal((await parseWorkflowResults(await readFile(archiveFile, 'utf8'))).records.length, 2);
      test.input('r'); await waitFor(() => !!session.getSnapshot().completedRun && !session.getSnapshot().busy);
      assert.equal(session.availableResults()?.provenance, 'verified');
      assert.equal(session.getSnapshot().completedRun!.report.completed, 2);
      assert.equal(returned, 0); assert.equal(genomes.getSnapshot().localCount, 2);
    } finally { test.ui.unmount(); session.cancel(); await genomes.close(); }
  });

  it('offers captured CDS, exact-repeat and digest settings without running them while editing', async () => {
    const f = await fixture(), genomes = new TerminalGenomeSession(null, f.imported.genomes), session = new TerminalResearchSession();
    assert(await session.createDraft('Explicit methods', genomes.exportBundle(), f.view));
    const test = terminal(session, genomes, () => assert.fail('editing cannot leave the workspace'), () => assert.fail('editing cannot restore'));
    const press = async (key: string, expected: string) => {
      const start = test.output().length; test.input(key); await waitFor(() => test.output().slice(start).includes(expected));
    };
    const method = async (index: number) => {
      await press('i', 'Choose a workflow action');
      for (let position = 0; position < index; position++) { test.input('\u001b[B'); await new Promise(resolve => setTimeout(resolve, 10)); }
      await press('\r', 'Choose a captured source genome');
    };
    try {
      await waitFor(test.ready);
      await method(3); await press('\r', 'Choose a captured feature');
      assert(test.output().includes('Host-model scores remain illustrative'));
      test.input('\r'); await waitFor(() => session.getSnapshot().draft!.plan.commands.length === 2);
      assert.deepEqual(session.getSnapshot().draft!.plan.commands[1].parameters, { contentId: f.view.contentId, geneId: f.view.geneId });
      await method(2); await press('\r', 'Exact arm length');
      await press('\r', 'Maximum gap'); await press('\r', 'Maximum reported pairs'); await press('\r', 'Search topology');
      test.input('\r'); await waitFor(() => session.getSnapshot().draft!.plan.commands.length === 3);
      const repeat = session.getSnapshot().draft!.plan.commands[2].parameters as Record<string, unknown>;
      assert.equal(repeat.method, 'exact-pairs'); assert.equal(repeat.armLength, 18);
      assert.equal(repeat.topology, undefined, 'canonical v1 commands omit topology for the explicitly selected linear search');
      await method(4); await press('\r', 'Enzymes (exact names'); await press('\r', 'Molecule topology');
      test.input('\r'); await waitFor(() => session.getSnapshot().draft!.plan.commands.length === 4);
      const digest = session.getSnapshot().draft!.plan.commands[3].parameters as Record<string, unknown>;
      assert.deepEqual(digest.enzymes, ['BamHI', 'EcoRI']); assert.equal(digest.topology, 'linear');
      assert.equal(session.getSnapshot().document, null); assert.equal(session.availableResults(), null);
      assert.equal(genomes.getSnapshot().review, null);
    } finally { test.ui.unmount(); session.cancel(); await genomes.close(); }
  });

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
