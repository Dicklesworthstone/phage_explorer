import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import type { AnalysisRecord, LocalGenome } from '@phage-explorer/core';
import { analysisJson } from '../../../core/src/analysis-result';
import { parseCommandTape, serializeCommandTape } from '../../../core/src/command-session';
import { ResearchWorkflow, validateResearchView, type ResearchEnvironment, type ResearchView } from './ResearchWorkflow';

const ids = { view: 'nav.goto', repeats: 'overlay.repeats', codons: 'overlay.codonAdaptation' };
const id = 'a'.repeat(64);
const initialView: ResearchView = { contentId: id, viewMode: 'dna', readingFrame: 0, scrollPosition: 0, geneId: null };
const genome = { sequence: 'ATGAAACCCGGGTTTCAT', original: { name: 'private.gb', text: 'exact source input' }, warnings: [],
  phage: { id: -1, name: 'Private record', accession: 'LOCAL', localGenome: { contentId: id, sequenceSha256: 'b'.repeat(64), format: 'genbank', topology: 'linear' },
    genes: [{ id: 1, type: 'CDS', locusTag: 'joined', startPos: 0, endPos: 18, strand: '-',
      qualifiers: { _location: 'complement(join(1..6,13..18))', _segments: [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }] } }] },
} as unknown as LocalGenome;
const evidence = (resultId = 'c'.repeat(64)) => ({ method: { id: 'test-method', version: '1', implementation: 'test adapter' }, cacheKey: 'd'.repeat(64), resultId }) as AnalysisRecord;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  const loaded = [structuredClone(genome)];
  let view = structuredClone(initialView), calculations = 0, parsing = 0;
  const env: ResearchEnvironment = {
    genomes: () => loaded, bundle: () => 'exact exported source bundle',
    parseBundle: async () => { parsing++; return { genomes: [structuredClone(genome)] }; },
    currentView: () => view,
    applyView: async next => { view = next; },
    repeats: async () => { calculations++; return evidence(); },
    codons: async () => { calculations++; return evidence(); },
  };
  const workflow = new ResearchWorkflow(ids, env);
  workflow.start('Private commands');
  return { workflow, env, loaded, view: () => view, calculations: () => calculations, parsing: () => parsing };
}
const navigate = (workflow: ResearchWorkflow, position: number) => workflow.commands.dispatch(ids.view, analysisJson({ ...initialView, scrollPosition: position, geneId: 1 }));
const codons = (workflow: ResearchWorkflow) => workflow.commands.dispatch(ids.codons, { contentId: id, geneId: 1 });

