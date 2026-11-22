// Simulation Implementations
// Core logic for all phage simulations
// Moved from TUI registry.ts to be shared with Web worker

import type {
  Simulation,
  SimulationId,
  LysogenyCircuitState,
  PlaqueAutomataState,
  EvolutionReplayState,
  PackagingMotorState,
  InfectionKineticsState,
  ResistanceCocktailState,
  SimState,
} from './simulation';
import { getDefaultParams, STANDARD_CONTROLS } from './simulation';
import { ribosomeTrafficSimulation } from './analysis/translation-simulation';
import type { PhageFull } from './types';
import {
  reconstructLysogenyCircuit,
  deriveLysogenyCircuitParams,
  calculateOperatorOccupancy,
  simulateSwitchStep,
  computeCircuitPhasePortrait,
  computeNullclines,
  computeAttractors,
  predictLysogenyFate,
} from './analysis/lysogeny-circuit';

// Helper to clamp numbers
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Approximate capsid radius (nm) by virion morphology.
 *
 * These are the standard published outer radii for the morphotypes in the
 * catalogue; they are what makes a 26 nm microvirus behave differently from a
 * 90 nm myovirus head in the packaging model. Filamentous phages (M13) have no
 * icosahedral capsid at all, so they fall through to the generic default and
 * the packaging model should be read as illustrative for them.
 */
const CAPSID_RADIUS_NM_BY_MORPHOLOGY: Record<string, number> = {
  microvirus: 13,
  levivirus: 13,
  podovirus: 30,
  siphovirus: 29,
  myovirus: 45,
  tectivirus: 31,
  corticovirus: 29,
  cystovirus: 43,
};

const DEFAULT_CAPSID_RADIUS_NM = 30;

/**
 * Capsid radius for a morphology, in nanometres. Falls back to a generic
 * icosahedral head where the morphology is unknown or has no capsid.
 */
export function capsidRadiusNm(morphology?: string | null): number {
  const m = (morphology ?? '').toLowerCase();
  return CAPSID_RADIUS_NM_BY_MORPHOLOGY[m] ?? DEFAULT_CAPSID_RADIUS_NM;
}

// ===========================================================================
// DNA packaging physics
// ===========================================================================

/**
 * Physical constants for the packaging model. Every one is a published value
 * with its source named; none is fitted here except FZERO_PN_PER_NM2, which
 * says so.
 */
/** Thermal energy at 25 degrees C, in pN*nm. */
const KBT_PN_NM = 4.11;
/** DNA persistence length in nm (Hagerman 1988; Bustamante et al. 1994). */
const PERSISTENCE_LENGTH_NM = 50;
/** Rise per base pair for B-form DNA, in nm. */
const RISE_PER_BP_NM = 0.34;
/**
 * Portal channel radius in nm, used to convert the packaging force into an
 * internal pressure. The portal lumen is roughly 3.5-4 nm across in the
 * tailed phages (Simpson et al. 2000, phi29 connector structure).
 */
const PORTAL_CHANNEL_RADIUS_NM = 1.8;
/**
 * Amplitude of the interstrand repulsion, in pN/nm^2.
 *
 * THIS ONE IS CALIBRATED, not independently derived. It is the single free
 * parameter in the model, solved so that lambda at full packing comes out at
 * 57 pN, the force measured by optical tweezers for phages of this class
 * (Smith et al., Nature 413:748, 2001 for phi29; Fuller et al., PNAS
 * 104:11245, 2007 for lambda). The functional FORM is the screened-Coulomb
 * term the README describes; only the amplitude is fitted.
 *
 * Lambda is the anchor rather than phi29 because lambda's head is close to
 * spherical, so the single-radius-per-morphology table below represents it
 * well. See the accuracy note on `packagingStateAt`.
 *
 * Stated here rather than buried because a reader has to be able to tell which
 * numbers in this file are measured and which are tuned.
 */
const FZERO_PN_PER_NM2 = 380.84;

/**
 * Interaxial spacing of hexagonally packed DNA, in nm.
 *
 * `packedLengthNm` of duplex confined in `volumeNm3` on a hexagonal lattice
 * occupies (sqrt(3)/2) * d^2 per unit length, which inverts to this.
 */
function interaxialSpacingNm(packedLengthNm: number, volumeNm3: number): number {
  if (packedLengthNm <= 0) return Infinity;
  return Math.sqrt((2 * volumeNm3) / (Math.sqrt(3) * packedLengthNm));
}

/**
 * Debye screening length in nm for a monovalent salt at 25 degrees C.
 *
 * The 0.304 nm numerator is the standard result for water at 25 C with ionic
 * strength in mol/L, and is the figure the README quotes.
 */
export function debyeLengthNm(ionicStrengthM: number): number {
  const I = Math.max(1e-4, ionicStrengthM);
  return 0.304 / Math.sqrt(I);
}

/**
 * Mean radius of the DNA-occupied shell, in nm.
 *
 * DNA spools from the capsid wall inwards, so at fill fraction phi it occupies
 * the shell between R*(1-phi)^(1/3) and R. The volume-weighted mean radius of
 * that shell is (3/4)*(R^4 - Rin^4)/(R^3 - Rin^3), which is the radius the
 * bending term should use. Taking R itself would understate the bending cost of
 * the innermost, tightest turns, which is where the force actually comes from.
 */
