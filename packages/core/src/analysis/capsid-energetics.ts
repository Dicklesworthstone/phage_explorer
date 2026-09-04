/**
 * capsid-energetics.ts
 *
 * Roadmap #32: Capsid Packaging & Ejection Energetics Simulator
 *
 * Simulates the complete biophysical thermodynamics of DNA packaging and ejection:
 * 1. Worm-Like Chain (WLC) model for DNA elasticity under high confinement.
 * 2. Three competing free energy components:
 *    - Bending energy in concentric inverse-spool geometries
 *    - Entropic confinement free energy in the Odijk regime
 *    - Electrostatic phosphate backbone repulsion using Debye-Hückel screening
 *      (modulated by ionic strength and divalent Mg2+ cations).
 * 3. Pressure calculations (reaching 30-60 atm inside the capsid).
 * 4. Force-extension curves across packaging fill fraction.
 * 5. Time-resolved ejection dynamics into host cytoplasm against counter-osmotic pressure.
 * 6. Viability and capsid burst pressure limits.
 */

import type { PhageFull } from '../types';

export type CapsidMorphology = 'icosahedral' | 'prolate' | 'filamentous';
export type PackagingStrategy = 'headful' | 'cos-site' | 'pac-site' | 'protein-primed';

/**
 * Physical constants for polymer and capsid biophysics
 */
export const CONSTANTS = {
  k_B: 1.380649e-23,        // Boltzmann constant (J/K)
  T_ref: 298.15,            // 25 °C reference temperature (K)
  k_BT_pN_nm: 4.114,        // k_B * T at 25°C in pN*nm
  L_p: 50.0,                // dsDNA persistence length in nm (Bustamante et al. 1994)
  DNA_rise_nm: 0.34,        // nm per base pair (B-form DNA)
  DNA_radius_nm: 1.0,       // Effective duplex radius (nm)
  charge_per_bp: -2.0,      // Formal phosphate charges per bp
  F0_repulsion: 380.84,     // Interstrand repulsion amplitude in pN/nm^2
  atm_per_pN_per_nm2: 9.8692e-2, // 1 pN/nm^2 = 1 MPa = 9.8692 atm
  k_BT_per_nm3_to_atm: 40.61, // 1 k_BT/nm^3 = 4.114 pN/nm^2 = 40.61 atm
};

export interface CapsidGeometry {
  name: string;
  innerRadius: number;       // nm
  portalRadius: number;      // nm
  volume: number;            // nm^3
  morphology: CapsidMorphology;
  burstPressureThresholdAtm: number; // Maximum sustainable pressure
}

export interface MotorProperties {
  name: string;
  stallForce: number;        // pN (e.g. 50-65 pN)
  velocity: number;          // bp/s at zero load
  atpPerBp: number;          // ATP molecules per bp packaged (e.g. 0.5)
  stepSize: number;          // bp per power stroke (e.g. 2.0)
  efficiency: number;        // Mechanical efficiency fraction (0.25 - 0.50)
}

export const CANONICAL_CAPSIDS: Record<string, CapsidGeometry> = {
  T4: {
    name: 'T4 (prolate)',
    innerRadius: 43,
    portalRadius: 3.5,
    volume: 333000,
    morphology: 'prolate',
    burstPressureThresholdAtm: 85,
  },
  Lambda: {
    name: 'Lambda (icosahedral)',
    innerRadius: 29,
    portalRadius: 3.0,
    volume: 102000,
    morphology: 'icosahedral',
    burstPressureThresholdAtm: 65,
  },
  T7: {
    name: 'T7 (icosahedral)',
    innerRadius: 28,
    portalRadius: 3.2,
    volume: 92000,
    morphology: 'icosahedral',
    burstPressureThresholdAtm: 60,
  },
  Phi29: {
    name: 'Phi29 (prolate)',
    innerRadius: 21,
    portalRadius: 1.8,
    volume: 38800,
    morphology: 'prolate',
    burstPressureThresholdAtm: 75,
  },
  PhiX174: {
    name: 'PhiX174 (icosahedral)',
    innerRadius: 13,
    portalRadius: 2.0,
    volume: 9200,
    morphology: 'icosahedral',
    burstPressureThresholdAtm: 50,
  },
};

