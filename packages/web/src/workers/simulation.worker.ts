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
  LysogenyCircuitState,
  RibosomeTrafficState,
  PlaqueAutomataState,
  EvolutionReplayState,
  PackagingMotorState,
  InfectionKineticsState,
  SimInitParams,
  SimStepRequest,
  SimulationWorkerAPI,
} from './types';
import { SIMULATION_METADATA } from '@phage-explorer/core';

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

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const randomNeighbor = (index: number, size: number): number | null => {
  const x = index % size;
  const y = Math.floor(index / size);
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  const [dx, dy] = dirs[Math.floor(rng.next() * dirs.length)];
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || ny < 0 || nx >= size || ny >= size) return null;
  return ny * size + nx;
};

// ============================================================
// Simulation Initializers
// ============================================================

function initLysogeny(params?: Record<string, number | boolean | string>): LysogenyCircuitState {
  const merged = {
    moi: 1, uv: 0, ciProd: 0.8, croProd: 0.6, decay: 0.05, hill: 2,
    ...params,
  };
  return {
    type: 'lysogeny-circuit',
    time: 0,
    running: true,
    speed: 1,
    params: merged,
    ci: 0.4,
    cro: 0.3,
    n: 0.05,
    phase: 'undecided',
    history: [],
  };
}

function initRibosome(params?: Record<string, number | boolean | string>): RibosomeTrafficState {
  const merged = {
    length: 120, stallRate: 0.08, initRate: 0.6, footprint: 9,
    ...params,
  };
  const length = Number(merged.length);
  const stallRate = Number(merged.stallRate);
  const slowCount = Math.max(1, Math.floor(length * stallRate));
  // Rates are probabilities per tick (0..1). Most sites are fast, a few are slow bottlenecks.
  const codonRates = Array.from({ length }, () => 0.2 + rng.next() * 0.8);
  for (let i = 0; i < slowCount; i++) {
    const idx = Math.floor(rng.next() * length);
    codonRates[idx] = 0.02 + rng.next() * 0.08;
  }
  return {
    type: 'ribosome-traffic',
    time: 0,
    running: true,
    speed: 1,
    params: merged,
    mRnaId: 'gene-1',
    ribosomes: [],
    codonRates,
    proteinsProduced: 0,
    stallEvents: 0,
    densityHistory: [],
    productionHistory: [],
  };
}

function initPlaque(params?: Record<string, number | boolean | string>): PlaqueAutomataState {
  const merged = {
    grid: 30, burst: 80, latent: 12, diffusion: 0.25, adsorption: 0.2, lysogeny: 0,
    ...params,
  };
  const size = Number(merged.grid);
  const cells = new Uint8Array(size * size);
  const ages = new Float32Array(size * size);
  // Initialize with bacteria (1) everywhere except center (phage)
  cells.fill(1);
  cells[Math.floor(size * size / 2)] = 4; // seed phage at center
  return {
    type: 'plaque-automata',
    time: 0,
    running: true,
    speed: 1,
    params: merged,
    gridSize: size,
    grid: cells,
    infectionTimes: ages,
    phageCount: 1,
    bacteriaCount: size * size - 1,
    infectionCount: 0,
  };
}

function initEvolution(params?: Record<string, number | boolean | string>): EvolutionReplayState {
  const merged = {
    mutRate: 0.05, popSize: 1e5, selMean: 0, selSd: 0.02,
    ...params,
  };
  return {
    type: 'evolution-replay',
    time: 0,
    running: true,
    speed: 1,
    params: merged,
    generation: 0,
    mutations: [],
    fitnessHistory: [1],
    neHistory: [Number(merged.popSize)],
  };
}

function initPackaging(params?: Record<string, number | boolean | string>): PackagingMotorState {
  const merged = {
    genomeKb: 50, capsidRadius: 30, ionic: 50, mode: 'cos',
    ...params,
  };
  const initial: PackagingMotorState & { history: Array<{ time: number; fill: number; pressure: number; force: number }> } = {
    type: 'packaging-motor',
    time: 0,
    running: true,
    speed: 1,
    params: merged,
    fillFraction: 0.1,
    pressure: 5,
    force: 20,
    stallProbability: 0,
    history: [{
      time: 0,
      fill: 0.1,
      pressure: 5,
      force: 20,
    }],
  };
  return initial;
}

