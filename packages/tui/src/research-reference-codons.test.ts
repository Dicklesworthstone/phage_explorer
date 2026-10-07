import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchWorkflow, researchReferenceCodonParameters, validateResearchCodons, type ResearchEnvironment, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { executeResearchRequest } from '../../web/src/workers/research-workflow.worker';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { COMMAND_LIMITS, parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
import { createCodonReferenceCorpus } from '../../core/src/analysis/codon-reference-corpus';
import { replayReferenceCodonExperiment } from '../../core/src/analysis/codon-reference';
import { inspectResearchTape, replayResearchTape } from './research-replay';
import { executeWorkflowCommand, runTerminalResearchWorker } from '../../../scripts/research-workflow';

const ids = { view: 'nav.goto', repeats: 'overlay.repeats', codons: 'overlay.codonAdaptation' };
const counts = JSON.stringify({ format: 'phage-explorer-codon-reference', version: 1, name: 'Count fixture', organism: 'Synthetic',
  geneticCode: 1, source: { citation: 'Hand-defined triplet counts, not expression data', version: '1' }, counts: { AAA: 3, AAG: 1 } });
const gb = (id: string, sequence: string) => ({ name: `${id}.gb`, text:
  `LOCUS       ${id} ${sequence.length} bp DNA linear\nACCESSION   ${id}\nFEATURES             Location/Qualifiers\n     CDS             1..${sequence.length}\nORIGIN\n        1 ${sequence}\n//\n` });
async function sourceReference() {
  return createCodonReferenceCorpus(gb('SOURCE', 'ATGAAAAAAAAAAAGTAA'), {
    name: 'Recounted source fixture', organism: 'Synthetic', geneticCode: 1, version: '1', citation: 'Three AAA and one AAG, independently counted',
  });
}
async function fixture() {
  const { genomes } = await importLocalGenomes(gb('QUERY', 'ATGAAAAAGTAA'));
  let view: ResearchView | null = null;
  const env: ResearchEnvironment = {
    genomes: () => genomes, bundle: () => exportLocalGenomeBundle(genomes),
    parseBundle: content => importLocalGenomes({ name: 'workflow-genomes.json', text: content }),
    currentView: () => view, applyView: async next => { view = next; },
    codons: async () => { throw new Error('Do not substitute illustrative codon profiles.'); },
    repeats: async () => { throw new Error('No repeat command in this fixture.'); },
    referenceCodons: async (genome, referenceText, options) => {
      const result = await executeResearchRequest({ type: 'reference-codons', genome, referenceText, options });
      assert.equal(result.type, 'analysis');
      if (result.type !== 'analysis') throw new Error('Expected numerical evidence.');
      return result.record;
    },
  };
  const workflow = new ResearchWorkflow(ids, env);
  workflow.start('Recorded reference experiment');
  const parameters = researchReferenceCodonParameters(genomes[0].phage.localGenome!.contentId, counts, [1], 0.5);
  const run = (referenceText = counts) => workflow.commands.dispatch(ids.codons, analysisJson({ ...parameters, referenceText }));
  return { env, genomes, workflow, parameters, run };
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe('recorded supplied-reference codon experiments', () => {
  it('records the actual reference and explicit parameters, then recomputes identical CAI in terminal replay', async () => {
    const f = await fixture(); await f.run(); f.workflow.commands.stop();
    const record = f.workflow.getSnapshot().result!, tape = f.workflow.commands.export();
    assert(Math.abs(Number(record.fields.pooledCai.value) - Math.sqrt(1 / 3)) < 1e-12);
    assert.deepEqual(parseCommandTape(tape).commands[0].parameters, f.parameters);
    assert.equal((await inspectResearchTape(tape)).canReplay, true);
    const replay = await replayResearchTape(tape, { repetitions: 2 });
    assert.equal(replay.report.completed, 2); assert.equal(replay.report.lastAnalysisExecution, 2);
    assert.deepEqual(replay.lastAnalysis, record);
    assert.deepEqual((await replayReferenceCodonExperiment(serializeAnalysisRecord(replay.lastAnalysis!))).record, record);
  });
  it('recounts embedded source corpora during worker replay and writes only a completely verified analysis', async () => {
    const f = await fixture(), source = await sourceReference(), text = serializeAnalysisRecord(source.record);
    await f.run(text); f.workflow.commands.stop();
    const dir = await mkdtemp(join(tmpdir(), 'phage-reference-tape-')), input = join(dir, 'tape.json'), output = join(dir, 'analysis.json');
    await writeFile(input, f.workflow.commands.export());
    const report = await executeWorkflowCommand({ type: 'replay', input, output, repetitions: 1, timeoutMs: 30000, progress: false });
    assert.equal('verified' in report && report.verified, true);
    const fresh = await replayReferenceCodonExperiment(await readFile(output, 'utf8'));
    assert.equal(fresh.record.method.version, '2');
    assert.equal(fresh.record.inputs.find(i => i.id === 'reference')!.data, text);
    assert(Math.abs(fresh.analysis.summary.cai! - Math.sqrt(1 / 3)) < 1e-12);
    await assert.rejects(executeWorkflowCommand({ type: 'replay', input, output, repetitions: 1, timeoutMs: 30000, progress: false }), /EEXIST/);
    const tape = parseCommandTape(f.workflow.commands.export()); tape.commands[0].expected = null;
    const forged = join(dir, 'forged.json'), missing = join(dir, 'not-created.json');
    await writeFile(forged, serializeCommandTape(tape));
    await assert.rejects(executeWorkflowCommand({ type: 'replay', input: forged, output: missing, repetitions: 1, timeoutMs: 30000, progress: false }), /differs/);
    await assert.rejects(access(missing));
  });
  it('validates the entire command shape and refuses unavailable hosts rather than falling back to illustration', async () => {
    const f = await fixture();
    for (const change of [{ method: 'guess' }, { geneIds: [] }, { geneIds: [1, 1] }, { geneIds: [-1] },
      { zeroCountReplacement: null }, { referenceText: '/tmp/reference.json' }, { referenceText: '{}' }, { unknown: true }]) {
      assert.throws(() => validateResearchCodons(analysisJson({ ...f.parameters, ...change })));
    }
    const { referenceCodons: _omit, ...oldHost } = f.env;
    const old = new ResearchWorkflow(ids, oldHost); old.start('Legacy host');
    await assert.rejects(old.commands.dispatch(ids.codons, analysisJson(f.parameters)), /cannot run reference-backed/);
    assert.equal(old.commands.getSnapshot().tape.commands.length, 0);
    await assert.rejects(f.workflow.commands.dispatch(ids.codons, analysisJson({ ...f.parameters, geneIds: [999] })), /CDS/);
    assert.equal(f.workflow.getSnapshot().result, null);
  });
  it('rejects changed references, policy and expected identity before applying a replayed result', async () => {
    const f = await fixture(); await f.run(); f.workflow.commands.stop();
    const original = f.workflow.commands.export();
    for (const change of [{ referenceText: counts.replace('"AAG":1', '"AAG":3') }, { zeroCountReplacement: 0 }]) {
      const tape = parseCommandTape(original); tape.commands[0].parameters = analysisJson({ ...f.parameters, ...change });
      await assert.rejects(replayResearchTape(serializeCommandTape(tape)), /differs/);
    }
    const source = await sourceReference();
    const { format: _f, version: _v, cacheKey: _c, resultId: _r, ...forged } = structuredClone(source.record);
    (forged.fields.reference.value as { counts: Record<string, number> }).counts.AAA++;
    const previous = f.workflow.getSnapshot().result;
    await assert.rejects(f.run(serializeAnalysisRecord(await createAnalysisRecord(forged))), /Recomputed corpus/);
    assert.strictEqual(f.workflow.getSnapshot().result, previous);
  });
  it('checks the returned query, reference and selection independently of the worker identity claim', async () => {
    const f = await fixture(); await f.run(); const previous = f.workflow.getSnapshot().result!;
    for (const change of ['reference', 'query', 'annotation', 'policy', 'method', 'provenance']) {
      f.env.referenceCodons = async () => {
        const record = structuredClone(previous);
        if (change === 'reference') record.inputs.find(i => i.id === 'reference')!.data = '{}';
        if (change === 'query') record.inputs.find(i => i.id === 'genome')!.data = 'different';
        if (change === 'annotation') record.inputs.find(i => i.id === 'annotations')!.data = {};
        if (change === 'policy') record.parameters.zeroCountReplacement = 0;
        if (change === 'method') record.method.id = 'illustrative-substitution';
        if (change === 'provenance') record.inputs.find(i => i.id === 'genome')!.source = 'catalog';
        return record;
      };
      await assert.rejects(f.run(), /does not match/);
      assert.strictEqual(f.workflow.getSnapshot().result, previous);
    }
  });
  it('preserves the accepted result after cancellation or late changes to the loaded query', async () => {
    const f = await fixture(); await f.run(); const previous = f.workflow.getSnapshot().result!;
    const started = deferred<void>(), pending = deferred<AnalysisRecord>();
    f.env.referenceCodons = () => { started.resolve(); return pending.promise; };
    const task = f.run(); await started.promise; f.workflow.commands.cancel();
    await assert.rejects(task, { name: 'AbortError' }); pending.resolve(structuredClone(previous)); await flush();
    assert.strictEqual(f.workflow.getSnapshot().result, previous);
    f.env.referenceCodons = async () => { f.genomes[0].original.text += '\n'; return structuredClone(previous); };
    await assert.rejects(f.run(), /changed sequence or annotations/);
    assert.strictEqual(f.workflow.getSnapshot().result, previous);
  });
  it('rejects a reference that would make the tape unexportable before changing accepted evidence', async () => {
    const f = await fixture(), bundle = f.env.bundle();
    f.workflow.commands.stop();
    f.env.bundle = () => bundle + ' '.repeat(COMMAND_LIMITS.bytes - 90000 - bundle.length);
    f.workflow.start('Near-limit tape');
    await assert.rejects(f.run(counts.padEnd(120000, ' ')), /10 MiB/);
    assert.equal(f.workflow.getSnapshot().result, null); assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
  });
  it('cancels one terminal worker while another invocation verifies the same reference recording', async () => {
    const f = await fixture(); await f.run(serializeAnalysisRecord((await sourceReference()).record)); f.workflow.commands.stop();
    const request = { type: 'replay' as const, content: f.workflow.commands.export(), repetitions: 1, exportAnalysis: true };
    const controller = new AbortController();
    const old = runTerminalResearchWorker(request, controller.signal);
    const current = runTerminalResearchWorker(request, new AbortController().signal);
    controller.abort(); await assert.rejects(old, { name: 'AbortError' });
    const result = await current; assert.equal(result.type, 'replayed');
    if (result.type !== 'replayed') throw new Error('Expected replay.');
    assert.equal(result.report.completed, 1); assert.equal(result.report.verified, true);
    assert.equal(JSON.parse(result.analysisJson!).resultId, f.workflow.getSnapshot().result!.resultId);
  });
});