export const CANONICAL_MOTORS: Record<string, MotorProperties> = {
  'T4-terminase': {
    name: 'T4 gp17 Packaging Motor',
    stallForce: 60,
    velocity: 700,
    atpPerBp: 0.5,
    stepSize: 2.0,
    efficiency: 0.40,
  },
  'Lambda-terminase': {
    name: 'Lambda TerL Motor',
    stallForce: 52,
    velocity: 600,
    atpPerBp: 0.5,
    stepSize: 2.0,
    efficiency: 0.35,
  },
  'Phi29-portal': {
    name: 'Phi29 Connector Motor',
    stallForce: 57,
    velocity: 120,
    atpPerBp: 0.25,
    stepSize: 2.5,
    efficiency: 0.50,
  },
  'T7-terminase': {
    name: 'T7 gp19 Motor',
    stallForce: 55,
    velocity: 500,
    atpPerBp: 0.5,
    stepSize: 2.0,
    efficiency: 0.38,
  },
};

export interface ForceStep {
  fillFraction: number; // 0..1
  packedBp: number;
  forcePn: number;
  pressureAtm: number;
  totalEnergyKbt: number;
  bendingEnergyKbt: number;
  confinementEnergyKbt: number;
  electrostaticEnergyKbt: number;
}

export interface EjectionTrajectoryStep {
  timeMs: number;
  fractionEjected: number;
  bpEjected: number;
  velocityBpPerSec: number;
  internalPressureAtm: number;
  counterOsmoticPressureAtm: number;
  netDrivingPressureAtm: number;
}

export interface PackagingEnergeticsOptions {
  ionicStrengthM?: number;    // Monovalent salt (mol/L), default 0.15
  magnesiumMm?: number;       // Divalent Mg2+ (mmol/L), default 10.0
  temperatureK?: number;      // Absolute temperature (K), default 298.15
  capsidOverride?: CapsidGeometry;
  motorOverride?: MotorProperties;
  targetOsmoticAtm?: number;  // Cytoplasmic counter-pressure (atm), default 3.5
}

export interface CapsidPackagingEnergetics {
  phageId: number;
  phageName: string;
  genomeLengthBp: number;
  capsid: CapsidGeometry;
  motor: MotorProperties;
  strategy: PackagingStrategy;
  ionicStrengthM: number;
  magnesiumMm: number;
  temperatureK: number;

  // Energetics at 100% full packaging (k_BT units)
  bendingEnergyKbt: number;
  confinementEntropyKbt: number;
  electrostaticRepulsionKbt: number;
  totalFreeEnergyKbt: number;

  // Physical quantities at full packaging
  internalPressureAtm: number;
  fillFraction: number;
  dnaPackingDensityMgMl: number;
  interhelixDistanceNm: number;
  debyeLengthNm: number;

  // Motor work & ATP
  totalMotorWorkKbt: number;
  atpRequired: number;
  packagingTimeSec: number;
  stallLimitReached: boolean;

  // Viability & burst limits
  burstPressureThresholdAtm: number;
  isViable: boolean;
  stabilityScore: number; // 0..100
  viabilitySummary: string;

  // Trajectories
  forceCurve: ForceStep[];
  ejectionTrajectory: EjectionTrajectoryStep[];
  ejectionDurationMs: number;
  ejectionInitialVelocityBpPerSec: number;

  summary: string;
}

/**
 * Calculate effective Debye screening length / interaction decay parameter
 * including divalent Mg2+ screening. In the dense DNA regime (d < 3 nm),
 * Manning counterion condensation and divalent Mg2+ cations govern the decay
 * length c (Rau & Parsegian 1992, Purohit et al. 2005):
 * Baseline ~0.60 nm at pure monovalent low salt, decreasing to ~0.47-0.51 nm in 10-20 mM Mg2+.
 */
