import { makeLysogenySimulation, makePackagingSimulation, makeResistanceSimulation } from '../../../core/src/simulation-implementations';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import type { LysogenyCircuitState, PackagingMotorState, ResistanceCocktailState } from '../../../core/src/simulation';
import { describe, it } from 'bun:test';
import type { PhageFull } from '../../../core/src/types';
import assert from 'node:assert/strict';
import type { Simulation, SimState, PlaqueAutomataState } from './types';
import { createSimulationAPI, getSimulationRandomState, MAX_SIMULATION_BATCH_STEPS, createSimulationExperimentRecord,
  getSimulationExperimentStepLimit, parseSimulationExperiment, type SeededSimState } from './simulation-runtime';

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


describe('lysogeny source-bound worker checkpoints', () => {
  const simulation = makeLysogenySimulation() as unknown as Simulation;
  const genomeSequence = 'TATCACCGCCAGAGGTA';
  const phage: PhageFull = { id: 31, accession: 'LOCAL_REGULATION', slug: 'regulatory-fixture',
    name: 'Regulatory fixture', family: null, host: null, genomeLength: genomeSequence.length,
    gcContent: null, morphology: null, lifecycle: null, description: null, baltimoreGroup: null,
    genomeType: 'dsDNA', pdbIds: [], hasModel: false, codonUsage: null, genes: [] };

  it('rejects missing/mismatched source and obsolete checkpoints, with generic simulations still available', async () => {
    const api = createSimulationAPI([simulation]);
    await assert.rejects(api.init({ simId: simulation.id, phage, seed: 0 }), /complete selected genome/);
    await assert.rejects(api.init({ simId: simulation.id, phage, seed: 0,
      context: { genomeSequence: genomeSequence.slice(1) } }), /complete selected genome/);
    await assert.rejects(api.init({ simId: simulation.id, seed: 0,
      context: { genomeSequence } }), /matching phage/);
    const generic = await api.init({ simId: simulation.id, seed: 0 }) as LysogenyCircuitState;
    assert.equal(generic.circuitInfo?.sequenceStatus, 'not-supplied');
    assert.deepEqual(generic.circuitInfo?.operators, []);
    const observed = await api.init({ simId: simulation.id, phage, context: { genomeSequence }, seed: 0 }) as LysogenyCircuitState;
    assert.equal(observed.modelVersion, 3);
    assert.equal(observed.circuitInfo?.operators[0].sequence, genomeSequence);
    for (const modelVersion of [undefined, 1, 2]) {
      await assert.rejects(api.step({ state: { ...observed, modelVersion } as unknown as SimState, dt: 1 }), /checkpoint/);
    }
  });

  it('preserves exact source evidence and unchanged model kinetics across worker migration', async () => {
    const first = createSimulationAPI([simulation]), fresh = createSimulationAPI([simulation]);
    const initial = await first.init({ simId: simulation.id, phage, context: { genomeSequence }, seed: 42 });
    const whole = await first.step({ state: initial, dt: 1 });
    const migrated = await fresh.step({ state: structuredClone(initial), dt: 1 });
    assert.deepEqual(migrated, whole);
    assert.deepEqual((whole as LysogenyCircuitState).circuitInfo, (initial as LysogenyCircuitState).circuitInfo);
    const record = await createSimulationExperimentRecord({
      simId: simulation.id, phage, context: { genomeSequence }, seed: 42, parameters: initial.params,
      stepDeltas: [1], initialState: initial, finalState: whole,
    });
    assert.equal(record.method.version, '3');
    assert.equal(record.references[0].version, '3');
    assert.match(record.method.implementation, /exact genome/);
    const content = serializeAnalysisRecord(record);
    await parseSimulationExperiment(content, simulation.id, phage, { genomeSequence });
    await assert.rejects(parseSimulationExperiment(content, simulation.id, phage,
      { genomeSequence: 'A' + genomeSequence.slice(1) }), /input differs/);
    await assert.rejects(parseSimulationExperiment(content, simulation.id, phage), /exact genome/);
    const previous = await createAnalysisRecord({ ...record, method: { ...record.method, version: '2' } });
    await assert.rejects(parseSimulationExperiment(serializeAnalysisRecord(previous), simulation.id, phage,
      { genomeSequence }), /version/i);
  });
});

