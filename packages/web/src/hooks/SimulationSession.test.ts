import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import type { PhageFull } from '@phage-explorer/core';
import type { Simulation, SimState, PlaqueAutomataState, SimInitParams } from '../workers/types';
import { createSimulationAPI, getSimulationRandomState } from '../workers/simulation-runtime';
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
