import { makePackagingSimulation, makeResistanceSimulation } from '../../../core/src/simulation-implementations';
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, ribosomeTrafficSimulation, SPEED_OPTIONS, makeLysogenySimulation,
  type PhageFull, type AnalysisRecord, type RibosomeTrafficState, type ResistanceCocktailState, type PackagingMotorState } from '@phage-explorer/core';
import type { Simulation, SimState, PlaqueAutomataState, SimInitParams } from '../workers/types';
import { createSimulationAPI, getSimulationRandomState, MAX_SIMULATION_EXPERIMENT_STEPS, simulationStateJson } from '../workers/simulation-runtime';
import { SimulationSession, loadRibosomeSimulationInput, type SimulationInput } from './SimulationSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

const codingSequence = 'ATGCTACTGCTGCTGTAA';
const codingPhage: PhageFull = {
  id: 31, accession: 'LOCAL_CDS', slug: 'local-cds', name: 'Local coding genome', family: null, host: null,
  genomeLength: codingSequence.length, gcContent: null, morphology: null, lifecycle: null, description: null,
  baltimoreGroup: null, genomeType: null, pdbIds: [], hasModel: false, codonUsage: null,
  genes: [{ id: 7, name: 'short', locusTag: 'exact_7', product: 'exact short CDS', type: 'CDS',
    startPos: 0, endPos: codingSequence.length, strand: '+' }],
};
const ribosomeBackend = () => {
  const api = createSimulationAPI([ribosomeTrafficSimulation as unknown as Simulation<SimState>]);
  return {
    getSimulationMetadata: (id: Simulation['id'], _signal?: AbortSignal) => api.getMetadata(id),
    initSimulation: (params: SimInitParams, _signal?: AbortSignal) => api.init(params),
    stepSimulation: (state: SimState, dt: number, _signal?: AbortSignal) => api.step({ state, dt }),
  };
};
const codingInput = (genomeSequence = codingSequence): SimulationInput => ({ phage: structuredClone(codingPhage),
  context: { genomeSequence, geneId: 7 } });

describe('complete packaging experiment sessions', () => {
  const motorBackend = () => {
    const api = createSimulationAPI([makePackagingSimulation() as unknown as Simulation]);
    return {
      getSimulationMetadata: (id: Simulation['id']) => api.getMetadata(id),
      initSimulation: (params: SimInitParams) => api.init(params),
      stepSimulation: (state: SimState, dt: number) => api.step({ state, dt }),
    };
  };

  it('completes, stops recording, exports and reopens through a fresh motor session', async () => {
    const source = new SimulationSession('packaging-motor', null, motorBackend, {}, 7);
    const target = new SimulationSession('packaging-motor', null, motorBackend, {}, 19);
    try {
      await source.activate();
      await source.init({ genomeKb: 3, capsidRadius: 60, ionic: 200 });
      assert.equal(source.getSnapshot().error, null);
      source.setSpeed(8); source.play(); await source.step();
      const final = source.getSnapshot().state as PackagingMotorState;
      assert.equal(final.status, 'complete');
      assert.equal(final.bpPackaged, 3000);
      assert.equal(final.running, false);
      assert.equal(source.getSnapshot().isRunning, false);
      assert.equal(source.getSnapshot().completedSteps, 1);
      source.play(); await source.step();
      assert.equal(source.getSnapshot().isRunning, false);
      assert.equal(source.getSnapshot().completedSteps, 1, 'terminal state does not record no-op worker calls');
      const content = await source.exportExperiment(), record = await parseAnalysisRecord(content);
      assert.equal(record.method.version, '2');
      assert.deepEqual(record.parameters.stepDeltas, [8], 'retain the requested delta even when completion occurs earlier');
      await target.activate(); await target.replayExperiment(content);
      assert.equal(target.getSnapshot().error, null);
      assert.deepEqual(target.getSnapshot().state, final);
      assert.equal((await parseAnalysisRecord(await target.exportExperiment())).resultId, record.resultId);
      target.play(); await target.step();
      assert.equal(target.getSnapshot().completedSteps, 1);
      await target.setParam('mode', 'phi29');
      const restarted = target.getSnapshot().state as PackagingMotorState;
      assert.equal(restarted.bpPackaged, 0);
      assert.equal(restarted.time, 0);
      assert.equal(restarted.status, 'packaging');
      assert.equal(restarted.motorStallForcePn, 57);
      assert.equal(restarted.params.ionic, 200);
    } finally { source.deactivate(); target.deactivate(); }
  });

  it('retains a partial physical tick and refuses obsolete or freshly rehashed false results', async () => {
    const source = new SimulationSession('packaging-motor', null, motorBackend, {}, 8);
    const target = new SimulationSession('packaging-motor', null, motorBackend, {}, 19);
    try {
      await source.activate(); source.setSpeed(0.27); await source.step();
      const partial = source.getSnapshot().state as PackagingMotorState;
      assert.equal(partial.completedSteps, 5);
      assert(Math.abs(partial.pendingSteps - 0.4) < 1e-12);
      const content = await source.exportExperiment(), record = await parseAnalysisRecord(content);
      await target.activate(); await target.replayExperiment(content);
      assert.equal(target.getSnapshot().error, null);
      assert.deepEqual(target.getSnapshot().state, partial);
      const accepted = target.getSnapshot().state;
      const old = await createAnalysisRecord({ ...record, method: { ...record.method, version: '1' } });
      await target.replayExperiment(serializeAnalysisRecord(old));
      assert.match(target.getSnapshot().error!, /version/i);
      assert.strictEqual(target.getSnapshot().state, accepted);
      const finalState = record.fields.finalState;
      assert(finalState.kind === 'simulation' || finalState.kind === 'demo');
      const falseRecord = await createAnalysisRecord({ ...record, fields: { ...record.fields,
        finalState: { ...finalState, value: { ...finalState.value as object, pressure: 123 } } } });
      await target.replayExperiment(serializeAnalysisRecord(falseRecord));
      assert.match(target.getSnapshot().error!, /differs/);
      assert.strictEqual(target.getSnapshot().state, accepted);
    } finally { source.deactivate(); target.deactivate(); }
  });
});

