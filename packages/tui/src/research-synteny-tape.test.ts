import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { importLocalGenomes, exportLocalGenomeBundle, type LocalGenome } from '../../core/src/genome-import';
import { parseCommandTape, serializeCommandTape, serializeCommandPlan } from '../../core/src/command-session';
import { parseWorkflowResults, workflowAnalysisAt } from '../../core/src/workflow-results';
import { analyzeSyntenyExperiment, exportSyntenyTsv, replaySyntenyExperiment, SYNTENY_EXPERIMENT_PARAMETERS,
  type SyntenyExperimentResult } from '../../comparison/src/synteny-experiment';
import { ResearchWorkflow, researchSyntenyParameters, researchSyntenyInput, validateResearchSynteny,
  type ResearchEnvironment, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { executeResearchRequest } from '../../web/src/workers/research-workflow.worker';
import { inspectResearchTape, replayResearchTape, recordResearchPlan, replayResearchResults } from './research-replay';
import { runTerminalResearchWorker } from '../../../scripts/research-workflow';
import { TerminalResearchSession } from './terminal-research-session';

const ids = { view: ActionIds.NavGoto, repeats: ActionIds.OverlayRepeats,
  codons: ActionIds.OverlayCodonAdaptation, synteny: ActionIds.OverlaySynteny };
function genbank(name: string, labels: string[]): string {
  return `LOCUS       ${name} 60 bp DNA linear\nACCESSION   ${name}\nFEATURES             Location/Qualifiers\n`
    + labels.map((label, index) => `     CDS             ${index * 20 + 1}..${index * 20 + 10}\n                     /product="${label}"\n`).join('')
    + `ORIGIN\n        1 ${'acgt'.repeat(15)}\n//\n`;
}
async function fixture(overrides: Partial<ResearchEnvironment> = {}) {
  const { genomes } = await importLocalGenomes({ name: 'private-annotations.gb',
    text: genbank('query', ['capsid', 'terminase', 'lysin']) + genbank('reference', ['lysin', 'terminase', 'capsid']) });
  let loaded = structuredClone(genomes), view: ResearchView | null = null;
  const environment: ResearchEnvironment = {
    genomes: () => loaded, bundle: () => exportLocalGenomeBundle(loaded),
    parseBundle: text => importLocalGenomes({ name: 'workflow.json', text }), currentView: () => view,
    applyView: async next => { view = structuredClone(next); },
    repeats: async () => { throw new Error('Unrelated repeat executor must not run'); },
    codons: async () => { throw new Error('Unrelated codon executor must not run'); },
    synteny: async input => {
      const response = await executeResearchRequest({ type: 'synteny', input });
      assert(response.type === 'analysis'); return response.record;
    }, ...overrides,
  };
  const query = genomes[0].phage.localGenome!.contentId, reference = genomes[1].phage.localGenome!.contentId;
  return { genomes, query, reference, environment, workflow: new ResearchWorkflow(ids, environment),
    pair: researchSyntenyParameters(query, reference), self: researchSyntenyParameters(query, query),
    replace: (value: LocalGenome[]) => { loaded = value; } };
}
async function recording() {
  const f = await fixture(); f.workflow.start('Ordered annotation comparisons');
  await f.workflow.commands.dispatch(ids.synteny, analysisJson(f.pair));
  const pair = f.workflow.getSnapshot().result!;
  await f.workflow.commands.dispatch(ids.synteny, analysisJson(f.self));
  const self = f.workflow.getSnapshot().result!;
  await f.workflow.commands.dispatch(ids.view, analysisJson({ contentId: f.query, geneId: 2, viewMode: 'dna', readingFrame: 0, scrollPosition: 20 }));
  f.workflow.commands.stop();
  return { ...f, pairRecord: pair, selfRecord: self, tape: f.workflow.commands.export() };
}
async function resign(record: AnalysisRecord, change: (copy: AnalysisRecord) => void): Promise<AnalysisRecord> {
  const copy = structuredClone(record); change(copy);
  return createAnalysisRecord({ method: copy.method, inputs: copy.inputs.map(({ sha256: _sha, ...input }) => input),
    parameters: copy.parameters, seed: copy.seed, references: copy.references, fields: copy.fields });
}
const resultOf = (record: AnalysisRecord) => record.fields.synteny.value as unknown as SyntenyExperimentResult;

describe('captured annotation synteny workflows', () => {
  it('records actual GenBank annotation order with independently known matrices and spans', async () => {
    const f = await recording(), pair = resultOf(f.pairRecord), self = resultOf(f.selfRecord);
    assert.deepEqual(pair.heatmap.values, [0, 0, 1, 0, 1, 0, 1, 0, 0]);
    assert.deepEqual(pair.blocksBp, [{ startIdxQuery: 0, endIdxQuery: 2, startIdxReference: 0, endIdxReference: 2,
      startBpQuery: 0, endBpQuery: 50, startBpReference: 0, endBpReference: 50, score: 1, orientation: 'reverse' }]);
    assert.deepEqual(self.heatmap.values, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.equal(self.stats.dtwDistance, 0); assert.equal(self.stats.globalScore, 1);
    assert.deepEqual(f.pairRecord.parameters, SYNTENY_EXPERIMENT_PARAMETERS);
    assert.deepEqual(f.pairRecord.inputs.map(row => [row.id, row.source, row.accession]),
      [['query', 'local', 'query'], ['reference', 'local', 'reference']]);
    assert.equal(f.workflow.getSnapshot().result, null, 'navigation must not relabel an analysis');
    assert.deepEqual(f.workflow.getSnapshot().lastAnalysis, f.selfRecord);
    const replay = await replaySyntenyExperiment(serializeAnalysisRecord(f.pairRecord));
    assert.deepEqual(replay.input.genesReference.map(row => row.product), ['lysin', 'terminase', 'capsid']);
    assert.equal(replay.input.reference.contentId, f.reference);
    assert.match(exportSyntenyTsv(replay, 'blocks'), /0\t0\t2\t0\t2\t0\t50\t0\t50\treverse\t1\n/);
    assert.equal(exportSyntenyTsv(replay, 'matrix').trim().split('\n').filter(row => !row.startsWith('#')).length, 10);
  });

  it('replays browser-produced tapes through native recording, complete archives and isolated workers', async () => {
    const f = await recording();
    assert.equal((await inspectResearchTape(f.tape)).canReplay, true);
    const native = await replayResearchTape(f.tape, { repetitions: 2, captureResults: true });
    assert.equal(native.report.completed, 6); assert.equal(native.report.lastAnalysisExecution, 5);
    assert.equal(native.report.finalView!.geneId, 2);
    const archive = await parseWorkflowResults(native.allResultsJson!);
    assert.deepEqual(archive.records, [f.pairRecord, f.selfRecord]);
    assert.deepEqual(workflowAnalysisAt(archive, 4), f.pairRecord);
    assert.equal((await replayResearchResults(native.allResultsJson!)).archiveJson, native.allResultsJson);
    const tape = parseCommandTape(f.tape);
    const plan = serializeCommandPlan({ ...tape, format: 'phage-explorer-command-plan',
      commands: tape.commands.map(({ actionId, parameters }) => ({ actionId, parameters })) });
    assert.equal((await recordResearchPlan(plan)).tapeJson, f.tape);
    const reply = await runTerminalResearchWorker({ type: 'replay', content: f.tape, repetitions: 1,
      exportAnalysis: true }, new AbortController().signal);
    assert(reply.type === 'replayed'); assert.equal(reply.report.completed, 3);
    assert.deepEqual(await parseAnalysisRecord(reply.analysisJson!), f.selfRecord);
  });

  it('independently replays extracted evidence and exports every block through the native worker', async () => {
    const f = await recording(), content = serializeAnalysisRecord(f.pairRecord);
    const replay = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' }, new AbortController().signal);
    assert(replay.type === 'experiment-replayed'); assert.equal(replay.report.verified, true);
    assert.equal(replay.exportText, content);
    const table = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'tsv' }, new AbortController().signal);
    assert(table.type === 'experiment-replayed');
    assert.equal(table.exportText, exportSyntenyTsv(await replaySyntenyExperiment(content), 'blocks'));
  });

  it('rejects changed settings, missing roles and out-of-bundle identities', async () => {
    const f = await fixture();
    for (const value of [
      { ...f.pair, settings: { ...f.pair.settings, matchDistanceBelow: 0.9 } },
      { contentId: f.query, comparisonContentId: f.reference },
      { ...f.pair, comparisonContentId: null }, { ...f.pair, contentId: 'query' },
      { ...f.pair, sortAnnotations: true },
    ]) assert.throws(() => validateResearchSynteny(analysisJson(value)));
    f.workflow.start('Source boundary');
    await assert.rejects(f.workflow.commands.dispatch(ids.synteny, analysisJson(researchSyntenyParameters(f.query, '0'.repeat(64)))), /outside the recorded/);
    assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
    assert.equal(f.workflow.getSnapshot().lastAnalysis, null);
  });

  it('refuses annotation-free and oversized sources without truncating their rows', async () => {
    const f = await fixture(), plain = (await importLocalGenomes({ name: 'plain.fa', text: '>plain\nACGT\n' })).genomes[0];
    assert.throws(() => researchSyntenyInput(f.genomes[0], plain), /annotation rows/);
    const large = structuredClone(f.genomes);
    large[0].phage.genes = Array.from({ length: 501 }, (_, id) => ({ ...large[0].phage.genes[0], id: id + 1 }));
    large[1].phage.genes = Array.from({ length: 1000 }, (_, id) => ({ ...large[1].phage.genes[0], id: id + 1 }));
    assert.throws(() => researchSyntenyInput(large[0], large[1]), /500,000-cell/);
    assert.equal(large[0].phage.genes.length, 501);
  });

  it('rejects a fresh but substituted annotation result before recording or publishing it', async () => {
    const f = await fixture({ synteny: async input => {
      input.genesReference.reverse();
      return (await analyzeSyntenyExperiment(input)).record;
    } });
    f.workflow.start('Substitution refusal');
    await assert.rejects(f.workflow.commands.dispatch(ids.synteny, analysisJson(f.pair)), /does not match the ordered captured/);
    assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
    assert.equal(f.workflow.getSnapshot().result, null);
  });

  it('rejects changed captured annotations and self-consistently forged numerical evidence', async () => {
    const f = await recording(), changed = structuredClone(f.genomes);
    changed[0].phage.genes[0].product = 'changed annotation';
    f.replace(changed);
    await assert.rejects(f.workflow.commands.replay(), /changed sequence or annotations/);
    const forged = await resign(f.pairRecord, record => { resultOf(record).heatmap.values[0] = 0.75; });
    const content = serializeAnalysisRecord(forged);
    await parseAnalysisRecord(content); // Deliberately valid hashes do not prove computation.
    await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' },
      new AbortController().signal), /freshly recomputed/);
    const tape = parseCommandTape(f.tape);
    tape.commands[0].expected = analysisJson({ method: forged.method, cacheKey: forged.cacheKey, resultId: forged.resultId });
    await assert.rejects(replayResearchTape(serializeCommandTape(tape)), /Recomputed output/);
  });

  it('cancels delayed synteny without allowing the late result into the recording', async () => {
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ synteny: async input => {
      const result = await analyzeSyntenyExperiment(input); started(); await held; return result.record;
    } });
    f.workflow.start('Cancellation');
    const task = f.workflow.commands.dispatch(ids.synteny, analysisJson(f.pair));
    await entered; f.workflow.commands.cancel(); await assert.rejects(task, /cancelled/);
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.workflow.getSnapshot().result, null);
    assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
  });

  it('authors captured synteny in the terminal draft without running a computation', async () => {
    const f = await fixture(), session = new TerminalResearchSession();
    try {
      assert(await session.createDraft('Synteny draft', exportLocalGenomeBundle(f.genomes)));
      session.setStep({ actionId: ids.synteny, parameters: analysisJson(f.pair) });
      assert.equal(session.getSnapshot().document, null);
      assert.deepEqual(session.getSnapshot().draft!.plan.commands[0].parameters, analysisJson(f.pair));
      assert.throws(() => session.setStep({ actionId: ids.synteny,
        parameters: analysisJson(researchSyntenyParameters(f.query, '0'.repeat(64))) }), /captured input/);
      assert.equal(session.getSnapshot().draft!.plan.commands.length, 1);
    } finally { session.cancel(); }
  });
});
