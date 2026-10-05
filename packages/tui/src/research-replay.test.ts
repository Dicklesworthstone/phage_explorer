import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { parseWorkflowCommand, researchWorkflowMain, executeWorkflowCommand, runTerminalResearchWorker } from '../../../scripts/research-workflow';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { ResearchWorkflow, researchPangenomeParameters, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { executePangenomeRequest } from '../../web/src/workers/PangenomeSession';
import { analysisJson, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { COMMAND_LIMITS, parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
import { replayAlignmentPangenome } from '../../core/src/analysis/alignment-pangenome';
import { exportCdsConsequenceFasta } from '../../core/src/analysis/cds-consequences';
import { inspectResearchTape, replayResearchTape } from './research-replay';

const ids = { view: ActionIds.NavGoto, repeats: ActionIds.OverlayRepeats,
  codons: ActionIds.OverlayCodonAdaptation, pangenome: ActionIds.OverlayPangenomeGraph };
/** Record through the actual browser-facing adapters/worker producers, not a
 * hand-built tape whose expected values merely mirror terminal report logic.
 */
export async function recordedTerminalFixture(includeCodons = false) {
  const reference = 'ATGAAACCCGGGTAA', query = 'ATGAGACCCGGGTAA';
  const annotated = await importLocalGenomes({ name: 'reference.gb', text:
    `LOCUS       REF 15 bp DNA linear\nACCESSION   REF\nFEATURES             Location/Qualifiers\n     CDS             1..15\n                     /gene="test_cds"\n                     /transl_table=11\nORIGIN\n        1 ${reference}\n//\n` });
  const sample = await importLocalGenomes({ name: 'sample.fa', text: `>REF\n${query}\n` });
  const genomes = [...annotated.genomes, ...sample.genomes];
  let view: ResearchView | null = null;
  const workflow = new ResearchWorkflow(ids, {
    genomes: () => genomes, bundle: () => exportLocalGenomeBundle(genomes),
    parseBundle: content => importLocalGenomes({ name: 'workflow-genomes.json', text: content }),
    currentView: () => view, applyView: async next => { view = structuredClone(next); },
    repeats: async () => { throw new Error('No repeats were requested in this numerical fixture.'); },
    codons: async (genome, geneId) => {
      const { executeResearchRequest } = await import('../../web/src/workers/research-workflow.worker');
      const result = await executeResearchRequest({ type: 'codons', genome, geneId });
      assert.equal(result.type, 'analysis');
      if (result.type !== 'analysis') throw new Error('Expected browser coding evidence.');
      return result.record;
    },
    pangenome: async request => {
      const result = await executePangenomeRequest(request); assert(result.record); return result.record;
    },
  });
  const contentIds = genomes.map(g => g.phage.localGenome!.contentId);
  const navigation: ResearchView = { contentId: contentIds[0], viewMode: 'dual', readingFrame: -1, scrollPosition: 3, geneId: 1 };
  const parameters = researchPangenomeParameters(contentIds, { referenceId: `local-${contentIds[0]}`,
    alignment: 'affine', terminalGaps: 'alleles' }, { contentId: contentIds[0], geneIds: [1] });
  workflow.start('Browser to terminal');
  await workflow.commands.dispatch(ids.view, analysisJson(navigation));
  await workflow.commands.dispatch(ids.pangenome, analysisJson(parameters));
  const graphRecord = workflow.getSnapshot().result!;
  if (includeCodons) await workflow.commands.dispatch(ids.codons, { contentId: contentIds[0], geneId: 1 });
  const codonRecord = workflow.getSnapshot().result!;
  await workflow.commands.dispatch(ids.view, analysisJson({ ...navigation, viewMode: 'aa', scrollPosition: 4 }));
  workflow.commands.stop();
  return { content: workflow.commands.export(), workflow, genomes, navigation, parameters, graphRecord, codonRecord, reference, query };
}

describe('terminal replay of browser research tapes', () => {
  it('legacy codon worker parity uses the unchanged illustrative producer', async () => {
    const f = await recordedTerminalFixture(true), result = await replayResearchTape(f.content);
    assert.equal(result.report.completed, 4); assert.equal(result.report.lastAnalysisExecution, 3);
    assert.deepEqual(result.lastAnalysis, f.codonRecord);
    assert.equal(result.lastAnalysis!.fields.geneScores.kind, 'demo');
  });
  it('inspects private source bundles and canonical action availability without leaking sequence data', async () => {
    const f = await recordedTerminalFixture(), inspection = await inspectResearchTape(f.content);
    assert.equal(inspection.canReplay, true); assert.equal(inspection.steps.length, 3);
    assert.equal(inspection.genomes.length, 2); assert.equal(new Set(inspection.genomes.map(g => g.accession)).size, 1);
    assert.equal(new Set(inspection.genomes.map(g => g.contentId)).size, 2, 'same accession is not the same input');
    assert.match(inspection.tapeSha256, /^[0-9a-f]{64}$/);
    assert(!JSON.stringify(inspection).includes(f.reference)); assert(!JSON.stringify(inspection).includes(f.query));
    assert.equal(f.workflow.commands.getSnapshot().completed, 0);
  });
  it('freshly recomputes annotated affine graphs, tracking final navigation separately', async () => {
    const f = await recordedTerminalFixture(), progress: number[] = [];
    const result = await replayResearchTape(f.content, { onProgress: p => { progress.push(p.completed); } });
    assert.equal(result.report.verified, true); assert.equal(result.report.headless, true);
    assert.equal(result.report.completed, 3); assert.equal(result.report.lastAnalysisExecution, 2);
    assert.deepEqual(result.lastAnalysis, f.codonRecord); assert.notStrictEqual(result.lastAnalysis, f.codonRecord);
    assert.deepEqual(result.report.finalView, { ...f.navigation, viewMode: 'aa', scrollPosition: 4 });
    assert.equal(result.report.steps[1].analysis!.resultId, f.graphRecord.resultId);
    assert.equal(result.report.steps[2].analysis, null);
    assert.deepEqual(progress, [0, 0, 1, 2, 3]);
    assert(!JSON.stringify(result.report).includes(f.reference));
    // Independent short CDS expectation, not only a shared producer/hash assertion.
    const tape = parseCommandTape(f.content); tape.commands = tape.commands.slice(0, 2);
    const graphOnly = await replayResearchTape(serializeCommandTape(tape));
    const fresh = await replayAlignmentPangenome(serializeAnalysisRecord(graphOnly.lastAnalysis!));
    assert.equal(fresh.graph.diagnostics.affine!.pairs[0].score, 4);
    assert.equal(fresh.graph.variants.length, 1); assert.equal(fresh.graph.variants[0].referenceStart, 4);
    assert.equal(fresh.cds!.genes[0].protein, 'MKPG*');
    assert.equal(fresh.cds!.consequences[0].queryProtein, 'MRPG*');
    assert.deepEqual(fresh.cds!.consequences[0].effects, ['amino-acid-change']);
    assert(exportCdsConsequenceFasta(fresh.cds!, 'protein').includes('MRPG*'));
  });
  it('verifies every repetition with absolute execution and step indexes', async () => {
    const f = await recordedTerminalFixture(), result = await replayResearchTape(f.content, { repetitions: 2 });
    assert.equal(result.report.completed, 6); assert.equal(result.report.lastAnalysisExecution, 5);
    assert.deepEqual(result.report.steps.map(s => [s.execution, s.iteration, s.step]),
      [[1,1,1],[2,1,2],[3,1,3],[4,2,1],[5,2,2],[6,2,3]]);
    assert.equal(result.report.steps[1].analysis!.resultId, result.report.steps[4].analysis!.resultId);
  });
  it('supports navigation-only workflows without inventing an analysis output', async () => {
    const f = await recordedTerminalFixture(), tape = parseCommandTape(f.content); tape.commands = [tape.commands[0]];
    const result = await replayResearchTape(serializeCommandTape(tape));
    assert.equal(result.lastAnalysis, null); assert.equal(result.report.lastAnalysisExecution, null);
    assert.deepEqual(result.report.finalView, f.navigation);
  });
  it('rejects unknown actions and backend-bound repeat commands before the first computation', async () => {
    const f = await recordedTerminalFixture();
    for (const actionId of ['process.exec', ids.repeats]) {
      const tape = parseCommandTape(f.content);
      tape.commands.push({ actionId, parameters: { contentId: f.navigation.contentId, minLength: 8, maxGap: 0 }, expected: null });
      const text = serializeCommandTape(tape), inspection = await inspectResearchTape(text);
      assert.equal(inspection.canReplay, false); assert.equal(inspection.steps[3].supported, false);
      let calls = 0;
      await assert.rejects(replayResearchTape(text, { onProgress: () => { calls++; } }), /Step 4/);
      assert.equal(calls, 0);
    }
  });
  it('rejects an invalid later model before parsing/computing earlier steps', async () => {
    const f = await recordedTerminalFixture(), tape = parseCommandTape(f.content);
    (tape.commands[1].parameters as unknown as typeof f.parameters).options.affinePenalties!.gapExtend = 0;
    let calls = 0;
    await assert.rejects(replayResearchTape(serializeCommandTape(tape), { onProgress: () => { calls++; } }), /Step 2/);
    assert.equal(calls, 0);
  });
  it('refuses altered expected outputs and reports the exact first failing step', async () => {
    const f = await recordedTerminalFixture(), tape = parseCommandTape(f.content);
    (tape.commands[1].expected as { resultId: string }).resultId = '0'.repeat(64);
    const completed: number[] = [];
    await assert.rejects(replayResearchTape(serializeCommandTape(tape), { onProgress: p => { completed.push(p.completed); } }), /Step 2.*differs/);
    assert.deepEqual(completed, [0, 0, 1]);
  });
  it('never resolves stale genome IDs from a different original input or an external catalog', async () => {
    const f = await recordedTerminalFixture(), tape = parseCommandTape(f.content);
    const context = tape.context as { bundle: string };
    const bundle = JSON.parse(context.bundle);
    bundle.inputs[0].text = bundle.inputs[0].text.replace(f.reference, 'CTGAAACCCGGGTAA');
    context.bundle = JSON.stringify(bundle);
    await assert.rejects(replayResearchTape(serializeCommandTape(tape)), /Step 1.*outside/);
    tape.context = { bundle: context.bundle, path: '/private/never-read.gb' };
    await assert.rejects(replayResearchTape(serializeCommandTape(tape)), /exactly.*embedded/);
  });
  it('cancels between commands, rejects already aborted calls and permits a clean subsequent replay', async () => {
    const f = await recordedTerminalFixture(), controller = new AbortController(), completed: number[] = [];
    await assert.rejects(replayResearchTape(f.content, { signal: controller.signal, onProgress: p => {
      completed.push(p.completed); if (p.completed === 1) controller.abort();
    } }), { name: 'AbortError' });
    assert.deepEqual(completed, [0, 0, 1]);
    await assert.rejects(replayResearchTape(f.content, { signal: controller.signal }), { name: 'AbortError' });
    const next = await replayResearchTape(f.content); assert.equal(next.report.completed, 3);
    assert.equal(f.content, f.workflow.commands.export());
  });
  it('enforces repetition and execution limits, and treats empty recordings as inspectable but not executable', async () => {
    const f = await recordedTerminalFixture();
    for (const repetitions of [0, -1, 1.5, 11, NaN]) await assert.rejects(replayResearchTape(f.content, { repetitions }), /1–10/);
    const tape = parseCommandTape(f.content); tape.commands = [];
    assert.equal((await inspectResearchTape(serializeCommandTape(tape))).canReplay, false);
    await assert.rejects(replayResearchTape(serializeCommandTape(tape)), /no recorded/);
    tape.commands = Array.from({ length: 30 }, () => parseCommandTape(f.content).commands[0]);
    await assert.rejects(replayResearchTape(serializeCommandTape(tape), { repetitions: 10 }), /256/);
  });
});

// Filesystem and real worker-thread boundaries of the terminal command. No DOM,
// IndexedDB or browser scheduler is substituted by these tests.

async function diskFixture() {
  const fixture = await recordedTerminalFixture(), directory = await mkdtemp(join(tmpdir(), 'phage-replay-'));
  const input = join(directory, 'workflow.json'), output = join(directory, 'analysis.json');
  await writeFile(input, fixture.content, { flag: 'wx', mode: 0o600 });
  return { ...fixture, directory, input, output };
}

describe('research workflow CLI and isolated computation', () => {
  it('parses explicit bounded options and refuses duplicate, ambiguous or inapplicable flags', () => {
    assert.deepEqual(parseWorkflowCommand(['replay', '--input', 'tape.json', '--progress', '--repetitions', '2', '--output', 'analysis.json']),
      { type: 'replay', input: 'tape.json', repetitions: 2, output: 'analysis.json', timeoutMs: 300000, progress: true });
    assert.equal(parseWorkflowCommand(['--help']).type, 'help');
    for (const args of [[], ['replay'], ['inspect', '--input', 'a', '--progress'], ['replay', '--input', 'a', '--input', 'b'],
      ['replay', '--input', 'a', '--repetitions', '1.5'], ['replay', '--input', 'a', '--timeout-ms', '0'],
      ['replay', '--input', 'a', '--timeout-ms', '3600001'], ['replay', '--input', 'a', '--progress', '--progress'],
      ['inspect', '--input', 'a', '--output', 'b'], ['replay', '--input', 'a', '--force']]) assert.throws(() => parseWorkflowCommand(args));
  });
  it('reparses a browser tape in a real worker and exports the exact verified v5 analysis, not the final view', async () => {
    const f = await diskFixture(), stdout: string[] = [], stderr: string[] = [];
    const code = await researchWorkflowMain(['replay', '--input', f.input, '--output', f.output, '--progress'],
      text => { stdout.push(text); }, text => { stderr.push(text); });
    assert.equal(code, 0, stderr.join('')); assert.equal(stdout.length, 1);
    const report = JSON.parse(stdout[0]); assert.equal(report.completed, 3); assert.equal(report.lastAnalysisExecution, 2);
    assert.equal(report.steps[1].analysis.resultId, f.graphRecord.resultId); assert.equal(report.finalView.viewMode, 'aa');
    const content = await readFile(f.output, 'utf8');
    assert.equal(content, serializeAnalysisRecord(f.graphRecord));
    const fresh = await replayAlignmentPangenome(content);
    assert.equal(fresh.cds!.consequences[0].queryProtein, 'MRPG*');
    if (process.platform !== 'win32') assert.equal((await stat(f.output)).mode & 0o777, 0o600);
    for (const line of stderr) { const p = JSON.parse(line); assert.equal(p.type, 'progress'); assert(!line.includes(f.reference)); }
    assert(!stdout[0].includes(f.reference)); assert(!stdout[0].includes(f.query));
    assert.equal(await readFile(f.input, 'utf8'), f.content);
  });
  it('inspects without running analyses and emits no numerical-success report after verification failure', async () => {
    const f = await diskFixture(), stdout: string[] = [], stderr: string[] = [];
    assert.equal(await researchWorkflowMain(['inspect', '--input', f.input], text => { stdout.push(text); }, text => { stderr.push(text); }), 0);
    assert.equal(JSON.parse(stdout[0]).canReplay, true); assert.equal(stderr.length, 0);
    const tape = parseCommandTape(f.content); (tape.commands[1].expected as { resultId: string }).resultId = '0'.repeat(64);
    const bad = join(f.directory, 'altered.json'); await writeFile(bad, serializeCommandTape(tape), { flag: 'wx' });
    stdout.length = 0;
    const code = await researchWorkflowMain(['replay', '--input', bad, '--output', f.output], text => { stdout.push(text); }, text => { stderr.push(text); });
    assert.equal(code, 1); assert.equal(stdout.length, 0); assert.match(stderr.join(''), /Step 2.*differs/);
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  });
  it('never overwrites existing analysis files or symlinks, including the source tape itself', async () => {
    const f = await diskFixture(), existing = join(f.directory, 'existing.json'); await writeFile(existing, 'retain me', { flag: 'wx' });
    const paths = [existing, f.input];
    if (process.platform !== 'win32') { const link = join(f.directory, 'link.json'); await symlink(existing, link); paths.push(link); }
    for (const output of paths) {
      const command = parseWorkflowCommand(['replay', '--input', f.input, '--output', output]);
      assert(command.type === 'replay'); await assert.rejects(executeWorkflowCommand(command), { code: 'EEXIST' });
    }
    assert.equal(await readFile(existing, 'utf8'), 'retain me'); assert.equal(await readFile(f.input, 'utf8'), f.content);
  });
  it('handles navigation-only replay without inventing a file and refuses nonregular, oversized or invalid UTF-8 inputs', async () => {
    const f = await diskFixture(), tape = parseCommandTape(f.content); tape.commands = [tape.commands[0]];
    const nav = join(f.directory, 'navigation.json'); await writeFile(nav, serializeCommandTape(tape), { flag: 'wx' });
    let out = '';
    assert.equal(await researchWorkflowMain(['replay', '--input', nav], text => { out += text; }, () => {}), 0);
    assert.equal(JSON.parse(out).lastAnalysisExecution, null);
    assert.equal(await researchWorkflowMain(['replay', '--input', nav, '--output', f.output], () => { assert.fail('No success output'); }, () => {}), 1);
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
    const invalid = join(f.directory, 'invalid.json'); await writeFile(invalid, new Uint8Array([255, 254]), { flag: 'wx' });
    const large = join(f.directory, 'large.json'), handle = await open(large, 'wx');
    try { await handle.truncate(COMMAND_LIMITS.bytes + 1); } finally { await handle.close(); }
    for (const input of [invalid, large, f.directory]) assert.equal(await researchWorkflowMain(['inspect', '--input', input], () => { assert.fail('No success output'); }, () => {}), 1);
  });
  it('cancels a real replay worker without affecting a concurrent replay or creating its output', async () => {
    const f = await diskFixture(), controller = new AbortController();
    const cancelled = parseWorkflowCommand(['replay', '--input', f.input, '--output', f.output]); assert(cancelled.type === 'replay');
    const independent = parseWorkflowCommand(['replay', '--input', f.input, '--repetitions', '2']); assert(independent.type === 'replay');
    const task = executeWorkflowCommand(cancelled, { signal: controller.signal, onProgress: p => { if (p.phase === 'commands') controller.abort(); } });
    const rejected = assert.rejects(task, { name: 'AbortError' });
    const result = await executeWorkflowCommand(independent) as { completed: number };
    await rejected; assert.equal(result.completed, 6); await assert.rejects(stat(f.output), { code: 'ENOENT' });
    assert.equal((await executeWorkflowCommand(independent) as { completed: number }).completed, 6);
  });
  it('terminates a busy thread on timeout and settles worker exits/errors without hanging', async () => {
    const f = await diskFixture(), messages: string[] = [];
    const code = await researchWorkflowMain(['replay', '--input', f.input, '--output', f.output, '--timeout-ms', '20'],
      () => { assert.fail('No success output'); }, text => { messages.push(text); }, { createWorker: () => new Worker('for (;;) {}', { eval: true }) });
    assert.equal(code, 124); assert.match(messages.join(''), /timed out/); await assert.rejects(stat(f.output), { code: 'ENOENT' });
    await assert.rejects(runTerminalResearchWorker({ type: 'inspect', content: f.content }, new AbortController().signal, undefined,
      () => new Worker('process.exit(0)', { eval: true })), /exited.*before/);
    await assert.rejects(runTerminalResearchWorker({ type: 'inspect', content: f.content }, new AbortController().signal, undefined,
      () => new Worker('throw new Error("initialization failed")', { eval: true })), /initialization failed/);
  });
  it('rejects malformed worker replies and honours abort before allocating a thread', async () => {
    const f = await diskFixture(), controller = new AbortController(); controller.abort(); let allocations = 0;
    await assert.rejects(runTerminalResearchWorker({ type: 'inspect', content: f.content }, controller.signal, undefined,
      () => { allocations++; throw new Error('must not start'); }), { name: 'AbortError' });
    assert.equal(allocations, 0);
    await assert.rejects(runTerminalResearchWorker({ type: 'replay', content: f.content, repetitions: 1, exportAnalysis: false }, new AbortController().signal, undefined,
      () => new Worker("require('node:worker_threads').parentPort.on('message',()=>require('node:worker_threads').parentPort.postMessage({type:'replayed',report:{verified:true,completed:0,steps:[]},analysisJson:null}))", { eval: true })), /Unexpected/);
  });
});
