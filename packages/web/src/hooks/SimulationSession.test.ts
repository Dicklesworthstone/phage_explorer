import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type PhageFull, type AnalysisRecord } from '@phage-explorer/core';
import type { Simulation, SimState, PlaqueAutomataState, SimInitParams } from '../workers/types';
import { createSimulationAPI, getSimulationRandomState, MAX_SIMULATION_EXPERIMENT_STEPS, simulationStateJson } from '../workers/simulation-runtime';
import { SimulationSession } from './SimulationSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
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
