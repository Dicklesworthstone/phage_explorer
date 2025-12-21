// Simulation Implementations
// Core logic for all phage simulations
// Moved from TUI registry.ts to be shared with Web worker

import type {
  Simulation,
  LysogenyCircuitState,
  PlaqueAutomataState,
  EvolutionReplayState,
  PackagingMotorState,
  InfectionKineticsState,
  SimState,
} from './simulation';
import { getDefaultParams, STANDARD_CONTROLS } from './simulation';
import { ribosomeTrafficSimulation } from './analysis/translation-simulation';

// Helper to clamp numbers
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Helper for 2D grid neighbor selection (used in Plaque Sim)
function randomNeighbor(index: number, size: number, rng: () => number): number | null {
  const x = index % size;
  const y = Math.floor(index / size);
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  const [dx, dy] = dirs[Math.floor(rng() * dirs.length)];
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || ny < 0 || nx >= size || ny >= size) return null;
  return ny * size + nx;
}

export function makeLysogenySimulation(): Simulation<LysogenyCircuitState> {
  return {
    id: 'lysogeny-circuit',
    name: 'Lysogeny Decision Circuit',
    description: 'Bistable CI/Cro toggle; MOI and UV tip the switch.',
    controls: STANDARD_CONTROLS,
    parameters: [
      { id: 'moi', label: 'Multiplicity of infection', type: 'number', min: 0.1, max: 5, step: 0.1, defaultValue: 1 },
      { id: 'uv', label: 'UV / damage', type: 'number', min: 0, max: 1, step: 0.05, defaultValue: 0 },
      { id: 'ciProd', label: 'CI synthesis', type: 'number', min: 0.1, max: 2, step: 0.05, defaultValue: 0.8 },
      { id: 'croProd', label: 'Cro synthesis', type: 'number', min: 0.1, max: 2, step: 0.05, defaultValue: 0.6 },
      { id: 'decay', label: 'Protein decay', type: 'number', min: 0.01, max: 0.3, step: 0.01, defaultValue: 0.05 },
      { id: 'hill', label: 'Hill cooperativity', type: 'number', min: 1, max: 4, step: 0.2, defaultValue: 2 },
    ],
    init: (_phage, params): LysogenyCircuitState => {
      const base = getDefaultParams([
        { id: 'moi', label: '', type: 'number', defaultValue: 1 },
        { id: 'uv', label: '', type: 'number', defaultValue: 0 },
        { id: 'ciProd', label: '', type: 'number', defaultValue: 0.8 },
        { id: 'croProd', label: '', type: 'number', defaultValue: 0.6 },
        { id: 'decay', label: '', type: 'number', defaultValue: 0.05 },
        { id: 'hill', label: '', type: 'number', defaultValue: 2 },
      ]);
      const merged = { ...base, ...(params ?? {}) } as Record<string, number | boolean | string>;
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
        history: [] as Array<{ time: number; ci: number; cro: number; phase: string }>,
      };
    },
    step: (state: LysogenyCircuitState, dt: number): LysogenyCircuitState => {
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
      const history = [...state.history, { time: state.time + dt, ci: ciNext, cro: croNext, phase }].slice(-120);
      return {
        ...state,
        time: state.time + dt,
        ci: ciNext,
        cro: croNext,
        phase,
        history,
      };
    },
    getSummary: (state) => `t=${state.time.toFixed(0)} CI=${state.ci.toFixed(2)} Cro=${state.cro.toFixed(2)} · ${state.phase}`,
  };
}