describe('resistance worker checkpoints and experiment version', () => {
  const resistance = makeResistanceSimulation() as unknown as Simulation;
  it('preserves the trajectory and random cursor across worker migration and fractional batches', async () => {
    const initial = await createSimulationAPI([resistance]).init({ simId: 'resistance-cocktail', seed: 42 });
    const whole = await createSimulationAPI([resistance]).step({ state: initial, dt: 8 });
    const batch = await createSimulationAPI([resistance]).stepBatch(initial, 0.25, 32);
    assert.deepEqual(batch.at(-1), whole);
    assert.equal((whole as ResistanceCocktailState).simTime, 0.08);
    assert.equal((initial as ResistanceCocktailState).completedSteps, 0);
    assert.deepEqual((initial as ResistanceCocktailState).infectedByPhage, [0, 0, 0]);
  });
  it('binds the new model, infected pools and exact deltas to a replayable version 2 record', async () => {
    const api = createSimulationAPI([resistance]);
    const initial = await api.init({ simId: 'resistance-cocktail', seed: 7 });
    const final = await api.step({ state: initial, dt: 8 });
    const record = await createSimulationExperimentRecord({
      simId: 'resistance-cocktail', phage: null, seed: 7, parameters: initial.params,
      stepDeltas: [8], initialState: initial, finalState: final,
    });
    assert.equal(record.method.version, '2');
    assert.equal(record.references[0].version, '2');
    // Captured from the version 2 implementation before the recording-budget fix.
    // UI bounds must not change the identity of an existing accepted trajectory.
    assert.equal(record.cacheKey, 'f47448443c6e8e5addbdcb525275aef32b5017d9a058a5e9b3898506ed10e70f');
    assert.equal(record.resultId, '951f58e67acfe7249c1ea9a8ea3980a186940edafc6521836a3048ecea16d7e9');
    const parsed = await parseSimulationExperiment(serializeAnalysisRecord(record), 'resistance-cocktail', null);
    const fresh = createSimulationAPI([resistance]);
    let state = await fresh.init({ simId: 'resistance-cocktail', seed: parsed.seed, params: parsed.parameters });
    for (const dt of parsed.stepDeltas) state = await fresh.step({ state, dt });
    assert.deepEqual(state, final);
    const earlier = await createAnalysisRecord({ ...record, method: { ...record.method, version: '1' } });
    await assert.rejects(parseSimulationExperiment(serializeAnalysisRecord(earlier), 'resistance-cocktail', null), /version/i);
  });
  it('bounds resistance recordings by its finite horizon without enlarging other model budgets', async () => {
    assert.equal(getSimulationExperimentStepLimit('resistance-cocktail'), 19200);
    for (const id of ['lysogeny-circuit', 'ribosome-traffic', 'plaque-automata', 'evolution-replay',
      'packaging-motor', 'infection-kinetics'] as const) {
      assert.equal(getSimulationExperimentStepLimit(id), 10000);
    }
    for (const simulation of [resistance, probe]) {
      const initial = await createSimulationAPI([simulation]).init({ simId: simulation.id, seed: 7 });
      const limit = getSimulationExperimentStepLimit(simulation.id);
      assert.throws(() => createSimulationExperimentRecord({
        simId: simulation.id, phage: null, seed: 7, parameters: initial.params,
        stepDeltas: Array(limit + 1).fill(0.25), initialState: initial, finalState: initial,
      }), new RegExp(`at most ${limit} step deltas`));
    }
  });
});

describe('packaging worker checkpoints and experiment version', () => {
  const motor = makePackagingSimulation() as unknown as Simulation;

  it('preserves physical state and the unused random cursor across fractional batches and fresh workers', async () => {
    const first = createSimulationAPI([motor]);
    const initial = await first.init({ simId: 'packaging-motor', seed: 42 });
    const whole = await first.step({ state: initial, dt: 8 });
    const batches = await createSimulationAPI([motor]).stepBatch(initial, 0.25, 32);
    assert.deepEqual(batches.at(-1), whole);
    assert.deepEqual(getSimulationRandomState(whole), getSimulationRandomState(initial));
    assert.equal((whole as PackagingMotorState).completedSteps, 160);
    assert.equal((whole as PackagingMotorState).history.length, 9);
    assert.equal((initial as PackagingMotorState).bpPackaged, 0);
  });

  it('binds the revised equations and terminal semantics to version 2 and refuses version 1', async () => {
    const api = createSimulationAPI([motor]);
    const initial = await api.init({ simId: 'packaging-motor', seed: 7 });
    const final = await api.step({ state: initial, dt: 8 });
    const record = await createSimulationExperimentRecord({
      simId: 'packaging-motor', phage: null, seed: 7, parameters: initial.params,
      stepDeltas: [8], initialState: initial, finalState: final,
    });
    assert.equal(record.method.version, '2');
    assert.match(record.method.implementation, /-dE\/dV/);
    const parsed = await parseSimulationExperiment(serializeAnalysisRecord(record), 'packaging-motor', null);
    const fresh = createSimulationAPI([motor]);
    let state = await fresh.init({ simId: 'packaging-motor', seed: parsed.seed, params: parsed.parameters });
    for (const dt of parsed.stepDeltas) state = await fresh.step({ state, dt });
    assert.deepEqual(state, final);
    const earlier = await createAnalysisRecord({ ...record, method: { ...record.method, version: '1' } });
    await assert.rejects(parseSimulationExperiment(serializeAnalysisRecord(earlier), 'packaging-motor', null), /version/i);
    await assert.rejects(api.step({ state: { ...initial, modelVersion: 1 } as unknown as SimState, dt: 1 }), /checkpoint/);
  });
});