export function calculateEffectiveDebyeLength(
  monovalentM: number,
  magnesiumMm: number
): number {
  const mgFactor = Math.min(1.0, Math.max(0, magnesiumMm) / 15.0);
  const saltFactor = Math.min(1.0, Math.max(0, monovalentM) / 0.3);
  const c = 0.60 - 0.11 * mgFactor - 0.04 * saltFactor;
  return Math.round(c * 1000) / 1000;
}

/**
 * Interaxial spacing in hexagonally packed spool
 */
export function calculateInteraxialSpacing(
  packedLengthNm: number,
  volumeNm3: number
): number {
  if (packedLengthNm <= 0 || volumeNm3 <= 0) return 10.0;
  // Volume of hexagonal prism: (sqrt(3)/2) * d^2 * L = V
  const d = Math.sqrt((2 * volumeNm3) / (Math.sqrt(3) * packedLengthNm));
  return Math.round(d * 100) / 100;
}

/**
 * Estimate or choose capsid geometry matching phage genome length and morphology
 */
export function estimateCapsidGeometry(
  genomeLengthBp: number,
  morphology?: string | null,
  phageName?: string | null
): CapsidGeometry {
  const normName = (phageName ?? '').toLowerCase();
  if (normName.includes('t4')) return CANONICAL_CAPSIDS.T4;
  if (normName.includes('lambda')) return CANONICAL_CAPSIDS.Lambda;
  if (normName.includes('t7')) return CANONICAL_CAPSIDS.T7;
  if (normName.includes('phi29') || normName.includes('φ29')) return CANONICAL_CAPSIDS.Phi29;
  if (normName.includes('phix174') || normName.includes('φx174')) return CANONICAL_CAPSIDS.PhiX174;

  const isProlate = (morphology ?? '').toLowerCase().includes('prolate') || genomeLengthBp > 120000;
  // Empirical capsid volume scaling: ~2.1 nm^3 per base pair (typical for tailed phages)
  const volume = Math.max(8000, genomeLengthBp * 2.15);
  const radius = Math.cbrt((3 * volume) / (4 * Math.PI));

  return {
    name: isProlate ? 'Scaled Prolate Capsid' : 'Scaled Icosahedral Capsid',
    innerRadius: Math.round(radius * 10) / 10,
    portalRadius: Math.max(1.8, Math.round(radius * 0.1 * 10) / 10),
    volume: Math.round(volume),
    morphology: isProlate ? 'prolate' : 'icosahedral',
    burstPressureThresholdAtm: genomeLengthBp > 100000 ? 80 : 65,
  };
}

/**
 * Infer packaging strategy from genes or genome size
 */
export function inferPackagingStrategy(phage: PhageFull): PackagingStrategy {
  const text = `${phage.name} ${phage.genes.map((g) => `${g.name} ${g.product}`).join(' ')}`.toLowerCase();
  if (text.includes('cos') || text.includes('lambda') || (text.includes('terl') && text.includes('terminase'))) {
    if (text.includes('pac') || text.includes('headful')) return 'headful';
    return 'cos-site';
  }
  if (text.includes('headful') || text.includes('concatemer') || text.includes('gp17') || text.includes('t4')) {
    return 'headful';
  }
  if (text.includes('protein-primed') || text.includes('terminal protein') || text.includes('phi29')) {
    return 'protein-primed';
  }
  if (text.includes('p22') || text.includes('pac')) {
    return 'pac-site';
  }
  return phage.genomeLength && phage.genomeLength > 100000 ? 'headful' : 'cos-site';
}

/**
 * Worm-Like Chain (WLC) Marko-Siggia interpolation formula for force
 */
