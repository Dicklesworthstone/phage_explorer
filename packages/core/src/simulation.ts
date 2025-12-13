// Simulation Framework Types
// Common infrastructure for interactive simulations in Phage Explorer

import type { PhageFull } from './types';

/**
 * Simulation IDs for the 5 planned simulations
 */
export type SimulationId =
  | 'lysogeny-circuit'
  | 'ribosome-traffic'
  | 'plaque-automata'
  | 'evolution-replay'
  | 'packaging-motor'
  | 'infection-kinetics';

/**
 * Simulation parameter definition
 */
export interface SimParameter {
  id: string;
  label: string;
  description?: string;
  type: 'number' | 'boolean' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string | number; label: string }>;
  defaultValue: number | boolean | string;
}

/**
 * Simulation control definition
 */
export interface SimControl {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  action: 'pause' | 'reset' | 'step' | 'speed-up' | 'speed-down' | 'custom';
  customHandler?: () => void;
}

/**
 * Base simulation state that all simulations share
 */
export interface SimStateBase {
  /** Current simulation time step */
  time: number;
  /** Whether simulation is running */
  running: boolean;
  /** Simulation speed multiplier */
  speed: number;
  /** Parameter values */
  params: Record<string, number | boolean | string>;
}

/**
 * Lysogeny Decision Circuit state
 * ODE model of Lambda lysis-lysogeny switch
 */
export interface LysogenyCircuitState extends SimStateBase {
  type: 'lysogeny-circuit';
  /** CI repressor concentration */
  ci: number;
  /** Cro repressor concentration */
  cro: number;
  /** N antiterminator concentration */
  n: number;
  /** Phase: 'lysogenic' | 'lytic' | 'undecided' */
  phase: 'lysogenic' | 'lytic' | 'undecided';
  /** History for plotting */
  history: Array<{ time: number; ci: number; cro: number }>;
}

/**
 * Ribosome Traffic Jam state
 * Particle simulation of translation
 */
export interface RibosomeTrafficState extends SimStateBase {
  type: 'ribosome-traffic';
  /** mRNA sequence (or gene ID) */
  mRnaId: string;
  /** Ribosome positions on mRNA (codon index) */
  ribosomes: number[];
  /** Translation rates per codon (based on tRNA abundance) */
  codonRates: number[];
  /** Proteins produced count */
  proteinsProduced: number;
  /** Stall events */
  stallEvents: number;
  /** History of active ribosome counts (for trends) */
  densityHistory: number[];
  /** History of cumulative protein output */
  productionHistory: number[];
}

/**
 * Plaque Growth Cellular Automata state
 */
export interface PlaqueAutomataState extends SimStateBase {
  type: 'plaque-automata';
  /** Grid size */
  gridSize: number;
  /** Cell states: 0=empty, 1=bacteria, 2=infected, 3=lysed, 4=phage */
  grid: Uint8Array;
  /** Track time since infection for each cell */
  infectionTimes: Float32Array;
  /** Phage count */
  phageCount: number;
  /** Bacteria count */
  bacteriaCount: number;
  /** Infection count */
  infectionCount: number;
}

/**
 * Evolution Replay state
 */
export interface EvolutionReplayState extends SimStateBase {
  type: 'evolution-replay';
  /** Current generation */
  generation: number;
  /** Mutation positions accumulated */
  mutations: Array<{ position: number; from: string; to: string; generation: number; s?: number }>;
  /** Fitness trajectory */
  fitnessHistory: number[];
  /** Effective population size trajectory */
  neHistory: number[];
}

/**
 * Infection kinetics (burst/latency) state
 */
export interface InfectionKineticsState extends SimStateBase {
  type: 'infection-kinetics';
  /** Bacteria population (relative) */
  bacteria: number;
  /** Infected population */
  infected: number;
  /** Free phage population */
  phage: number;
}

/**
 * Packaging Motor Pressure Gauge state
 */
export interface PackagingMotorState extends SimStateBase {
  type: 'packaging-motor';
  /** Fraction of genome packaged (0-1) */
  fillFraction: number;
  /** Current internal pressure (atmospheres) */
  pressure: number;
  /** Force on portal (pN) */
  force: number;
  /** Motor stall probability */
  stallProbability: number;
}

/**
 * Union of all simulation states
 */
export type SimState =
  | LysogenyCircuitState
  | RibosomeTrafficState
  | PlaqueAutomataState
  | EvolutionReplayState
  | InfectionKineticsState
  | PackagingMotorState;

/**
 * Simulation definition interface
 * All simulations must implement this interface
 */
export interface Simulation<S extends SimState = SimState> {
  /** Unique identifier */
  id: SimulationId;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** Icon for menu display */
  icon?: string;

  /** Configurable parameters */
  parameters: SimParameter[];

  /** Available controls */
  controls: SimControl[];

  /**
   * Initialize simulation state
   * @param phage Current phage data (optional, some sims are generic)
   * @param params Initial parameter overrides
   * @param rng Random number generator (returns 0-1)
   */
  init: (phage?: PhageFull | null, params?: Partial<S['params']>, rng?: () => number) => S;