describe('content-bound research command adapters', () => {
  it('records original inputs and absolute genome/CDS/frame/position commands', async () => {
    const f = fixture();
    await f.workflow.commands.dispatch(ids.view, analysisJson({ ...initialView, viewMode: 'dual', readingFrame: -2, scrollPosition: 12, geneId: 1 }));
    await codons(f.workflow); f.workflow.commands.stop();
    const tape = parseCommandTape(f.workflow.commands.export());
    assert.deepEqual(tape.context, { bundle: 'exact exported source bundle' });
    assert.deepEqual(tape.commands.map(c => c.actionId), [ids.view, ids.codons]);
    assert.equal(f.view().readingFrame, -2);
    assert.equal(f.view().geneId, 1);
    await f.workflow.commands.replay();
    assert.equal(f.calculations(), 2);
    assert.equal(f.workflow.getSnapshot().result!.resultId, 'c'.repeat(64));
  });
  it('validates a context once but checks actual loaded sequence and annotation data on every command', async () => {
    const f = fixture();
    await navigate(f.workflow, 1); await navigate(f.workflow, 2);
    assert.equal(f.parsing(), 1);
    f.loaded[0].sequence = 'C'.repeat(genome.sequence.length);
    await assert.rejects(codons(f.workflow), /changed sequence or annotations/);
    assert.equal(f.calculations(), 0);
    f.loaded[0] = structuredClone(genome);
    f.loaded[0].phage.genes[0].qualifiers!._location = '1..6';
    await assert.rejects(codons(f.workflow), /annotations/);
  });
  it('rejects missing inputs or commands outside the bundled genomes without computing', async () => {
    const f = fixture(); f.loaded.length = 0;
    await assert.rejects(codons(f.workflow), /Missing local genome/);
    f.loaded.push(structuredClone(genome));
    await assert.rejects(f.workflow.commands.dispatch(ids.codons, { contentId: 'f'.repeat(64), geneId: 1 }), /outside/);
    assert.equal(f.calculations(), 0);
  });
  it('preserves exact joined/complement qualifiers and gives the backend isolated inputs', async () => {
    const f = fixture();
    f.env.codons = async (input, selected) => {
      assert.equal(selected, 1);
      assert.deepEqual(input.phage.genes[0].qualifiers, genome.phage.genes[0].qualifiers);
      input.sequence = 'mutated'; input.phage.genes.length = 0;
      return evidence();
    };
    await assert.rejects(codons(f.workflow), /changed sequence or annotations/, 'backend mutation must not publish an incorrectly bound result');
    assert.deepEqual(f.loaded[0], genome);
  });
  it('rejects invalid command fields, out-of-bounds views, wrong CDS and unsupported frames', async () => {
    const f = fixture();
    await assert.rejects(navigate(f.workflow, 100), /outside/);
    await assert.rejects(f.workflow.commands.dispatch(ids.codons, { contentId: id, geneId: 999 }), /CDS/);
    await assert.rejects(f.workflow.commands.dispatch(ids.repeats, { contentId: id, minLength: 3, maxGap: 1 }), /integer/);
    await assert.rejects(f.workflow.commands.dispatch(ids.repeats, { contentId: id, minLength: 8, maxGap: 1, ignored: true }), /parameters/);
    for (const extra of [{ readingFrame: '0' }, { viewMode: 'protein' }, { geneId: -1 }, { scrollPosition: NaN }]) {
      assert.throws(() => validateResearchView({ ...initialView, ...extra } as never));
    }
    assert.equal(f.calculations(), 0);
  });
  it('undo/redo restores absolute views and a new branch discards forward history', async () => {
    const f = fixture();
    await navigate(f.workflow, 2); await navigate(f.workflow, 4);
    await f.workflow.moveHistory(-1); assert.equal(f.view().scrollPosition, 2);
    assert.equal(f.workflow.getSnapshot().redoAvailable, true);
    await f.workflow.moveHistory(1); assert.equal(f.view().scrollPosition, 4);
    await f.workflow.moveHistory(-1); await navigate(f.workflow, 7);
    assert.equal(f.workflow.getSnapshot().redoAvailable, false);
    await assert.rejects(f.workflow.moveHistory(1), /No saved view/);
    const tape = f.workflow.commands.getSnapshot().tape;
    assert.deepEqual(tape.commands.map(c => (c.parameters as { scrollPosition: number }).scrollPosition), [2, 4, 2, 4, 2, 7]);
  });
  it('failed history navigation does not move its pointer or erase the current view', async () => {
    const f = fixture(); await navigate(f.workflow, 2); await navigate(f.workflow, 4);
    f.loaded.length = 0;
    await assert.rejects(f.workflow.moveHistory(-1), /Missing/);
    assert.equal(f.view().scrollPosition, 4);
    assert.equal(f.workflow.getSnapshot().redoAvailable, false);
  });
  it('rejects changed method/reference result identity before installing a replay result', async () => {
    const f = fixture(); await codons(f.workflow); f.workflow.commands.stop();
    const previous = f.workflow.getSnapshot().result;
    f.env.codons = async () => evidence('f'.repeat(64));
    await assert.rejects(f.workflow.commands.replay(), /differs/);
    assert.strictEqual(f.workflow.getSnapshot().result, previous);
  });
  it('replay installs newly computed evidence rather than a saved result', async () => {
    const f = fixture(); await codons(f.workflow); f.workflow.commands.stop();
    const previous = f.workflow.getSnapshot().result;
    await f.workflow.commands.replay();
    assert.notStrictEqual(f.workflow.getSnapshot().result, previous);
    assert.deepEqual(f.workflow.getSnapshot().result, previous);
  });
  it('late cancelled computation cannot replace accepted evidence', async () => {
    const f = fixture(); await codons(f.workflow);
    const previous = f.workflow.getSnapshot().result, pending = deferred<AnalysisRecord>();
    f.env.codons = () => pending.promise;
    const task = codons(f.workflow); await flush();
    f.workflow.commands.cancel();
    await assert.rejects(task, { name: 'AbortError' });
    pending.resolve(evidence('f'.repeat(64))); await flush();
    assert.strictEqual(f.workflow.getSnapshot().result, previous);
  });
  it('checks loaded input again after worker computation and before publication', async () => {
    const f = fixture(), pending = deferred<AnalysisRecord>();
    f.env.codons = () => pending.promise;
    const task = codons(f.workflow); await flush();
    f.loaded[0].sequence = 'different'; pending.resolve(evidence());
    await assert.rejects(task, /changed sequence/);
    assert.equal(f.workflow.getSnapshot().result, null);
  });
  it('loading a tape and reviewing bundled inputs do not add inputs or navigate', async () => {
    const f = fixture(); await navigate(f.workflow, 2); f.workflow.commands.stop();
    const content = f.workflow.commands.export();
    f.workflow.load(content);
    const parsed = await f.workflow.bundledInputs(new AbortController().signal);
    assert.deepEqual(parsed.genomes, [genome]);
    assert.equal(f.view().scrollPosition, 2);
    assert.equal(f.workflow.getSnapshot().view, null);
    assert.equal(f.loaded.length, 1);
    await f.workflow.commands.replay(); assert.equal(f.workflow.getSnapshot().view?.scrollPosition, 2);
  });
  it('a changed genome in a saved context is rejected even when action parameters still name an old content ID', async () => {
    const f = fixture(); await navigate(f.workflow, 2); f.workflow.commands.stop();
    const tape = parseCommandTape(f.workflow.commands.export()); tape.context = { bundle: 'modified source bundle' };
    f.workflow.load(serializeCommandTape(tape));
    f.env.parseBundle = async () => ({ genomes: [{ ...structuredClone(genome), sequence: 'changed original input' }] });
    await assert.rejects(f.workflow.commands.replay(), /changed sequence/);
  });
});

it('failed and cancelled private input review preserve the previously accepted tape and result', async () => {
  const f = fixture(); await codons(f.workflow); f.workflow.commands.stop();
  const tape = f.workflow.commands.export(), previous = f.workflow.getSnapshot().result;
  const pending = deferred<{ genomes: LocalGenome[] }>();
  f.env.parseBundle = () => pending.promise;
  const controller = new AbortController();
  const task = f.workflow.loadAndReview(tape, controller.signal);
  controller.abort(); pending.resolve({ genomes: [genome] });
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(f.workflow.commands.export(), tape);
  assert.strictEqual(f.workflow.getSnapshot().result, previous);
  f.env.parseBundle = async () => { throw new Error('invalid genome bundle'); };
  await assert.rejects(f.workflow.loadAndReview(tape, new AbortController().signal), /invalid genome/);
  assert.strictEqual(f.workflow.getSnapshot().result, previous);
});