export function calculateWlcForce(
  extensionNm: number,
  contourLengthNm: number
): number {
  if (contourLengthNm <= 0 || extensionNm <= 0) return 0.0;
  const x = Math.min(0.98, Math.max(0.0, extensionNm / contourLengthNm));

  // Marko-Siggia: F = (k_BT / L_p) * [1 / (4*(1-x)^2) - 1/4 + x]
  const term1 = 1.0 / (4.0 * Math.pow(1.0 - x, 2));
  const term2 = -0.25;
  const term3 = x;

  const force = (CONSTANTS.k_BT_pN_nm / CONSTANTS.L_p) * (term1 + term2 + term3);
  return Math.round(force * 100) / 100;
}

/**
 * Concentric spool bending energy in k_BT units
 */
export function calculateBendingEnergy(
  packedBp: number,
  capsid: CapsidGeometry,
  fillFraction: number
): number {
  if (packedBp <= 0) return 0.0;
  const contourLength = packedBp * CONSTANTS.DNA_rise_nm;

  // Mean radius of concentric spooling shell from outer wall inwards
  const phi = Math.min(1.0, Math.max(0.05, fillFraction));
  const rIn = capsid.innerRadius * Math.cbrt(Math.max(0.01, 1.0 - phi));
  const num = Math.pow(capsid.innerRadius, 4) - Math.pow(rIn, 4);
  const den = Math.pow(capsid.innerRadius, 3) - Math.pow(rIn, 3);
  const avgRadius = den > 0 ? 0.75 * (num / den) : capsid.innerRadius * 0.7;

  // E_bend = (L_p * L) / (2 * R^2) in k_BT units
  const energy = (CONSTANTS.L_p * contourLength) / (2.0 * Math.pow(avgRadius, 2));
  return Math.round(energy * 10) / 10;
}

/**
 * Entropic confinement free energy in the Odijk deflection regime
 */
export function calculateConfinementEntropy(
  packedBp: number,
  capsid: CapsidGeometry,
  fillFraction: number
): number {
  if (packedBp <= 0) return 0.0;
  const contourLength = packedBp * CONSTANTS.DNA_rise_nm;
  const D = capsid.innerRadius * 2.0;

  // Odijk deflection length: lambda_d = (L_p * D^2)^(1/3)
  const deflectionLength = Math.cbrt(CONSTANTS.L_p * Math.pow(D, 2));
  // Entropy loss scaled with fill density
  const baseEntropy = (contourLength / deflectionLength) * 1.1;
  const scaledEntropy = baseEntropy * (1.0 + 1.8 * Math.pow(fillFraction, 1.5));

  return Math.round(scaledEntropy * 10) / 10;
}

/**
 * Debye-Hückel electrostatic repulsion between hexagonally packed duplexes (k_BT units)
 */
export function calculateElectrostaticRepulsion(
  packedBp: number,
  capsid: CapsidGeometry,
  debyeLengthNm: number,
  fillFraction: number
): number {
  if (packedBp <= 0 || fillFraction <= 0) return 0.0;
  const contourLength = packedBp * CONSTANTS.DNA_rise_nm;
  const interhelix = calculateInteraxialSpacing(contourLength, capsid.volume);

  // Screened exponential potential: E_elec = (F0 / k_BT) * exp(-d / lambda_D) * L * phi^2
  const screenedTerm = Math.exp(-interhelix / Math.max(0.1, debyeLengthNm));
  const energy = (CONSTANTS.F0_repulsion / CONSTANTS.k_BT_pN_nm) * screenedTerm * contourLength * Math.pow(fillFraction, 1.4);

  return Math.round(energy * 10) / 10;
}

/**
 * Internal pressure in atmospheres derived from osmotic equation of state (Purohit et al. 2005)
 */