function initInfection(params?: Record<string, number | boolean | string>): InfectionKineticsState {
  const merged = {
    b0: 1e6, p0: 1e7, k: 2e-10, latent: 40, burst: 120, growth: 0.5, decay: 0.02,
    ...params,
  };
  const initial: InfectionKineticsState & { history: Array<{ time: number; bacteria: number; infected: number; phage: number }> } = {
    type: 'infection-kinetics',
    time: 0,
    running: true,
    speed: 1,
    params: merged,
    bacteria: Number(merged.b0),
    infected: 0,
    phage: Number(merged.p0),
    history: [{
      time: 0,
      bacteria: Number(merged.b0),
      infected: 0,
      phage: Number(merged.p0),
    }],
  };
  return initial;
}

// ============================================================
// Simulation Step Functions
// ============================================================

function stepLysogeny(state: LysogenyCircuitState, dt: number): LysogenyCircuitState {
  const uv = Number(state.params.uv ?? 0);
  const moi = Number(state.params.moi ?? 1);
  const ciProd = Number(state.params.ciProd ?? 0.8);
  const croProd = Number(state.params.croProd ?? 0.6);
  const decay = Number(state.params.decay ?? 0.05);
  const hill = Number(state.params.hill ?? 2);

  const ciRepr = 1 / (1 + Math.pow(state.cro / 0.5, hill));
  const croRepr = 1 / (1 + Math.pow(state.ci / 0.5, hill));

  const ciSynth = ciProd * moi * ciRepr;
  const croSynth = croProd * croRepr + 0.12 * uv;

  const ciNext = clamp(state.ci + (ciSynth - decay * state.ci - 0.2 * uv) * dt, 0, 3);
  const croNext = clamp(state.cro + (croSynth - decay * state.cro + 0.05) * dt, 0, 3);

  const phase = ciNext - croNext > 0.2 ? 'lysogenic' : croNext - ciNext > 0.2 ? 'lytic' : 'undecided';
  const history = [...state.history, { time: state.time + dt, ci: ciNext, cro: croNext }].slice(-120);

  return { ...state, time: state.time + dt, ci: ciNext, cro: croNext, phase, history };
}

function stepRibosome(state: RibosomeTrafficState, dt: number): RibosomeTrafficState {
  const codonRates = state.codonRates ?? [];
  const length = codonRates.length || Number(state.params.length ?? 120);
  const initRate = Number(state.params.initRate ?? 0.6);
  const footprint = Number(state.params.footprint ?? 9);
  const terminationRate = 0.8;

  const ribosomes = state.ribosomes;
  const newPositions: number[] = [];
  let stallEvents = state.stallEvents;
  let proteins = state.proteinsProduced;

  // Process from 3' to 5' to enforce exclusion with footprint.
  for (let i = ribosomes.length - 1; i >= 0; i--) {
    const pos = ribosomes[i];

    // Termination at end.
    if (pos >= length - 1) {
      if (rng.next() < Math.min(1, terminationRate * dt)) {
        proteins += 1;
        continue;
      }
      newPositions.unshift(pos);
      continue;
    }

    const rate = codonRates[pos] ?? 0.1;
    const aheadPos = newPositions.length > 0 ? newPositions[0] : null;
    const blocked = aheadPos !== null && aheadPos - pos <= footprint;

    if (blocked) {
      stallEvents += 1;
      newPositions.unshift(pos);
      continue;
    }

    if (rng.next() < Math.min(1, rate * dt)) {
      newPositions.unshift(pos + 1);
    } else {
      newPositions.unshift(pos);
    }
  }

  // Initiation at 5' end if start segment free.
  const startBlocked = newPositions.length > 0 && newPositions[0] < footprint;
  if (!startBlocked && rng.next() < Math.min(1, initRate * dt)) {
    newPositions.unshift(0);
  }

  const densityHistory = [...(state.densityHistory ?? []), newPositions.length].slice(-200);
  const productionHistory = [...(state.productionHistory ?? []), proteins].slice(-200);

  return {
    ...state,
    time: state.time + dt,
    ribosomes: newPositions,
    proteinsProduced: proteins,
    stallEvents,
    densityHistory,
    productionHistory,
  };
}

