/**
 * Simulation Worker - Runs simulations in a Web Worker
 *
 * All simulation logic runs off the main thread to maintain smooth UI.
 * Uses Comlink for type-safe communication.
 */

import * as Comlink from 'comlink';
import type {
  SimulationId,
  SimState,
  SimParameter,
  SimInitParams,
  SimStepRequest,
  SimulationWorkerAPI,
  Simulation,
} from './types';
import { getAllSimulations } from '@phage-explorer/core';

// Simple RNG with seed support for reproducibility
class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    // LCG parameters from Numerical Recipes
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 0xffffffff;
  }
}

let rng = new SeededRandom(Date.now());

// Build registry from Core implementations
const SIMULATION_MAP = new Map<string, Simulation<SimState>>();
getAllSimulations().forEach(sim => {
  SIMULATION_MAP.set(sim.id, sim);
});

// ============================================================
// Worker API
// ============================================================

const workerAPI: SimulationWorkerAPI = {
  async init({ simId, params, seed, phage }: SimInitParams): Promise<SimState> {
    if (seed !== undefined) {
      rng = new SeededRandom(seed);
    }
    const sim = SIMULATION_MAP.get(simId);
    if (!sim) throw new Error(`Unknown simulation: ${simId}`);

    return sim.init(phage ?? undefined, params, () => rng.next());
  },

  async step({ state, dt }: SimStepRequest): Promise<SimState> {
    const sim = SIMULATION_MAP.get(state.type);
    if (!sim) throw new Error(`Unknown simulation type: ${state.type}`);
    
    return sim.step(state, dt, () => rng.next());
  },

  async stepBatch(state: SimState, dt: number, steps: number): Promise<SimState[]> {
    const sim = SIMULATION_MAP.get(state.type);
    if (!sim) throw new Error(`Unknown simulation type: ${state.type}`);

    const results: SimState[] = [];
    let current = state;
    const random = () => rng.next();
    
    for (let i = 0; i < steps; i++) {
      current = sim.step(current, dt, random);
      results.push(current);
    }
    return results;
  },

  async getMetadata(simId: SimulationId): Promise<{
    name: string;
    description: string;
    parameters: SimParameter[];
  }> {
    const sim = SIMULATION_MAP.get(simId);
    if (!sim) throw new Error(`Unknown simulation: ${simId}`);

    return {
      name: sim.name,
      description: sim.description,
      parameters: sim.parameters,
    };
  },
};

// Expose worker API via Comlink
Comlink.expose(workerAPI);