export function calculateInternalPressureAtm(
  capsid: CapsidGeometry,
  packedBp: number,
  debyeLengthNm: number,
  fillFraction: number
): number {
  if (packedBp <= 0 || fillFraction <= 0) return 0.0;
  const contourLength = packedBp * CONSTANTS.DNA_rise_nm;
  const dH = calculateInteraxialSpacing(contourLength, capsid.volume);
  const c = Math.max(0.1, debyeLengthNm);

  // Electrostatic osmotic pressure (Parsegian/Purohit relation):
  // P_elec = F0_atm * (c / dH + 1) * exp(-dH / c)
  const F0_atm = CONSTANTS.F0_repulsion * CONSTANTS.atm_per_pN_per_nm2 * 100; // 3758.6 atm
  const pElec = F0_atm * (c / dH + 1.0) * Math.exp(-dH / c);

  // Bending pressure component:
  // P_bend = (k_BT * L_p) / (4 * pi * R_capsid^2 * dH^2) converted to atm
  const pBendKbtNm3 = (CONSTANTS.L_p) / (4 * Math.PI * Math.pow(capsid.innerRadius, 2) * Math.pow(dH, 2));
  const pBendAtm = pBendKbtNm3 * CONSTANTS.k_BT_per_nm3_to_atm;

  // Confinement entropic pressure:
  const pConfAtm = 1.8 * Math.pow(fillFraction, 2.5);

  const totalPressure = Math.min(250, pElec + pBendAtm + pConfAtm);
  return Math.round(totalPressure * 10) / 10;
}

/**
 * Time-resolved ejection trajectory simulation
 */
export function simulateEjectionTrajectory(
  initialPressureAtm: number,
  portalRadiusNm: number,
  genomeLengthBp: number,
  counterOsmoticAtm: number = 3.5,
  steps: number = 30
): EjectionTrajectoryStep[] {
  const trajectory: EjectionTrajectoryStep[] = [];
  const estimatedDurationMs = Math.max(600, Math.round((genomeLengthBp / 20000) * 1000));
  const dtMs = Math.max(15, Math.round(estimatedDurationMs / steps));

  let fractionEjected = 0.0;
  let currentPressure = Math.max(0.0, initialPressureAtm);

  for (let i = 0; i <= steps; i++) {
    const timeMs = i * dtMs;
    const netPressure = Math.max(0.0, currentPressure - counterOsmoticAtm);

    // Initial ejection velocity scales with net driving pressure
    // In vitro single-molecule experiments observe ~20,000 to 60,000 bp/s initially
    const velocityBpPerSec = Math.round(netPressure * 750);
    const bpEjected = Math.round(fractionEjected * genomeLengthBp);

    trajectory.push({
      timeMs,
      fractionEjected: Math.round(fractionEjected * 1000) / 1000,
      bpEjected,
      velocityBpPerSec,
      internalPressureAtm: Math.round(currentPressure * 10) / 10,
      counterOsmoticPressureAtm: counterOsmoticAtm,
      netDrivingPressureAtm: Math.round(netPressure * 10) / 10,
    });

    if (fractionEjected >= 0.999 || netPressure <= 0.01) {
      break;
    }

    // Advance fraction ejected
    const bpThisStep = (velocityBpPerSec * dtMs) / 1000;
    fractionEjected = Math.min(1.0, fractionEjected + bpThisStep / Math.max(1, genomeLengthBp));

    // Internal pressure relaxes quadratically as genome unspools
    currentPressure = initialPressureAtm * Math.pow(1.0 - fractionEjected, 2.2);
  }

  return trajectory;
}

/**
 * Generate full force-extension packaging curve
 */
