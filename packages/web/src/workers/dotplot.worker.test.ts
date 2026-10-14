import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { computeDotPlotBuffers, createDotPlotExperiment, serializeAnalysisRecord, createAnalysisRecord } from '@phage-explorer/core';
import { computeDotPlot, computePairwiseDotPlotBuffers, createPairwiseDotPlotExperiment } from '@phage-explorer/core';
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

describe('dot plot direct-buffer integration', () => {
  it('transfers packed preview and final outputs with the same sampled windows and Float32 values', async () => {
    const sequence = 'ACGTNacgt?'.repeat(83);
    const run = harness({ loadWasm: async () => { throw new Error('ambiguous input must not load the literal backend'); }, yieldControl: async () => {} });
    await run.handle({ data: job(20, sequence, 80, 65) });
    assert.deepEqual(run.messages.map(response => [response.requestId, response.bins, response.window, response.ok]),
      [[20, 40, 65, true], [20, 80, 65, true]]);
    for (const response of run.messages) {
      // Contract check against the full-precision API. Independent scalar
      // numerical oracles live in the core dot-plot tests.
      const expected = computeDotPlot(sequence, { bins: response.bins, window: 65, ambiguity: 'exclude' });
      assert.deepEqual(response.directValues, new Float32Array(expected.grid.flat().map(cell => cell.direct)));
      assert.deepEqual(response.invertedValues, new Float32Array(expected.grid.flat().map(cell => cell.inverted)));
    }
  });

  it('supports maximum resolution with a full-genome window without recomputing identical pairs', async () => {
    const run = harness({ yieldControl: async () => {} });
    await run.handle({ data: job(21, 'A'.repeat(4096), 1024, 4096) });
    const final = run.messages[1];
    assert.equal(final.ok, true);
    assert.equal(final.bins, 1024);
    assert.equal(final.window, 4096);
    assert.equal(final.directValues!.length, 1024 * 1024);
    assert(final.directValues!.every(value => value === 1));
    assert(final.invertedValues!.every(value => value === 0));
  });

  it('publishes only the newer full result after transferring an older packed preview', async () => {
    const preview = deferred(), resume = deferred();
    const run = harness({ yieldControl: () => { preview.resolve(); return resume.promise; } });
    const old = run.handle({ data: job(22, 'ACGTN'.repeat(500), 80, 65) });
    await preview.promise;
    await run.handle({ data: job(23, 'ANNT') });
    resume.resolve();
    await old;
    assert.deepEqual(run.messages.map(response => [response.requestId, response.bins]), [[22, 40], [23, 2]]);
    assert.deepEqual(Array.from(run.messages[1].directValues!), [0.5, 0, 0, 0.5]);
    assert.deepEqual(Array.from(run.messages[1].invertedValues!), [0, 0.5, 0.5, 0]);
  });
});

const experimentContext = { accession: 'PRIVATE.1', source: 'local' as const };
function captureJob(requestId: number, sequence = 'ACGT', bins = 2, window = 2): DotPlotJob {
  const config = { bins, window, ambiguity: 'exclude' as const };
  return { requestId, sequence, config, experiment: {
    kind: 'create', context: experimentContext, displayed: computeDotPlotBuffers(sequence, config),
  } };
}

