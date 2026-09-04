import { describe, it, expect } from 'bun:test';
import {
  rungeKutta4,
  infectionODE,
  simulateInfectionTrajectory,
  predictAtTime,
  evaluateFit,
  analyzeLysisCassette,
  correlateGenomicLysis,
  simulateInSilicoCassetteMutations,
  inferBurstKinetics,
  CANONICAL_GROWTH_CURVES,
  type InfectionParameters,
} from './burst-kinetics';
import type { PhageFull } from '../types';

function createMockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 1,
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
    genes: [],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('burst-kinetics', () => {
  const defaultParams: InfectionParameters = {
    adsorptionRate: 2.0e-10,
    latentPeriod: 25.0,
    burstSize: 120.0,
    bacterialGrowthRate: 0.015,
    phageDecayRate: 0.0005,
    initialBacteria: 1.0e8,
    initialPhage: 1.0e7,
  };

  describe('ODE Numerical Integration (RK4)', () => {
    it('integrates infection ODEs stably over time', () => {
      const f = infectionODE(defaultParams);
      const trajectory = rungeKutta4(f, [1.0e8, 0, 1.0e7], [0, 40], 1.0);

      expect(trajectory.length).toBe(41);
      const start = trajectory[0].y;
      expect(start[0]).toBe(1.0e8);
      expect(start[1]).toBe(0);
      expect(start[2]).toBe(1.0e7);

      const end = trajectory[trajectory.length - 1].y;
      // After 40 minutes, phages should have burst and increased
      expect(end[2]).toBeGreaterThan(start[2]);
    });

    it('simulates trajectory with biomass and OD600 calculation', () => {
      const trajectory = simulateInfectionTrajectory(defaultParams, 50, 1.0);
      expect(trajectory.length).toBe(51);

      const t0 = trajectory[0];
      expect(t0.od600).toBeGreaterThan(0.1);
      expect(t0.totalBiomass).toBe(t0.bacteria + t0.infected);

      const tPeak = trajectory.find((p) => p.timeMin >= 30);
      expect(tPeak).toBeDefined();
      expect(tPeak!.phage).toBeGreaterThan(defaultParams.initialPhage);
    });
  });

  describe('Prediction and Fit Evaluation', () => {
    it('interpolates prediction at exact and between timepoints', () => {
      const trajectory = simulateInfectionTrajectory(defaultParams, 40, 2.0);

      const valExact = predictAtTime(trajectory, 10.0, 'PFU');
      expect(valExact).toBeGreaterThan(0);

      const valBetween = predictAtTime(trajectory, 11.0, 'PFU');
      expect(valBetween).toBeGreaterThan(0);

      const odExact = predictAtTime(trajectory, 10.0, 'OD');
      expect(odExact).toBeGreaterThan(0);
    });

    it('evaluates sum of squared errors and log-likelihood', () => {
      const curve = CANONICAL_GROWTH_CURVES.t4_ecoli;
      const fit = evaluateFit(defaultParams, curve.data);

      expect(fit.sse).toBeGreaterThan(0);
      expect(Number.isFinite(fit.logLikelihood)).toBe(true);
      expect(fit.residuals.length).toBe(curve.data.length);
    });
  });

  describe('Lysis Cassette Detection and Genomic Correlation', () => {
    it('identifies holin, antiholin, endolysin, and spanin in Phage Lambda', () => {
      const lambdaPhage = createMockPhage({
        name: 'Enterobacteria phage lambda',
        genomeLength: 48502,
        genes: [
          { id: 1, name: 'S', locusTag: 'LAM_S', startPos: 100, endPos: 450, strand: '+', product: 'holin protein S', type: 'CDS' },
          { id: 2, name: 'S107', locusTag: 'LAM_S107', startPos: 100, endPos: 450, strand: '+', product: 'antiholin S107 dual-start', type: 'CDS' },
          { id: 3, name: 'R', locusTag: 'LAM_R', startPos: 500, endPos: 1000, strand: '+', product: 'endolysin muralytic enzyme', type: 'CDS' },
          { id: 4, name: 'Rz', locusTag: 'LAM_RZ', startPos: 1100, endPos: 1500, strand: '+', product: 'spanin inner membrane component', type: 'CDS' },
        ],
      });

      const cassette = analyzeLysisCassette(lambdaPhage);
      expect(cassette.hasHolin).toBe(true);
      expect(cassette.hasAntiholin).toBe(true);
      expect(cassette.hasEndolysin).toBe(true);
      expect(cassette.hasSpanin).toBe(true);
      expect(cassette.predictedLysisTimingMin).toBe(48.0);
    });

    it('correlates inferred latency with cassette prediction', () => {
      const lambdaPhage = createMockPhage({ name: 'Enterobacteria phage lambda' });
      const cassette = analyzeLysisCassette(lambdaPhage);

      const closeCorr = correlateGenomicLysis(50.0, cassette);
      expect(closeCorr.concordance).toBe('high');
      expect(closeCorr.correlationScore).toBeGreaterThan(85);
      expect(closeCorr.insights.length).toBeGreaterThan(0);

      const distantCorr = correlateGenomicLysis(80.0, cassette);
      expect(distantCorr.concordance).toBe('divergent');
      expect(distantCorr.correlationScore).toBeLessThan(70);
    });

    it('simulates in-silico genetic modifications and predicts latency/yield shifts', () => {
      const cassette = analyzeLysisCassette(createMockPhage());
      const scenarios = simulateInSilicoCassetteMutations(defaultParams, cassette);

      expect(scenarios.length).toBe(3);

      const antiholinKO = scenarios.find((s) => s.mutationType === 'antiholin_knockout');
      expect(antiholinKO).toBeDefined();
      expect(antiholinKO!.latentPeriodDeltaMin).toBeLessThan(0); // Faster lysis
      expect(antiholinKO!.burstSizeDelta).toBeLessThan(0); // Lower burst size

      const delayed = scenarios.find((s) => s.mutationType === 'delayed_lysis');
      expect(delayed).toBeDefined();
      expect(delayed!.latentPeriodDeltaMin).toBeGreaterThan(0); // Delayed lysis
      expect(delayed!.burstSizeDelta).toBeGreaterThan(0); // Higher yield
    });
  });

  describe('Full Inference Engine (inferBurstKinetics)', () => {
    it('infers realistic kinetic parameters from T4 experimental one-step growth curve', () => {
      const t4Phage = createMockPhage({
        name: 'Enterobacteria phage T4',
        genes: [
          { id: 1, name: 'gp19', locusTag: 'T4_019', startPos: 500, endPos: 1200, strand: '+', product: 'endolysin lysozyme', type: 'CDS' },
          { id: 2, name: 't', locusTag: 'T4_T', startPos: 1500, endPos: 2100, strand: '+', product: 'holin lysis protein t', type: 'CDS' },
        ],
      });

      const curve = CANONICAL_GROWTH_CURVES.t4_ecoli;
      const result = inferBurstKinetics(t4Phage, curve, { maxIterations: 60 });

      expect(result.curveId).toBe('t4_ecoli');
      expect(result.phageName).toBe('Enterobacteria phage T4');

      // T4 literature: latent period ~22-30 min, burst size ~80-160
      expect(result.fittedParameters.latentPeriod).toBeGreaterThan(18);
      expect(result.fittedParameters.latentPeriod).toBeLessThan(35);
      expect(result.fittedParameters.burstSize).toBeGreaterThan(60);

      // Model quality metrics
      expect(result.fitQualityR2).toBeGreaterThan(0.80);
      expect(Number.isFinite(result.aic)).toBe(true);
      expect(Number.isFinite(result.bic)).toBe(true);
      expect(result.residuals.length).toBe(curve.data.length);

      // 95% Confidence intervals
      expect(result.confidenceIntervals.latentPeriod[0]).toBeLessThan(result.fittedParameters.latentPeriod);
      expect(result.confidenceIntervals.latentPeriod[1]).toBeGreaterThan(result.fittedParameters.latentPeriod);

      // Lysis cassette and genomic correlation
      expect(result.lysisCassette.hasHolin).toBe(true);
      expect(result.lysisCassette.hasEndolysin).toBe(true);
      expect(result.genomicCorrelation.correlationScore).toBeGreaterThan(50);
      expect(result.inSilicoScenarios.length).toBe(3);
      expect(result.summary).toContain('min');
    });

    it('infers kinetics from OD600 clearance curve (Pseudomonas PAK_P1)', () => {
      const pakPhage = createMockPhage({
        name: 'Pseudomonas phage PAK_P1',
        host: 'Pseudomonas aeruginosa',
        genomeLength: 93000,
      });

      const curve = CANONICAL_GROWTH_CURVES.pseudomonas_pak_p1;
      const result = inferBurstKinetics(pakPhage, curve, { maxIterations: 60 });

      expect(result.curveId).toBe('pseudomonas_pak_p1');
      expect(result.fittedParameters.latentPeriod).toBeGreaterThan(20);
      expect(result.fittedParameters.latentPeriod).toBeLessThan(50);
      expect(result.fitQualityR2).toBeGreaterThan(0.70);
      expect(result.fittedTrajectory.length).toBeGreaterThan(10);
    });
  });
});