  /**
   * Advance simulation by one time step
   * @param state Current state
   * @param dt Time delta (typically 1 for discrete, or frame time for continuous)
   * @param rng Random number generator (returns 0-1)
   */
  step: (state: S, dt: number, rng?: () => number) => S;

  /**
   * Check if simulation has reached terminal state
   * @param state Current state
   */
  isComplete?: (state: S) => boolean;

  /**
   * Get summary text for current state (shown in status bar)
   */
  getSummary: (state: S) => string;
}

/**
 * Simulation registry - maps IDs to simulation definitions
 */
export type SimulationRegistry = Map<SimulationId, Simulation>;

/**
 * Create default parameters object from parameter definitions
 */
export function getDefaultParams(params: SimParameter[]): Record<string, number | boolean | string> {
  const defaults: Record<string, number | boolean | string> = {};
  for (const p of params) {
    defaults[p.id] = p.defaultValue;
  }
  return defaults;
}

/**
 * Standard controls available to all simulations
 */
export const STANDARD_CONTROLS: SimControl[] = [
  { id: 'pause', label: 'Pause/Resume', icon: '⏯', shortcut: 'Space', action: 'pause' },
  { id: 'reset', label: 'Reset', icon: '🔄', shortcut: 'R', action: 'reset' },
  { id: 'step', label: 'Single Step', icon: '→', shortcut: '.', action: 'step' },
  { id: 'speed-up', label: 'Speed Up', icon: '⏩', shortcut: '+', action: 'speed-up' },
  { id: 'speed-down', label: 'Slow Down', icon: '⏪', shortcut: '-', action: 'speed-down' },
];

/**
 * Speed multiplier options
 */
export const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8] as const;
export type SpeedOption = typeof SPEED_OPTIONS[number];

/**
 * Get next speed option
 */
export function nextSpeed(current: number): number {
  const idx = SPEED_OPTIONS.findIndex(s => s >= current);
  if (idx === -1 || idx === SPEED_OPTIONS.length - 1) return SPEED_OPTIONS[SPEED_OPTIONS.length - 1];
  return SPEED_OPTIONS[idx + 1];
}

/**
 * Get previous speed option
 */
export function prevSpeed(current: number): number {
  const idx = SPEED_OPTIONS.findIndex(s => s >= current);
  if (idx <= 0) return SPEED_OPTIONS[0];
  return SPEED_OPTIONS[idx - 1];
}

/**
 * Simulation metadata for menu display
 */
export interface SimulationMeta {
  id: SimulationId;
  name: string;
  description: string;
  icon: string;
  /** Priority in menu (lower = higher in list) */
  priority: number;
  /** Whether this simulation requires a specific phage */
  requiresPhage: boolean;
  /** Keywords for search */
  keywords: string[];
}

/**
 * Metadata for all planned simulations
 */
export const SIMULATION_METADATA: SimulationMeta[] = [
  {
    id: 'lysogeny-circuit',
    name: 'Lysogeny Decision Circuit',
    description: 'Watch CI/Cro battle unfold — adjust MOI, UV damage',
    icon: '⚖️',
    priority: 1,
    requiresPhage: false,
    keywords: ['lambda', 'lysogeny', 'lytic', 'ci', 'cro', 'decision', 'circuit', 'ode'],
  },
  {
    id: 'ribosome-traffic',
    name: 'Ribosome Traffic Simulator',
    description: 'See translation bottlenecks form in real-time',
    icon: '🚗',
    priority: 2,
    requiresPhage: true,
    keywords: ['ribosome', 'translation', 'codon', 'traffic', 'mrna', 'protein'],
  },
  {
    id: 'plaque-automata',
    name: 'Plaque Growth Automata',
    description: 'Cellular automaton of phage spreading on lawn',
    icon: '🧫',
    priority: 3,
    requiresPhage: false,
    keywords: ['plaque', 'automata', 'cellular', 'growth', 'lawn', 'spreading'],
  },
  {
    id: 'evolution-replay',
    name: 'Evolution Replay',
    description: 'Watch mutations accumulate across isolates',
    icon: '🧬',
    priority: 4,
    requiresPhage: true,
    keywords: ['evolution', 'mutation', 'replay', 'isolate', 'fitness'],
  },
  {
    id: 'packaging-motor',
    name: 'Packaging Motor Pressure',
    description: 'Feel the 60 atmospheres building in the capsid',
    icon: '📦',
    priority: 5,
    requiresPhage: true,
    keywords: ['packaging', 'motor', 'pressure', 'capsid', 'portal', 'dna'],
  },
  {
    id: 'infection-kinetics',
    name: 'Burst Kinetics Simulator',
    description: 'Adsorption, latent period, burst size infection model',
    icon: '📈',
    priority: 6,
    requiresPhage: false,
    keywords: ['burst', 'latency', 'adsorption', 'infection', 'ode'],
  },
];
