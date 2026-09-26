/**
 * Stateless simulation RPC implementation. A run's RNG cursor travels with its
 * state, never with the worker that happens to execute the next step.
 */
import type { Simulation, SimState, SimulationId, SimulationWorkerAPI } from './types';

export interface SimulationRandomState {
  algorithm: 'lcg32-v1';
  seed: number;
  cursor: number;
}

export type SeededSimState = SimState & { randomState: SimulationRandomState };
export const MAX_SIMULATION_BATCH_STEPS = 1000;

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
