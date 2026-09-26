/**
 * Stateless simulation RPC implementation. A run's RNG cursor travels with its
 * state, never with the worker that happens to execute the next step.
 */
import type { Simulation, SimState, SimulationId, SimulationWorkerAPI } from './types';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisJson, type AnalysisRecord, type PhageFull } from '@phage-explorer/core';

export interface SimulationRandomState {
  algorithm: 'lcg32-v1';
  seed: number;
  cursor: number;
}

export type SeededSimState = SimState & { randomState: SimulationRandomState };
export const MAX_SIMULATION_BATCH_STEPS = 1000;
export const MAX_SIMULATION_EXPERIMENT_STEPS = 10000;

// Advance the version when the model equations, defaults or checkpoint encoding change.
const EXPERIMENT_VERSION = '1';
const EXPERIMENT_IMPLEMENTATION = 'bundled core models; lcg32-v1; typed-array snapshots-v1';
const EXPERIMENT_REFERENCES = [{ id: 'core-simulation-models', version: '2026-09-26',
  description: 'Bundled computational models and defaults; no new empirical calibration is supplied by replay.' }];

const uint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

/** Refuse an unseeded/unsupported checkpoint instead of silently inventing a trajectory. */
export function getSimulationRandomState(state: SimState): SimulationRandomState {
  const random = (state as Partial<SeededSimState>).randomState;
  if (!random || random.algorithm !== 'lcg32-v1' || !uint32(random.seed) || !uint32(random.cursor)) {
    throw new Error('Simulation has no supported random-state checkpoint. Reset it before continuing.');
  }
  return { ...random };
}

function createRandom(checkpoint: SimulationRandomState) {
  let cursor = checkpoint.cursor;
  return {
    next: () => {
      cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
      // Divide by 2^32, not UINT32_MAX: random draws must be strictly less than 1.
      return cursor / 0x100000000;
    },
    snapshot: (): SimulationRandomState => ({ ...checkpoint, cursor }),
  };
}

function validateDelta(dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) throw new Error('Simulation time delta must be positive and finite.');
}

/** Each worker creates an API, but these objects hold no run-specific mutable state. */
export function createSimulationAPI(simulations: Simulation[]): SimulationWorkerAPI {
  const registry = new Map(simulations.map(simulation => [simulation.id, simulation]));
  const lookup = (id: SimulationId): Simulation => {
    const simulation = registry.get(id);
    if (!simulation) throw new Error(`Unknown simulation: ${id}`);
    return simulation;
  };

  const advance = (state: SimState, dt: number): SeededSimState => {
    const simulation = lookup(state.type);
    const random = createRandom(getSimulationRandomState(state));
    // Some models mutate their arrays. A cancelled step or a branch must not
    // mutate the last accepted checkpoint, including typed-array backing stores.
    const next = simulation.step(structuredClone(state), dt, random.next);
    if (next.type !== state.type) throw new Error('Simulation returned a different state type.');
    return { ...next, randomState: random.snapshot() };
  };

  return {
    async init({ simId, params, seed = Date.now(), phage }): Promise<SeededSimState> {
      const simulation = lookup(simId);
      if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Simulation seed must be a non-negative safe integer.');
      // Preserve the existing numeric-seed API, including Date.now(), while
      // recording the effective 32-bit seed unambiguously in the checkpoint.
      const effectiveSeed = seed >>> 0;
      const random = createRandom({ algorithm: 'lcg32-v1', seed: effectiveSeed, cursor: effectiveSeed });
      const state = simulation.init(structuredClone(phage), structuredClone(params), random.next);
      if (state.type !== simId) throw new Error('Simulation returned a different state type.');
      return { ...state, randomState: random.snapshot() };
    },
    async step({ state, dt }): Promise<SeededSimState> {
      validateDelta(dt);
      return advance(state, dt);
    },
    async stepBatch(state, dt, steps): Promise<SimState[]> {
      validateDelta(dt);
      if (!Number.isSafeInteger(steps) || steps < 0 || steps > MAX_SIMULATION_BATCH_STEPS) {
        throw new Error(`Simulation batch must contain 0–${MAX_SIMULATION_BATCH_STEPS} steps.`);
      }
      lookup(state.type);
      getSimulationRandomState(state);
      const results: SimState[] = [];
      let current = state;
      for (let i = 0; i < steps; i++) {
        current = advance(current, dt);
        results.push(current);
      }
      return results;
    },
    async getMetadata(simId) {
      const simulation = lookup(simId);
      return { name: simulation.name, description: simulation.description, parameters: structuredClone(simulation.parameters) };
    },
  };
}

/** Explicit array encoding preserves type and rejects nonfinite values instead of JSON's null coercion. */
export function simulationStateJson(value: unknown, depth = 0): AnalysisJson {
  if (depth > 64) throw new Error('Simulation state exceeds the nesting limit.');
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) throw new Error('DataView is not a supported simulation array.');
    return { arrayType: Object.prototype.toString.call(value).slice(8, -1),
      values: Array.from(value as unknown as ArrayLike<number>, item => analysisJson(item)) };
  }
  if (Array.isArray(value)) return value.map(item => simulationStateJson(item, depth + 1));
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.keys(value).sort().filter(key => Reflect.get(value, key) !== undefined)
      .map(key => [key, simulationStateJson(Reflect.get(value, key), depth + 1)]));
  }
  return analysisJson(value);
}

