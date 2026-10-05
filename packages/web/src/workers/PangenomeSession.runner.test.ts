import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { runPangenomeWorker, PangenomeSession, executePangenomeRequest, type PangenomeWorker, type PangenomeRequest } from './PangenomeSession';

function port() {
  let terminations = 0;
  // Fixture callbacks do not depend on native Worker's `this` receiver.
  const worker: Pick<PangenomeWorker, 'postMessage' | 'terminate'> & {
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
  } = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage() {}, terminate() { terminations++; } };
  return { worker, terminations: () => terminations };
}
const data = (value: unknown) => ({ data: value } as MessageEvent);
const job: PangenomeRequest = { kind: 'analyze', input: { format: 'phage-explorer-pangenome', version: 1,
  name: 'Independent worker clients', source: 'local', sequences: [
    { id: 'ref', description: '', sequence: 'ACGT' }, { id: 'query', description: '', sequence: 'ATGT' },
  ] }, options: { referenceId: 'ref', alignment: 'provided', terminalGaps: 'alleles' } };

describe('shared pangenome worker lifetime', () => {
  it('returns the actual numerical result with progress and releases all handlers exactly once', async () => {
    const p = port(), progress: string[] = [];
    p.worker.postMessage = value => { void executePangenomeRequest(value, phase => p.worker.onmessage?.(data({ kind: 'progress', phase })))
      .then(result => p.worker.onmessage?.(data({ kind: 'result', result }))); };
    const result = await runPangenomeWorker(job, new AbortController().signal, () => p.worker, phase => progress.push(phase));
    assert.deepEqual(result.graph!.variants.map(v => [v.referenceStart, v.reference, v.alternate]), [[1, 'C', 'T']]);
    assert.equal(progress.length, 2); assert.equal(p.terminations(), 1);
    assert.equal(p.worker.onmessage, null); assert.equal(p.worker.onerror, null); assert.equal(p.worker.onmessageerror, null);
  });
  it('does not create an already-cancelled worker and terminates one cancelled during creation', async () => {
    const c = new AbortController(); c.abort();
    await assert.rejects(runPangenomeWorker(job, c.signal, () => { throw new Error('must not create'); }), { name: 'AbortError' });
    const d = new AbortController(), p = port();
    await assert.rejects(runPangenomeWorker(job, d.signal, () => { d.abort(); return p.worker; }), { name: 'AbortError' });
    assert.equal(p.terminations(), 1);
  });
  it('snapshots before the factory and ignores captured late callbacks after cancellation', async () => {
    const original = structuredClone(job), request = structuredClone(job), c = new AbortController(), p = port();
    let submitted: unknown;
    p.worker.postMessage = value => { submitted = value; };
    const pending = runPangenomeWorker(request, c.signal, () => { if (request.kind === 'analyze') request.input.sequences[0].sequence = 'CCCC'; return p.worker; });
    const callback = p.worker.onmessage!;
    assert.deepEqual(submitted, original);
    c.abort(); await assert.rejects(pending, { name: 'AbortError' });
    callback(data({ kind: 'result', result: await executePangenomeRequest(original) }));
    assert.equal(p.terminations(), 1);
  });
  it('settles construction, posting, decoding, native and malformed-response failures', async () => {
    await assert.rejects(runPangenomeWorker(job, new AbortController().signal, () => { throw new Error('construction failed'); }), /construction/);
    for (const failure of ['post', 'decode', 'native', 'shape', 'reported', 'progress']) {
      const p = port();
      p.worker.postMessage = () => {
        if (failure === 'post') throw new Error('post failed');
        if (failure === 'decode') p.worker.onmessageerror?.(data(null));
        if (failure === 'native') p.worker.onerror?.({ preventDefault() {} } as ErrorEvent);
        if (failure === 'shape') p.worker.onmessage?.(data({ kind: 'result', result: null }));
        if (failure === 'reported') p.worker.onmessage?.(data({ kind: 'error', message: 'actual computation failed' }));
        if (failure === 'progress') p.worker.onmessage?.(data({ kind: 'progress', phase: 'started' }));
      };
      await assert.rejects(runPangenomeWorker(job, new AbortController().signal, () => p.worker, () => { throw new Error('observer failed'); }));
      assert.equal(p.terminations(), 1, failure); assert.equal(p.worker.onmessage, null);
    }
  });
  it('concurrent clients own independent workers; aborting a command does not cancel another workspace', async () => {
    const a = port(), b = port(), ca = new AbortController(), cb = new AbortController();
    const taskA = runPangenomeWorker(job, ca.signal, () => a.worker);
    const taskB = runPangenomeWorker(job, cb.signal, () => b.worker);
    ca.abort(); await assert.rejects(taskA, { name: 'AbortError' });
    const result = await executePangenomeRequest(job); b.worker.onmessage?.(data({ kind: 'result', result }));
    assert.strictEqual(await taskB, result); assert.equal(a.terminations(), 1); assert.equal(b.terminations(), 1);
  });
  it('workspace cancellation still preserves accepted results and permits subsequent work through the shared runner', async () => {
    let block = false;
    const session = new PangenomeSession(() => {
      const p = port();
      p.worker.postMessage = request => { if (!block) void executePangenomeRequest(request)
        .then(result => p.worker.onmessage?.(data({ kind: 'result', result }))); };
      return p.worker;
    });
    session.activate();
    await session.run(job); const prior = session.getSnapshot().accepted;
    block = true; const pending = session.run(job);
    await new Promise(resolve => setTimeout(resolve, 0)); session.cancel(); await pending;
    assert.strictEqual(session.getSnapshot().accepted, prior);
    block = false; await session.run(job);
    assert.notStrictEqual(session.getSnapshot().accepted, prior); assert.equal(session.getSnapshot().error, null);
    session.deactivate();
  });
});