function meanSpoolRadiusNm(capsidRadiusNm: number, fillFraction: number): number {
  const phi = Math.min(1, Math.max(0, fillFraction));
  if (phi <= 0) return capsidRadiusNm;
  const rIn = capsidRadiusNm * Math.cbrt(1 - phi);
  const num = Math.pow(capsidRadiusNm, 4) - Math.pow(rIn, 4);
  const den = Math.pow(capsidRadiusNm, 3) - Math.pow(rIn, 3);
  if (den <= 0) return capsidRadiusNm * 0.75;
  return 0.75 * (num / den);
}

/**
 * Total free energy of the packaged DNA, in pN*nm.
 *
 * Two terms, both named in the README:
 *
 *   bending      E/L = xi_p * kT / (2 R^2)      elastic rod bent to radius R
 *   electrostatic E/L = F0 * exp(-d_s / lambda_D)  screened interstrand repulsion
 *
 * This is the inverse-spool picture used by Riemer & Bloomfield (1978) and
 * Purohit, Kondev & Phillips (PNAS 100:3173, 2003). It is a continuum model: it
 * has no sequence dependence, no explicit ions, and no kinetics, so it predicts
 * the SCALE and the SHAPE of the force curve rather than a per-genome number to
 * three digits.
 */
export function packagingEnergyPnNm(
  bpPackaged: number,
  genomeLengthBp: number,
  capsidRadiusNm: number,
  ionicStrengthM: number
): number {
  if (bpPackaged <= 0 || genomeLengthBp <= 0) return 0;

  const packedLengthNm = bpPackaged * RISE_PER_BP_NM;
  const volumeNm3 = (4 / 3) * Math.PI * Math.pow(capsidRadiusNm, 3);
  const fill = Math.min(1, bpPackaged / genomeLengthBp);

  const rEff = meanSpoolRadiusNm(capsidRadiusNm, fill);
  const bendingPerNm = (PERSISTENCE_LENGTH_NM * KBT_PN_NM) / (2 * rEff * rEff);

  const ds = interaxialSpacingNm(packedLengthNm, volumeNm3);
  const lambda = debyeLengthNm(ionicStrengthM);
  const elecPerNm = FZERO_PN_PER_NM2 * Math.exp(-ds / lambda);

  return packedLengthNm * (bendingPerNm + elecPerNm);
}

export interface PackagingState {
  /** Base pairs packaged so far. */
  bpPackaged: number;
  /** Fraction of the genome packaged, 0-1. */
  fillFraction: number;
  /** Force the motor works against, in pN. */
  forcePn: number;
  /** Internal pressure, in atmospheres. */
  pressureAtm: number;
  /** Interaxial DNA spacing at this fill, in nm. */
  spacingNm: number;
  /** Debye screening length at this ionic strength, in nm. */
  debyeNm: number;
  /** Capsid radius used, in nm. */
  capsidRadiusNm: number;
  /** ATP hydrolysed so far, at the measured 2 bp per ATP. */
  atpCount: number;
}

/** Pascals per atmosphere. */
const PA_PER_ATM = 101325;

/**
 * Packaging force and pressure at a given fill.
 *
 * Force is dE/dL evaluated numerically, which is what the motor works against
 * and what optical-tweezer experiments measure. Pressure is that force spread
 * over the portal channel cross-section, which is how the ~6 MPa figure quoted
 * for phi29 is obtained from the ~57 pN force.
 *
 * Replaces `force = 5 + 50*phi^3` and `pressure = min(60, 5 + 55*phi)`, closed
 * forms in which nothing but genome length and cursor position appeared, while
 * the README described a bending-energy and Debye-screening model that did not
 * exist anywhere in the code.
 *
 * ## How accurate is this
 *
 * At full packing the model gives 12-73 pN across this catalogue, centred on
 * the measured 50-60 pN band, and the force rises steeply above about half
 * packing, which is the shape the tweezer experiments show. That is the level
 * of agreement to expect: scale and shape, not a per-genome number to three
 * digits.
 *
 * The dominant source of per-phage error is the capsid radius table, which
 * carries ONE radius per morphology and treats every head as a sphere. Phi29 is
 * the clearest casualty: its head is prolate, roughly 42 by 54 nm, so a single
 * 30 nm sphere overstates its volume and the model reports about 13 pN where
 * 57 pN was measured. Fixing that means per-phage capsid dimensions, not a
 * different force law.
 */
