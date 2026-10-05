import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { executePangenomeRequest, PangenomeSession, type PangenomeRequest, type PangenomeWorker } from './PangenomeSession';
import { parsePangenomeInput } from '../../../core/src/analysis/alignment-pangenome';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';

const bases = 'ATGAAAGCTTAA';
const source = { name: 'ref.gb', text: `LOCUS       REF 12 bp DNA linear\nFEATURES             Location/Qualifiers\n     CDS             1..12\n                     /gene="coding"\nORIGIN\n        1 ${bases}\n//\n` };
const input = () => parsePangenomeInput(`>r\n${bases}\n>q\nATGAAGGCCTAA`);
const annotate = (): PangenomeRequest => ({ kind: 'annotate', input: input(),
  options: { referenceId: 'r', alignment: 'wavefront', terminalGaps: 'missing' }, annotation: { ...source } });

/** In-process transport fixture only; numeric results use the actual request executor. */
function harness() {
  const workers: Array<PangenomeWorker & { stopped: boolean; pending: (() => Promise<void>) | null }> = [];
  const session = new PangenomeSession(() => {
    const worker: typeof workers[number] = {
      onmessage: null, onerror: null, onmessageerror: null, stopped: false, pending: null,
      terminate() { this.stopped = true; },
      postMessage(value: PangenomeRequest) {
        const captured = structuredClone(value), notify = this.onmessage;
        this.pending = async () => {
          try { const result = await executePangenomeRequest(captured);
            // Deliver even after terminate, to exercise generation ownership.
            notify?.call({} as Worker, { data: { kind: 'result', result } } as MessageEvent);
          } catch (cause) {
            notify?.call({} as Worker, { data: { kind: 'error', message: (cause as Error).message } } as MessageEvent);
          }
        };
      },
    };
    workers.push(worker); return worker;
  });
  session.activate();
  return { session, workers, async deliver() {
    for (let i = 0; i < 20 && (!workers.at(-1)?.pending || workers.at(-1)?.stopped); i++) await Promise.resolve();
    assert(workers.at(-1)?.pending && !workers.at(-1)?.stopped); await workers.at(-1)!.pending!();
  } };
}

describe('annotated pangenome worker/session', () => {
  it('produces actual graph and coding transcripts through the worker request API and restores them on import', async () => {
    const phases: string[] = [];
    const result = await executePangenomeRequest(annotate(), value => phases.push(value));
    assert.equal(result.cds?.consequences[0].queryProtein, 'MKA*');
    assert.deepEqual(result.cds?.consequences[0].effects, ['synonymous']);
    assert.equal(result.record?.method.version, '5'); assert(phases.length > 0);
    const replay = await executePangenomeRequest({ kind: 'import', content: serializeAnalysisRecord(result.record!), filename: 'saved.json' });
    assert.equal(replay.verified, true); assert.deepEqual(replay.cds, result.cds);
    assert.equal(replay.record?.resultId, result.record?.resultId);
    const unannotated = await executePangenomeRequest({ kind: 'analyze', input: result.input, options: result.options });
    assert.equal(unannotated.cds, undefined, 'a new graph must not retain old coding evidence');
  });
  it('snapshots source and selection before caller mutation', async () => {
    const run = harness(), request = annotate();
    assert.equal(request.kind, 'annotate'); if (request.kind !== 'annotate') throw new Error('fixture');
    const pending = run.session.run(request);
    request.annotation.text = 'changed'; request.options.referenceId = 'changed';
    await run.deliver(); await pending;
    assert.equal(run.session.getSnapshot().accepted?.cds?.consequences[0].queryProtein, 'MKA*');
    assert.equal(run.workers[0].stopped, true);
  });
  it('retains accepted results after source failure, cancellation and a late obsolete reply', async () => {
    const run = harness();
    const initial = run.session.run(annotate()); await run.deliver(); await initial;
    const accepted = run.session.getSnapshot().accepted;
    const wrong = annotate(); if (wrong.kind !== 'annotate') throw new Error('fixture');
    wrong.annotation.text = source.text.replace(bases, 'ATGAAGGCTTAA');
    const failed = run.session.run(wrong); await run.deliver(); await failed;
    assert.equal(run.session.getSnapshot().accepted, accepted); assert.match(run.session.getSnapshot().error!, /exactly match/);
    const old = run.session.run(annotate());
    for (let i = 0; i < 20 && run.workers.length < 3; i++) await Promise.resolve();
    const oldWorker = run.workers[2]; assert(oldWorker.pending);
    run.session.cancel(); await old;
    const newer = run.session.run({ kind: 'demo' }); await run.deliver(); await newer;
    const latest = run.session.getSnapshot().accepted;
    await oldWorker.pending();
    assert.equal(run.session.getSnapshot().accepted, latest);
    assert.equal(latest?.cds, undefined); assert.equal(oldWorker.stopped, true);
  });
  it('cancels a pending GenBank file read before any worker starts', async () => {
    const run = harness(); let resolve!: (request: PangenomeRequest) => void;
    const read = new Promise<PangenomeRequest>(yes => { resolve = yes; });
    const pending = run.session.run(read); run.session.cancel(); await pending;
    resolve(annotate()); await Promise.resolve(); await Promise.resolve();
    assert.equal(run.workers.length, 0); assert.equal(run.session.getSnapshot().busy, false);
    assert.equal(run.session.getSnapshot().accepted, null);
  });
});