describe('lysogeny numerical-method replay', () => {
  it('replays verified equilibria and rejects obsolete portrait results before changing the accepted state', async () => {
    const api = createSimulationAPI([makeLysogenySimulation() as unknown as Simulation<SimState>]);
    let initCalls = 0;
    const service = {
      getSimulationMetadata: (id: Simulation['id']) => api.getMetadata(id),
      initSimulation: (params: SimInitParams) => { initCalls++; return api.init(params); },
      stepSimulation: (state: SimState, dt: number) => api.step({ state, dt }),
    };
    const source = new SimulationSession('lysogeny-circuit', null, () => service, {}, 0);
    const target = new SimulationSession('lysogeny-circuit', null, () => service, {}, 1);
    await source.activate(); await source.step();
    const content = await source.exportExperiment(), record = await parseAnalysisRecord(content);
    assert.equal(record.method.version, '2');
    assert.match(record.method.implementation, /residual-checked/);
    await target.activate(); await target.replayExperiment(content);
    assert.equal(target.getSnapshot().error, null);
    assert.deepEqual(target.getSnapshot().state, source.getSnapshot().state);
    assert.equal((await parseAnalysisRecord(await target.exportExperiment())).resultId, record.resultId);
    const before = target.getSnapshot().state, previousCalls = initCalls;
    await target.replayExperiment(await rewriteRecord(content, old => { old.method.version = '1'; }));
    assert.match(target.getSnapshot().error!, /incompatible/);
    assert.strictEqual(target.getSnapshot().state, before);
    assert.equal(initCalls, previousCalls);
    source.deactivate(); target.deactivate();
  });
});