function stepPlaque(state: PlaqueAutomataState, dt: number): PlaqueAutomataState {
  const currentGrid = state.grid;
  const currentAges = state.infectionTimes;
  const size = state.gridSize;
  const len = size * size;
  const nextGrid = new Uint8Array(len);
  const nextAges = new Float32Array(len);

  const burst = Number(state.params.burst ?? 80);
  const latent = Number(state.params.latent ?? 12);
  const diffusion = Number(state.params.diffusion ?? 0.25);
  const adsorption = Number(state.params.adsorption ?? 0.2);
  const lysogenyProb = Number(state.params.lysogeny ?? 0);

  // Process phages
  for (let i = 0; i < len; i++) {
    if (currentGrid[i] === 4) {
      let target = i;
      if (rng.next() < diffusion * dt) {
        const neighbor = randomNeighbor(i, size);
        if (neighbor !== null) target = neighbor;
      }

      const targetState = currentGrid[target];
      if (targetState === 1) {
        if (rng.next() < adsorption) {
          nextGrid[target] = 2;
          nextAges[target] = 0;
        } else {
          if (nextGrid[target] !== 2 && nextGrid[target] !== 5) nextGrid[target] = 4;
        }
      } else if (targetState === 2 || targetState === 3 || targetState === 5) {
        if (nextGrid[target] !== 2 && nextGrid[target] !== 5) nextGrid[target] = 4;
      } else {
        if (nextGrid[target] !== 2 && nextGrid[target] !== 5) nextGrid[target] = 4;
      }
    }
  }

  // Process cells
  for (let i = 0; i < len; i++) {
    const stateVal = currentGrid[i];

    if (stateVal === 1) {
      if (nextGrid[i] !== 2) nextGrid[i] = 1;
    } else if (stateVal === 5) {
      nextGrid[i] = 5;
    } else if (stateVal === 2) {
      const newAge = currentAges[i] + dt;
      if (newAge >= latent) {
        if (rng.next() < lysogenyProb) {
          nextGrid[i] = 5;
          nextAges[i] = 0;
        } else {
          nextGrid[i] = 3;
          nextAges[i] = 0;
          const burstCount = Math.max(1, Math.floor(burst));
          for (let b = 0; b < burstCount; b++) {
            const nb = randomNeighbor(i, size);
            if (nb !== null) {
              const nbState = currentGrid[nb];
              if (nbState === 1 && rng.next() < adsorption) {
                nextGrid[nb] = 2;
                nextAges[nb] = 0;
              } else if (nextGrid[nb] === 0) {
                nextGrid[nb] = 4;
              }
            }
          }
        }
      } else {
        nextGrid[i] = 2;
        nextAges[i] = newAge;
      }
    } else if (stateVal === 0) {
      if (nextGrid[i] === 0 && rng.next() < 0.01 * dt) nextGrid[i] = 1;
    }
  }

  let phage = 0, bacteria = 0, infected = 0;
  for (let i = 0; i < len; i++) {
    const val = nextGrid[i];
    if (val === 1 || val === 5) bacteria++;
    if (val === 2) infected++;
    if (val === 4) phage++;
  }

  return {
    ...state,
    time: state.time + dt,
    grid: nextGrid,
    infectionTimes: nextAges,
    phageCount: phage,
    bacteriaCount: bacteria,
    infectionCount: infected,
  };
}

