import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchWorkflow, validateResearchRepeats, type ResearchEnvironment } from '../../web/src/keyboard/ResearchWorkflow';
import { executeResearchRequest } from '../../web/src/workers/research-workflow.worker';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { analysisJson, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
import { replayExactRepeatRecord, type ExactRepeatPair } from '../../core/src/analysis/exact-repeat-pairs';
import { inspectResearchTape, replayResearchTape } from './research-replay';
import { executeWorkflowCommand } from '../../../scripts/research-workflow';

const ids = { view: 'nav.goto', repeats: 'overlay.repeats', codons: 'overlay.codonAdaptation' };
async function fixture(sequence = 'ACGTNNACGTACGT', maxPairs = 2000) {
  const { genomes } = await importLocalGenomes({ name: 'repeat.fa', text: `>repeat\n${sequence}\n` });
  const env: ResearchEnvironment = {
    genomes: () => genomes, bundle: () => exportLocalGenomeBundle(genomes),
    parseBundle: content => importLocalGenomes({ name: 'workflow-genomes.json', text: content }),
    currentView: () => null, applyView: async () => {},
    repeats: async () => { throw new Error('The portable method must not call the sampled backend.'); },
    codons: async () => { throw new Error('No codon command in this fixture.'); },
    exactRepeats: async (genome, options) => {
      const result = await executeResearchRequest({ type: 'exact-repeats', genome, options });
      assert.equal(result.type, 'analysis');
      if (result.type !== 'analysis') throw new Error('Expected repeat evidence.');
      return result.record;
    },
  };
  const workflow = new ResearchWorkflow(ids, env);
  const parameters = { contentId: genomes[0].phage.localGenome!.contentId, method: 'exact-pairs', armLength: 4, maxGap: 20, maxPairs };
  workflow.start('Portable repeat workflow');
  await workflow.commands.dispatch(ids.repeats, parameters);
  workflow.commands.stop();
  return { workflow, env, genomes, parameters, record: workflow.getSnapshot().result!, content: workflow.commands.export() };
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

describe('portable unsampled repeat recordings', () => {
  it('records with the browser worker producer and freshly verifies the exact same evidence in the terminal', async () => {
    const f = await fixture(), inspection = await inspectResearchTape(f.content);
    assert.equal(inspection.canReplay, true);
    const replay = await replayResearchTape(f.content, { repetitions: 2 });
    assert.equal(replay.report.completed, 2); assert.equal(replay.report.lastAnalysisExecution, 2);
    assert.deepEqual(replay.lastAnalysis, f.record); assert.notStrictEqual(replay.lastAnalysis, f.record);
    const pairs = f.record.fields.pairs.value as unknown as ExactRepeatPair[];
    // Hand-enumerated positions: ACGT at 0,6,10; the latter two arms also touch.
    assert.deepEqual(pairs.map(p => [p.type, p.leftStart, p.rightStart]), [
      ['direct', 0, 6], ['inverted', 0, 6], ['direct', 0, 10], ['direct', 6, 10], ['inverted', 0, 10], ['inverted', 6, 10],
    ]);
    assert.deepEqual(await replayExactRepeatRecord(serializeAnalysisRecord(replay.lastAnalysis!)), f.record);
  });
  it('verifies honestly truncated prefixes and never converts them to complete scans on replay', async () => {
    const f = await fixture('ACGTNNACGTACGT', 1), fresh = await replayResearchTape(f.content);
    assert.equal((fresh.lastAnalysis!.fields.search.value as { complete: boolean }).complete, false);
    assert.equal((fresh.lastAnalysis!.fields.pairs.value as unknown[]).length, 1);
    assert.deepEqual(fresh.lastAnalysis, f.record);
  });
  it('retains legacy repeat rejection before ANY terminal step without accepting an added discriminator as a migration', async () => {
    const f = await fixture(), tape = parseCommandTape(f.content);
    tape.commands.push({ actionId: ids.repeats, parameters: { contentId: f.parameters.contentId, minLength: 4, maxGap: 20 }, expected: null });
    const legacy = serializeCommandTape(tape), progress: unknown[] = [];
    assert.equal((await inspectResearchTape(legacy)).canReplay, false);
    await assert.rejects(replayResearchTape(legacy, { onProgress: p => progress.push(p) }), /Step 2.*browser/);
    assert.equal(progress.length, 0);
    tape.commands = tape.commands.slice(0, 1);
    tape.commands[0].expected = { method: { id: 'sequence-repeats', version: '2', implementation: 'browser' }, resultId: 'a'.repeat(64), cacheKey: 'b'.repeat(64) };
    await assert.rejects(replayResearchTape(serializeCommandTape(tape)), /differs/);
  });
  it('requires complete validated method parameters before recording, including bounds and unknown-field rejection', async () => {
    const f = await fixture();
    for (const edit of [{ armLength: null }, { armLength: 0 }, { method: 'guessed' }, { maxPairs: 0 }, { maxGap: -1 }, { ignored: true }]) {
      assert.throws(() => validateResearchRepeats(analysisJson({ ...f.parameters, ...edit })));
    }
    const tape = parseCommandTape(f.content); delete (tape.commands[0].parameters as Record<string, unknown>).maxPairs;
    await assert.rejects(inspectResearchTape(serializeCommandTape(tape)), /parameters/);
    const unsupportedHost = new ResearchWorkflow(ids, { ...f.env, exactRepeats: undefined });
    assert.throws(() => unsupportedHost.load(f.content), /cannot run exact/);
  });
  it('rejects stale producer results and altered expected identities without replacing accepted evidence', async () => {
    const f = await fixture(), previous = f.workflow.getSnapshot().result;
    f.env.exactRepeats = async () => ({ ...f.record, parameters: { armLength: 5, maxGap: 20, maxPairs: 2000 } });
    await assert.rejects(f.workflow.commands.dispatch(ids.repeats, f.parameters), /does not match/);
    assert.strictEqual(f.workflow.getSnapshot().result, previous);
    f.env.exactRepeats = async (genome, options) => {
      options.armLength = 5;
      const response = await executeResearchRequest({ type: 'exact-repeats', genome, options });
      if (response.type !== 'analysis') throw new Error('Expected analysis.');
      return response.record;
    };
    await assert.rejects(f.workflow.commands.dispatch(ids.repeats, f.parameters), /does not match/);
    assert.strictEqual(f.workflow.getSnapshot().result, previous);
    const tape = parseCommandTape(f.content); (tape.commands[0].expected as Record<string, unknown>).resultId = 'e'.repeat(64);
    await assert.rejects(replayResearchTape(serializeCommandTape(tape)), /differs/);
  });
  it('late cancellation and source changes cannot replace the previously accepted repeat result', async () => {
    for (const changed of [false, true]) {
      const f = await fixture(), pending = deferred<AnalysisRecord>(), started = deferred<void>();
      f.env.exactRepeats = () => { started.resolve(); return pending.promise; };
      const job = f.workflow.commands.dispatch(ids.repeats, f.parameters);
      const rejected = assert.rejects(job, changed ? /changed sequence/ : { name: 'AbortError' });
      await started.promise;
      if (changed) f.genomes[0].sequence = 'G'.repeat(14); else f.workflow.commands.cancel();
      pending.resolve(f.record); await rejected;
      assert.strictEqual(f.workflow.getSnapshot().result, f.record);
    }
  });
  it('replays through a real owned terminal worker and writes only the verified analysis to a new file', async () => {
    const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'phage-exact-repeats-'));
    const input = join(directory, 'workflow.json'), output = join(directory, 'analysis.json');
    await writeFile(input, f.content);
    const report = await executeWorkflowCommand({ type: 'replay', input, output, repetitions: 1, timeoutMs: 30000, progress: false }) as { verified: boolean };
    assert.equal(report.verified, true);
    assert.deepEqual(await replayExactRepeatRecord(await readFile(output, 'utf8')), f.record);
    await assert.rejects(executeWorkflowCommand({ type: 'replay', input, output, repetitions: 1, timeoutMs: 30000, progress: false }), /EEXIST/);
  });
});