describe('sequence-grounded simulation input and replay', () => {
  it('loads exact bases and canonical genes together instead of stale summary annotations', async () => {
    const calls: unknown[] = [];
    const input = await loadRibosomeSimulationInput({
      getFullGenomeLength: async id => { calls.push(['length', id]); return codingSequence.length; },
      getSequenceWindow: async (...args) => { calls.push(['sequence', ...args]); return codingSequence; },
      getGenes: async id => { calls.push(['genes', id]); return codingPhage.genes; },
    }, { ...codingPhage, genes: [] }, 7, new AbortController().signal);
    assert.deepEqual(calls, [['length', 31], ['sequence', 31, 0, 18], ['genes', 31]]);
    assert.deepEqual(input.context, { genomeSequence: codingSequence, geneId: 7 });
    assert.deepEqual(input.phage?.genes, codingPhage.genes);
    const state = await ribosomeBackend().initSimulation({ simId: 'ribosome-traffic', seed: 0, ...input }) as RibosomeTrafficState;
    assert.equal(state.transcript?.cds, codingSequence);
    assert.equal(state.transcript?.protein, 'MLLLL*');
    assert.deepEqual(state.codonRates, [1, 0.4, 1, 1, 1, 1]);
  });

  it('refuses incomplete reads and cancels before downstream repository calls', async () => {
    let downstream = 0;
    const pending = deferred<number>(), controller = new AbortController();
    const repository = {
      getFullGenomeLength: () => pending.promise,
      getSequenceWindow: async () => { downstream++; return codingSequence.slice(1); },
      getGenes: async () => { downstream++; return codingPhage.genes; },
    };
    const reading = loadRibosomeSimulationInput(repository, codingPhage, 7, controller.signal);
    controller.abort(); pending.resolve(18);
    await assert.rejects(reading, /abort/i);
    assert.equal(downstream, 0);
    await assert.rejects(loadRibosomeSimulationInput(repository, codingPhage, 7, new AbortController().signal), /incomplete/);
    for (const length of [0, NaN, 1.5, 5000001]) {
      await assert.rejects(loadRibosomeSimulationInput({ ...repository, getFullGenomeLength: async () => length },
        codingPhage, 7, new AbortController().signal), /genome of/);
    }
    assert.equal(downstream, 2);
  });

  it('discards cancelled sources and retains an immutable accepted sequence for resets', async () => {
    const old = deferred<SimulationInput>(), fresh = codingInput('ATGCTGCTGCTGCTGTAA');
    const signals: AbortSignal[] = [];
    const session = new SimulationSession('ribosome-traffic', codingPhage, ribosomeBackend, {}, 0, signal => {
      signals.push(signal); return signals.length === 1 ? old.promise : Promise.resolve(fresh);
    });
    const first = session.activate(); await flush();
    session.cancel();
    assert.equal(signals[0].aborted, true);
    await session.init();
    const accepted = session.getSnapshot().state as RibosomeTrafficState;
    assert.equal(accepted.transcript?.cds, 'ATGCTGCTGCTGCTGTAA');
    fresh.context!.genomeSequence = codingSequence;
    old.resolve(codingInput()); await first;
    assert.strictEqual(session.getSnapshot().state, accepted);
    await session.reset();
    assert.equal((session.getSnapshot().state as RibosomeTrafficState).transcript?.cds, 'ATGCTGCTGCTGCTGTAA');
    assert.equal(signals.length, 2);
    session.deactivate();
  });

  it('reports source failures and retries without inventing a synthetic track', async () => {
    let attempts = 0;
    const session = new SimulationSession('ribosome-traffic', codingPhage, ribosomeBackend, {}, 0, async () => {
      if (++attempts === 1) throw new Error('Repository read failed');
      return codingInput();
    });
    await session.activate();
    assert.equal(session.getSnapshot().state, null);
    assert.equal(session.getSnapshot().isLoading, false);
    assert.match(session.getSnapshot().error!, /Repository read failed/);
    await session.init();
    assert.equal(session.getSnapshot().error, null);
    assert.equal((session.getSnapshot().state as RibosomeTrafficState).source, 'annotated-cds');
    session.deactivate();
  });

  it('replays exact transcripts and rejects same-ID changed bases or CDS selection before compute', async () => {
    const source = new SimulationSession('ribosome-traffic', codingPhage, ribosomeBackend, {}, 0, async () => codingInput());
    await source.activate();
    await source.setParam('footprint', 1);
    for (const delta of [0.25, 0.25, 0.5, 1, 2]) { source.setSpeed(delta); await source.step(); }
    const content = await source.exportExperiment(), record = await parseAnalysisRecord(content);
    assert.equal(record.method.version, '2');
    assert.deepEqual(record.inputs[0].data, analysisJson({ phage: codingPhage,
      context: { genomeSequence: codingSequence, geneId: 7 } }));
    const target = new SimulationSession('ribosome-traffic', codingPhage, ribosomeBackend, {}, 42, async () => codingInput());
    await target.activate(); await target.replayExperiment(content);
    assert.equal(target.getSnapshot().error, null);
    assert.deepEqual(target.getSnapshot().state, source.getSnapshot().state);
    assert.equal((await parseAnalysisRecord(await target.exportExperiment())).resultId, record.resultId);
    for (const input of [codingInput('ATGCTGCTGCTGCTGTAA'), { ...codingInput(), context: { genomeSequence: codingSequence } }]) {
      const service = ribosomeBackend();
      const changed = new SimulationSession('ribosome-traffic', codingPhage, () => service, {}, 0, async () => input);
      await changed.activate();
      const before = changed.getSnapshot().state;
      let calls = 0;
      service.initSimulation = async () => { calls++; throw new Error('Unexpected model work'); };
      await changed.replayExperiment(content);
      assert.equal(calls, 0);
      assert.match(changed.getSnapshot().error!, /input differs/);
      assert.strictEqual(changed.getSnapshot().state, before);
      changed.deactivate();
    }
    await target.replayExperiment(await rewriteRecord(content, changed => { changed.method.version = '1'; }));
    assert.match(target.getSnapshot().error!, /incompatible/);
    assert.deepEqual(target.getSnapshot().state, source.getSnapshot().state);
    source.deactivate(); target.deactivate();
  });
});
const probe: Simulation = {
  id: 'plaque-automata', name: 'Test model', description: 'A stateful model used to verify controls', controls: [],
  parameters: [
    { id: 'size', label: 'Size', type: 'number', min: 1, max: 32, step: 1, defaultValue: 2 },
    { id: 'flag', label: 'Flag', type: 'boolean', defaultValue: false },
    { id: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'A' }], defaultValue: 'a' },
  ],
  init: (_phage, params, random) => {
    const size = Number(params?.size ?? 2);
    return { type: 'plaque-automata', params: { size, flag: params?.flag ?? false, mode: params?.mode ?? 'a' }, time: 0, speed: 1, running: false,
      gridSize: size, grid: new Uint8Array(size), infectionTimes: new Float32Array(size),
      phageCount: random!(), bacteriaCount: 0, infectionCount: 0 };
  },
  step: (input, dt, random) => ({ ...input, time: input.time + dt, phageCount: random!() } as SimState),
  getSummary: () => '',
};
function backend() {
  const api = createSimulationAPI([probe]);
  return {
    getSimulationMetadata: (id: typeof probe.id, _signal?: AbortSignal) => api.getMetadata(id),
    initSimulation: (params: SimInitParams, _signal?: AbortSignal) => api.init(params),
    stepSimulation: (state: SimState, dt: number, _signal?: AbortSignal) => api.step({ state, dt }),
  };
}

