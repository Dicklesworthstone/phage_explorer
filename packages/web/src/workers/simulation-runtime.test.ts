import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import type { Simulation, SimState, PlaqueAutomataState } from './types';
import { createSimulationAPI, getSimulationRandomState, MAX_SIMULATION_BATCH_STEPS, type SeededSimState } from './simulation-runtime';

// Deliberately mutating model: tests must protect checkpoints even when a core
// implementation changes its arrays in place. Numeric draws are checked against
// an independently evaluated BigInt recurrence, not another runtime instance.
const probe: Simulation = {
  id: 'plaque-automata', name: 'RNG probe', description: 'Determinism test', controls: [], parameters: [],
  init: (_phage, _params, rng) => ({
    type: 'plaque-automata', time: 0, running: false, speed: 1, params: {},
    gridSize: 1, grid: new Uint8Array([0]), infectionTimes: new Float32Array([0]),
    phageCount: rng!(), bacteriaCount: 0, infectionCount: 0,
  }),
  step: (input, dt, rng) => {
    const state = input as PlaqueAutomataState;
    state.grid[0]++;
    state.infectionTimes[0] += dt;
    state.time += dt;
    state.phageCount = rng!();
    return state;
  },
  getSummary: () => '',
};
const count = (state: SimState) => (state as PlaqueAutomataState).phageCount;
const oracle = (seed: number, draws: number) => {
  let value = BigInt(seed >>> 0);
  for (let i = 0; i < draws; i++) value = (1664525n * value + 1013904223n) % (1n << 32n);
  return Number(value) / 2 ** 32;
};

describe('worker-independent seeded simulations', () => {
  it('matches an independent integer RNG oracle through init and multiple steps', async () => {
    const api = createSimulationAPI([probe]);
    let state = await api.init({ simId: probe.id, seed: 42 });
    assert.equal(count(state), oracle(42, 1));
    for (let draw = 2; draw < 8; draw++) {
      state = await api.step({ state, dt: 1 });
      assert.equal(count(state), oracle(42, draw));
    }
    assert.equal(getSimulationRandomState(state).seed, 42);
  });
  it('continues exactly after migration to a fresh worker and unrelated initializations', async () => {
    const firstWorker = createSimulationAPI([probe]);
    const secondWorker = createSimulationAPI([probe]);
    const state = await firstWorker.init({ simId: probe.id, seed: 17 });
    await secondWorker.init({ simId: probe.id, seed: 999 });
    const next = await secondWorker.step({ state: structuredClone(state), dt: 1 });
    assert.equal(count(next), oracle(17, 2));
    await firstWorker.init({ simId: probe.id, seed: 333 });
    assert.equal(count(await firstWorker.step({ state: next, dt: 1 })), oracle(17, 3));
  });
  it('isolates two interleaved runs even on the same worker', async () => {
    const api = createSimulationAPI([probe]);
    let a = await api.init({ simId: probe.id, seed: 7 });
    let b = await api.init({ simId: probe.id, seed: 23 });
    for (let draw = 2; draw <= 6; draw++) {
      b = await api.step({ state: b, dt: 1 });
      a = await api.step({ state: a, dt: 1 });
      assert.equal(count(a), oracle(7, draw));
      assert.equal(count(b), oracle(23, draw));
    }
  });
  it('matches batch and single-step execution across fresh APIs', async () => {
    const api = createSimulationAPI([probe]);
    const initial = await api.init({ simId: probe.id, seed: 12 });
    const batch = await api.stepBatch(initial, 0.5, 5);
    let state = initial;
    for (const checkpoint of batch) {
      state = await createSimulationAPI([probe]).step({ state, dt: 0.5 });
      assert.deepEqual(checkpoint, state);
    }
  });
  it('does not mutate input state or alias batch typed arrays', async () => {
    const api = createSimulationAPI([probe]);
    const initial = await api.init({ simId: probe.id, seed: 1 });
    const before = structuredClone(initial);
    const batch = await api.stepBatch(initial, 1, 3);
    assert.deepEqual(initial, before);
    assert.deepEqual(batch.map(state => [...(state as PlaqueAutomataState).grid]), [[1], [2], [3]]);
    (batch[2] as PlaqueAutomataState).grid[0] = 99;
    assert.equal((batch[0] as PlaqueAutomataState).grid[0], 1);
    assert.deepEqual(await api.step({ state: initial, dt: 1 }), batch[0]);
  });
  it('supports seed zero and records normalization of large numeric seeds', async () => {
    const api = createSimulationAPI([probe]);
    const zero = await api.init({ simId: probe.id, seed: 0 });
    const large = await api.init({ simId: probe.id, seed: 2 ** 32 });
    assert.deepEqual(zero, large);
    assert.equal(count(zero), oracle(0, 1));
  });
  it('never emits 1 when the recurrence reaches UINT32_MAX', async () => {
    const api = createSimulationAPI([probe]);
    const state = await api.init({ simId: probe.id, seed: 0 }) as SeededSimState;
    // Inverse recurrence computed using modular arithmetic, not a random search.
    const inverse = 4276115653n;
    const cursor = Number(((0xffffffffn - 1013904223n) * inverse) & 0xffffffffn);
    state.randomState.cursor = cursor;
    const next = await api.step({ state, dt: 1 });
    assert.equal(count(next), 0xffffffff / 2 ** 32);
    assert.ok(count(next) < 1);
  });
  it('rejects missing, malformed and version-incompatible checkpoints', async () => {
    const api = createSimulationAPI([probe]);
    const raw = probe.init(null, {}, () => 0.5);
    await assert.rejects(api.step({ state: raw, dt: 1 }), /checkpoint/);
    const state = await api.init({ simId: probe.id, seed: 1 });
    for (const randomState of [null, { algorithm: 'unknown', seed: 1, cursor: 1 },
      { algorithm: 'lcg32-v1', seed: 1, cursor: NaN }, { algorithm: 'lcg32-v1', seed: -1, cursor: 0 }]) {
      await assert.rejects(api.step({ state: { ...state, randomState } as unknown as SimState, dt: 1 }), /checkpoint/);
    }
  });
  it('rejects invalid seeds, deltas and unbounded batches', async () => {
    const api = createSimulationAPI([probe]);
    for (const seed of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(api.init({ simId: probe.id, seed }), /seed/);
    }
    const state = await api.init({ simId: probe.id, seed: 1 });
    for (const dt of [0, -1, NaN, Infinity]) await assert.rejects(api.step({ state, dt }), /delta/);
    for (const steps of [-1, 0.5, NaN, Infinity, MAX_SIMULATION_BATCH_STEPS + 1]) {
      await assert.rejects(api.stepBatch(state, 1, steps), /batch/);
    }
    assert.deepEqual(await api.stepBatch(state, 1, 0), []);
  });
  it('returns isolated checkpoint metadata', async () => {
    const state = await createSimulationAPI([probe]).init({ simId: probe.id, seed: 5 });
    const metadata = getSimulationRandomState(state);
    metadata.cursor = 0;
    assert.notEqual(getSimulationRandomState(state).cursor, 0);
  });
});
