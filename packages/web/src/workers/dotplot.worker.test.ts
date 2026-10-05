import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createDotPlotHandler } from './dotplot.worker';
import type { DotPlotJob, DotPlotWorkerResponse, SequenceBytesRef } from './types';

type Runtime = Parameters<typeof createDotPlotHandler>[0];
function harness(options: Partial<Omit<Runtime, 'postMessage'>> = {}) {
  const messages: DotPlotWorkerResponse[] = [];
  const handle = createDotPlotHandler({
    loadWasm: async () => null,
    ...options,
    postMessage(response, transfer) {
      if (response.ok) {
        assert(response.directValues instanceof Float32Array);
        assert(response.invertedValues instanceof Float32Array);
        assert(transfer.includes(response.directValues.buffer as ArrayBuffer), 'transfer the array actually in the response');
        assert(transfer.includes(response.invertedValues.buffer as ArrayBuffer));
      }
      messages.push(structuredClone(response, { transfer }));
      for (const buffer of transfer) assert.equal((buffer as ArrayBuffer).byteLength, 0, 'ownership was transferred');
    },
  });
  return { handle, messages };
}
function assertAcgt(response: DotPlotWorkerResponse) {
  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.directValues!), [1, 0, 0, 1]);
  assert.deepEqual(Array.from(response.invertedValues!), [0, 1, 1, 0]);
}
function deferred() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const job = (requestId: number, sequence = 'ACGT', bins = 2, window = 2): DotPlotJob =>
  ({ requestId, sequence, config: { bins, window } });