describe('simulation session lifecycle', () => {
  it('initializes with metadata defaults, phage defaults and an explicit seed', async () => {
    const service = backend();
    const session = new SimulationSession(probe.id, null, () => service, { size: 5 }, 0);
    await session.activate();
    assert.equal((session.getSnapshot().state as PlaqueAutomataState).grid.length, 5);
    assert.equal(session.getSnapshot().parameterValues.flag, false);
    assert.equal(getSimulationRandomState(session.getSnapshot().state!).seed, 0);
    assert.equal(session.getSnapshot().isLoading, false);
    session.deactivate();
  });
  it('reset reproduces the initial state and the same subsequent random trajectory', async () => {
    const session = new SimulationSession(probe.id, null, backend, {}, 42);
    await session.activate();
    const initial = structuredClone(session.getSnapshot().state);
    await session.step();
    const first = structuredClone(session.getSnapshot().state);
    await session.step();
    await session.reset();
    assert.deepEqual(session.getSnapshot().state, initial);
    await session.step();
    assert.deepEqual(session.getSnapshot().state, first);
    assert.equal(session.getSnapshot().completedSteps, 1);
    session.deactivate();
  });
  it('parameter changes rebuild derived arrays and initial conditions, not just labels', async () => {
    const session = new SimulationSession(probe.id, null, backend, { size: 5 }, 4);
    await session.activate();
    await session.step();
    await session.setParam('size', 7);
    const state = session.getSnapshot().state as PlaqueAutomataState;
    assert.equal(state.params.size, 7);
    assert.equal(state.gridSize, 7);
    assert.equal(state.grid.length, 7);
    assert.equal(state.time, 0);
    assert.equal(session.getSnapshot().isRunning, false);
    await session.reset();
    assert.equal((session.getSnapshot().state as PlaqueAutomataState).grid.length, 7);
    session.deactivate();
  });
  it('invalid parameter edits preserve the accepted state and report the cause', async () => {
    const session = new SimulationSession(probe.id, null, backend);
    await session.activate();
    const before = session.getSnapshot().state;
    for (const [id, value] of [['size', NaN], ['size', 33], ['size', '2'], ['flag', 1], ['mode', 'b'], ['missing', 1]] as const) {
      await session.setParam(id, value);
      assert.strictEqual(session.getSnapshot().state, before);
      assert.ok(session.getSnapshot().error);
    }
    session.deactivate();
  });
  it('a new seed rebuilds the run, while invalid seeds and speeds are not applied', async () => {
    const session = new SimulationSession(probe.id, null, backend, {}, 1);
    await session.activate();
    const before = structuredClone(session.getSnapshot().state);
    await session.setSeed(0);
    assert.notDeepEqual(session.getSnapshot().state, before);
    const seeded = session.getSnapshot().state;
    await session.setSeed(-1);
    assert.strictEqual(session.getSnapshot().state, seeded);
    assert.equal(session.getSnapshot().seed, 0);
    for (const speed of [NaN, Infinity, 0, 9]) {
      session.setSpeed(speed);
      assert.equal(session.getSnapshot().speed, 1);
    }
    session.setSpeed(0.5);
    await session.step();
    assert.equal(session.getSnapshot().state!.time, 0.5);
    session.deactivate();
  });
  it('cancels initialization immediately and ignores its late success', async () => {
    const service = backend();
    const pending = deferred<SimState>();
    let signal: AbortSignal | undefined;
    service.initSimulation = (_params, s) => { signal = s; return pending.promise; };
    const session = new SimulationSession(probe.id, null, () => service);
    const starting = session.activate();
    await flush();
    assert.equal(session.getSnapshot().isLoading, true);
    session.cancel();
    assert.equal(signal?.aborted, true);
    assert.equal(session.getSnapshot().isLoading, false);
    pending.resolve(await backend().initSimulation({ simId: probe.id, seed: 7 }));
    await starting;
    assert.equal(session.getSnapshot().state, null);
    session.deactivate();
  });
  it('an old initialization failure cannot clear a newer loading state or install an error', async () => {
    const service = backend();
    const old = deferred<SimState>();
    const fresh = deferred<SimState>();
    let calls = 0;
    service.initSimulation = () => (++calls === 1 ? old.promise : fresh.promise);
    const session = new SimulationSession(probe.id, null, () => service, {}, 3);
    const first = session.activate();
    await flush();
    const second = session.init();
    await flush();
    old.reject(new Error('late old error'));
    await first;
    assert.equal(session.getSnapshot().isLoading, true);
    assert.equal(session.getSnapshot().error, null);
    fresh.resolve(await backend().initSimulation({ simId: probe.id, seed: 3 }));
    await second;
    assert.equal(session.getSnapshot().isLoading, false);
    assert.ok(session.getSnapshot().state);
    session.deactivate();
  });
  it('pause aborts an in-flight step and resumes from the last accepted RNG cursor', async () => {
    const service = backend();
    const actualStep = service.stepSimulation;
    const pending = deferred<SimState>();
    let signal: AbortSignal | undefined;
    service.stepSimulation = (_state, _dt, s) => { signal = s; return pending.promise; };
    const session = new SimulationSession(probe.id, null, () => service, {}, 12);
    await session.activate();
    const before = structuredClone(session.getSnapshot().state!);
    const stepping = session.step();
    session.pause();
    assert.equal(signal?.aborted, true);
    pending.resolve(await actualStep(before, 1));
    await stepping;
    assert.deepEqual(session.getSnapshot().state, before);
    service.stepSimulation = actualStep;
    await session.step();
    assert.deepEqual(session.getSnapshot().state, await actualStep(before, 1));
    assert.equal(session.getSnapshot().completedSteps, 1);
    session.deactivate();
  });
  it('late step completion cannot unlock a newer step after reset', async () => {
    const service = backend();
    const pending = [deferred<SimState>(), deferred<SimState>()];
    const calls: SimState[] = [];
    service.stepSimulation = state => { calls.push(state); return pending[calls.length - 1].promise; };
    const session = new SimulationSession(probe.id, null, () => service, {}, 6);
    await session.activate();
    const oldStep = session.step();
    await session.reset();
    const newStep = session.step();
    pending[0].resolve(await backend().stepSimulation(calls[0], 1));
    await oldStep;
    await session.step();
    assert.equal(calls.length, 2);
    assert.equal(session.getSnapshot().isStepping, true);
    pending[1].resolve(await backend().stepSimulation(calls[1], 1));
    await newStep;
    assert.equal(session.getSnapshot().completedSteps, 1);
    assert.equal(session.getSnapshot().isStepping, false);
    session.deactivate();
  });
  it('an old rejected step cannot stop a restarted playback timer', async () => {
    const service = backend();
    const actualStep = service.stepSimulation;
    const old = deferred<SimState>();
    let calls = 0;
    service.stepSimulation = (state, dt, signal) => ++calls === 1 ? old.promise : actualStep(state, dt, signal);
    const session = new SimulationSession(probe.id, null, () => service);
    try {
      await session.activate();
      const oldStep = session.step();
      await session.reset();
      session.play();
      old.reject(new Error('obsolete worker failed'));
      await oldStep;
      assert.equal(session.getSnapshot().isRunning, true);
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.ok(calls >= 2, 'the new playback timer must still schedule steps');
      assert.equal(session.getSnapshot().error, null);
    } finally { session.deactivate(); }
  });
  it('a current playback failure stops the timer and a manual retry clears the error', async () => {
    const service = backend();
    const actualStep = service.stepSimulation;
    let calls = 0;
    service.stepSimulation = async () => { calls++; throw new Error('current failure'); };
    const session = new SimulationSession(probe.id, null, () => service);
    try {
      await session.activate();
      session.play();
      await session.step();
      assert.equal(session.getSnapshot().isRunning, false);
      assert.match(session.getSnapshot().error!, /current failure/);
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(calls, 1);
      service.stepSimulation = actualStep;
      await session.step();
      assert.equal(session.getSnapshot().error, null);
    } finally { session.deactivate(); }
  });
  it('deactivation/re-activation cannot accept old metadata (StrictMode and selection changes)', async () => {
    const service = backend();
    type Metadata = Awaited<ReturnType<typeof service.getSimulationMetadata>>;
    const old = deferred<Metadata>();
    const fresh = deferred<Metadata>();
    let calls = 0;
    service.getSimulationMetadata = () => ++calls === 1 ? old.promise : fresh.promise;
    const session = new SimulationSession(probe.id, null, () => service);
    const first = session.activate();
    session.deactivate();
    const second = session.activate();
    const metadata = await backend().getSimulationMetadata(probe.id);
    fresh.resolve({ ...metadata, name: 'Current metadata' });
    await second;
    old.resolve({ ...metadata, name: 'Obsolete metadata' });
    await first;
    assert.equal(session.getSnapshot().metadata?.name, 'Current metadata');
    assert.ok(session.getSnapshot().state);
    session.deactivate();
  });
  it('snapshots phage input and does not share state between selection-scoped sessions', async () => {
    const service = backend();
    const actualInit = service.initSimulation;
    const names: Array<string | undefined> = [];
    service.initSimulation = (params, signal) => { names.push(params.phage?.name); return actualInit(params, signal); };
    const phage = { name: 'Original genome' } as PhageFull;
    const first = new SimulationSession(probe.id, phage, () => service);
    phage.name = 'Replacement genome';
    await first.activate();
    const second = new SimulationSession(probe.id, phage, () => service);
    first.deactivate();
    assert.equal(second.getSnapshot().state, null);
    await second.activate();
    assert.deepEqual(names, ['Original genome', 'Replacement genome']);
    assert.notStrictEqual(first.getSnapshot().state, second.getSnapshot().state);
    second.deactivate();
  });
});