function stepEvolution(state: EvolutionReplayState, dt: number): EvolutionReplayState {
  const mutRate = Number(state.params.mutRate ?? 0.05);
  const popSize = Number(state.params.popSize ?? 1e5);
  const selMean = Number(state.params.selMean ?? 0);
  const selSd = Number(state.params.selSd ?? 0.02);

  const newMutations = [...state.mutations];
  const mutsThisGen = Math.max(0, Math.round(mutRate * 3 * dt));
  for (let i = 0; i < mutsThisGen; i++) {
    const s = selMean + selSd * (rng.next() * 2 - 1);
    newMutations.push({
      position: Math.floor(rng.next() * 50000),
      from: 'A',
      to: 'G',
      generation: state.generation + 1,
      s,
    });
  }

  const lastFitness = state.fitnessHistory[state.fitnessHistory.length - 1] ?? 1;
  const meanS = newMutations.slice(-10).reduce((a, m) => a + (m.s ?? 0), 0) / Math.max(1, Math.min(10, newMutations.length));
  const drift = (rng.next() - 0.5) * 0.01;
  const nextFitness = clamp(lastFitness * (1 + meanS + drift), 0.6, 1.5);
  const nextHistory = [...state.fitnessHistory, nextFitness].slice(-200);

  const lastNe = state.neHistory.at(-1) ?? popSize;
  const neDrift = lastNe * (1 + (rng.next() - 0.5) * 0.05);
  const nextNe = clamp(neDrift, popSize * 0.1, popSize * 10);
  const neHistory = [...state.neHistory, nextNe].slice(-200);

  return {
    ...state,
    time: state.time + dt,
    generation: state.generation + 1,
    mutations: newMutations,
    fitnessHistory: nextHistory,
    neHistory,
  };
}

function stepPackaging(state: PackagingMotorState, dt: number): PackagingMotorState {
  const genomeKb = Number(state.params.genomeKb ?? 50);
  const capsidRadius = Number(state.params.capsidRadius ?? 30);
  const ionic = Number(state.params.ionic ?? 50);
  const mode = String(state.params.mode ?? 'cos');

  const fillDelta = 0.015 * state.speed * (1 - state.fillFraction) * dt;
  const fill = clamp(state.fillFraction + fillDelta, 0, 1);

  const persistenceLen = 50;
  const contourNm = genomeKb * 0.34 * 1000;
  const packedDensity = (contourNm * fill) / ((4 / 3) * Math.PI * Math.pow(capsidRadius, 3));
  const bendingEnergy = (contourNm * fill) / Math.max(1, capsidRadius * capsidRadius * persistenceLen);
  const debye = 0.304 / Math.sqrt(Math.max(1, ionic));
  const electrostatic = packedDensity * 0.5 * (1 / Math.max(debye, 0.05));
  const modeFactor = mode === 'headful' ? 1.0 : mode === 'phi29' ? 1.2 : 0.9;

  const pressure = clamp(5 + 30 * fill + 200 * bendingEnergy * 1e-6 + 80 * electrostatic * 1e-3, 0, 80) * modeFactor;
  const force = clamp(10 + 150 * fill + pressure * 0.8, 0, 200);

  const history = (state as any).history as Array<{ time: number; fill: number; pressure: number; force: number }> | undefined;
  const nextHistory = [...(history ?? []), {
    time: state.time + dt,
    fill,
    pressure,
    force,
  }].slice(-600);

  const nextState: PackagingMotorState & { history: typeof nextHistory } = {
    ...state,
    time: state.time + dt,
    fillFraction: fill,
    pressure,
    force,
    stallProbability: 0,
    history: nextHistory,
  };

  return nextState;
}

function stepInfection(state: InfectionKineticsState, dt: number): InfectionKineticsState {
  const k = Number(state.params.k ?? 2e-10);
  const latent = Number(state.params.latent ?? 40);
  const burst = Number(state.params.burst ?? 120);
  const growth = Number(state.params.growth ?? 0.5);
  const decay = Number(state.params.decay ?? 0.02);

  const B = state.bacteria;
  const I = state.infected;
  const P = state.phage;

  const dB = (growth * B - k * B * P) * dt;
  const dI = (k * B * P - I / Math.max(1, latent)) * dt;
  const dP = ((burst / Math.max(1, latent)) * I - k * B * P - decay * P) * dt;

  const nextB = clamp(B + dB, 0, 1e12);
  const nextI = clamp(I + dI, 0, 1e12);
  const nextP = clamp(P + dP, 0, 1e12);

  const history = (state as any).history as Array<{ time: number; bacteria: number; infected: number; phage: number }> | undefined;
  const nextHistory = [...(history ?? []), {
    time: state.time + dt,
    bacteria: nextB,
    infected: nextI,
    phage: nextP,
  }].slice(-600);

  const nextState: InfectionKineticsState & { history: typeof nextHistory } = {
    ...state,
    time: state.time + dt,
    bacteria: nextB,
    infected: nextI,
    phage: nextP,
    history: nextHistory,
  };
  return nextState;
}