export function generateForceCurve(
  genomeLengthBp: number,
  capsid: CapsidGeometry,
  motor: MotorProperties,
  debyeLengthNm: number,
  steps: number = 20
): ForceStep[] {
  const curve: ForceStep[] = [];

  for (let i = 0; i <= steps; i++) {
    const fill = i / steps;
    const packedBp = Math.round(genomeLengthBp * fill);

    const bending = calculateBendingEnergy(packedBp, capsid, fill);
    const confinement = calculateConfinementEntropy(packedBp, capsid, fill);
    const electrostatic = calculateElectrostaticRepulsion(packedBp, capsid, debyeLengthNm, fill);
    const totalEnergy = Math.round((bending + confinement + electrostatic) * 10) / 10;

    const pressure = calculateInternalPressureAtm(capsid, packedBp, debyeLengthNm, fill);

    // Force from pressure against DNA portal cross-section (effective area ~6.8 nm^2)
    // 1 atm = 0.0001013 pN/nm^2
    const effectiveDnaAreaNm2 = 6.8;
    const pressureForcePn = pressure * (1.0 / CONSTANTS.atm_per_pN_per_nm2) * 0.01 * effectiveDnaAreaNm2;
    const wlcTerm = calculateWlcForce(packedBp * CONSTANTS.DNA_rise_nm, genomeLengthBp * CONSTANTS.DNA_rise_nm);

    let forcePn = Math.max(1.5, pressureForcePn + wlcTerm * 0.05);
    // Motor stall limit clamp
    if (forcePn > motor.stallForce) {
      forcePn = motor.stallForce + (forcePn - motor.stallForce) * 0.05;
    }

    curve.push({
      fillFraction: Math.round(fill * 100) / 100,
      packedBp,
      forcePn: Math.round(forcePn * 10) / 10,
      pressureAtm: pressure,
      totalEnergyKbt: totalEnergy,
      bendingEnergyKbt: bending,
      confinementEnergyKbt: confinement,
      electrostaticEnergyKbt: electrostatic,
    });
  }

  return curve;
}


/**
 * Comprehensive Capsid Packaging & Ejection Energetics Analysis
 */