describe('dot plot experiment worker integration', () => {
  it('captures the actual full matrix, serializes evidence and TSV off-thread, and transfers exact buffers', async () => {
    let nativeLoads = 0;
    const run = harness({ loadWasm: async () => { nativeLoads++; throw new Error('not part of portable capture'); } });
    await run.handle({ data: captureJob(20) });
    assert.equal(run.messages.length, 1);
    const response = run.messages[0];
    assertAcgt(response);
    assert.equal(response.replayExactRecord, undefined);
    assert.equal(nativeLoads, 0);
    assert.deepEqual(JSON.parse(response.experimentJson!), response.evidenceRecord);
    assert.deepEqual(response.evidenceRecord!.fields.direct.value, Array.from(response.directValues!));
    assert.deepEqual(response.evidenceRecord!.fields.inverted.value, Array.from(response.invertedValues!));
    assert.match(response.experimentTsv!, /0\t1\t0\t2\t2\t4\t0\t1/);
    assert.equal(response.experimentTsv!.includes('ACGT'), false);
  });

  it('never exports a preview as the requested full-resolution experiment', async () => {
    const run = harness();
    await run.handle({ data: captureJob(21, 'ANCT'.repeat(40), 200, 21) });
    assert.equal(run.messages.length, 1);
    const response = run.messages[0];
    assert.equal(response.ok, true);
    assert.equal(response.bins, 200);
    assert.equal(response.directValues!.length, 40000);
    assert.equal(response.evidenceRecord!.parameters.bins, 200);
    assert.equal(response.experimentTsv!.trimEnd().split('\n').length, 40004);
  });

  it('replays exported JSON numerically and returns the currently selected input metadata', async () => {
    const run = harness();
    await run.handle({ data: captureJob(22, 'anNt') });
    const content = run.messages[0].experimentJson!;
    await run.handle({ data: { requestId: 23, sequence: 'anNt', experiment: { kind: 'replay', content, context: experimentContext } } });
    assert.equal(run.messages[1].replayExactRecord, true);
    assert.deepEqual(Array.from(run.messages[1].invertedValues!), [0, 0.5, 0.5, 0]);
    await run.handle({ data: { requestId: 24, sequence: 'anNt', experiment: {
      kind: 'replay', content, context: { accession: 'CATALOG.9', source: 'catalog' },
    } } });
    assert.equal(run.messages[2].ok, true);
    assert.equal(run.messages[2].replayExactRecord, false);
    assert.equal(run.messages[2].evidenceRecord!.inputs[0].accession, 'CATALOG.9');
    assert.equal(run.messages[2].evidenceRecord!.inputs[0].source, 'catalog');
  });

  it('does not publish saved matrices for another same-length genome and remains usable after refusal', async () => {
    const run = harness();
    await run.handle({ data: captureJob(25) });
    await run.handle({ data: { requestId: 26, sequence: 'AAAA', experiment: {
      kind: 'replay', context: experimentContext, content: run.messages[0].experimentJson!,
    } } });
    const failure = run.messages[1];
    assert.equal(failure.ok, false);
    assert.match(failure.error!, /exact source/);
    assert.equal(failure.directValues, undefined);
    assert.equal(failure.evidenceRecord, undefined);
    await run.handle({ data: job(27) });
    assertAcgt(run.messages[2]);
  });

  it('rejects validly rehashed false outputs rather than treating the checksum as a replay', async () => {
    const source = await createDotPlotExperiment({ sequence: 'ACGT', ...experimentContext }, { bins: 2, window: 2 });
    const { record } = source;
    record.fields.inverted.value = [0, 0, 0, 0];
    const rehashed = await createAnalysisRecord({
      method: record.method, parameters: record.parameters, references: record.references, seed: record.seed, fields: record.fields,
      inputs: record.inputs.map(input => ({ id: input.id, data: input.data, description: input.description, accession: input.accession, source: input.source })),
    });
    const run = harness();
    await run.handle({ data: { requestId: 28, sequence: 'ACGT', experiment: {
      kind: 'replay', context: experimentContext, content: serializeAnalysisRecord(rehashed),
    } } });
    assert.equal(run.messages[0].ok, false);
    assert.match(run.messages[0].error!, /Recomputed/);
    assert.equal(run.messages[0].evidenceRecord, undefined);
    assert.equal(run.messages[0].experimentJson, undefined);
  });

  it('refuses a divergent displayed backend result, missing display or lossy source encoding', async () => {
    const badDisplay = captureJob(29);
    assert(badDisplay.experiment?.kind === 'create');
    badDisplay.experiment.displayed.directValues[1] = 1;
    const encoded: SequenceBytesRef = {
      buffer: new Uint8Array([0, 1, 2, 3]).buffer, byteOffset: 0, byteLength: 4, length: 4, encoding: 'acgt05', isShared: false,
    };
    const run = harness();
    const invalid = [badDisplay,
      { requestId: 30, sequence: 'ACGT', experiment: { kind: 'create', context: experimentContext } },
      { requestId: 31, sequenceRef: encoded, experiment: captureJob(31).experiment },
      { requestId: 32, sequence: 'ACGT', experiment: { kind: 'unsupported' } },
      { requestId: 33, sequence: 'ACGT', experiment: null },
      { requestId: 34, sequence: 'ACGT', config: { bins: 2 }, experiment: { kind: 'replay', context: experimentContext, content: '{}' } },
    ];
    for (const data of invalid) await run.handle({ data: data as DotPlotJob });
    assert.equal(run.messages.length, invalid.length);
    assert.equal(run.messages.every(response => !response.ok && response.evidenceRecord === undefined), true);
    assert.match(run.messages[0].error!, /Displayed/);
    assert.match(run.messages[2].error!, /lossy/);
  });

  it('accepts exact ASCII references without allowing the context to replace the actual source', async () => {
    const request = captureJob(35);
    const ascii: SequenceBytesRef = {
      buffer: new Uint8Array([65, 67, 71, 84]).buffer, byteOffset: 0, byteLength: 4, length: 4, encoding: 'ascii', isShared: false,
    };
    const run = harness();
    await run.handle({ data: { requestId: 35, sequenceRef: ascii, config: request.config, experiment: request.experiment } });
    assertAcgt(run.messages[0]);
    assert.equal(run.messages[0].evidenceRecord!.inputs[0].data, 'ACGT');
  });

  it('suppresses captures superseded while asynchronous record hashes are pending', async () => {
    const run = harness();
    const old = run.handle({ data: captureJob(36) });
    await run.handle({ data: job(37) });
    await old;
    assert.deepEqual(run.messages.map(response => response.requestId), [37]);
    assertAcgt(run.messages[0]);
  });

  it('suppresses both replay results and replay failures after a newer job takes ownership', async () => {
    const source = await createDotPlotExperiment({ sequence: 'ACGT', ...experimentContext }, { bins: 2, window: 2 });
    for (const invalidHash of [false, true]) {
      const record = structuredClone(source.record);
      if (invalidHash) record.inputs[0].sha256 = '0'.repeat(64);
      const run = harness();
      const old = run.handle({ data: { requestId: 38, sequence: 'ACGT', experiment: {
        kind: 'replay', context: experimentContext, content: serializeAnalysisRecord(record),
      } } });
      await run.handle({ data: job(39) });
      await old;
      assert.deepEqual(run.messages.map(response => response.requestId), [39]);
      assertAcgt(run.messages[0]);
    }
  });
});