// ============================================================
// Dispatcher functions
// ============================================================

function initSimulation(simId: SimulationId, params?: Record<string, number | boolean | string>): SimState {
  switch (simId) {
    case 'lysogeny-circuit': return initLysogeny(params);
    case 'ribosome-traffic': return initRibosome(params);
    case 'plaque-automata': return initPlaque(params);
    case 'evolution-replay': return initEvolution(params);
    case 'packaging-motor': return initPackaging(params);
    case 'infection-kinetics': return initInfection(params);
    default: throw new Error(`Unknown simulation: ${simId}`);
  }
}

function stepSimulation(state: SimState, dt: number): SimState {
  switch (state.type) {
    case 'lysogeny-circuit': return stepLysogeny(state, dt);
    case 'ribosome-traffic': return stepRibosome(state, dt);
    case 'plaque-automata': return stepPlaque(state, dt);
    case 'evolution-replay': return stepEvolution(state, dt);
    case 'packaging-motor': return stepPackaging(state, dt);
    case 'infection-kinetics': return stepInfection(state, dt);
    default: throw new Error(`Unknown simulation type: ${(state as SimState).type}`);
  }
}

// ============================================================
// Worker API
// ============================================================

const workerAPI: SimulationWorkerAPI = {
  async init({ simId, params, seed }: SimInitParams): Promise<SimState> {
    if (seed !== undefined) {
      rng = new SeededRandom(seed);
    }
    return initSimulation(simId, params);
  },

  async step({ state, dt }: SimStepRequest): Promise<SimState> {
    return stepSimulation(state, dt);
  },

  async stepBatch(state: SimState, dt: number, steps: number): Promise<SimState[]> {
    const results: SimState[] = [];
    let current = state;
    for (let i = 0; i < steps; i++) {
      current = stepSimulation(current, dt);
      results.push(current);
    }
    return results;
  },

  async getMetadata(simId: SimulationId): Promise<{
    name: string;
    description: string;
    parameters: SimParameter[];
  }> {
    const meta = SIMULATION_METADATA.find(m => m.id === simId);
    if (!meta) throw new Error(`Unknown simulation: ${simId}`);

    // Define parameters based on simulation
    const params = getSimulationParameters(simId);

    return {
      name: meta.name,
      description: meta.description,
      parameters: params,
    };
  },
};