async function recordedRun(phage: PhageFull | null = null) {
  const session = new SimulationSession(probe.id, phage, backend, {}, 0);
  await session.activate();
  await session.setParam('size', 5);
  for (const delta of [1, 0.25, 2, 8]) { session.setSpeed(delta); await session.step(); }
  return { session, content: await session.exportExperiment() };
}
async function rewriteRecord(content: string, change: (record: AnalysisRecord) => void) {
  const record = await parseAnalysisRecord(content);
  change(record);
  return serializeAnalysisRecord(await createAnalysisRecord({ ...record,
    inputs: record.inputs.map(({ sha256: _sha256, ...input }) => input) }));
}

describe('portable simulation experiment replay', () => {
  it('records the exact accepted step partition and typed-array state', async () => {
    const { session, content } = await recordedRun();
    const record = await parseAnalysisRecord(content);
    assert.deepEqual(record.parameters.stepDeltas, [1, 0.25, 2, 8]);
    assert.equal(record.seed, 0);
    assert.equal(record.inputs[0].source, 'demo');
    assert.equal(record.fields.finalState.kind, 'simulation');
    const initial = record.fields.initialState.value as Record<string, unknown>;
    assert.deepEqual(initial.grid, { arrayType: 'Uint8Array', values: [0, 0, 0, 0, 0] });
    assert.equal((record.fields.finalState.value as Record<string, unknown>).time, 11.25);
    session.deactivate();
  });
  it('recomputes, restores and re-exports an identical run through fresh runtime instances', async () => {
    const { session: source, content } = await recordedRun();
    const target = new SimulationSession(probe.id, null, backend, {}, 999);
    await target.activate();
    await target.replayExperiment(content);
    assert.equal(target.getSnapshot().error, null);
    assert.match(target.getSnapshot().replayMessage!, /Verified replay of 4/);
    assert.deepEqual(target.getSnapshot().state, source.getSnapshot().state);
    assert.equal(target.getSnapshot().isRunning, false);
    assert.equal((await parseAnalysisRecord(await target.exportExperiment())).resultId,
      (await parseAnalysisRecord(content)).resultId);
    source.setSpeed(0.5); target.setSpeed(0.5);
    await source.step(); await target.step();
    assert.deepEqual(target.getSnapshot().state, source.getSnapshot().state);
    assert.deepEqual((await parseAnalysisRecord(await target.exportExperiment())).parameters.stepDeltas, [1, 0.25, 2, 8, 0.5]);
    await target.reset();
    assert.equal(target.getSnapshot().state!.time, 0);
    assert.equal(target.getSnapshot().seed, 0);
    assert.equal(target.getSnapshot().parameterValues.size, 5);
    source.deactivate(); target.deactivate();
  });
  it('rejects same-ID input metadata changes before initializing a replay', async () => {
    const phage = { id: 1, accession: 'INPUT', name: 'Original', genes: [] } as unknown as PhageFull;
    const { session: source, content } = await recordedRun(phage);
    const service = backend();
    const target = new SimulationSession(probe.id, { ...phage, name: 'Different annotation snapshot' }, () => service);
    await target.activate();
    const before = target.getSnapshot().state;
    let computations = 0;
    service.initSimulation = async () => { computations++; throw new Error('Must not compute'); };
    await target.replayExperiment(content);
    assert.equal(computations, 0);
    assert.match(target.getSnapshot().error!, /input differs/);
    assert.strictEqual(target.getSnapshot().state, before);
    source.deactivate(); target.deactivate();
  });
  it('rejects changed checksums without starting model work', async () => {
    const { session, content } = await recordedRun();
    const changed = JSON.parse(content);
    changed.seed = 2;
    const before = session.getSnapshot().state;
    await session.replayExperiment(JSON.stringify(changed));
    assert.match(session.getSnapshot().error!, /identity differs|checksum/);
    assert.strictEqual(session.getSnapshot().state, before);
    session.deactivate();
  });
  it('rejects unsupported methods, implementation versions and references even with valid hashes', async () => {
    const { session, content } = await recordedRun();
    for (const change of [
      (record: AnalysisRecord) => { record.method.id = 'simulation-infection-kinetics'; },
      (record: AnalysisRecord) => { record.method.version = '999'; },
      (record: AnalysisRecord) => { record.method.implementation = 'other implementation'; },
      (record: AnalysisRecord) => { record.references[0].version = 'other reference'; },
    ]) {
      await session.replayExperiment(await rewriteRecord(content, change));
      assert.match(session.getSnapshot().error!, /incompatible/);
    }
    session.deactivate();
  });
  it('rejects oversized histories, invalid deltas and unsupported RNG configuration', async () => {
    const { session, content } = await recordedRun();
    for (const change of [
      (record: AnalysisRecord) => { record.parameters.stepDeltas = Array(MAX_SIMULATION_EXPERIMENT_STEPS + 1).fill(1); },
      (record: AnalysisRecord) => { record.parameters.stepDeltas = [0]; },
      (record: AnalysisRecord) => { record.parameters.randomAlgorithm = 'unknown'; },
      (record: AnalysisRecord) => { record.seed = -1; },
    ]) {
      await session.replayExperiment(await rewriteRecord(content, change));
      assert.match(session.getSnapshot().error!, /step deltas|parameters or seed/);
    }
    session.deactivate();
  });
  it('validates all recorded parameters before calling model initialization', async () => {
    const { session: source, content } = await recordedRun();
    const service = backend();
    const target = new SimulationSession(probe.id, null, () => service);
    await target.activate();
    let initializations = 0;
    service.initSimulation = async () => { initializations++; throw new Error('Unexpected initialization'); };
    for (const parameters of [{ size: 999, flag: false, mode: 'a' }, { size: 5 },
      { size: 5, flag: false, mode: 'a', injected: true }]) {
      await target.replayExperiment(await rewriteRecord(content, record => { record.parameters.initialParameters = analysisJson(parameters); }));
      assert.ok(target.getSnapshot().error);
      assert.equal(initializations, 0);
    }
    source.deactivate(); target.deactivate();
  });
  it('does not install forged final values whose hashes are internally valid', async () => {
    const { session, content } = await recordedRun();
    const before = session.getSnapshot().state;
    const changed = await rewriteRecord(content, record => {
      (record.fields.finalState.value as Record<string, unknown>).phageCount = 99;
    });
    await session.replayExperiment(changed);
    assert.match(session.getSnapshot().error!, /Fresh simulation result or evidence differs/);
    assert.strictEqual(session.getSnapshot().state, before);
    assert.equal(session.getSnapshot().completedSteps, 4);
    session.deactivate();
  });
  it('checks freshly computed initial conditions before replaying later steps', async () => {
    const { session, content } = await recordedRun();
    const before = session.getSnapshot().state;
    await session.replayExperiment(await rewriteRecord(content, record => {
      (record.fields.initialState.value as Record<string, unknown>).time = 50;
    }));
    assert.match(session.getSnapshot().error!, /Fresh initial simulation state differs/);
    assert.strictEqual(session.getSnapshot().state, before);
    session.deactivate();
  });
  it('preserves the accepted run when a delayed file read is cancelled', async () => {
    const { session, content } = await recordedRun();
    const before = session.getSnapshot().state;
    const file = deferred<string>();
    const replaying = session.replayExperiment(file.promise);
    assert.equal(session.getSnapshot().isLoading, true);
    session.cancel();
    file.resolve(content);
    await replaying;
    assert.equal(session.getSnapshot().isLoading, false);
    assert.strictEqual(session.getSnapshot().state, before);
    assert.match(session.getSnapshot().replayMessage!, /cancelled/);
    session.deactivate();
  });
  it('aborts replay work and refuses its late result after a newer reset', async () => {
    const { session: source, content } = await recordedRun();
    const service = backend();
    const actualStep = service.stepSimulation;
    const started = deferred<void>();
    const result = deferred<SimState>();
    let signal: AbortSignal | undefined;
    service.stepSimulation = (state, dt, activeSignal) => {
      signal = activeSignal;
      void actualStep(state, dt).then(result.resolve);
      started.resolve();
      return result.promise.then(async state => { await release.promise; return state; });
    };
    const release = deferred<void>();
    const target = new SimulationSession(probe.id, null, () => service, {}, 19);
    await target.activate();
    const replaying = target.replayExperiment(content);
    await started.promise;
    await target.reset();
    const resetState = target.getSnapshot().state;
    assert.equal(signal?.aborted, true);
    release.resolve();
    await replaying;
    assert.strictEqual(target.getSnapshot().state, resetState);
    assert.equal(target.getSnapshot().seed, 19);
    assert.equal(target.getSnapshot().completedSteps, 0);
    assert.equal(target.getSnapshot().isLoading, false);
    assert.equal(target.getSnapshot().error, null);
    source.deactivate(); target.deactivate();
  });
  it('exports a snapshot, not changes made while its hashes are being computed', async () => {
    const { session, content } = await recordedRun();
    const exporting = session.exportExperiment();
    await session.setSeed(18);
    assert.equal((await parseAnalysisRecord(await exporting)).resultId, (await parseAnalysisRecord(content)).resultId);
    session.deactivate();
  });
  it('rejects exporting an in-flight run and does not record a cancelled step', async () => {
    const service = backend();
    const session = new SimulationSession(probe.id, null, () => service, {}, 5);
    await session.activate();
    const pending = deferred<SimState>();
    const before = session.getSnapshot().state!;
    service.stepSimulation = () => pending.promise;
    const stepping = session.step();
    await assert.rejects(session.exportExperiment(), /Pause/);
    session.pause();
    pending.resolve(await backend().stepSimulation(before, 1));
    await stepping;
    const record = await parseAnalysisRecord(await session.exportExperiment());
    assert.deepEqual(record.parameters.stepDeltas, []);
    assert.deepEqual(record.fields.initialState.value, record.fields.finalState.value);
    session.deactivate();
  });
  it('accepts a semantically identical record with reordered JSON properties', async () => {
    const { session, content } = await recordedRun();
    const record = JSON.parse(content);
    record.fields.initialState.value = Object.fromEntries(Object.entries(record.fields.initialState.value).reverse());
    await session.replayExperiment(JSON.stringify(record));
    assert.equal(session.getSnapshot().error, null);
    assert.match(session.getSnapshot().replayMessage!, /Verified replay/);
    session.deactivate();
  });
  it('rejects nonfinite typed-array values instead of serializing them as null', () => {
    assert.throws(() => simulationStateJson(new Float32Array([NaN])), /finite/);
    assert.throws(() => simulationStateJson({ value: Infinity }), /finite/);
    assert.throws(() => simulationStateJson(new DataView(new ArrayBuffer(4))), /DataView/);
    const values = new Float32Array([0.25]);
    const captured = simulationStateJson(values);
    values[0] = 0.5;
    assert.deepEqual(captured, { arrayType: 'Float32Array', values: [0.25] });
  });
});