// Helper for single Plaque step (dt=1)
function runPlaqueStep(state: PlaqueAutomataState, rng: () => number): PlaqueAutomataState {
  const random = rng ?? Math.random;
  const currentGrid = state.grid;
  const currentAges = state.infectionTimes;
  
  const size = state.gridSize;
  const len = size * size;
  const nextGrid = new Uint8Array(len); // Zero-init to prevent race conditions
  const nextAges = new Float32Array(currentAges);

  const burst = Number(state.params.burst ?? 80);
  const latent = Number(state.params.latent ?? 12);
  const diffusion = Number(state.params.diffusion ?? 0.25);
  const adsorption = Number(state.params.adsorption ?? 0.2);
  const lysogeny = Number(state.params.lysogeny ?? 0.0);

  // Process Phages
  for (let i = 0; i < len; i++) {
    if (currentGrid[i] === 4) { // Phage
      let target = i;
      // Single step diffusion logic
      if (random() < diffusion) {
        const neighbor = randomNeighbor(i, size, random);
        if (neighbor !== null) target = neighbor;
      }

      const targetState = currentGrid[target];
      if (targetState === 1) { // Bacteria
        if (random() < adsorption) {
          nextGrid[target] = 2; // Infect
          nextAges[target] = 0;
        } else {
          // Bounce off
          if (nextGrid[target] !== 2 && nextGrid[target] !== 5) nextGrid[target] = 4;
        }
      } else {
         // Empty, already infected, lysogen, or another phage: move there if not occupied by bacteria/infected
         if (nextGrid[target] !== 2 && nextGrid[target] !== 5) {
            nextGrid[target] = 4; 
         }
      }
    }
  }

  // Process Cells (Bacteria, Infected, Lysogen)
  for (let i = 0; i < len; i++) {
    const stateVal = currentGrid[i];

    if (stateVal === 1) { // Bacteria
      if (nextGrid[i] !== 2) nextGrid[i] = 1; // Stay unless infected
    } else if (stateVal === 5) { // Lysogen
      nextGrid[i] = 5;
    } else if (stateVal === 2) { // Infected
      const newAge = currentAges[i] + 1; // dt=1
      if (newAge >= latent) {
        if (random() < lysogeny) {
          nextGrid[i] = 5; // Lysogenize
          nextAges[i] = 0;
        } else {
          nextGrid[i] = 3; // Lysis
          nextAges[i] = 0;
          const burstCount = Math.max(1, Math.floor(burst));
          for (let b = 0; b < burstCount; b++) {
            const nb = randomNeighbor(i, size, random);
            if (nb !== null) {
              const nbState = currentGrid[nb];
              // Infect neighbors immediately if bacteria
              if (nbState === 1 && random() < adsorption) {
                 nextGrid[nb] = 2; 
                 nextAges[nb] = 0;
              } else if (nextGrid[nb] === 0) {
                 // Otherwise spawn free phage in empty space
                 nextGrid[nb] = 4; 
              }
            }
          }
        }
      } else {
        nextGrid[i] = 2; // Stay infected
        nextAges[i] = newAge;
      }
    } else if (stateVal === 0) { // Empty
       if (nextGrid[i] === 0 && random() < 0.01) nextGrid[i] = 1; // Regrowth
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
    // time is not updated here
    grid: nextGrid,
    infectionTimes: nextAges,
    phageCount: phage,
    bacteriaCount: bacteria,
    infectionCount: infected,
  };
}

// Helper for single Evolution step (dt=1)
function runEvolutionStep(state: EvolutionReplayState, rng: () => number): EvolutionReplayState {
  const random = rng ?? Math.random;
  const mutRate = Number(state.params.mutRate ?? 0.05);
  const popSize = Number(state.params.popSize ?? 1e5);
  const selMean = Number(state.params.selMean ?? 0.0);
  const selSd = Number(state.params.selSd ?? 0.02);

  const newMutations = [...state.mutations];
  
  // Probabilistic mutations: Rate is expected mutations per step
  // mutRate is effectively mutations per genome per generation?
  // Let's assume mutRate is mean count.
  const expectedMuts = mutRate * 3; // Scaling factor
  let mutsThisGen = Math.floor(expectedMuts);
  if (random() < (expectedMuts - mutsThisGen)) {
      mutsThisGen++;
  }
  
  let currentStepS = 0;

  for (let i = 0; i < mutsThisGen; i++) {
    const s = selMean + selSd * (random() * 2 - 1);
    currentStepS += s;
    
    newMutations.push({
      position: Math.floor(random() * 50000),
      from: 'A',
      to: 'G',
      generation: state.generation + 1,
      s,
    });
  }
  
  // Cap mutations history to prevent memory leak
  if (newMutations.length > 500) {
      newMutations.splice(0, newMutations.length - 500);
  }

  const lastFitness = state.fitnessHistory[state.fitnessHistory.length - 1] ?? 1;
  const drift = (random() - 0.5) * 0.01;
  // Apply selection from new mutations + random genetic drift
  const nextFitness = clamp(lastFitness * (1 + currentStepS + drift), 0.6, 1.5);
  const nextHistory = [...state.fitnessHistory, nextFitness].slice(-200);

  const lastNe = state.neHistory.at(-1) ?? popSize;
  const neDrift = lastNe * (1 + (random() - 0.5) * 0.05);
  const nextNe = clamp(neDrift, popSize * 0.1, popSize * 10);
  const neHistory = [...state.neHistory, nextNe].slice(-200);

  return {
    ...state,
    // time not updated
    generation: state.generation + 1,
    mutations: newMutations,
    fitnessHistory: nextHistory,
    neHistory,
  };
}

export function makePlaqueSimulation(): Simulation<PlaqueAutomataState> {
  return {
    id: 'plaque-automata',
    name: 'Plaque Automata',
    description: 'Reaction-diffusion CA: infection, lysis, diffusion, lysogeny.',
    controls: STANDARD_CONTROLS,
    parameters: [
      { id: 'grid', label: 'Grid size', type: 'number', min: 10, max: 50, step: 5, defaultValue: 30 },
      { id: 'burst', label: 'Burst size', type: 'number', min: 5, max: 300, step: 5, defaultValue: 80 },
      { id: 'latent', label: 'Latent period (ticks)', type: 'number', min: 2, max: 40, step: 1, defaultValue: 12 },
      { id: 'diffusion', label: 'Diffusion prob', type: 'number', min: 0.0, max: 0.6, step: 0.05, defaultValue: 0.25 },
      { id: 'adsorption', label: 'Adsorption prob', type: 'number', min: 0.0, max: 0.6, step: 0.05, defaultValue: 0.2 },
      { id: 'lysogeny', label: 'Lysogeny prob', type: 'number', min: 0.0, max: 1.0, step: 0.05, defaultValue: 0.0 },
    ],
    init: (_phage, params): PlaqueAutomataState => {
      const base = getDefaultParams([
        { id: 'grid', label: '', type: 'number', defaultValue: 30 },
        { id: 'burst', label: '', type: 'number', defaultValue: 80 },
        { id: 'latent', label: '', type: 'number', defaultValue: 12 },
        { id: 'diffusion', label: '', type: 'number', defaultValue: 0.25 },
        { id: 'adsorption', label: '', type: 'number', defaultValue: 0.2 },
        { id: 'lysogeny', label: '', type: 'number', defaultValue: 0.0 },
      ]);
      const merged = { ...base, ...(params ?? {}) } as Record<string, number | boolean | string>;
      const size = Number(merged.grid ?? 30);
      const cells = new Uint8Array(size * size);
      const ages = new Float32Array(size * size);
      const center = Math.floor(size * size / 2);
      cells[center] = 4; // seed phage at center
      ages[center] = 0; // explicit initialization
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
    },
    step: (state: PlaqueAutomataState, dt: number, rng?: () => number): PlaqueAutomataState => {
      const random = rng ?? Math.random;
      
      const steps = Math.floor(dt);
      const remainder = dt - steps;
      const totalSteps = steps + (random() < remainder ? 1 : 0);
      
      let currentState = state;
      for (let s = 0; s < totalSteps; s++) {
        currentState = runPlaqueStep(currentState, random);
      }
      return { ...currentState, time: state.time + dt };
    },
    getSummary: (state) => `t=${state.time.toFixed(0)} phage=${state.phageCount} infected=${state.infectionCount}`,
  };
}

export function makeEvolutionSimulation(): Simulation<EvolutionReplayState> {
  return {
    id: 'evolution-replay',
    name: 'Evolution Replay',
    description: 'Molecular clock-ish replay: mutations, fitness, Ne drift.',
    controls: STANDARD_CONTROLS,
    parameters: [
      { id: 'mutRate', label: 'Mutation rate', type: 'number', min: 0, max: 0.2, step: 0.01, defaultValue: 0.05 },
      { id: 'popSize', label: 'Effective population (Ne)', type: 'number', min: 1e3, max: 1e7, step: 1e3, defaultValue: 1e5 },
      { id: 'selMean', label: 'Selection mean s', type: 'number', min: -0.1, max: 0.1, step: 0.01, defaultValue: 0.0 },
      { id: 'selSd', label: 'Selection sd', type: 'number', min: 0, max: 0.1, step: 0.01, defaultValue: 0.02 },
    ],
    init: (_phage, params): EvolutionReplayState => {
      const base = getDefaultParams([
        { id: 'mutRate', label: '', type: 'number', defaultValue: 0.05 },
        { id: 'popSize', label: '', type: 'number', defaultValue: 1e5 },
        { id: 'selMean', label: '', type: 'number', defaultValue: 0.0 },
        { id: 'selSd', label: '', type: 'number', defaultValue: 0.02 },
      ]);
      const merged = { ...base, ...(params ?? {}) } as Record<string, number | boolean | string>;
      return {
        type: 'evolution-replay',
        time: 0,
        running: true,
        speed: 1,
        params: merged,
        generation: 0,
        mutations: [],
        fitnessHistory: [1],
        neHistory: [Number(merged.popSize ?? 1e5)],
      };
    },
    step: (state: EvolutionReplayState, dt: number, rng?: () => number): EvolutionReplayState => {
      const random = rng ?? Math.random;
      
      const steps = Math.floor(dt);
      const remainder = dt - steps;
      const totalSteps = steps + (random() < remainder ? 1 : 0);
      
      let currentState = state;
      for (let s = 0; s < totalSteps; s++) {
        currentState = runEvolutionStep(currentState, random);
      }
      return { ...currentState, time: state.time + dt };
    },
    getSummary: (state) => `gen=${state.generation} fitness=${state.fitnessHistory.at(-1)?.toFixed(2) ?? '1.00'} muts=${state.mutations.length}`,
  };
}

export function makeInfectionSimulation(): Simulation<InfectionKineticsState> {
  return {
    id: 'infection-kinetics',
    name: 'Burst Kinetics',
    description: 'SIR-like infection ODE: adsorption, latent period, burst.',
    controls: STANDARD_CONTROLS,
    parameters: [
      { id: 'b0', label: 'Bacteria (start)', type: 'number', min: 1e4, max: 1e9, step: 1e4, defaultValue: 1e6 },
      { id: 'p0', label: 'Phage (start)', type: 'number', min: 1e2, max: 1e9, step: 1e2, defaultValue: 1e7 },
      { id: 'k', label: 'Adsorption k (mL/min)', type: 'number', min: 1e-11, max: 1e-8, step: 1e-11, defaultValue: 2e-10 },
      { id: 'latent', label: 'Latent period (min)', type: 'number', min: 5, max: 120, step: 1, defaultValue: 40 },
      { id: 'burst', label: 'Burst size', type: 'number', min: 10, max: 500, step: 5, defaultValue: 120 },
      { id: 'growth', label: 'Bacterial growth (μ)', type: 'number', min: 0, max: 2, step: 0.05, defaultValue: 0.5 },
      { id: 'decay', label: 'Phage decay (δ)', type: 'number', min: 0, max: 0.5, step: 0.01, defaultValue: 0.02 },
    ],
    init: (_phage, params): InfectionKineticsState => {
      const base = getDefaultParams([
        { id: 'b0', label: '', type: 'number', defaultValue: 1e6 },
        { id: 'p0', label: '', type: 'number', defaultValue: 1e7 },
        { id: 'k', label: '', type: 'number', defaultValue: 2e-10 },
        { id: 'latent', label: '', type: 'number', defaultValue: 40 },
        { id: 'burst', label: '', type: 'number', defaultValue: 120 },
        { id: 'growth', label: '', type: 'number', defaultValue: 0.5 },
        { id: 'decay', label: '', type: 'number', defaultValue: 0.02 },
      ]);
      const merged = { ...base, ...(params ?? {}) } as Record<string, number | boolean | string>;
      return {
        type: 'infection-kinetics',
        time: 0,
        running: true,
        speed: 1,
        params: merged,
        bacteria: Number(merged.b0 ?? 1e6),
        infected: 0,
        phage: Number(merged.p0 ?? 1e7),
      };
    },
    step: (state: InfectionKineticsState, dt: number): InfectionKineticsState => {
      const k = Number(state.params.k ?? 2e-10);
      const latent = Number(state.params.latent ?? 40);
      const burst = Number(state.params.burst ?? 120);
      const growth = Number(state.params.growth ?? 0.5);
      const decay = Number(state.params.decay ?? 0.02);

      const B = state.bacteria;
      const I = state.infected;
      const P = state.phage;

      // Note: 'latent' is treated here as the mean lifetime of the infected state (1/latent rate),
      // effectively modeling lysis as an exponential decay process rather than a fixed time delay.
      const dB = (growth * B - k * B * P) * dt;
      const dI = (k * B * P - I / Math.max(1, latent)) * dt;
      const dP = ((burst / Math.max(1, latent)) * I - k * B * P - decay * P) * dt;

      const nextB = clamp(B + dB, 0, 1e12);
      const nextI = clamp(I + dI, 0, 1e12);
      const nextP = clamp(P + dP, 0, 1e12);

      return {
        ...state,
        time: state.time + dt,
        bacteria: nextB,
        infected: nextI,
        phage: nextP,
      };
    },
    getSummary: (state) => {
      return `t=${state.time.toFixed(0)} B=${state.bacteria.toExponential(2)} I=${state.infected.toExponential(2)} P=${state.phage.toExponential(2)}`;
    },
  };
}

export function makePackagingSimulation(): Simulation<PackagingMotorState> {
  return {
    id: 'packaging-motor',
    name: 'Packaging Motor',
    description: 'DNA fill → pressure/force with salt and capsid geometry.',
    controls: STANDARD_CONTROLS,
    parameters: [
      { id: 'genomeKb', label: 'Genome length (kb)', type: 'number', min: 3, max: 200, step: 1, defaultValue: 50 },
      { id: 'capsidRadius', label: 'Capsid radius (nm)', type: 'number', min: 20, max: 60, step: 1, defaultValue: 30 },
      { id: 'ionic', label: 'Ionic strength (mM)', type: 'number', min: 1, max: 200, step: 5, defaultValue: 50 },
      { id: 'mode', label: 'Packaging mode', type: 'select', options: [
        { value: 'headful', label: 'Headful' },
        { value: 'cos', label: 'Cos' },
        { value: 'phi29', label: 'Phi29 motor' },
      ], defaultValue: 'cos' },
    ],
    init: (_phage, params): PackagingMotorState => {
      const base = getDefaultParams([{ id: 'stall', label: '', type: 'number', defaultValue: 0.02 }]);
      const merged = { ...base, ...(params ?? {}) } as Record<string, number | boolean | string>;
      return {
        type: 'packaging-motor',
        time: 0,
        running: true,
        speed: 1,
        params: merged,
        fillFraction: 0.1,
        pressure: 5,
        force: 20,
        stallProbability: 0,
      };
    },
    step: (state: PackagingMotorState, dt: number): PackagingMotorState => {
      const genomeKb = Number(state.params.genomeKb ?? 50);
      const capsidRadius = Number(state.params.capsidRadius ?? 30); // nm
      const ionic = Number(state.params.ionic ?? 50); // mM
      const mode = String(state.params.mode ?? 'cos');

      // Progress fill; faster when under-stuffed, slower near full
      const fillDelta = 0.015 * state.speed * (1 - state.fillFraction) * dt;
      const fill = clamp(state.fillFraction + fillDelta, 0, 1);

      // Very lightweight physics-inspired approximations
      const persistenceLen = 50; // nm
      const contourNm = genomeKb * 0.34 * 1000; // nm
      const packedDensity = (contourNm * fill) / ((4 / 3) * Math.PI * Math.pow(capsidRadius, 3));

      // Bending energy ~ (L / R^2)
      const bendingEnergy = (contourNm * fill) / Math.max(1, capsidRadius * capsidRadius * persistenceLen);

      // Electrostatics damped by ionic strength (Debye ~ 0.304/sqrt(I) nm)
      const debye = 0.304 / Math.sqrt(Math.max(1, ionic)); // nm
      const electrostatic = packedDensity * 0.5 * (1 / Math.max(debye, 0.05));

      // Mode-specific pressure scaling
      const modeFactor = mode === 'headful' ? 1.0 : mode === 'phi29' ? 1.2 : 0.9;

      const pressure = clamp(5 + 30 * fill + 200 * bendingEnergy * 1e-6 + 80 * electrostatic * 1e-3, 0, 80) * modeFactor;
      const force = clamp(10 + 150 * fill + pressure * 0.8, 0, 200);

      return {
        ...state,
        time: state.time + dt,
        fillFraction: fill,
        pressure,
        force,
        stallProbability: 0,
      };
    },
    getSummary: (state) => `t=${state.time.toFixed(0)} fill ${(state.fillFraction * 100).toFixed(1)}% · P=${state.pressure.toFixed(1)} atm · F=${state.force.toFixed(1)} pN`,
  };
}

export function getAllSimulations(): Simulation<SimState>[] {
  return [
    makeLysogenySimulation(),
    ribosomeTrafficSimulation,
    makePlaqueSimulation(),
    makeEvolutionSimulation(),
    makePackagingSimulation(),
    makeInfectionSimulation(),
  ].map(s => s as unknown as Simulation<SimState>);
}