export function analyzeCapsidPackagingEnergetics(
  phage: PhageFull,
  options: PackagingEnergeticsOptions = {}
): CapsidPackagingEnergetics {
  const genomeLengthBp = phage.genomeLength ?? 48502;
  const ionicStrengthM = options.ionicStrengthM ?? 0.15;
  const magnesiumMm = options.magnesiumMm ?? 10.0;
  const temperatureK = options.temperatureK ?? 298.15;

  const capsid = options.capsidOverride ?? estimateCapsidGeometry(genomeLengthBp, phage.morphology, phage.name);
  const motor = options.motorOverride ?? CANONICAL_MOTORS['Lambda-terminase'];
  const strategy = inferPackagingStrategy(phage);

  const debyeLengthNm = calculateEffectiveDebyeLength(ionicStrengthM, magnesiumMm);

  // Geometric fill fraction: DNA cylinder volume / capsid volume
  const dnaVolumeNm3 = Math.PI * Math.pow(CONSTANTS.DNA_radius_nm, 2) * (genomeLengthBp * CONSTANTS.DNA_rise_nm);
  const fillFraction = Math.min(0.65, Math.round((dnaVolumeNm3 / capsid.volume) * 1000) / 1000);

  // DNA packing density in mg/mL (1 Dalton/nm^3 = 1.66 mg/mL)
  const dnaMassDaltons = genomeLengthBp * 660; // 660 Da per bp
  const dnaPackingDensityMgMl = Math.round((dnaMassDaltons / (capsid.volume * 1e-21 * 6.022e23)) * 1000);

  const interhelixDistanceNm = calculateInteraxialSpacing(genomeLengthBp * CONSTANTS.DNA_rise_nm, capsid.volume);

  // 100% full packaging energy components
  const bendingEnergyKbt = calculateBendingEnergy(genomeLengthBp, capsid, fillFraction);
  const confinementEntropyKbt = calculateConfinementEntropy(genomeLengthBp, capsid, fillFraction);
  const electrostaticRepulsionKbt = calculateElectrostaticRepulsion(genomeLengthBp, capsid, debyeLengthNm, fillFraction);
  const totalFreeEnergyKbt = Math.round((bendingEnergyKbt + confinementEntropyKbt + electrostaticRepulsionKbt) * 10) / 10;

  const internalPressureAtm = calculateInternalPressureAtm(capsid, genomeLengthBp, debyeLengthNm, fillFraction);

  // Motor work & ATP
  const totalMotorWorkKbt = Math.round(totalFreeEnergyKbt / motor.efficiency);
  const atpRequired = Math.round(genomeLengthBp * motor.atpPerBp);
  const packagingTimeSec = Math.round((genomeLengthBp / motor.velocity) * 10) / 10;

  // Force curve & ejection trajectory
  const forceCurve = generateForceCurve(genomeLengthBp, capsid, motor, debyeLengthNm, 20);
  const finalForce = forceCurve[forceCurve.length - 1]?.forcePn ?? 50;
  const stallLimitReached = finalForce >= motor.stallForce;

  const counterOsmoticAtm = options.targetOsmoticAtm ?? 3.5;
  const ejectionTrajectory = simulateEjectionTrajectory(internalPressureAtm, capsid.portalRadius, genomeLengthBp, counterOsmoticAtm, 25);
  const ejectionDurationMs = ejectionTrajectory[ejectionTrajectory.length - 1]?.timeMs ?? 300;
  const ejectionInitialVelocityBpPerSec = ejectionTrajectory[0]?.velocityBpPerSec ?? 20000;

  // Viability & Stability scoring
  const burstPressureThresholdAtm = capsid.burstPressureThresholdAtm;
  const pressureRatio = internalPressureAtm / burstPressureThresholdAtm;
  const isViable = pressureRatio <= 1.0 && !stallLimitReached;

  let stabilityScore = 85;
  if (pressureRatio > 0.85) stabilityScore -= 30;
  else if (pressureRatio > 0.70) stabilityScore -= 15;
  if (fillFraction > 0.50) stabilityScore -= 20;
  if (magnesiumMm < 2.0) stabilityScore -= 15; // Low magnesium increases electrostatic repulsion
  stabilityScore = Math.max(10, Math.min(98, stabilityScore));

  let viabilitySummary = 'Viable wild-type packaging parameters.';
  if (pressureRatio > 1.0) {
    viabilitySummary = `Exceeds capsid tensile burst pressure (${internalPressureAtm.toFixed(1)} atm > ${burstPressureThresholdAtm} atm limit). Genome will rupture capsid.`;
  } else if (stallLimitReached) {
    viabilitySummary = `Exceeds motor stall force limit (${finalForce.toFixed(1)} pN >= ${motor.stallForce} pN). Packaging will abort prematurely.`;
  } else if (stabilityScore < 60) {
    viabilitySummary = 'High packaging tension; vulnerable to heat and osmotic shock during storage.';
  }

  const summary =
    `Capsid Packaging Energetics for ${phage.name}: ` +
    `Internal pressure reaches ${internalPressureAtm.toFixed(1)} atm at ${(fillFraction * 100).toFixed(1)}% fill ` +
    `(Bending: ${bendingEnergyKbt} k_BT, Confinement: ${confinementEntropyKbt} k_BT, Electrostatic: ${electrostaticRepulsionKbt} k_BT). ` +
    `Motor consumes ~${atpRequired.toLocaleString()} ATP over ${packagingTimeSec}s. ` +
    `Ejection delivers initial velocity of ${ejectionInitialVelocityBpPerSec.toLocaleString()} bp/s into host cytoplasm.`;

  return {
    phageId: phage.id,
    phageName: phage.name,
    genomeLengthBp,
    capsid,
    motor,
    strategy,
    ionicStrengthM,
    magnesiumMm,
    temperatureK,
    bendingEnergyKbt,
    confinementEntropyKbt,
    electrostaticRepulsionKbt,
    totalFreeEnergyKbt,
    internalPressureAtm,
    fillFraction,
    dnaPackingDensityMgMl,
    interhelixDistanceNm,
    debyeLengthNm,
    totalMotorWorkKbt,
    atpRequired,
    packagingTimeSec,
    stallLimitReached,
    burstPressureThresholdAtm,
    isViable,
    stabilityScore,
    viabilitySummary,
    forceCurve,
    ejectionTrajectory,
    ejectionDurationMs,
    ejectionInitialVelocityBpPerSec,
    summary,
  };
}