describe('terminal resistance playback', () => {
  const zeroRates = { growthRate: 0, infectionRate: 0, mutationRate: 0, multiResRate: 0, phageDecay: 0 };
  const resistanceBackend = () => {
    const api = createSimulationAPI([makeResistanceSimulation() as unknown as Simulation]);
    return {
      getSimulationMetadata: (id: Simulation['id']) => api.getMetadata(id),
      initSimulation: (params: SimInitParams) => api.init(params),
      stepSimulation: (state: SimState, dt: number) => api.step({ state, dt }),
    };
  };

  it('runs all 48 hours at the slowest UI speed and replays the portable experiment exactly', async () => {
    const sourceService = resistanceBackend(), targetService = resistanceBackend();
    const source = new SimulationSession('resistance-cocktail', null, () => sourceService, {}, 7);
    const target = new SimulationSession('resistance-cocktail', null, () => targetService, {}, 99);
    try {
      await source.activate();
      // Actual public controls, not a replacement transition or test-only parameter metadata.
      await source.init(zeroRates);
      assert.equal(source.getSnapshot().error, null);
      source.setSpeed(SPEED_OPTIONS[0]);
      assert.equal(source.getSnapshot().speed, 0.25);
      source.play();
      for (let i = 0; i < 19200; i++) await source.step();
      const final = source.getSnapshot().state as ResistanceCocktailState;
      assert.equal(source.getSnapshot().error, null);
      assert.equal(source.getSnapshot().completedSteps, 19200);
      assert.equal(source.getSnapshot().isRunning, false);
      assert.equal(final.running, false);
      assert.equal(final.simTime, 48);
      assert.equal(final.time, 4800);
      assert.equal(final.completedSteps, 4800);
      assert.equal(final.pendingSteps, 0);
      assert.equal(final.sensitiveBacteria, 1e7);
      assert.deepEqual(final.phageCounts, [1e8, 1e8, 1e8]);
      assert.deepEqual(final.infectedByPhage, [0, 0, 0]);
      assert.deepEqual(final.partialResistant, [0, 0, 0]);
      assert.equal(final.fullyResistant, 0);
      assert.equal(final.history.at(-1)?.t, 48);
      const content = await source.exportExperiment(), record = await parseAnalysisRecord(content);
      assert.deepEqual(record.parameters.stepDeltas, Array(19200).fill(0.25));
      assert.equal(record.method.version, '2');
      assert.ok(new TextEncoder().encode(content).length < 10 * 1024 * 1024);

      await target.activate();
      await target.replayExperiment(content);
      assert.equal(target.getSnapshot().error, null);
      assert.deepEqual(target.getSnapshot().state, final);
      assert.equal(target.getSnapshot().completedSteps, 19200);
      assert.equal((await parseAnalysisRecord(await target.exportExperiment())).resultId, record.resultId);
      const replayed = target.getSnapshot().state;
      target.play();
      await target.step();
      assert.equal(target.getSnapshot().isRunning, false);
      assert.equal(target.getSnapshot().completedSteps, 19200);
      assert.strictEqual(target.getSnapshot().state, replayed);

      // Hash-valid but oversized input must fail before any replay initialization.
      const accepted = target.getSnapshot().state;
      let initializations = 0;
      targetService.initSimulation = async () => { initializations++; throw new Error('Unexpected replay work'); };
      await target.replayExperiment(await rewriteRecord(content, changed => {
        changed.parameters.stepDeltas = Array(19201).fill(0.25);
      }));
      assert.match(target.getSnapshot().error!, /at most 19200 step deltas/);
      assert.equal(initializations, 0);
      assert.strictEqual(target.getSnapshot().state, accepted);
    } finally { source.deactivate(); target.deactivate(); }
  }, 30000);

  it('preserves paused fractional ticks and the exact final delta when the horizon clamps a step', async () => {
    const sourceService = resistanceBackend(), targetService = resistanceBackend(), replayService = resistanceBackend();
    const source = new SimulationSession('resistance-cocktail', null, () => sourceService, {}, 7);
    const target = new SimulationSession('resistance-cocktail', null, () => targetService, {}, 99);
    const replay = new SimulationSession('resistance-cocktail', null, () => replayService, {}, 42);
    try {
      await source.activate();
      await source.init(zeroRates);
      source.setSpeed(0.25);
      source.play();
      await source.step();
      source.pause();
      const partial = source.getSnapshot().state as ResistanceCocktailState;
      assert.equal(partial.completedSteps, 0);
      assert.equal(partial.pendingSteps, 0.25);
      assert.equal(partial.simTime, 0);
      assert.equal(partial.time, 0.25);
      const partialContent = await source.exportExperiment();
      await target.activate();
      await target.replayExperiment(partialContent);
      assert.equal(target.getSnapshot().error, null);
      assert.deepEqual(target.getSnapshot().state, partial);
      assert.equal((await parseAnalysisRecord(await target.exportExperiment())).resultId,
        (await parseAnalysisRecord(partialContent)).resultId);

      target.setSpeed(8);
      target.play();
      for (let i = 0; i < 600; i++) await target.step();
      const final = target.getSnapshot().state as ResistanceCocktailState;
      assert.equal(target.getSnapshot().error, null);
      assert.equal(final.simTime, 48);
      assert.equal(final.pendingSteps, 0);
      const finalContent = await target.exportExperiment(), finalRecord = await parseAnalysisRecord(finalContent);
      // The last requested step overruns the remaining horizon by 0.25 ticks.
      // Keep it intact: replay must use the accepted calls, not a rewritten partition.
      assert.deepEqual(finalRecord.parameters.stepDeltas, [0.25, ...Array(600).fill(8)]);
      await replay.activate();
      await replay.replayExperiment(finalContent);
      assert.equal(replay.getSnapshot().error, null);
      assert.deepEqual(replay.getSnapshot().state, final);
      assert.equal((await parseAnalysisRecord(await replay.exportExperiment())).resultId, finalRecord.resultId);
    } finally { source.deactivate(); target.deactivate(); replay.deactivate(); }
  });

  it('still stops other simulations after 10000 recorded calls without losing their accepted run', async () => {
    const service = backend();
    let calls = 0;
    const actualStep = service.stepSimulation;
    service.stepSimulation = (state, dt, signal) => { calls++; return actualStep(state, dt, signal); };
    const session = new SimulationSession(probe.id, null, () => service, {}, 7);
    try {
      await session.activate();
      for (let i = 0; i < 10000; i++) await session.step();
      const accepted = session.getSnapshot().state;
      session.play();
      await session.step();
      assert.equal(calls, 10000);
      assert.equal(session.getSnapshot().completedSteps, 10000);
      assert.strictEqual(session.getSnapshot().state, accepted);
      assert.equal(session.getSnapshot().isRunning, false);
      assert.match(session.getSnapshot().error!, /Run reached 10000 recorded steps/);
      const record = await parseAnalysisRecord(await session.exportExperiment());
      assert.deepEqual(record.parameters.stepDeltas, Array(10000).fill(1));
    } finally { session.deactivate(); }
  });

  it('stops animation and recording when the resistance backend returns a completed checkpoint', async () => {
    // Lifecycle fixture: numerical extinction/lysis is covered in the core suite.
    // This backend deliberately completes on its first accepted step.
    const resistance = makeResistanceSimulation() as unknown as Simulation;
    const api = createSimulationAPI([{ ...resistance, step: state => ({ ...state, running: false }) }]);
    let calls = 0;
    const service = {
      getSimulationMetadata: (id: Simulation['id']) => api.getMetadata(id),
      initSimulation: (params: SimInitParams) => api.init(params),
      stepSimulation: (state: SimState, dt: number) => { calls++; return api.step({ state, dt }); },
    };
    const session = new SimulationSession('resistance-cocktail', null, () => service, {}, 7);
    try {
      await session.activate();
      session.play();
      await session.step();
      assert.equal(session.getSnapshot().isRunning, false);
      assert.equal(session.getSnapshot().isStepping, false);
      assert.equal(session.getSnapshot().completedSteps, 1);
      assert.equal(session.getSnapshot().error, null);
      await session.step();
      session.play();
      assert.equal(session.getSnapshot().isRunning, false);
      assert.equal(calls, 1, 'completed runs must not accumulate no-op worker requests');
      assert.equal(session.getSnapshot().completedSteps, 1);
      const record = await parseAnalysisRecord(await session.exportExperiment());
      assert.deepEqual(record.parameters.stepDeltas, [1]);
      await session.reset();
      assert.equal(session.getSnapshot().state?.running, true);
      assert.equal(session.getSnapshot().completedSteps, 0);
    } finally { session.deactivate(); }
  });
});