function getSimulationParameters(simId: SimulationId): SimParameter[] {
  switch (simId) {
    case 'lysogeny-circuit':
      return [
        { id: 'moi', label: 'Multiplicity of infection', type: 'number', min: 0.1, max: 5, step: 0.1, defaultValue: 1 },
        { id: 'uv', label: 'UV / damage', type: 'number', min: 0, max: 1, step: 0.05, defaultValue: 0 },
        { id: 'ciProd', label: 'CI synthesis', type: 'number', min: 0.1, max: 2, step: 0.05, defaultValue: 0.8 },
        { id: 'croProd', label: 'Cro synthesis', type: 'number', min: 0.1, max: 2, step: 0.05, defaultValue: 0.6 },
        { id: 'decay', label: 'Protein decay', type: 'number', min: 0.01, max: 0.3, step: 0.01, defaultValue: 0.05 },
        { id: 'hill', label: 'Hill cooperativity', type: 'number', min: 1, max: 4, step: 0.2, defaultValue: 2 },
      ];
    case 'ribosome-traffic':
      return [
        { id: 'length', label: 'mRNA length (codons)', type: 'number', min: 30, max: 300, step: 10, defaultValue: 120 },
        { id: 'stallRate', label: 'Stall site fraction', type: 'number', min: 0, max: 0.3, step: 0.01, defaultValue: 0.08 },
        { id: 'initRate', label: 'Initiation rate', type: 'number', min: 0, max: 2, step: 0.05, defaultValue: 0.6 },
        { id: 'footprint', label: 'Ribosome footprint (codons)', type: 'number', min: 6, max: 12, step: 1, defaultValue: 9 },
      ];
    case 'plaque-automata':
      return [
        { id: 'grid', label: 'Grid size', type: 'number', min: 10, max: 50, step: 5, defaultValue: 30 },
        { id: 'burst', label: 'Burst size', type: 'number', min: 5, max: 300, step: 5, defaultValue: 80 },
        { id: 'latent', label: 'Latent period (ticks)', type: 'number', min: 2, max: 40, step: 1, defaultValue: 12 },
        { id: 'diffusion', label: 'Diffusion prob', type: 'number', min: 0.0, max: 0.6, step: 0.05, defaultValue: 0.25 },
        { id: 'adsorption', label: 'Adsorption prob', type: 'number', min: 0.0, max: 0.6, step: 0.05, defaultValue: 0.2 },
        { id: 'lysogeny', label: 'Lysogeny prob', type: 'number', min: 0.0, max: 1.0, step: 0.05, defaultValue: 0.0 },
      ];
    case 'evolution-replay':
      return [
        { id: 'mutRate', label: 'Mutation rate', type: 'number', min: 0, max: 0.2, step: 0.01, defaultValue: 0.05 },
        { id: 'popSize', label: 'Effective population (Ne)', type: 'number', min: 1e3, max: 1e7, step: 1e3, defaultValue: 1e5 },
        { id: 'selMean', label: 'Selection mean s', type: 'number', min: -0.1, max: 0.1, step: 0.01, defaultValue: 0.0 },
        { id: 'selSd', label: 'Selection sd', type: 'number', min: 0, max: 0.1, step: 0.01, defaultValue: 0.02 },
      ];
    case 'packaging-motor':
      return [
        { id: 'genomeKb', label: 'Genome length (kb)', type: 'number', min: 3, max: 200, step: 1, defaultValue: 50 },
        { id: 'capsidRadius', label: 'Capsid radius (nm)', type: 'number', min: 20, max: 60, step: 1, defaultValue: 30 },
        { id: 'ionic', label: 'Ionic strength (mM)', type: 'number', min: 1, max: 200, step: 5, defaultValue: 50 },
        { id: 'mode', label: 'Packaging mode', type: 'select', options: [
          { value: 'headful', label: 'Headful' },
          { value: 'cos', label: 'Cos' },
          { value: 'phi29', label: 'Phi29 motor' },
        ], defaultValue: 'cos' },
      ];
    case 'infection-kinetics':
      return [
        { id: 'b0', label: 'Bacteria (start)', type: 'number', min: 1e4, max: 1e9, step: 1e4, defaultValue: 1e6 },
        { id: 'p0', label: 'Phage (start)', type: 'number', min: 1e2, max: 1e9, step: 1e2, defaultValue: 1e7 },
        { id: 'k', label: 'Adsorption k (mL/min)', type: 'number', min: 1e-11, max: 1e-8, step: 1e-11, defaultValue: 2e-10 },
        { id: 'latent', label: 'Latent period (min)', type: 'number', min: 5, max: 120, step: 1, defaultValue: 40 },
        { id: 'burst', label: 'Burst size', type: 'number', min: 10, max: 500, step: 5, defaultValue: 120 },
        { id: 'growth', label: 'Bacterial growth', type: 'number', min: 0, max: 2, step: 0.05, defaultValue: 0.5 },
        { id: 'decay', label: 'Phage decay', type: 'number', min: 0, max: 0.5, step: 0.01, defaultValue: 0.02 },
      ];
    default:
      return [];
  }
}

// Expose worker API via Comlink
Comlink.expose(workerAPI);
