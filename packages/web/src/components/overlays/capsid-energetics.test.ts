import { describe, expect, it } from 'bun:test';
import type { PhageFull } from '@phage-explorer/core';
import {
  analyzeCapsidPackagingEnergetics,
  CANONICAL_CAPSIDS,
  CANONICAL_MOTORS,
} from '@phage-explorer/core';

function createMockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 101,
    slug: 'enterobacteria-phage-t4',
    name: 'Enterobacteria phage T4',
    accession: 'NC_000866',
    family: 'Myoviridae',
    host: 'Escherichia coli',
    genomeLength: 168903,
    gcContent: 35.3,
    morphology: 'prolate',
    lifecycle: 'lytic',
    description: null,
    baltimoreGroup: null,
    genomeType: 'dsDNA',
    pdbIds: [],
    genes: [
      {
        id: 1,
        name: 'gp17',
        locusTag: 'T4_017',
        startPos: 100,
        endPos: 2500,
        strand: '+',
        product: 'terminase large subunit packaging motor',
        type: 'CDS',
      },
    ],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Capsid Packaging & Ejection Energetics (Web Integration)', () => {
  it('analyzes T4 phage packaging energetics with prolate capsid and gp17 motor', () => {
    const phage = createMockPhage();
    const result = analyzeCapsidPackagingEnergetics(phage, {
      ionicStrengthM: 0.15,
      magnesiumMm: 10.0,
      targetOsmoticAtm: 3.5,
    });

    expect(result.phageName).toBe('Enterobacteria phage T4');
    expect(result.capsid.name).toContain('T4');
    expect(result.capsid.morphology).toBe('prolate');
    expect(result.capsid.volume).toBe(333000);
    expect(result.strategy).toBe('headful');

    // Fill fraction should be ~0.45 - 0.55
    expect(result.fillFraction).toBeGreaterThan(0.40);
    expect(result.fillFraction).toBeLessThan(0.60);

    // Pressure should reach ~25 - 45 atm
    expect(result.internalPressureAtm).toBeGreaterThan(20);
    expect(result.internalPressureAtm).toBeLessThan(60);

    // Stability and viability
    expect(result.isViable).toBe(true);
    expect(result.stabilityScore).toBeGreaterThan(50);
    expect(result.burstPressureThresholdAtm).toBe(85);

    // Motor work and ATP
    expect(result.atpRequired).toBeGreaterThan(50000);
    expect(result.totalMotorWorkKbt).toBeGreaterThan(result.totalFreeEnergyKbt);
  });

  it('evaluates buffer condition sensitivity (Mg2+ screening effect)', () => {
    const phage = createMockPhage({ genomeLength: 48502, name: 'Phage Lambda' });

    const lowMg = analyzeCapsidPackagingEnergetics(phage, {
      ionicStrengthM: 0.10,
      magnesiumMm: 0.0,
    });

    const highMg = analyzeCapsidPackagingEnergetics(phage, {
      ionicStrengthM: 0.10,
      magnesiumMm: 20.0,
    });

    // Lower Mg2+ means less screening -> higher electrostatic repulsion -> higher pressure
    expect(lowMg.debyeLengthNm).toBeGreaterThan(highMg.debyeLengthNm);
    expect(lowMg.electrostaticRepulsionKbt).toBeGreaterThan(highMg.electrostaticRepulsionKbt);
    expect(lowMg.internalPressureAtm).toBeGreaterThan(highMg.internalPressureAtm);
  });

  it('computes ejection trajectory matching UI display criteria', () => {
    const phage = createMockPhage();
    const result = analyzeCapsidPackagingEnergetics(phage, {
      targetOsmoticAtm: 3.5,
    });

    expect(result.ejectionTrajectory.length).toBeGreaterThan(5);
    const step0 = result.ejectionTrajectory[0];
    expect(step0.timeMs).toBe(0);
    expect(step0.fractionEjected).toBe(0);
    expect(step0.velocityBpPerSec).toBeGreaterThan(10000);
    expect(step0.netDrivingPressureAtm).toBeGreaterThan(15);

    // Final step should have ejected significant portion before pressure equilibrates
    const stepLast = result.ejectionTrajectory[result.ejectionTrajectory.length - 1];
    expect(stepLast.timeMs).toBeGreaterThan(step0.timeMs);
    expect(stepLast.fractionEjected).toBeGreaterThan(0.35);
    expect(stepLast.netDrivingPressureAtm).toBeLessThan(step0.netDrivingPressureAtm);
  });

  it('supports custom canonical capsid overrides and detects overload failure', () => {
    const phage = createMockPhage({ genomeLength: 170000 });

    // Pack 170 kb into small Phi29 capsid (burst limit 75 atm, volume 38800 nm^3)
    const result = analyzeCapsidPackagingEnergetics(phage, {
      capsidOverride: CANONICAL_CAPSIDS.Phi29,
      motorOverride: CANONICAL_MOTORS['Phi29-portal'],
    });

    expect(result.capsid.name).toContain('Phi29');
    expect(result.internalPressureAtm).toBeGreaterThan(CANONICAL_CAPSIDS.Phi29.burstPressureThresholdAtm);
    expect(result.isViable).toBe(false);
    expect(result.viabilitySummary).toContain('rupture');
  });

  it('generates complete force curve with three energy components for UI table rendering', () => {
    const phage = createMockPhage();
    const result = analyzeCapsidPackagingEnergetics(phage);

    expect(result.forceCurve.length).toBeGreaterThan(15);
    for (const step of result.forceCurve) {
      expect(step.fillFraction).toBeGreaterThanOrEqual(0);
      expect(step.fillFraction).toBeLessThanOrEqual(1);
      expect(step.bendingEnergyKbt).toBeGreaterThanOrEqual(0);
      expect(step.confinementEnergyKbt).toBeGreaterThanOrEqual(0);
      expect(step.electrostaticEnergyKbt).toBeGreaterThanOrEqual(0);
      expect(step.totalEnergyKbt).toBeGreaterThanOrEqual(0);
      expect(step.forcePn).toBeGreaterThanOrEqual(0);
    }
  });
});
