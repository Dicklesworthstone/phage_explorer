import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { createAnalysisRecord } from '../../core/src/analysis-result';
import { serializeCommandPlan, parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
import { parseWorkflowResults, workflowResultIndex, workflowAnalysisAt } from '../../core/src/workflow-results';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { recordResearchPlan, replayResearchTape, replayResearchResults } from './research-replay';

async function plan() {
  const { genomes } = await importLocalGenomes({ name: 'synthetic.fa', text: '>row\nAACC\n>column\nCCAATT\n>circle [topology=circular]\nGAATTCAA\n' });
  const [row, column, circle] = genomes.map(g => g.phage.localGenome!.contentId);
  const view = { contentId: row, geneId: null, viewMode: 'dna', readingFrame: 0, scrollPosition: 0 };
  return serializeCommandPlan({ format: 'phage-explorer-command-plan', version: 1, name: 'Synthetic complete run',
    context: { bundle: exportLocalGenomeBundle(genomes) }, commands: [
      { actionId: ActionIds.NavGoto, parameters: view },
      { actionId: ActionIds.OverlayDotPlot, parameters: { contentId: row, comparisonContentId: null, bins: 2, window: 2 } },
      { actionId: ActionIds.OverlayDotPlot, parameters: { contentId: row, comparisonContentId: column, bins: 3, window: 2 } },
      { actionId: ActionIds.OverlayGel, parameters: { contentId: circle, enzymes: ['EcoRI'], topology: 'circular' } },
      { actionId: ActionIds.NavGoto, parameters: { ...view, scrollPosition: 1 } },
    ] });
}

describe('complete mixed-workflow results', () => {
  it('retains all three numerical results and all ten executions, without relabeling navigation', async () => {
    const recorded = await recordResearchPlan(await plan());
    assert.equal(recorded.allResultsJson, undefined);
    const result = await replayResearchTape(recorded.tapeJson, { repetitions: 2, captureResults: true });
    const archive = await parseWorkflowResults(result.allResultsJson!);
    assert.equal(archive.records.length, 3);
    assert.deepEqual(archive.records[0].fields.direct.value, [1,0,0,1]);
    assert.deepEqual(archive.records[1].fields.direct.value, [0,1,0,.5,.5,0,1,0,0]);
    assert.deepEqual(archive.records[2].fields.cutSites.value, [1]);
    assert.deepEqual(archive.records[2].fields.fragments.value, [{ start: 1, end: 1, length: 8, wrapsOrigin: true }]);
    assert.equal(workflowResultIndex(archive.tapeJson, 2).length, 10);
    assert.equal(workflowAnalysisAt(archive, 8).resultId, archive.records[1].resultId);
    assert.throws(() => workflowAnalysisAt(archive, 10), /navigation/);
    const replay = await replayResearchResults(result.allResultsJson!);
    assert.equal(replay.archiveJson, result.allResultsJson);
    assert.equal(replay.report.lastAnalysisExecution, 9);
  });
  it('authors an archive without claiming verification and preserves legacy default outputs', async () => {
    const content = await plan();
    const plain = await recordResearchPlan(content), recorded = await recordResearchPlan(content, { captureResults: true });
    assert.equal(recorded.tapeJson, plain.tapeJson); assert.equal('verified' in recorded.report, false);
    const archive = await parseWorkflowResults(recorded.allResultsJson!);
    assert.equal(archive.tapeJson, recorded.tapeJson); assert.equal(archive.repetitions, 1); assert.equal(archive.records.length, 3);
    const replay = await replayResearchTape(recorded.tapeJson);
    assert.equal(replay.allResultsJson, undefined); assert.equal(replay.lastAnalysis!.resultId, archive.records[2].resultId);
    assert.equal((await replayResearchResults(recorded.allResultsJson!)).report.verified, true);
  });
  it('rejects rehashed false earlier evidence even when archive and tape identities agree', async () => {
    const recorded = await recordResearchPlan(await plan(), { captureResults: true });
    const archive = await parseWorkflowResults(recorded.allResultsJson!);
    const copy = structuredClone(archive.records[1]); (copy.fields.direct.value as number[])[0] = 1;
    const changed = await createAnalysisRecord({ ...copy, inputs: copy.inputs }); archive.records[1] = changed;
    const tape = parseCommandTape(archive.tapeJson);
    tape.commands[2].expected = { method: changed.method, cacheKey: changed.cacheKey, resultId: changed.resultId };
    archive.tapeJson = serializeCommandTape(tape); const content = JSON.stringify(archive);
    await parseWorkflowResults(content); // Integrity alone passes: numerical replay must still fail.
    let completed = 0;
    await assert.rejects(replayResearchResults(content, { onProgress: p => { completed = p.completed; } }), /Step 3.*differs/);
    assert.equal(completed, 2);
  });
  it('returns no archive after cancellation and supports a complete navigation-only run', async () => {
    const recorded = await recordResearchPlan(await plan()), controller = new AbortController();
    await assert.rejects(replayResearchTape(recorded.tapeJson, { captureResults: true, signal: controller.signal,
      onProgress: p => { if (p.completed === 2) controller.abort(); } }), { name: 'AbortError' });
    const tape = parseCommandTape(recorded.tapeJson); tape.commands = [tape.commands[0]];
    const navigation = await replayResearchTape(serializeCommandTape(tape), { captureResults: true });
    assert.equal(navigation.lastAnalysis, null);
    assert.deepEqual((await parseWorkflowResults(navigation.allResultsJson!)).records, []);
    assert.equal((await replayResearchResults(navigation.allResultsJson!)).report.completed, 1);
  });
});