describe('dot plot worker runtime', () => {
  it('computes real JS results after optional WASM initialization rejects', async () => {
    const run = harness({ loadWasm: async () => { throw new Error('offline WASM'); } });
    await run.handle({ data: job(1) });
    assert.equal(run.messages.length, 1);
    assertAcgt(run.messages[0]);
  });

  it('keeps unresolved bases out of scientific evidence without changing the literal kernel contract', async () => {
    let loads = 0;
    const run = harness({ loadWasm: async () => { loads++; return null; } });
    await run.handle({ data: job(1, 'anNt') });
    assert.equal(loads, 0, 'a successful native load is not ambiguity parity');
    assert.deepEqual(Array.from(run.messages[0].directValues!), [0.5, 0, 0, 0.5]);
    assert.deepEqual(Array.from(run.messages[0].invertedValues!), [0, 0.5, 0.5, 0]);
    await run.handle({ data: { requestId: 2, sequence: 'RY', config: { bins: 2, window: 1, ambiguity: 'literal' } } });
    assertAcgt(run.messages[1]);
    assert.equal(loads, 0, 'SequenceHandle must not collapse literal IUPAC symbols either');
  });

  it('reports absent resolved evidence instead of displaying an all-unknown genome as no matches', async () => {
    const run = harness();
    await run.handle({ data: job(3, 'NNNN') });
    assert.equal(run.messages[0].ok, false);
    assert.match(run.messages[0].error!, /No resolved/);
    assert.equal(run.messages[0].directValues, undefined);
  });

  it('honors logical lengths and offsets for ASCII, encoded and shared sequence references', async () => {
    const ascii = new Uint8Array([255, 255, 65, 67, 71, 84, 255, 255]);
    const encoded = new Uint8Array([99, 0, 1, 2, 3, 4, 99]);
    const shared = new SharedArrayBuffer(ascii.length);
    new Uint8Array(shared).set(ascii);
    const references: SequenceBytesRef[] = [
      { buffer: ascii.buffer, byteOffset: 2, byteLength: 6, length: 4, encoding: 'ascii', isShared: false },
      { buffer: encoded.buffer, byteOffset: 1, byteLength: 6, length: 4, encoding: 'acgt05', isShared: false },
      { buffer: shared, byteOffset: 2, byteLength: 6, length: 4, encoding: 'ascii', isShared: true },
    ];
    for (const sequenceRef of references) {
      const run = harness();
      await run.handle({ data: { requestId: 4, sequenceRef, config: { bins: 2, window: 2 } } });
      assertAcgt(run.messages[0]);
      assert.equal(sequenceRef.buffer.byteLength > 0, true, 'source buffers are never transferred back');
    }
  });

  it('rejects malformed references and unsafe dimensions before touching optional acceleration', async () => {
    let loads = 0;
    const run = harness({ loadWasm: async () => { loads++; return null; } });
    const reference: SequenceBytesRef = {
      buffer: new Uint8Array([65, 67, 71, 84]).buffer,
      byteOffset: 0, byteLength: 4, length: 4, encoding: 'ascii', isShared: false,
    };
    const invalid: DotPlotJob[] = [
      ...[0, -1, 1.5, NaN, Infinity, 1025].map(bins => job(5, 'ACGT', bins)),
      ...[-1, 1.5, NaN, Infinity].map(window => job(5, 'ACGT', 2, window)),
      ...[{ length: 5 }, { byteOffset: -1 }, { byteOffset: 0.5 }, { byteLength: 5 },
        { encoding: 'utf8' }, { buffer: new Uint8Array([65, 255, 71, 84]).buffer },
        { encoding: 'acgt05' },
      ].map(change => ({ requestId: 5, sequenceRef: { ...reference, ...change } as SequenceBytesRef })),
      { requestId: 5, sequence: '', config: {} },
      { requestId: 5, sequence: 'ACGT', sequenceRef: reference } as DotPlotJob,
    ];
    for (const data of invalid) await run.handle({ data });
    assert.equal(run.messages.length, invalid.length);
    for (const response of run.messages) { assert.equal(response.ok, false); assert.equal(response.requestId, 5); }
    assert.equal(loads, 0);
  });

  it('falls back through failed native handle construction and a trapping one-shot kernel', async () => {
    let calls = 0;
    const run = harness({
      loadWasm: async () => ({
        SequenceHandle: class {
          constructor() { throw new Error('allocation failure'); }
          dotplot_self(): never { throw new Error('unreachable'); }
          free() { throw new Error('unreachable'); }
        },
        dotplot_self_buffers() { calls++; throw new Error('native trap'); },
      }),
      yieldControl: async () => {},
    });
    await run.handle({ data: job(6, 'A'.repeat(160), 80, 0) });
    assert.equal(calls, 1, 'a failed backend is not retried for the second pass');
    assert.deepEqual(run.messages.map(r => [r.bins, r.window]), [[40, 20], [80, 20]]);
    for (const response of run.messages) {
      assert.equal(response.ok, true);
      assert(response.directValues!.every(value => value === 1));
      assert(response.invertedValues!.every(value => value === 0));
    }
  });

  it('reads native copy getters once, transfers their actual arrays and releases both results and the handle', async () => {
    let directReads = 0, invertedReads = 0, resultFrees = 0, handleFrees = 0, constructors = 0;
    const run = harness({
      loadWasm: async () => ({ SequenceHandle: class {
        constructor() { constructors++; }
        dotplot_self(bins: number, window: number) {
          // ABI ownership fixture, not a native numeric implementation or parity proof.
          return {
            bins, window,
            get direct() { directReads++; return new Float32Array(bins * bins).fill(1); },
            get inverted() { invertedReads++; return new Float32Array(bins * bins); },
            free() { resultFrees++; },
          };
        }
        free() { handleFrees++; }
      } }),
      yieldControl: async () => {},
    });
    await run.handle({ data: job(7, 'A'.repeat(1000), 80, 0) });
    assert.deepEqual(run.messages.map(r => [r.bins, r.window]), [[40, 20], [80, 20]]);
    assert.deepEqual([constructors, directReads, invertedReads, resultFrees, handleFrees], [1, 2, 2, 2, 1]);
  });

  it('rejects malformed native results and frees their owners before producing valid JS results', async () => {
    for (const failure of ['shape', 'nan', 'range', 'window', 'getter']) {
      let frees = 0;
      const run = harness({ loadWasm: async () => ({ dotplot_self_buffers(_sequence, bins, window) {
        return {
          bins, window: failure === 'window' ? window + 1 : window,
          get direct() {
            if (failure === 'getter') throw new Error('getter trap');
            const values = new Float32Array(failure === 'shape' ? 1 : bins * bins);
            values[0] = failure === 'nan' ? NaN : failure === 'range' ? 2 : 1;
            return values;
          },
          get inverted() { return new Float32Array(bins * bins); },
          free() { frees++; },
        };
      } }) });
      await run.handle({ data: job(8) });
      assertAcgt(run.messages[0]);
      assert.equal(frees, 1);
    }
  });

  it('suppresses obsolete full results and obsolete failures after yielding a preview', async () => {
    for (const reject of [false, true]) {
      const preview = deferred(), resume = deferred();
      const run = harness({ yieldControl: () => { preview.resolve(); return resume.promise; } });
      const old = run.handle({ data: job(9, 'A'.repeat(160), 80) });
      await preview.promise;
      await run.handle({ data: job(10) });
      if (reject) resume.reject(new Error('obsolete failure')); else resume.resolve();
      await old;
      assert.deepEqual(run.messages.map(r => [r.requestId, r.bins, r.ok]), [[9, 40, true], [10, 2, true]]);
      assertAcgt(run.messages[1]);
    }
  });

  it('suppresses a superseded WASM initialization rejection', async () => {
    const pending = deferred();
    let loads = 0;
    const run = harness({ loadWasm: async () => { if (++loads === 1) await pending.promise; return null; } });
    const old = run.handle({ data: job(11) });
    await run.handle({ data: job(12) });
    pending.reject(new Error('old initialization failed'));
    await old;
    assert.deepEqual(run.messages.map(r => r.requestId), [12]);
    assertAcgt(run.messages[0]);
  });

  it('the production yield admits a newer task, not only promise microtasks', async () => {
    const messages: DotPlotWorkerResponse[] = [];
    let newer: Promise<void> | undefined;
    const handle = createDotPlotHandler({
      loadWasm: async () => null,
      postMessage(response) {
        messages.push(response);
        if (response.requestId === 13 && response.bins === 40) {
          setTimeout(() => { newer = handle({ data: job(14) }); }, 0);
        }
      },
    });
    await handle({ data: job(13, 'A'.repeat(160), 80) });
    assert(newer, 'the newer task ran before the full pass');
    await newer;
    assert.deepEqual(messages.map(r => [r.requestId, r.bins]), [[13, 40], [14, 2]]);
  });
});