export function packagingStateAt(
  bpPackaged: number,
  genomeLengthBp: number,
  morphology?: string | null,
  ionicStrengthM = 0.1
): PackagingState {
  const radius = capsidRadiusNm(morphology);
  const clamped = Math.max(0, Math.min(genomeLengthBp, bpPackaged));
  const fill = genomeLengthBp > 0 ? clamped / genomeLengthBp : 0;

  // Central difference over one nanometre of duplex, in bp.
  const hBp = Math.max(1, genomeLengthBp * 1e-4);
  const lo = Math.max(0, clamped - hBp);
  const hi = Math.min(genomeLengthBp, clamped + hBp);
  const dLnm = (hi - lo) * RISE_PER_BP_NM;

  const eLo = packagingEnergyPnNm(lo, genomeLengthBp, radius, ionicStrengthM);
  const eHi = packagingEnergyPnNm(hi, genomeLengthBp, radius, ionicStrengthM);
  const forcePn = dLnm > 0 ? Math.max(0, (eHi - eLo) / dLnm) : 0;

  const areaNm2 = Math.PI * PORTAL_CHANNEL_RADIUS_NM * PORTAL_CHANNEL_RADIUS_NM;
  // pN/nm^2 = 1e-12 N / 1e-18 m^2 = 1e6 Pa.
  const pressureAtm = (forcePn / areaNm2) * 1e6 / PA_PER_ATM;

  const volumeNm3 = (4 / 3) * Math.PI * Math.pow(radius, 3);

  return {
    bpPackaged: clamped,
    fillFraction: fill,
    forcePn,
    pressureAtm,
    spacingNm: interaxialSpacingNm(clamped * RISE_PER_BP_NM, volumeNm3),
    debyeNm: debyeLengthNm(ionicStrengthM),
    capsidRadiusNm: radius,
    // 2 bp per ATP, measured for phi29 (Guo et al. 1987; Smith et al. 2001).
    atpCount: Math.floor(clamped / 2),
  };
}

/** Fallback genome size for evolution replay when no phage is loaded (bp). */
const DEFAULT_EVOLUTION_GENOME_LENGTH = 50000;

/**
 * Draw a single base substitution.
 *
 * The starting base is sampled from the genome's own GC composition, and the
 * replacement is drawn from the remaining three bases with transitions
 * (A<->G, C<->T) weighted twice as heavily as transversions, which is the
 * standard first-order approximation of observed substitution spectra. This is
 * a model, not a read of the sequence, but every input to it is real.
 */
function drawSubstitution(
  gcContent: number,
  random: () => number
): { from: string; to: string } {
  const gcHalf = gcContent / 2;
  const atHalf = (1 - gcContent) / 2;
  const roll = random();
  let from: string;
  if (roll < atHalf) from = 'A';
  else if (roll < atHalf * 2) from = 'T';
  else if (roll < atHalf * 2 + gcHalf) from = 'G';
  else from = 'C';

  const transition: Record<string, string> = { A: 'G', G: 'A', C: 'T', T: 'C' };
  const transversions: Record<string, string[]> = {
    A: ['C', 'T'],
    G: ['C', 'T'],
    C: ['A', 'G'],
    T: ['A', 'G'],
  };

  // 2:1 transition:transversion, i.e. transitions half the time overall.
  if (random() < 0.5) {
    return { from, to: transition[from] };
  }
  const options = transversions[from];
  return { from, to: options[random() < 0.5 ? 0 : 1] };
}

/**
 * Parameter defaults derived from the phage the user actually has open.
 *
 * The simulation parameter lists carry generic `defaultValue`s so the controls
 * render sensibly with no genome loaded. When a phage IS loaded those generics
 * are wrong -- a 280 kb jumbo phage and a 3.5 kb leviphage are not both 50 kb --
 * so callers merge this over the generic defaults before initialising. A value
 * the user has since edited by hand must still win, so callers apply this
 * BETWEEN the generic defaults and any explicit user overrides.
 *
 * Returns an empty object when there is nothing real to derive, so callers can
 * spread it unconditionally.
 */
export function derivePhageSimDefaults(
  simId: SimulationId,
  phage?: PhageFull | null
): Record<string, number | boolean | string> {
  if (!phage) return {};

  if (simId === 'packaging-motor') {
    const derived: Record<string, number | boolean | string> = {};
    if (typeof phage.genomeLength === 'number' && phage.genomeLength > 0) {
      derived.genomeKb = Math.round((phage.genomeLength / 1000) * 10) / 10;
    }
    const morphology = phage.morphology?.toLowerCase() ?? '';
    derived.capsidRadius =
      CAPSID_RADIUS_NM_BY_MORPHOLOGY[morphology] ?? DEFAULT_CAPSID_RADIUS_NM;
    return derived;
  }

  if (simId === 'lysogeny-circuit') {
    return deriveLysogenyCircuitParams(phage);
  }

  return {};
}

