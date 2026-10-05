import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { ResearchWorkflow, researchPangenomeParameters, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { executePangenomeRequest } from '../../web/src/workers/PangenomeSession';
import { analysisJson, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
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