const columnInput = (sequence = 'CCAANT') => ({ sequence, accession: 'COLUMN.1', source: 'local' as const });
function pairJob(id: number, row = 'AACC', column = 'CCAANT', bins = 3, window = 2): DotPlotJob {
  return { requestId: id, sequence: row, comparison: columnInput(column), config: { bins, window, ambiguity: 'exclude' } };
}
function pairCapture(id: number): DotPlotJob {
  const request = pairJob(id);
  return { ...request, experiment: { kind: 'create', context: experimentContext,
    displayed: computePairwiseDotPlotBuffers('AACC', 'CCAANT', request.config) } };
}

describe('pairwise dot plot worker integration', () => {
  it('computes both distinct axes without substituting the self-only native ABI', async () => {
    let loads = 0;
    const run = harness({ loadWasm: async () => { loads++; throw new Error('Self ABI must not be requested'); } });
    await run.handle({ data: pairJob(60) });
    const response = run.messages[0];
    assert.equal(response.ok, true); assert.equal(response.pairwise, true); assert.equal(loads, 0);
    assert.deepEqual(Array.from(response.directValues!), [0, 1, 0, 0.5, 0.5, 0, 1, 0, 0]);
    assert.deepEqual(Array.from(response.invertedValues!), [0, 0, 0.5, 0, 0, 0.5, 0, 0, 0]);
    assert.deepEqual(response.rowResolvedPerWindow, [2, 2, 2]);
    assert.deepEqual(response.columnResolvedPerWindow, [2, 2, 1]);
    assert.equal(response.evidenceRecord, undefined);
  });
  it('uses one common shorter-genome window in preview and final passes', async () => {
    const run = harness({ yieldControl: async () => {} });
    await run.handle({ data: pairJob(61, 'ACGT'.repeat(400), 'TGCA'.repeat(160), 80, 0) });
    assert.deepEqual(run.messages.map(r => [r.bins, r.window]), [[40, 20], [80, 20]]);
    for (const response of run.messages) {
      assert.equal(response.pairwise, true); assert.equal(response.rowResolvedPerWindow!.length, response.bins);
      assert.equal(response.columnResolvedPerWindow!.length, response.bins);
    }
  });
  it('captures and replays two-source records with exact matrix transfers and matching JSON/TSV', async () => {
    const run = harness();
    await run.handle({ data: pairCapture(62) });
    const first = run.messages[0];
    assert.equal(first.ok, true); assert.equal(first.evidenceRecord!.method.id, 'sequence-pairwise-dot-plot');
    assert.deepEqual(first.evidenceRecord!.inputs.map(i => i.data), ['AACC', 'CCAANT']);
    assert.deepEqual(JSON.parse(first.experimentJson!), first.evidenceRecord);
    assert.match(first.experimentTsv!, /0\t2\t0\t2\t4\t6\t2\t1\t0\t0.5/);
    await run.handle({ data: { requestId: 63, sequence: 'AACC', comparison: columnInput(),
      experiment: { kind: 'replay', context: experimentContext, content: first.experimentJson! } } });
    const second = run.messages[1];
    assert.equal(second.replayExactRecord, true); assert.deepEqual(second.evidenceRecord, first.evidenceRecord);
    assert.deepEqual(second.directValues, first.directValues); assert.deepEqual(second.columnResolvedPerWindow, [2, 2, 1]);
  });
  it('refuses a different same-length column and self/pairwise record substitution without losing the next job', async () => {
    const saved = (await createPairwiseDotPlotExperiment({ sequence: 'AACC', ...experimentContext }, columnInput(), { bins: 3, window: 2 })).record;
    const content = serializeAnalysisRecord(saved), run = harness();
    for (const comparison of [columnInput('TTTTTT'), undefined]) {
      await run.handle({ data: { requestId: 64, sequence: 'AACC', comparison,
        experiment: { kind: 'replay', context: experimentContext, content } } });
    }
    assert(run.messages.every(message => !message.ok && message.evidenceRecord === undefined));
    await run.handle({ data: job(65) }); assertAcgt(run.messages[2]);
  });
  it('rejects invalid column data and literal policy before producing a preview or loading WASM', async () => {
    let loads = 0;
    const run = harness({ loadWasm: async () => { loads++; return null; } });
    for (const comparison of [null, {}, columnInput(''), columnInput('NNNN'), columnInput('A😀T')]) {
      await run.handle({ data: { ...pairJob(66), comparison } as DotPlotJob });
    }
    await run.handle({ data: { ...pairJob(66), config: { bins: 3, window: 2, ambiguity: 'literal' } } });
    assert.equal(run.messages.length, 6); assert.equal(loads, 0);
    assert(run.messages.every(message => !message.ok && message.directValues === undefined));
  });
  it('preserves exact primary ASCII references and the separately supplied comparison sequence', async () => {
    const bytes = new TextEncoder().encode('!AACC!');
    const sequenceRef: SequenceBytesRef = { buffer: bytes.buffer, byteOffset: 1, byteLength: 4, length: 4, encoding: 'ascii', isShared: false };
    const run = harness();
    await run.handle({ data: { requestId: 67, sequenceRef, comparison: columnInput(), config: { bins: 3, window: 2 }, experiment: pairCapture(67).experiment } });
    assert.equal(run.messages[0].ok, true);
    assert.deepEqual(run.messages[0].evidenceRecord!.inputs.map(input => input.data), ['AACC', 'CCAANT']);
  });
  it('suppresses an old pairwise final pass after a new comparison takes ownership', async () => {
    const preview = deferred(), resume = deferred();
    const run = harness({ yieldControl: () => { preview.resolve(); return resume.promise; } });
    const old = run.handle({ data: pairJob(68, 'ACGT'.repeat(50), 'TTAA'.repeat(30), 80, 20) });
    await preview.promise;
    await run.handle({ data: pairJob(69) }); resume.resolve(); await old;
    assert.deepEqual(run.messages.map(r => [r.requestId, r.bins]), [[68, 40], [69, 3]]);
  });
  it('suppresses obsolete captures and replay failures while evidence hashes are pending', async () => {
    const run = harness(), old = run.handle({ data: pairCapture(70) });
    await run.handle({ data: job(71) }); await old;
    assert.deepEqual(run.messages.map(r => r.requestId), [71]);
    const saved = (await createPairwiseDotPlotExperiment({ sequence: 'AACC', ...experimentContext }, columnInput(), { bins: 3, window: 2 })).record;
    const replay = run.handle({ data: { requestId: 72, sequence: 'AACC', comparison: columnInput('TTTTTT'),
      experiment: { kind: 'replay', context: experimentContext, content: serializeAnalysisRecord(saved) } } });
    await run.handle({ data: job(73) }); await replay;
    assert.deepEqual(run.messages.map(r => r.requestId), [71, 73]);
  });
});
