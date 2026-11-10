import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisJson, serializeAnalysisRecord, parseAnalysisRecord } from '../../core/src/analysis-result';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { parseCommandTape, serializeCommandTape, serializeCommandPlan } from '../../core/src/command-session';
import { parseWorkflowResults, workflowAnalysisAt, workflowResultIndex } from '../../core/src/workflow-results';
import { createMosaicExperiment, mosaicResultFromRecord, exportMosaicTsv, MOSAIC_METHOD } from '../../core/src/analysis/recombination-radar';
import { ResearchWorkflow, researchMosaicParameters, researchMosaicDataset, validateResearchMosaic,
  type ResearchEnvironment, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { executeResearchRequest } from '../../web/src/workers/research-workflow.worker';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { inspectResearchTape, recordResearchPlan, replayResearchTape, replayResearchResults } from './research-replay';
import { researchWorkflowMain } from '../../../scripts/research-workflow';

const ids = { view: ActionIds.NavGoto, repeats: ActionIds.OverlayRepeats, codons: ActionIds.OverlayCodonAdaptation,
  mosaic: ActionIds.OverlayMosaicRadar };
const source = '>query\nAAAC\n>reference\nAAGT\n>reverse-complement reference\nACTT\n>ambiguous query\nNNNN\n';
async function fixture(overrides: Partial<ResearchEnvironment> = {}) {
  const imported = await importLocalGenomes({ name: 'mosaic-sources.fa', text: source });
  let loaded = structuredClone(imported.genomes), view: ResearchView | null = null, calculations = 0;
  const contentIds = imported.genomes.map(genome => genome.phage.localGenome!.contentId);
  const environment: ResearchEnvironment = {
    genomes: () => loaded, bundle: () => exportLocalGenomeBundle(loaded),
    parseBundle: text => importLocalGenomes({ name: 'workflow.json', text }), currentView: () => view,
    applyView: async (next, signal) => { assert(!signal.aborted); view = structuredClone(next); },
    repeats: async () => { throw new Error('Unexpected repeats'); }, codons: async () => { throw new Error('Unexpected codons'); },
    mosaic: async (dataset, options) => {
      calculations++;
      const reply = await executeResearchRequest({ type: 'mosaic', dataset, options });
      assert(reply.type === 'analysis'); return reply.record;
    }, ...overrides,
  };
  const workflow = new ResearchWorkflow(ids, environment);
  const parameters = researchMosaicParameters(contentIds[0], [contentIds[1]], { k: 2, window: 200, step: 100, minSimilarity: 0 });
  const navigation: ResearchView = { contentId: contentIds[0], viewMode: 'dna', readingFrame: 0, scrollPosition: 0, geneId: null };
  return { workflow, environment, parameters, navigation, contentIds, genomes: imported.genomes, calculations: () => calculations,
    replace: (next: typeof loaded) => { loaded = next; } };
}
async function recorded() {
  const f = await fixture(); f.workflow.start('Reference similarity at two thresholds');
  await f.workflow.commands.dispatch(ids.view, analysisJson(f.navigation));
  await f.workflow.commands.dispatch(ids.mosaic, analysisJson(f.parameters));
  const matched = f.workflow.getSnapshot().result!;
  await f.workflow.commands.dispatch(ids.mosaic, analysisJson({ ...f.parameters, options: { ...f.parameters.options, minSimilarity: 1 } }));
  const below = f.workflow.getSnapshot().result!;
  await f.workflow.commands.dispatch(ids.view, analysisJson({ ...f.navigation, scrollPosition: 2 }));
  f.workflow.commands.stop();
  return { ...f, matched, below, tapeJson: f.workflow.commands.export() };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('Mosaic commands use exact bundled inputs across browser and terminal hosts', () => {
  it('records an independent Jaccard oracle and replays a mixed tape without relabeling the last analysis as navigation', async () => {
    const f = await recorded(), result = mosaicResultFromRecord(f.matched);
    // Explicit strand-canonical sets: AAAC -> {AA, AC}; AAGT -> {AA, AG, AC}.
    assert.equal(result.windows[0].score, 2 / 3);
    assert.equal(result.windows[0].status, 'matched');
    assert.deepEqual(result.coverage, { matched: 4, ambiguous: 0, 'below-threshold': 0, 'no-evidence': 0 });
    assert.equal(mosaicResultFromRecord(f.below).windows[0].status, 'below-threshold');
    assert.equal(f.workflow.getSnapshot().result, null);
    assert.equal(f.workflow.getSnapshot().lastAnalysis!.resultId, f.below.resultId);
    const tape = parseCommandTape(f.tapeJson);
    assert.deepEqual(tape.commands[1].parameters, analysisJson(f.parameters));
    assert.deepEqual(f.matched.method, MOSAIC_METHOD);
    assert(!JSON.stringify(tape.commands[1].parameters).includes('AAAC'));
    const inspection = await inspectResearchTape(f.tapeJson); assert(inspection.canReplay);
    const replay = await replayResearchTape(f.tapeJson, { repetitions: 2 });
    assert.equal(replay.report.completed, 8); assert.equal(replay.report.lastAnalysisExecution, 7);
    assert.equal(replay.report.finalView!.scrollPosition, 2);
    assert.deepEqual(replay.lastAnalysis, f.below);
    const browser = await fixture(); browser.workflow.load(f.tapeJson); await browser.workflow.commands.replay(2);
    assert.deepEqual(browser.workflow.getSnapshot().lastAnalysis, f.below);
  });

  it('authors the same canonical tape from a plan and round-trips every complete result and repeated execution', async () => {
    const f = await recorded(), tape = parseCommandTape(f.tapeJson);
    const plan = serializeCommandPlan({ ...tape, format: 'phage-explorer-command-plan',
      commands: tape.commands.map(({ actionId, parameters }) => ({ actionId, parameters })) });
    const authored = await recordResearchPlan(plan, { captureResults: true });
    assert.equal(authored.tapeJson, f.tapeJson);
    const archive = await parseWorkflowResults(await f.workflow.replayWithResults(2));
    assert.equal(archive.records.length, 2); assert.equal(workflowResultIndex(archive.tapeJson, archive.repetitions).length, 8);
    assert.deepEqual(workflowAnalysisAt(archive, 2), f.matched);
    assert.deepEqual(workflowAnalysisAt(archive, 6), f.matched);
    assert.deepEqual(workflowAnalysisAt(archive, 7), f.below);
    assert.throws(() => workflowAnalysisAt(archive, 8), /navigation/);
    const fresh = await replayResearchResults(JSON.stringify(archive));
    assert.equal(fresh.report.completed, 8);
    assert.deepEqual(await parseWorkflowResults(fresh.archiveJson), archive);
    assert(exportMosaicTsv(workflowAnalysisAt(archive, 2)).includes('0.6666666666666666'));
  });

  it('keeps ties and absent evidence distinct, including an explicit empty reference panel', async () => {
    const f = await fixture(); f.workflow.start('Unresolved controls');
    const run = async (query: string, references: string[]) => {
      await f.workflow.commands.dispatch(ids.mosaic, analysisJson(researchMosaicParameters(query, references, f.parameters.options)));
      return mosaicResultFromRecord(f.workflow.getSnapshot().result!);
    };
    const tied = await run(f.contentIds[0], [f.contentIds[1], f.contentIds[2]]);
    assert.equal(tied.windows[0].status, 'ambiguous'); assert.equal(tied.windows[0].donor, null);
    assert.equal(tied.windows[0].score, 2 / 3); assert.equal(tied.coverage.ambiguous, 4);
    const unknown = await run(f.contentIds[3], [f.contentIds[1]]);
    assert.equal(unknown.windows[0].status, 'no-evidence'); assert.equal(unknown.coverage['no-evidence'], 4);
    const empty = await run(f.contentIds[0], []);
    assert.equal(empty.windows.length, 0); assert.equal(empty.coverage['no-evidence'], 4);
  });

  it('validates the whole tape before parsing inputs, and rejects implicit or noncanonical selections and settings', async () => {
    const f = await recorded();
    for (const bad of [
      { ...f.parameters, referenceContentIds: [f.contentIds[0]] },
      { ...f.parameters, referenceContentIds: [f.contentIds[1], f.contentIds[1]] },
      { ...f.parameters, referenceContentIds: [...f.contentIds.slice(1)].sort().reverse() },
      { ...f.parameters, referenceContentIds: ['not-a-content-id'] },
      { ...f.parameters, options: { k: 2 } },
      { ...f.parameters, options: { ...f.parameters.options, step: 201 } },
      { ...f.parameters, options: { ...f.parameters.options, approximate: true } },
      { ...f.parameters, file: '/never/read' },
    ]) assert.throws(() => validateResearchMosaic(analysisJson(bad)));
    let reads = 0;
    const next = await fixture({ parseBundle: async () => { reads++; throw new Error('Must not parse'); } });
    const changed = parseCommandTape(f.tapeJson);
    changed.commands[2].parameters = analysisJson({ ...f.parameters, options: { k: 2 } });
    assert.throws(() => next.workflow.load(serializeCommandTape(changed)), /Step 3/);
    assert.equal(reads, 0);
    assert.throws(() => new ResearchWorkflow({ ...ids, mosaic: ids.codons }, f.environment), /distinct/);
    assert.throws(() => new ResearchWorkflow(ids, { ...f.environment, mosaic: undefined }), /together/);
  });

  it('binds complete source slices and rejects missing, foreign or modified bundled references', async () => {
    const f = await fixture(); f.workflow.start('Strict inputs');
    const dataset = researchMosaicDataset(f.genomes, f.parameters);
    assert.equal(dataset.query.sourceLength, 4); assert.equal(dataset.query.sourceStart, 0);
    assert.equal(dataset.references[0].sequence, 'AAGT'); assert.equal(dataset.references[0].source, 'local');
    const outside = researchMosaicParameters(f.contentIds[0], ['f'.repeat(64)], f.parameters.options);
    await assert.rejects(f.workflow.commands.dispatch(ids.mosaic, analysisJson(outside)), /outside the recorded/);
    f.replace(f.genomes.filter(genome => genome.phage.localGenome!.contentId !== f.contentIds[1]));
    await assert.rejects(f.workflow.commands.dispatch(ids.mosaic, analysisJson(f.parameters)), /Missing local genome/);
    const changed = structuredClone(f.genomes); changed[1].sequence = 'CCCC'; f.replace(changed);
    await assert.rejects(f.workflow.commands.dispatch(ids.mosaic, analysisJson(f.parameters)), /changed sequence/);
    assert.equal(f.calculations(), 0); assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
  });

  it('rejects validly hashed output for another query, panel or effective setting before recording it', async () => {
    for (const change of ['query', 'reference', 'options'] as const) {
      const f = await fixture({ mosaic: async (dataset, options) => {
        if (change === 'query') dataset.query.sequence = 'CCCC';
        if (change === 'reference') dataset.references[0].sequence = 'CCCC';
        if (change === 'options') options.minSimilarity = 1;
        return (await createMosaicExperiment(dataset, options)).record;
      } });
      f.workflow.start('Worker source binding');
      await assert.rejects(f.workflow.commands.dispatch(ids.mosaic, analysisJson(f.parameters)), /does not match/);
      assert.equal(f.workflow.getSnapshot().result, null); assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
    }
  });

  it('refuses changed recorded expectations and cannot publish a cancelled or superseded calculation', async () => {
    const saved = await recorded(), changed = parseCommandTape(saved.tapeJson);
    (changed.commands[1].expected as { resultId: string }).resultId = '0'.repeat(64);
    await assert.rejects(replayResearchTape(serializeCommandTape(changed)), /Step 2.*differs/);
    const started = latch(), held = latch();
    const f = await fixture({ mosaic: async (dataset, options) => {
      started.release(); await held.promise; return (await createMosaicExperiment(dataset, options)).record;
    } });
    f.workflow.start('Cancellation');
    const pending = f.workflow.commands.dispatch(ids.mosaic, analysisJson(f.parameters)); await started.promise;
    f.workflow.commands.cancel(); await assert.rejects(pending, { name: 'AbortError' }); held.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.workflow.getSnapshot().result, null); assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
    await f.workflow.commands.dispatch(ids.mosaic, analysisJson(f.parameters));
    assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 1);
  });

  it('runs record, complete replay and execution extraction through the real native worker and CLI', async () => {
    const f = await recorded(), tape = parseCommandTape(f.tapeJson), directory = await mkdtemp(join(tmpdir(), 'phage-mosaic-tape-'));
    const planPath = join(directory, 'plan.json'), output = join(directory, 'recorded.json'), archive = join(directory, 'all-results.json'), extracted = join(directory, 'selected.json');
    await writeFile(planPath, serializeCommandPlan({ ...tape, format: 'phage-explorer-command-plan',
      commands: tape.commands.map(({ actionId, parameters }) => ({ actionId, parameters })) }));
    const cli = async (args: string[]) => {
      let stdout = '', stderr = '';
      const code = await researchWorkflowMain(args, text => { stdout += text; }, text => { stderr += text; });
      assert.equal(code, 0, stderr); assert(!stdout.includes('AAAC')); assert(!stderr.includes('AAGT'));
      return JSON.parse(stdout);
    };
    await cli(['record', '--input', planPath, '--output', output]);
    assert.equal(await readFile(output, 'utf8'), f.tapeJson);
    await cli(['replay', '--input', output, '--repetitions', '2', '--results', '--output', archive]);
    await cli(['extract-result', '--input', archive, '--execution', '2', '--output', extracted]);
    assert.deepEqual(await parseAnalysisRecord(await readFile(extracted, 'utf8')), f.matched);
    const tsv = join(directory, 'selected.tsv');
    await cli(['replay-experiment', '--input', extracted, '--format', 'tsv', '--output', tsv]);
    assert((await readFile(tsv, 'utf8')).includes('0.6666666666666666'));
    assert.equal(serializeAnalysisRecord(workflowAnalysisAt(await parseWorkflowResults(await readFile(archive, 'utf8')), 7)), serializeAnalysisRecord(f.below));
  });
});