function simulationInput(phage: PhageFull | null) {
  return { id: 'simulationInput', accession: phage?.accession ?? null,
    source: phage ? phage.localGenome ? 'local' as const : 'catalog' as const : 'demo' as const,
    description: 'Exact phage metadata, genes and codon data supplied to the model; null selects generic inputs. This is not an experimental assay or a complete nucleotide-sequence record.',
    data: analysisJson(phage) };
}

export interface SimulationExperimentInput {
  simId: SimulationId;
  phage: PhageFull | null;
  seed: number;
  parameters: Record<string, number | boolean | string>;
  stepDeltas: number[];
  initialState: SimState;
  finalState: SimState;
}

function validateExperimentSteps(steps: unknown): asserts steps is number[] {
  if (!Array.isArray(steps) || steps.length > MAX_SIMULATION_EXPERIMENT_STEPS ||
    steps.some(dt => typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0.25 || dt > 8)) {
    throw new Error(`Simulation experiment requires at most ${MAX_SIMULATION_EXPERIMENT_STEPS} step deltas between 0.25 and 8.`);
  }
}

/** Bind a completed run to its actual initialization input and accepted step partition. */
export function createSimulationExperimentRecord(input: SimulationExperimentInput): Promise<AnalysisRecord> {
  validateExperimentSteps(input.stepDeltas);
  if (!uint32(input.seed) || input.initialState.type !== input.simId || input.finalState.type !== input.simId ||
    getSimulationRandomState(input.initialState).seed !== input.seed || getSimulationRandomState(input.finalState).seed !== input.seed) {
    throw new Error('Simulation experiment state, method and seed disagree.');
  }
  const field = (label: string, state: SimState) => ({
    label, kind: 'simulation' as const, units: 'records' as const, value: simulationStateJson(state),
    coverage: { available: 1, total: 1, unit: 'records' as const },
    assumptions: ['Bundled model equations and defaults, the supplied initialization data, recorded seed and exact accepted step deltas.'],
    limitations: ['Numerical reproducibility is not biological validation. State variables retain model-specific units and assumptions.'],
  });
  return createAnalysisRecord({
    method: { id: `simulation-${input.simId}`, version: EXPERIMENT_VERSION, implementation: EXPERIMENT_IMPLEMENTATION },
    inputs: [simulationInput(input.phage)],
    parameters: { initialParameters: analysisJson(input.parameters), stepDeltas: [...input.stepDeltas], randomAlgorithm: 'lcg32-v1' },
    seed: input.seed, references: EXPERIMENT_REFERENCES,
    fields: { initialState: field('Initial numerical state', input.initialState), finalState: field('Final numerical state', input.finalState) },
  });
}

/** Validate before scheduling any model work. Saved output is never deserialized into live state. */
export async function parseSimulationExperiment(content: string, simId: SimulationId, phage: PhageFull | null): Promise<{
  record: AnalysisRecord; seed: number; parameters: Record<string, number | boolean | string>; stepDeltas: number[];
}> {
  const expectedInput = simulationInput(phage);
  const record = await parseAnalysisRecord(content, { methodId: `simulation-${simId}`, methodVersion: EXPERIMENT_VERSION });
  const equal = (a: unknown, b: unknown) => JSON.stringify(analysisJson(a)) === JSON.stringify(analysisJson(b));
  if (record.method.implementation !== EXPERIMENT_IMPLEMENTATION || !equal(record.references, EXPERIMENT_REFERENCES)) {
    throw new Error('Simulation implementation/reference version is incompatible.');
  }
  if (record.inputs.length !== 1 || !equal({ ...record.inputs[0], sha256: undefined }, expectedInput)) {
    throw new Error('Selected simulation input differs from the saved experiment. Select the same phage metadata and annotations.');
  }
  if (!uint32(record.seed) || !equal(Object.keys(record.parameters).sort(), ['initialParameters', 'randomAlgorithm', 'stepDeltas']) ||
    record.parameters.randomAlgorithm !== 'lcg32-v1') throw new Error('Simulation experiment has unsupported parameters or seed.');
  const parameters = record.parameters.initialParameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.values(parameters).some(value =>
    !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error('Simulation initial parameters must be finite primitive values.');
  }
  validateExperimentSteps(record.parameters.stepDeltas);
  if (!equal(Object.keys(record.fields).sort(), ['finalState', 'initialState']) ||
    Object.values(record.fields).some(field => field.kind !== 'simulation' || field.units !== 'records')) {
    throw new Error('Simulation experiment lacks the initial and final model-state fields.');
  }
  return { record, seed: record.seed, parameters: parameters as Record<string, number | boolean | string>,
    stepDeltas: record.parameters.stepDeltas };
}
