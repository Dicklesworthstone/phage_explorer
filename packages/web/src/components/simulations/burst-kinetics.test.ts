import { describe, expect, it } from 'bun:test';
import {
  CANONICAL_GROWTH_CURVES,
  inferBurstKinetics,
  analyzeLysisCassette,
  correlateGenomicLysis,
  simulateInSilicoCassetteMutations,
  type PhageFull,
} from '@phage-explorer/core';

function mockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 1,
    slug: 'mock-phage',
    name: 'Bacteriophage Mock',
    accession: 'NC_000001',
    family: 'Myoviridae',
    host: 'Escherichia coli',
    genomeLength: 50000,
    gcContent: 50.0,
    morphology: 'myovirus',
    lifecycle: 'lytic',
    description: null,
    baltimoreGroup: 'I',
    genomeType: 'dsDNA',
    pdbIds: [],
    genes: [],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Burst Kinetics & Latency Inference (Roadmap #33)', () => {
  it('has valid canonical growth curve benchmark datasets', () => {
    const curves = Object.values(CANONICAL_GROWTH_CURVES);
    expect(curves.length).toBe(4);
    for (const dataset of curves) {
      expect(dataset.id).toBeDefined();
      expect(dataset.phageName).toBeDefined();
      expect(dataset.data.length).toBeGreaterThanOrEqual(9);
      expect(dataset.defaultB0).toBeGreaterThan(0);
      expect(dataset.defaultP0).toBeGreaterThan(0);
      for (const pt of dataset.data) {
        expect(pt.timeMin).toBeGreaterThanOrEqual(0);
        expect(pt.value).toBeGreaterThan(0);
      }
    }
  });

  it('accurately fits T4 on E. coli B growth curve (Ellis & Delbrück 1939)', () => {
    const t4Dataset = CANONICAL_GROWTH_CURVES['t4_ecoli'];
    expect(t4Dataset).toBeDefined();

    const phage = mockPhage({ name: 'Enterobacteria phage T4' });
    const result = inferBurstKinetics(phage, t4Dataset);

    expect(result.fittedParameters.latentPeriod).toBeGreaterThan(15);
    expect(result.fittedParameters.latentPeriod).toBeLessThan(35);
    expect(result.fittedParameters.burstSize).toBeGreaterThan(50);
    expect(result.fittedParameters.burstSize).toBeLessThan(250);
    expect(result.fitQualityR2).toBeGreaterThan(0.90);
    expect(result.confidenceIntervals.latentPeriod[0]).toBeLessThanOrEqual(result.fittedParameters.latentPeriod);
    expect(result.confidenceIntervals.latentPeriod[1]).toBeGreaterThanOrEqual(result.fittedParameters.latentPeriod);
    expect(result.fittedTrajectory.length).toBeGreaterThan(20);
  });

  it('accurately fits Lambda on E. coli K-12 growth curve (Wang 2000)', () => {
    const lambdaDataset = CANONICAL_GROWTH_CURVES['lambda_ecoli'];
    expect(lambdaDataset).toBeDefined();

    const phage = mockPhage({ name: 'Enterobacteria phage lambda' });
    const result = inferBurstKinetics(phage, lambdaDataset);

    expect(result.fittedParameters.latentPeriod).toBeGreaterThan(35);
    expect(result.fittedParameters.latentPeriod).toBeLessThan(65);
    expect(result.fittedParameters.burstSize).toBeGreaterThan(50);
    expect(result.fittedParameters.burstSize).toBeLessThan(200);
    expect(result.fitQualityR2).toBeGreaterThan(0.90);
  });

  it('accurately fits phiX174 on E. coli C growth curve (Hutchison & Sinsheimer 1966)', () => {
    const phiXDataset = CANONICAL_GROWTH_CURVES['phix174_ecoli'];
    expect(phiXDataset).toBeDefined();

    const phage = mockPhage({ name: 'Escherichia virus phiX174' });
    const result = inferBurstKinetics(phage, phiXDataset);

    expect(result.fittedParameters.latentPeriod).toBeGreaterThan(10);
    expect(result.fittedParameters.latentPeriod).toBeLessThan(30);
    expect(result.fittedParameters.burstSize).toBeGreaterThan(80);
    expect(result.fittedParameters.burstSize).toBeLessThan(300);
    expect(result.fitQualityR2).toBeGreaterThan(0.85);
  });

  it('accurately fits PAK_P1 on P. aeruginosa OD clearance curve (Henry et al. 2013)', () => {
    const pakDataset = CANONICAL_GROWTH_CURVES['pseudomonas_pak_p1'];
    expect(pakDataset).toBeDefined();

    const phage = mockPhage({ name: 'Pseudomonas phage PAK_P1' });
    const result = inferBurstKinetics(phage, pakDataset);

    expect(result.fittedParameters.latentPeriod).toBeGreaterThan(20);
    expect(result.fittedParameters.latentPeriod).toBeLessThan(50);
    expect(result.fitQualityR2).toBeGreaterThan(0.85);
  });

  it('analyzes genomic lysis cassette and correlates with inferred latency', () => {
    const phage = mockPhage({
      name: 'Enterobacteria phage lambda',
      genes: [
        {
          id: 1,
          name: 'S105',
          product: 'holin S105 inner membrane pore',
          locusTag: null,
          startPos: 1000,
          endPos: 1318,
          strand: '+',
          type: 'CDS',
        },
        {
          id: 2,
          name: 'S107',
          product: 'antiholin S107 dual start motif regulator',
          locusTag: null,
          startPos: 1000,
          endPos: 1324,
          strand: '+',
          type: 'CDS',
        },
        {
          id: 3,
          name: 'R',
          product: 'endolysin muralytic enzyme muramidase',
          locusTag: null,
          startPos: 1350,
          endPos: 1820,
          strand: '+',
          type: 'CDS',
        },
        {
          id: 4,
          name: 'Rz/Rz1',
          product: 'outer membrane spanin complex',
          locusTag: null,
          startPos: 1830,
          endPos: 2300,
          strand: '+',
          type: 'CDS',
        },
      ],
    });

    const cassette = analyzeLysisCassette(phage);
    expect(cassette.hasHolin).toBe(true);
    expect(cassette.hasAntiholin).toBe(true);
    expect(cassette.hasEndolysin).toBe(true);
    expect(cassette.hasSpanin).toBe(true);
    expect(cassette.predictedLysisTimingMin).toBeGreaterThan(30);

    const correlation = correlateGenomicLysis(48.5, cassette);
    expect(correlation.correlationScore).toBeGreaterThan(60);
    expect(correlation.concordance).toBe('high');
  });

  it('simulates in-silico genetic cassette alterations', () => {
    const phage = mockPhage({
      genes: [
        {
          id: 1,
          name: 'S105',
          product: 'holin S105 inner membrane pore',
          locusTag: null,
          startPos: 1000,
          endPos: 1318,
          strand: '+',
          type: 'CDS',
        },
        {
          id: 2,
          name: 'S107',
          product: 'antiholin S107 dual start motif regulator',
          locusTag: null,
          startPos: 1000,
          endPos: 1324,
          strand: '+',
          type: 'CDS',
        },
        {
          id: 3,
          name: 'R',
          product: 'endolysin muralytic enzyme muramidase',
          locusTag: null,
          startPos: 1350,
          endPos: 1820,
          strand: '+',
          type: 'CDS',
        },
      ],
    });

    const cassette = analyzeLysisCassette(phage);
    const mockParams = {
      adsorptionRate: 2.5e-9,
      latentPeriod: 45,
      burstSize: 120,
      bacterialGrowthRate: 0.015,
      phageDecayRate: 0.001,
      initialBacteria: 1e8,
      initialPhage: 5e6,
    };

    const mutations = simulateInSilicoCassetteMutations(mockParams, cassette);
    expect(mutations.length).toBe(3);

    const antiholinKo = mutations.find(m => m.mutationType === 'antiholin_knockout')!;
    expect(antiholinKo).toBeDefined();
    expect(antiholinKo.latentPeriodDeltaMin).toBeLessThan(0); // premature lysis
    expect(antiholinKo.predictedBurstSize).toBeLessThan(120); // reduced yield

    const holinOe = mutations.find(m => m.mutationType === 'holin_overexpression')!;
    expect(holinOe).toBeDefined();
    expect(holinOe.latentPeriodDeltaMin).toBeLessThan(0);

    const delayedLysis = mutations.find(m => m.mutationType === 'delayed_lysis')!;
    expect(delayedLysis).toBeDefined();
    expect(delayedLysis.latentPeriodDeltaMin).toBeGreaterThan(0);
    expect(delayedLysis.predictedBurstSize).toBeGreaterThan(120);
  });
});