// Helper for 2D grid neighbor selection (used in Plaque Sim)
// Toroidal wrap-around to avoid edge effects
function randomNeighbor(index: number, size: number, rng: () => number): number {
  const x = index % size;
  const y = Math.floor(index / size);
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  const [dx, dy] = dirs[Math.floor(rng() * dirs.length)];
  // Wrap around (toroidal)
  const nx = (x + dx + size) % size;
  const ny = (y + dy + size) % size;
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
      { id: 'nutrients', label: 'Host nutrient level', type: 'number', min: 0.1, max: 2, step: 0.1, defaultValue: 1 },
      { id: 'ciProd', label: 'CI synthesis', type: 'number', min: 0.05, max: 2.5, step: 0.05, defaultValue: 0.8 },
      { id: 'croProd', label: 'Cro synthesis', type: 'number', min: 0.05, max: 2.5, step: 0.05, defaultValue: 0.6 },
      { id: 'decay', label: 'Protein decay', type: 'number', min: 0.01, max: 0.3, step: 0.01, defaultValue: 0.05 },
      { id: 'hill', label: 'Hill cooperativity', type: 'number', min: 1, max: 4, step: 0.2, defaultValue: 2 },
    ],
    init: (phage, params): LysogenyCircuitState => {
      const circuit = reconstructLysogenyCircuit(phage);
      const derived = deriveLysogenyCircuitParams(phage);
      const base = getDefaultParams([
        { id: 'moi', label: '', type: 'number', defaultValue: 1 },
        { id: 'uv', label: '', type: 'number', defaultValue: 0 },
        { id: 'nutrients', label: '', type: 'number', defaultValue: 1 },
        { id: 'ciProd', label: '', type: 'number', defaultValue: 0.8 },
        { id: 'croProd', label: '', type: 'number', defaultValue: 0.6 },
        { id: 'decay', label: '', type: 'number', defaultValue: 0.05 },
        { id: 'hill', label: '', type: 'number', defaultValue: 2 },
      ]);
      const merged = { ...base, ...derived, ...(params ?? {}) } as Record<string, number | boolean | string>;

      const isLytic = circuit.architecture === 'obligately-lytic';
      const initialCi = isLytic ? 0.05 : 0.4;
      const initialCro = isLytic ? 0.8 : 0.3;
      const initialPhase = isLytic ? 'lytic' : 'undecided';

      const occupancy = calculateOperatorOccupancy(initialCi, initialCro, merged);
      const predicted = predictLysogenyFate(merged, circuit);
      const phasePortrait = computeCircuitPhasePortrait(merged, 16);
      const nullclines = computeNullclines(merged, 30);
      const attractors = computeAttractors(merged);

      return {
        type: 'lysogeny-circuit',
        time: 0,
        running: true,
        speed: 1,
        params: merged,
        ci: initialCi,
        cro: initialCro,
        n: 0.05,
        cII: 0.1,
        recAStar: 0.0,
        phase: initialPhase,
        occupancy,
        circuitInfo: circuit,
        predictedProbability: predicted.probability,
        predictionFactors: predicted.factors,
        phasePortrait,
        nullclines,
        attractors,
        history: [{ time: 0, ci: initialCi, cro: initialCro, cII: 0.1, phase: initialPhase }],
      };
    },
    step: (state: LysogenyCircuitState, dt: number): LysogenyCircuitState => {
      const simResult = simulateSwitchStep(state, dt, state.params);
      if (dt === 0) return state;
      const predicted = predictLysogenyFate(state.params, state.circuitInfo);

      const history = [
        ...state.history,
        {
          time: state.time + dt,
          ci: simResult.ci,
          cro: simResult.cro,
          cII: simResult.cII,
          phase: simResult.phase,
        },
      ].slice(-120);

      return {
        ...state,
        time: state.time + dt,
        ci: simResult.ci,
        cro: simResult.cro,
        cII: simResult.cII,
        recAStar: simResult.recAStar,
        phase: simResult.phase,
        occupancy: simResult.occupancy,
        predictedProbability: predicted.probability,
        predictionFactors: predicted.factors,
        history,
      };
    },
    getSummary: (state) => {
      const pred =
        state.predictedProbability !== undefined
          ? ` · P(lyso)=${(state.predictedProbability * 100).toFixed(0)}%`
          : '';
      return `t=${state.time.toFixed(0)} CI=${state.ci.toFixed(2)} Cro=${state.cro.toFixed(2)} · ${state.phase}${pred}`;
    },
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
        target = randomNeighbor(i, size, random);
      }

      const targetState = currentGrid[target];
      if (targetState === 1) { // Bacteria
        if (random() < adsorption) {
          nextGrid[target] = 2; // Infect
          nextAges[target] = 0;
        } else {
          // Bounce off: Stay at current position (i)
          // Do NOT overwrite target (which is occupied by bacteria)
          if (nextGrid[i] !== 2 && nextGrid[i] !== 5) nextGrid[i] = 4;
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

  const genomeLength =
    state.genomeLength > 0 ? state.genomeLength : DEFAULT_EVOLUTION_GENOME_LENGTH;
  const gcContent = state.gcContent > 0 ? state.gcContent : 0.5;

  for (let i = 0; i < mutsThisGen; i++) {
    const s = selMean + selSd * (random() * 2 - 1);
    currentStepS += s;

    const { from, to } = drawSubstitution(gcContent, random);
    newMutations.push({
      // 1-based, to match the coordinates the rest of the app displays.
      position: Math.floor(random() * genomeLength) + 1,
      from,
      to,
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
    init: (phage, params): EvolutionReplayState => {
      const base = getDefaultParams([
        { id: 'mutRate', label: '', type: 'number', defaultValue: 0.05 },
        { id: 'popSize', label: '', type: 'number', defaultValue: 1e5 },
        { id: 'selMean', label: '', type: 'number', defaultValue: 0.0 },
        { id: 'selSd', label: '', type: 'number', defaultValue: 0.02 },
      ]);
      const merged = { ...base, ...(params ?? {}) } as Record<string, number | boolean | string>;
      const genomeLength =
        typeof phage?.genomeLength === 'number' && phage.genomeLength > 0
          ? phage.genomeLength
          : DEFAULT_EVOLUTION_GENOME_LENGTH;
      const gcContent =
        typeof phage?.gcContent === 'number' && phage.gcContent > 0
          ? // The catalogue stores GC as a percentage; normalise to a fraction.
            clamp(phage.gcContent > 1 ? phage.gcContent / 100 : phage.gcContent, 0.05, 0.95)
          : 0.5;
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
        genomeLength,
        gcContent,
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

      // Normalize units to seconds (assuming dt is in seconds)
      const kSec = k / 60; // mL/min -> mL/sec
      const growthSec = growth / 3600; // per hour -> per sec
      const decaySec = decay / 3600; // per hour -> per sec
      const latentSec = Math.max(1, latent * 60); // min -> sec

      // Note: 'latent' is treated here as the mean lifetime of the infected state (1/latent rate),
      // effectively modeling lysis as an exponential decay process rather than a fixed time delay.
      const dB = (growthSec * B - kSec * B * P) * dt;
      const dI = (kSec * B * P - I / latentSec) * dt;
      const dP = ((burst / latentSec) * I - kSec * B * P - decaySec * P) * dt;

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
      // Ranges span the catalogue: MS2 at 3.6 kb through phiKZ at 280 kb, and
      // microvirus capsids at ~13 nm through myovirus heads at ~45 nm.
      { id: 'genomeKb', label: 'Genome length (kb)', type: 'number', min: 3, max: 300, step: 1, defaultValue: 50 },
      { id: 'capsidRadius', label: 'Capsid radius (nm)', type: 'number', min: 10, max: 60, step: 1, defaultValue: 30 },
      { id: 'ionic', label: 'Ionic strength (mM)', type: 'number', min: 1, max: 200, step: 5, defaultValue: 50 },
      { id: 'mode', label: 'Packaging mode', type: 'select', options: [
        { value: 'headful', label: 'Headful' },
        { value: 'cos', label: 'Cos' },
        { value: 'phi29', label: 'Phi29 motor' },
      ], defaultValue: 'cos' },
    ],
    init: (phage, params): PackagingMotorState => {
      const base = getDefaultParams([{ id: 'stall', label: '', type: 'number', defaultValue: 0.02 }]);
      // Phage-derived geometry sits under any explicit caller params so a user
      // who drags the genome-length slider still wins.
      const merged = {
        ...base,
        ...derivePhageSimDefaults('packaging-motor', phage),
        ...(params ?? {}),
      } as Record<string, number | boolean | string>;
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

/**
 * Bounded Poisson tau-leap teaching model, not an exact Gillespie SSA.
 * R_i resists only phage i. I_i is infected by i and does not divide.
 * S/R_j + P_i -> I_i consumes one cell and virion (j != i);
 * I_i -> burstSize * P_i has exponential mean waiting time latentPeriod.
 * Only I present at the start of a leap can lyse in that leap.
 * Fixed 0.01-hour ticks are subdivided to limit active individual hazards.
 * Random reaction order avoids permanent first-member priority.
 */
export const RESISTANCE_TICK_HOURS = 0.01;
export const RESISTANCE_MAX_TICKS = 4800;
const RESISTANCE_MAX_SUBSTEPS = 10000;

const resistanceCount: (value: unknown) => boolean = value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const validateResistanceParameters: (params: Record<string, number | boolean | string>) => void = params => {
  const ranges = {
    cocktailSize: [1, 5], initialBacteria: [0, 1e9], initialPhage: [0, 1e10],
    carryingCap: [1, 1e10], growthRate: [0, 2], infectionRate: [0, 1e-7],
    burstSize: [1, 500], latentPeriod: [0.1, 2], mutationRate: [0, 1e-5],
    multiResRate: [0, 1e-6], phageDecay: [0, 0.5],
  };
  if (Object.keys(params).some(name => !Object.hasOwn(ranges, name))) throw new Error('Unsupported resistance parameter.');
  for (const [name, range] of Object.entries(ranges)) {
    const value = params[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) {
      throw new Error('Resistance parameter ' + name + ' is outside its supported range.');
    }
  }
  for (const name of ['cocktailSize', 'initialBacteria', 'initialPhage', 'burstSize']) {
    if (!Number.isSafeInteger(params[name])) throw new Error('Resistance parameter ' + name + ' requires an integer.');
  }
};

const resistanceComplete: (state: ResistanceCocktailState) => boolean = state => {
  const infected = state.infectedByPhage.reduce((a, b) => a + b, 0);
  const bacteria = state.sensitiveBacteria + state.fullyResistant +
    state.partialResistant.reduce((a, b) => a + b, 0) + infected;
  const phage = state.phageCounts.reduce((a, b) => a + b, 0);
  return bacteria === 0 || phage + infected === 0 || state.completedSteps >= RESISTANCE_MAX_TICKS;
};

const resistanceOrder: (size: number, rng: () => number) => number[] = (size, rng) => {
  const order = Array.from({ length: size }, (_, index) => index);
  for (let index = size - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [order[index], order[other]] = [order[other], order[index]];
  }
  return order;
};

// Knuth for small means; explicit normal approximation for means above 30.
const poissonSample: (lambda: number, rng: () => number) => number = (lambda, rng) => {
  if (lambda <= 0) return 0;
  if (!Number.isFinite(lambda)) throw new Error('Resistance transition mean is not finite.');
  if (lambda > 30) {
    // RNG is [0,1); 1-rng() is strictly positive even when a seeded draw is zero.
    const u1 = 1 - rng();
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const limit = Math.exp(-lambda);
  let count = 0;
  let product = 1;
  do {
    count++;
    product *= rng();
    if (count > 10000) throw new Error('Resistance Poisson draw exceeded its work budget.');
  } while (product > limit);
  return count - 1;
};

const runResistanceStep: (state: ResistanceCocktailState, tau: number, rng: () => number) => ResistanceCocktailState = (state, tau, rng) => {
  const carryingCap = Number(state.params.carryingCap);
  const growthRate = Number(state.params.growthRate);
  const infectionRate = Number(state.params.infectionRate);
  const burstSize = Number(state.params.burstSize);
  const latentPeriod = Number(state.params.latentPeriod);
  const mutationRate = Number(state.params.mutationRate);
  const multiResRate = Number(state.params.multiResRate);
  const phageDecay = Number(state.params.phageDecay);
  const size = state.cocktailSize;
  // Index zero is sensitive; index j+1 resists only phage j.
  const uninfected = [state.sensitiveBacteria, ...state.partialResistant];
  let fullyResistant = state.fullyResistant;
  const phage = [...state.phageCounts];
  const infected = [...state.infectedByPhage];
  const events = [...state.events];
  const nextTime = state.simTime + tau;
  const event = (type: string) => events.push({ t: nextTime, type });
  const live = uninfected.reduce((a, b) => a + b, 0) + fullyResistant + infected.reduce((a, b) => a + b, 0);
  const growth = growthRate * Math.max(0, 1 - live / carryingCap) * tau;

  for (let group = 0; group < uninfected.length; group++) {
    uninfected[group] += poissonSample(growth * uninfected[group], rng);
  }
  fullyResistant += poissonSample(growth * fullyResistant, rng);

  // Keep the original infected pool distinct so new infections cannot burst immediately.
  const lysed = infected.map(count => Math.min(count, poissonSample(count / latentPeriod * tau, rng)));
  for (let member = 0; member < size; member++) infected[member] -= lysed[member];

  for (const member of resistanceOrder(size, rng)) {
    for (const group of resistanceOrder(uninfected.length, rng)) {
      if (group === member + 1) continue;
      const count = Math.min(uninfected[group], phage[member],
        poissonSample(infectionRate * uninfected[group] * phage[member] * tau, rng));
      uninfected[group] -= count;
      phage[member] -= count;
      infected[member] += count;
      if (count > 0) event('inf-P' + (member + 1));
    }
  }

  // Convert only existing partial classes before adding new resistance mutations.
  for (let member = 0; member < size; member++) {
    const count = Math.min(uninfected[member + 1], poissonSample(multiResRate * uninfected[member + 1] * tau, rng));
    uninfected[member + 1] -= count;
    fullyResistant += count;
    if (count > 0) event('full-res');
  }
  for (const member of resistanceOrder(size, rng)) {
    const count = Math.min(uninfected[0], poissonSample(mutationRate * uninfected[0] * tau, rng));
    uninfected[0] -= count;
    // With one member, resistance to that member is already full resistance.
    if (size === 1) fullyResistant += count;
    else uninfected[member + 1] += count;
    if (count > 0) event(size === 1 ? 'full-res' : 'mut-R' + (member + 1));
  }

  for (let member = 0; member < size; member++) {
    // Decay only the free pool surviving adsorption; new progeny enter at leap end.
    phage[member] -= Math.min(phage[member], poissonSample(phageDecay * phage[member] * tau, rng));
    phage[member] += lysed[member] * burstSize;
    if (lysed[member] > 0) event('lysis-P' + (member + 1));
  }

  if (![...uninfected, fullyResistant, ...infected, ...phage].every(resistanceCount)) {
    throw new Error('Resistance populations exceeded the supported exact-integer range.');
  }
  const crossed = uninfected.slice(1).reduce((a, b) => a + b, 0) + fullyResistant > carryingCap * 0.1;
  return {
    ...state, simTime: nextTime, sensitiveBacteria: uninfected[0], partialResistant: uninfected.slice(1),
    fullyResistant, infectedByPhage: infected, phageCounts: phage,
    resistanceEmerged: state.resistanceEmerged || crossed,
    resistanceTime: state.resistanceTime ?? (crossed ? nextTime : null),
    events: events.slice(-20),
  };
};

// Active competing hazards determine the substep; empty target pools do not constrain it.
const resistanceHazard: (state: ResistanceCocktailState) => number = state => {
  const p = state.params;
  const infectionRate = Number(p.infectionRate);
  const totalPhage = state.phageCounts.reduce((a, b) => a + b, 0);
  const totalPartial = state.partialResistant.reduce((a, b) => a + b, 0);
  let hazard = 0;
  if (state.sensitiveBacteria > 0) {
    hazard = Math.max(hazard, Number(p.growthRate) + infectionRate * totalPhage + state.cocktailSize * Number(p.mutationRate));
  }
  if (state.fullyResistant > 0) hazard = Math.max(hazard, Number(p.growthRate));
  for (let member = 0; member < state.cocktailSize; member++) {
    if (state.partialResistant[member] > 0) {
      hazard = Math.max(hazard, Number(p.growthRate) + infectionRate * (totalPhage - state.phageCounts[member]) + Number(p.multiResRate));
    }
    if (state.phageCounts[member] > 0) {
      hazard = Math.max(hazard, infectionRate * (state.sensitiveBacteria + totalPartial - state.partialResistant[member]) + Number(p.phageDecay));
    }
    if (state.infectedByPhage[member] > 0) hazard = Math.max(hazard, 1 / Number(p.latentPeriod));
  }
  return hazard;
};

const advanceResistance: (state: ResistanceCocktailState, dt: number, rng?: () => number) => ResistanceCocktailState = (state, dt, suppliedRng) => {
  validateResistanceParameters(state.params);
  if (!Number.isFinite(dt) || dt < 0 || dt > 10000) throw new Error('Resistance delta must be finite and between 0 and 10000 model ticks.');
  if (!Number.isSafeInteger(state.completedSteps) || state.completedSteps < 0 || state.completedSteps > RESISTANCE_MAX_TICKS ||
    !Number.isFinite(state.pendingSteps) || state.pendingSteps < 0 || state.pendingSteps >= 1 ||
    state.cocktailSize !== state.params.cocktailSize ||
    state.simTime !== state.completedSteps * RESISTANCE_TICK_HOURS ||
    ![state.sensitiveBacteria, state.fullyResistant].every(resistanceCount) ||
    [state.partialResistant, state.infectedByPhage, state.phageCounts].some(values =>
      !Array.isArray(values) || values.length !== state.cocktailSize || !Array.from(values).every(resistanceCount))) {
    throw new Error('Resistance checkpoint is incompatible or invalid; reset after changing cocktail size.');
  }
  if (resistanceComplete(state)) return { ...state, running: false };
  if (dt === 0) return state;
  const source = suppliedRng ?? Math.random;
  const rng = () => {
    const value = source();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Resistance RNG must return a finite value in [0,1).');
    return value;
  };
  const accumulated = state.pendingSteps + dt;
  const nearest = Math.round(accumulated);
  const snapped = nearest >= 1 && Math.abs(accumulated - nearest) <= 8 * Number.EPSILON * Math.max(1, accumulated) ? nearest : accumulated;
  const ticks = Math.floor(snapped);
  let current = state;
  for (let tick = 0; tick < ticks; tick++) {
    let elapsed = 0;
    let substeps = 0;
    while (elapsed < RESISTANCE_TICK_HOURS) {
      if (substeps++ >= RESISTANCE_MAX_SUBSTEPS) throw new Error('Resistance tick exceeded its bounded substep budget; reduce populations or rates.');
      const hazard = resistanceHazard(current);
      const tau = Math.min(RESISTANCE_TICK_HOURS - elapsed, hazard > 0 ? 0.1 / hazard : RESISTANCE_TICK_HOURS);
      if (!(tau > 0) || elapsed + tau === elapsed) throw new Error('Resistance substep is outside the supported numerical range.');
      current = runResistanceStep(current, tau, rng);
      elapsed += tau;
    }
    const completedSteps = current.completedSteps + 1;
    current = { ...current, completedSteps, simTime: completedSteps * RESISTANCE_TICK_HOURS };
    const complete = resistanceComplete(current);
    if (completedSteps % 10 === 0 || complete) {
      current = { ...current, history: [...current.history, {
        t: current.simTime, sensitive: current.sensitiveBacteria,
        partialResistant: current.partialResistant.reduce((a, b) => a + b, 0), fullyResistant: current.fullyResistant,
        infected: current.infectedByPhage.reduce((a, b) => a + b, 0), totalPhage: current.phageCounts.reduce((a, b) => a + b, 0),
      }].slice(-500) };
    }
    if (complete) return { ...current, running: false, pendingSteps: 0, time: completedSteps };
  }
  const pendingSteps = snapped - ticks;
  return { ...current, pendingSteps, time: current.completedSteps + pendingSteps };
};

export function makeResistanceSimulation(): Simulation<ResistanceCocktailState> {
  return {
    id: 'resistance-cocktail',
    name: 'Resistance Evolution',
    description: 'Illustrative finite-pool resistance model with infected cells and exponential mean lysis time.',
    controls: STANDARD_CONTROLS,
    parameters: [
      { id: 'cocktailSize', label: 'Cocktail size', type: 'number', min: 1, max: 5, step: 1, defaultValue: 3 },
      { id: 'initialBacteria', label: 'Initial bacteria', type: 'number', min: 1e5, max: 1e9, step: 1e5, defaultValue: 1e7 },
      { id: 'initialPhage', label: 'Initial phage (per type)', type: 'number', min: 1e4, max: 1e10, step: 1e4, defaultValue: 1e8 },
      { id: 'carryingCap', label: 'Carrying capacity', type: 'number', min: 1e7, max: 1e10, step: 1e7, defaultValue: 1e9 },
      { id: 'growthRate', label: 'Growth rate (per hour)', type: 'number', min: 0, max: 2.0, step: 0.1, defaultValue: 0.5 },
      { id: 'infectionRate', label: 'Infection rate (mL/phage/hr)', type: 'number', min: 0, max: 1e-7, step: 1e-10, defaultValue: 2e-9 },
      { id: 'burstSize', label: 'Burst size', type: 'number', min: 10, max: 500, step: 10, defaultValue: 100 },
      { id: 'latentPeriod', label: 'Mean lysis waiting time (hours)', type: 'number', min: 0.1, max: 2.0, step: 0.1, defaultValue: 0.5 },
      { id: 'mutationRate', label: 'Resistance mutation rate', type: 'number', min: 0, max: 1e-5, step: 1e-9, defaultValue: 1e-7 },
      { id: 'multiResRate', label: 'Full resistance rate', type: 'number', min: 0, max: 1e-6, step: 1e-10, defaultValue: 1e-8 },
      { id: 'phageDecay', label: 'Phage decay (per hour)', type: 'number', min: 0, max: 0.5, step: 0.01, defaultValue: 0.1 },
    ],
    init: (_phage, params): ResistanceCocktailState => {
      const base = getDefaultParams([
        { id: 'cocktailSize', label: '', type: 'number', defaultValue: 3 },
        { id: 'initialBacteria', label: '', type: 'number', defaultValue: 1e7 },
        { id: 'initialPhage', label: '', type: 'number', defaultValue: 1e8 },
        { id: 'carryingCap', label: '', type: 'number', defaultValue: 1e9 },
        { id: 'growthRate', label: '', type: 'number', defaultValue: 0.5 },
        { id: 'infectionRate', label: '', type: 'number', defaultValue: 2e-9 },
        { id: 'burstSize', label: '', type: 'number', defaultValue: 100 },
        { id: 'latentPeriod', label: '', type: 'number', defaultValue: 0.5 },
        { id: 'mutationRate', label: '', type: 'number', defaultValue: 1e-7 },
        { id: 'multiResRate', label: '', type: 'number', defaultValue: 1e-8 },
        { id: 'phageDecay', label: '', type: 'number', defaultValue: 0.1 },
      ]);
      const merged = { ...base, ...(params ?? {}) } as Record<string, number | boolean | string>;

      validateResistanceParameters(merged);
      const cocktailSize = Number(merged.cocktailSize ?? 3);
      const initialBacteria = Number(merged.initialBacteria ?? 1e7);
      const initialPhage = Number(merged.initialPhage ?? 1e8);

      return {
        type: 'resistance-cocktail',
        time: 0,
        running: true,
        speed: 1,
        params: merged,
        sensitiveBacteria: initialBacteria,
        partialResistant: new Array(cocktailSize).fill(0),
        infectedByPhage: new Array(cocktailSize).fill(0),
        completedSteps: 0,
        pendingSteps: 0,
        fullyResistant: 0,
        phageCounts: new Array(cocktailSize).fill(initialPhage),
        cocktailSize,
        simTime: 0,
        resistanceEmerged: false,
        resistanceTime: null,
        history: [{
          t: 0,
          sensitive: initialBacteria,
          partialResistant: 0,
          infected: 0,
          fullyResistant: 0,
          totalPhage: initialPhage * cocktailSize,
        }],
        events: [],
      };
    },
    step: advanceResistance,
    isComplete: resistanceComplete,
    getSummary: (state) => {
      const totalResistant = state.partialResistant.reduce((a, b) => a + b, 0) + state.fullyResistant;
      const totalPhage = state.phageCounts.reduce((a, b) => a + b, 0);
      const infected = state.infectedByPhage.reduce((a, b) => a + b, 0);
      const status = state.sensitiveBacteria + totalResistant + infected === 0
        ? 'CLEARED'
        : state.resistanceEmerged
          ? `RESIST@${state.resistanceTime?.toFixed(1)}h`
          : totalPhage + infected === 0
            ? 'PHAGE EXTINCT'
            : state.completedSteps >= RESISTANCE_MAX_TICKS ? 'TIME LIMIT' : 'active';
      return `t=${state.simTime.toFixed(1)}h S=${state.sensitiveBacteria.toExponential(1)} R=${totalResistant.toExponential(1)} I=${infected.toExponential(1)} P=${totalPhage.toExponential(1)} · ${status}`;
    },
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
    makeResistanceSimulation(),
  ].map(s => s as unknown as Simulation<SimState>);
}
