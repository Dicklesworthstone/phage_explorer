import { describe, it, expect } from 'bun:test';
import {
  calculateEffectiveDebyeLength,
  calculateInteraxialSpacing,
  estimateCapsidGeometry,
  inferPackagingStrategy,
  calculateWlcForce,
  calculateBendingEnergy,
  calculateConfinementEntropy,
  calculateElectrostaticRepulsion,
  calculateInternalPressureAtm,
  simulateEjectionTrajectory,
  generateForceCurve,
  analyzeCapsidPackagingEnergetics,
  CANONICAL_CAPSIDS,
  CANONICAL_MOTORS,
} from './capsid-energetics';
import type { PhageFull } from '../types';

function createMockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 1,
    slug: 'enterobacteria-phage-lambda',
    name: 'Enterobacteria phage lambda',
    accession: 'NC_001416',
    family: 'Siphoviridae',
    host: 'Escherichia coli',
    genomeLength: 48502,
    gcContent: 49.9,
    morphology: 'siphovirus',
    lifecycle: 'temperate',
    description: null,
    baltimoreGroup: null,
    genomeType: 'dsDNA',
    pdbIds: [],
    genes: [],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('capsid-energetics', () => {
  describe('Debye length and electrostatic screening', () => {
    it('calculates effective Debye length with monovalent salt and Mg2+', () => {
      // 0.15 M monovalent, 0 Mg2+ -> baseline ~0.58 nm
      const debye0Mg = calculateEffectiveDebyeLength(0.15, 0.0);
      expect(debye0Mg).toBeGreaterThan(0.55);
      expect(debye0Mg).toBeLessThan(0.62);

      // Adding 10 mM Mg2+ enhances screening -> shorter decay length ~0.50 nm
      const debye10Mg = calculateEffectiveDebyeLength(0.15, 10.0);
      expect(debye10Mg).toBeLessThan(debye0Mg);
      expect(debye10Mg).toBeGreaterThan(0.48);
      expect(debye10Mg).toBeLessThan(0.54);
    });

    it('handles zero or boundary ionic strength gracefully', () => {
      const debyeNearZero = calculateEffectiveDebyeLength(0, 0);
      expect(debyeNearZero).toBeGreaterThan(0);
      expect(Number.isFinite(debyeNearZero)).toBe(true);
    });
  });

  describe('Capsid Geometry and Packaging Strategy', () => {
    it('selects canonical capsids when phage name matches', () => {
      const t4 = estimateCapsidGeometry(168903, 'prolate', 'Enterobacteria phage T4');
      expect(t4.name).toBe(CANONICAL_CAPSIDS.T4.name);
      expect(t4.morphology).toBe('prolate');
      expect(t4.volume).toBe(333000);

      const lambda = estimateCapsidGeometry(48502, 'icosahedral', 'Escherichia phage Lambda');
      expect(lambda.name).toBe(CANONICAL_CAPSIDS.Lambda.name);
      expect(lambda.burstPressureThresholdAtm).toBe(65);

      const phi29 = estimateCapsidGeometry(19285, 'prolate', 'Bacillus virus phi29');
      expect(phi29.name).toBe(CANONICAL_CAPSIDS.Phi29.name);
    });

    it('scales custom capsid geometry based on genome size for novel phages', () => {
      const novelSmall = estimateCapsidGeometry(30000, 'icosahedral', 'Novel Phage Alpha');
      const novelLarge = estimateCapsidGeometry(150000, 'prolate', 'Novel Jumbo Phage Beta');

      expect(novelLarge.volume).toBeGreaterThan(novelSmall.volume);
      expect(novelLarge.innerRadius).toBeGreaterThan(novelSmall.innerRadius);
      expect(novelLarge.morphology).toBe('prolate');
    });

    it('infers packaging strategy correctly', () => {
      const mockLambda = createMockPhage({
        id: 1,
        accession: 'NC_001416',
        name: 'Enterobacteria phage lambda',
        genomeLength: 48502,
        gcContent: 0.5,
        genes: [{ id: 101, name: 'terL', locusTag: 'LAM_01', startPos: 100, endPos: 1500, strand: '+', product: 'terminase large subunit cos cleavage', type: 'CDS' }],
      });
      expect(inferPackagingStrategy(mockLambda)).toBe('cos-site');

      const mockT4 = createMockPhage({
        id: 2,
        accession: 'NC_000866',
        name: 'Enterobacteria phage T4',
        genomeLength: 168903,
        gcContent: 0.35,
        genes: [{ id: 201, name: 'gp17', locusTag: 'T4_017', startPos: 500, endPos: 2500, strand: '+', product: 'terminase large subunit headful packaging', type: 'CDS' }],
      });
      expect(inferPackagingStrategy(mockT4)).toBe('headful');

      const mockPhi29 = createMockPhage({
        id: 3,
        accession: 'NC_011048',
        name: 'Bacillus phage phi29',
        genomeLength: 19285,
        gcContent: 0.40,
        genes: [{ id: 301, name: 'gp3', locusTag: 'P29_03', startPos: 10, endPos: 800, strand: '+', product: 'terminal protein primed replication', type: 'CDS' }],
      });
      expect(inferPackagingStrategy(mockPhi29)).toBe('protein-primed');
    });
  });

  describe('Thermodynamic Energy Models & Force-Extension', () => {
    it('calculates WLC force conforming to Marko-Siggia interpolation', () => {
      const zeroForce = calculateWlcForce(0, 1000);
      expect(zeroForce).toBe(0);

      const moderateForce = calculateWlcForce(500, 1000); // 50% extension
      expect(moderateForce).toBeGreaterThan(0.05);
      expect(moderateForce).toBeLessThan(1.0);

      const highForce = calculateWlcForce(950, 1000); // 95% extension
      expect(highForce).toBeGreaterThan(moderateForce);
    });

    it('calculates interaxial spacing as packing density increases', () => {
      const spacingLow = calculateInteraxialSpacing(5000, 100000);
      const spacingHigh = calculateInteraxialSpacing(20000, 100000);
      expect(spacingHigh).toBeLessThan(spacingLow);
      expect(spacingHigh).toBeGreaterThan(1.5); // Still physically plausible
    });

    it('computes bending, confinement, and electrostatic energies with fill fraction', () => {
      const capsid = CANONICAL_CAPSIDS.Lambda;
      const bend = calculateBendingEnergy(48502, capsid, 0.45);
      const conf = calculateConfinementEntropy(48502, capsid, 0.45);
      const elec = calculateElectrostaticRepulsion(48502, capsid, 0.75, 0.45);

      expect(bend).toBeGreaterThan(100);
      expect(conf).toBeGreaterThan(100);
      expect(elec).toBeGreaterThan(100);

      const pressure = calculateInternalPressureAtm(capsid, 48502, 0.55, 0.45);
      expect(pressure).toBeGreaterThan(10);
      expect(pressure).toBeLessThan(80);
    });

    it('generates monotonic force curves up to motor stall force limit', () => {
      const capsid = CANONICAL_CAPSIDS.Lambda;
      const motor = CANONICAL_MOTORS['Lambda-terminase'];
      const curve = generateForceCurve(48502, capsid, motor, 0.75, 10);

      expect(curve.length).toBe(11);
      expect(curve[0].fillFraction).toBe(0);
      expect(curve[curve.length - 1].fillFraction).toBe(1.0);
      expect(curve[curve.length - 1].forcePn).toBeGreaterThan(curve[0].forcePn);
    });
  });

  describe('Ejection Dynamics Simulation', () => {
    it('simulates rapid initial ejection that slows as capsid pressure drops', () => {
      const trajectory = simulateEjectionTrajectory(45.0, 3.0, 48502, 3.5, 25);
      expect(trajectory.length).toBeGreaterThan(1);

      const firstStep = trajectory[0];
      expect(firstStep.timeMs).toBe(0);
      expect(firstStep.velocityBpPerSec).toBeGreaterThan(15000);
      expect(firstStep.internalPressureAtm).toBe(45);

      const laterStep = trajectory[trajectory.length - 1];
      expect(laterStep.fractionEjected).toBeGreaterThan(firstStep.fractionEjected);
      expect(laterStep.internalPressureAtm).toBeLessThan(firstStep.internalPressureAtm);
    });
  });

  describe('analyzeCapsidPackagingEnergetics integration', () => {
    it('produces biophysically realistic metrics for Phage Lambda', () => {
      const lambdaPhage = createMockPhage({
        id: 42,
        accession: 'NC_001416',
        name: 'Enterobacteria phage lambda',
        genomeLength: 48502,
        gcContent: 0.499,
        morphology: 'icosahedral',
        genes: [
          { id: 421, name: 'terL', locusTag: 'LAM_01', startPos: 100, endPos: 1500, strand: '+', product: 'terminase large subunit', type: 'CDS' },
        ],
      });

      const result = analyzeCapsidPackagingEnergetics(lambdaPhage, {
        ionicStrengthM: 0.15,
        magnesiumMm: 10.0,
      });

      expect(result.phageName).toBe('Enterobacteria phage lambda');
      expect(result.fillFraction).toBeGreaterThan(0.35);
      expect(result.fillFraction).toBeLessThan(0.60);
      // Realistic internal pressure: ~20 - 60 atm
      expect(result.internalPressureAtm).toBeGreaterThan(20);
      expect(result.internalPressureAtm).toBeLessThan(65);
      expect(result.isViable).toBe(true);
      expect(result.stabilityScore).toBeGreaterThan(50);
      expect(result.atpRequired).toBeGreaterThan(20000);
      expect(result.forceCurve.length).toBeGreaterThan(10);
      expect(result.ejectionTrajectory.length).toBeGreaterThan(5);
      expect(result.summary).toContain('atm');
    });

    it('detects capsid rupture risk when an oversized genome is packaged into a small capsid', () => {
      const oversizedPhage = createMockPhage({
        id: 99,
        accession: 'NC_TEST',
        name: 'Oversized Mutant Phage',
        genomeLength: 120000,
        morphology: 'icosahedral',
        genes: [],
      });

      // Force Lambda capsid (burst pressure 65 atm, volume 102,000 nm^3)
      const result = analyzeCapsidPackagingEnergetics(oversizedPhage, {
        capsidOverride: CANONICAL_CAPSIDS.Lambda,
      });

      // 120 kb in a 48.5 kb capsid should cause extreme pressure and burst failure
      expect(result.internalPressureAtm).toBeGreaterThan(CANONICAL_CAPSIDS.Lambda.burstPressureThresholdAtm);
      expect(result.isViable).toBe(false);
      expect(result.viabilitySummary).toContain('rupture');
    });
  });
});
