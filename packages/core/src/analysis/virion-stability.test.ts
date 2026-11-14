import { describe, expect, it } from 'bun:test';
import {
  predictVirionStability, predictVirionStabilityFromPhage, createInactivationTemplate,
  parseInactivationInput, parseInactivationCSV, fitInactivation, createInactivationRecord,
  replayInactivationRecord, exportInactivationTsv, INACTIVATION_METHOD, INACTIVATION_LIMITS,
  type InactivationFit,
} from './virion-stability';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import type { GrowthPlate } from './plaque-growth';

describe('Virion stability', () => {
  it('predictVirionStability > returns robust under ideal cold + isotonic conditions for a stable dsDNA morphology', () => {
    const estimate = predictVirionStability(
      {
        genomeLength: 45_000,
        gcContent: 70,
        morphology: 'Myoviridae',
        baltimoreGroup: 'I',
        pdbIds: ['1abc'],
      },
      { temperatureC: 4, saltMilliMolar: 100 }
    );

    expect(estimate.status).toBe('robust');
    expect(estimate.integrity).toBeGreaterThanOrEqual(0.65);
    expect(estimate.temperatureFactor).toBe(1);
    expect(estimate.saltFactor).toBe(1);
    expect(estimate.warnings).toEqual([]);
    expect(estimate.notes).toEqual([]);
  });

  it('predictVirionStability > degrades under high temperature and emits warnings', () => {
    const estimate = predictVirionStability(
      {
        genomeLength: 150_000,
        gcContent: 40,
        morphology: 'Inoviridae',
        baltimoreGroup: 'V',
        pdbIds: [],
      },
      { temperatureC: 45, saltMilliMolar: 20 }
    );

    expect(estimate.status).toBe('fragile');
    expect(estimate.integrity).toBeLessThan(0.5);
    expect(estimate.warnings.join(' ')).toContain('Handling above 37°C');
    expect(estimate.warnings.join(' ')).toContain('Very low salt');
    expect(estimate.notes.join(' ')).toContain('No PDB models linked');
  });

  it('predictVirionStabilityFromPhage > handles null phage', () => {
    const estimate = predictVirionStabilityFromPhage(null, { temperatureC: 4, saltMilliMolar: 100 });
    expect(estimate.integrity).toBeGreaterThanOrEqual(0);
    expect(estimate.integrity).toBeLessThanOrEqual(1);
  });
});

/**
 * Storage advice must not be a constant wearing a recommendation's clothes.
 *
 * `recommendedStorage` returned `{ 4 °C, 100 mM }` for every phage in the
 * catalogue and both overlays presented it as a per-phage recommendation. This
 * overlay sits inside the phage-therapy screening story the README tells, so it
 * is exactly the kind of output a wet-lab user might act on, and a constant is
 * indistinguishable from a computed one.
 */
describe('storage advice is derived or absent, never constant', () => {
  const env = { temperatureC: 20, saltMilliMolar: 100 };
  const base = { genomeLength: 48000, gcContent: 50, morphology: '' };

  it('gives no recommendation for a phage with nothing to base one on', () => {
    const r = predictVirionStability({ ...base, family: 'Siphoviridae' }, env);
    expect(r.recommendedStorage).toBeNull();
  });

  it('gives a recommendation for lipid-containing virions, with a reason', () => {
    // PRD1, PM2 and phi6 are in this catalogue and genuinely differ in
    // handling: they lose infectivity on freezing and on solvent contact.
    for (const family of ['Tectiviridae', 'Corticoviridae', 'Cystoviridae']) {
      const r = predictVirionStability({ ...base, family }, env);
      expect(r.recommendedStorage).not.toBeNull();
      expect(r.recommendedStorage!.rationale).toContain('Lipid-containing');
    }
  });

  it('does not give every phage the same answer', () => {
    // The discrimination check, and the exact defect being fixed. If this ever
    // passes for all families again, the constant is back.
    const lipid = predictVirionStability({ ...base, family: 'Tectiviridae' }, env);
    const other = predictVirionStability({ ...base, family: 'Myoviridae' }, env);
    expect(lipid.recommendedStorage).not.toEqual(other.recommendedStorage);
  });

  it('still varies its composition-derived metrics with the genome', () => {
    // Guards against over-correction: removing the constant must not flatten
    // the metrics that were always real.
    const lowGc = predictVirionStability({ ...base, gcContent: 38 }, env);
    const highGc = predictVirionStability({ ...base, gcContent: 66 }, env);
    expect(highGc.meltingTempC).toBeGreaterThan(lowGc.meltingTempC);
    expect(highGc.baseIndex).toBeGreaterThan(lowGc.baseIndex);
  });
});

const plate = (timeMin: number, count: number, dilution = 1, volumeMl = 1): GrowthPlate =>
  ({ timeMin, count, dilution, volumeMl });
const support = { supportDeviance: 3.84 };
const measuredInput = () => {
  const input = createInactivationTemplate();
  input.provenance = { kind: 'user-supplied', source: 'Local exact-count fixture', reference: 'Local notebook, page 1', license: 'Private research use' };
  return input;
};
async function rehash(record: AnalysisRecord): Promise<AnalysisRecord> {
  return createAnalysisRecord({ method: record.method, inputs: record.inputs.map(({ sha256: _sha, ...input }) => input),
    parameters: record.parameters, seed: record.seed, references: record.references, fields: record.fields });
}
function fitValue(record: AnalysisRecord): InactivationFit {
  return record.fields.fit.value as unknown as InactivationFit;
}

describe('measured first-order plaque-count inactivation', () => {
  it('recovers hand-specified half-life, concentration and exposure-adjusted plate means', () => {
    const input = createInactivationTemplate();
    const fit = fitInactivation(parseInactivationCSV(input.csv), input.options);
    expect(fit.status).toBe('estimated');
    expect(fit.referencePFUPerMl).toBeCloseTo(1_600_000, 6);
    expect(fit.decayRatePerMin!).toBeCloseTo(Math.LN2 / 10, 12);
    expect(fit.log10LossPerMin!).toBeCloseTo(Math.log10(2) / 10, 12);
    expect(fit.halfLifeMin!).toBeCloseTo(10, 10);
    expect(fit.oneLogReductionMin!).toBeCloseTo(10 * Math.log2(10), 10);
    expect(fit.deviance).toBeLessThan(1e-10);
    expect(fit.fitted.map(p => Math.round(p.expectedCount))).toEqual([160, 80, 40, 20]);
    expect(fit.support.lowerRatePerMin).toBeGreaterThan(0);
    expect(fit.support.upperRatePerMin!).toBeGreaterThan(fit.decayRatePerMin!);
    expect(fit.warnings.join(' ')).toContain('model extrapolation');
    expect(fit.warnings.join(' ')).toContain('not a calibrated confidence interval');
  });

  it('uses exposure, not raw count ratios, for unequal volumes and dilutions', () => {
    // Titers are 1,000 -> 500 -> 250, while counts are 100 -> 75 -> 25.
    const fit = fitInactivation([plate(0, 100, 1, .1), plate(10, 75, 1, .15), plate(20, 25, .5, .2)], support);
    expect(fit.referencePFUPerMl).toBeCloseTo(1000, 9);
    expect(fit.halfLifeMin!).toBeCloseTo(10, 10);
    expect(fit.fitted.map(p => Math.round(p.expectedCount))).toEqual([100, 75, 25]);
    expect(fit.deviance).toBeLessThan(1e-10);
  });

  it('matches the independent two-time closed-form rate under an extreme exposure ratio', () => {
    const fit = fitInactivation([plate(0, 100, 1e-12, 1e-6), plate(10, 50, 1, 10)], support);
    const expectedRate = Math.log((100 / 1e-18) / (50 / 10)) / 10;
    expect(fit.decayRatePerMin!).toBeCloseTo(expectedRate, 11);
    expect(fit.referencePFUPerMl / 1e20).toBeCloseTo(1, 12);
    expect(fit.fitted[0].expectedCount).toBeCloseTo(100, 9);
    expect(fit.fitted[1].expectedCount).toBeCloseTo(50, 9);
    expect(fit.deviance).toBeLessThan(1e-9);
  });

  it('keeps exact zero counts and matches a three-time quadratic likelihood oracle', () => {
    // Equal exposures, times 0,10,20; x=exp(-10k).
    // The score gives (x+2x²)/(1+x+x²)=50/150, hence 5x²+2x-1=0.
    const x = (Math.sqrt(6) - 1) / 5;
    const expectedRate = -Math.log(x) / 10;
    const expectedConcentration = 150 / (1 + x + x * x);
    const fit = fitInactivation([plate(0, 100), plate(10, 50), plate(20, 0)], support);
    expect(fit.status).toBe('estimated');
    expect(fit.decayRatePerMin!).toBeCloseTo(expectedRate, 12);
    expect(fit.referencePFUPerMl).toBeCloseTo(expectedConcentration, 10);
    expect(fit.observations).toBe(3);
    expect(fit.fitted[2].count).toBe(0);
    expect(fit.fitted[2].expectedCount).toBeGreaterThan(0);
    expect(fit.fitted[2].devianceResidual).toBeCloseTo(-Math.sqrt(2 * expectedConcentration * x * x), 10);
  });

  it('preserves sufficient statistics when a plate is split, while retaining lack-of-fit within a time', () => {
    const pooled = [plate(0, 120, 1, .1), plate(10, 60, 1, .1), plate(20, 30, 1, .1)];
    const split = [plate(0, 70, 1, .06), plate(0, 50, 1, .04), ...pooled.slice(1)];
    const a = fitInactivation(pooled, support), b = fitInactivation(split, support);
    expect(b.decayRatePerMin!).toBeCloseTo(a.decayRatePerMin!, 12);
    expect(b.referencePFUPerMl).toBeCloseTo(a.referencePFUPerMl, 9);
    expect(b.support.lowerRatePerMin).toBeCloseTo(a.support.lowerRatePerMin, 12);
    expect(b.support.upperRatePerMin!).toBeCloseTo(a.support.upperRatePerMin!, 12);
    expect(b.deviance).toBeGreaterThan(a.deviance + .1);
    expect(b.fitted).toHaveLength(4);
  });

  it('is invariant to observation order and time translation, and rescales physical units', () => {
    const plates = [plate(0, 100, 1, .1), plate(10, 40, 1, .1), plate(20, 10, 1, .1)];
    const original = fitInactivation(plates, support);
    expect(fitInactivation([...plates].reverse(), support)).toEqual(original);
    const translated = fitInactivation(plates.map(p => ({ ...p, timeMin: p.timeMin + 50 })), support);
    expect(translated.decayRatePerMin).toBe(original.decayRatePerMin);
    expect(translated.referenceTimeMin).toBe(50);
    expect(translated.referencePFUPerMl).toBe(original.referencePFUPerMl);
    const stretched = fitInactivation(plates.map(p => ({ ...p, timeMin: p.timeMin * 60 })), support);
    expect(stretched.decayRatePerMin! * 60).toBeCloseTo(original.decayRatePerMin!, 12);
    expect(stretched.halfLifeMin! / 60).toBeCloseTo(original.halfLifeMin!, 12);
    const doubledExposure = fitInactivation(plates.map(p => ({ ...p, volumeMl: p.volumeMl * 2 })), support);
    expect(doubledExposure.referencePFUPerMl * 2).toBeCloseTo(original.referencePFUPerMl, 8);
    expect(doubledExposure.decayRatePerMin!).toBeCloseTo(original.decayRatePerMin!, 12);
  });

  it('reoptimizes concentration at both profile-support endpoints', () => {
    const plates = [plate(0, 99, .01, .1), plate(4, 42, .01, .1), plate(9, 25, .02, .1), plate(20, 5, .05, .1)];
    const fit = fitInactivation(plates, support), total = 171;
    // Independent direct Poisson log likelihood; no production profile helper.
    const logLikelihood = (rate: number) => {
      const exposure = plates.reduce((sum, p) => sum + p.dilution * p.volumeMl * Math.exp(-rate * p.timeMin), 0);
      const concentration = total / exposure;
      return plates.reduce((sum, p) => {
        const mean = p.dilution * p.volumeMl * concentration * Math.exp(-rate * p.timeMin);
        return sum + p.count * Math.log(mean) - mean;
      }, 0);
    };
    const optimum = logLikelihood(fit.decayRatePerMin!);
    expect(fit.support.lowerStatus).toBe('crossed');
    expect(fit.support.upperStatus).toBe('crossed');
    for (const bound of [fit.support.lowerRatePerMin, fit.support.upperRatePerMin!]) {
      expect(2 * (optimum - logLikelihood(bound))).toBeCloseTo(support.supportDeviance, 8);
    }
    expect(2 * (optimum - logLikelihood(fit.decayRatePerMin!))).toBe(0);
    expect(2 * (optimum - logLikelihood(fit.support.upperRatePerMin! * 1.1))).toBeGreaterThan(support.supportDeviance);
    const wider = fitInactivation(plates, { supportDeviance: 10 });
    expect(wider.support.lowerRatePerMin).toBeLessThan(fit.support.lowerRatePerMin);
    expect(wider.support.upperRatePerMin!).toBeGreaterThan(fit.support.upperRatePerMin!);
  });

  it('fits increasing counts at the zero-rate boundary without asserting stability or a finite loss time', () => {
    const fit = fitInactivation([plate(0, 10), plate(10, 20), plate(20, 30)], support);
    expect(fit.status).toBe('zero-rate-boundary');
    expect(fit.decayRatePerMin).toBe(0);
    expect(fit.referencePFUPerMl).toBeCloseTo(20, 12);
    expect(fit.halfLifeMin).toBeNull();
    expect(fit.oneLogReductionMin).toBeNull();
    expect(fit.support.lowerRatePerMin).toBe(0);
    expect(fit.support.upperRatePerMin!).toBeGreaterThan(0);
    const expectedDeviance = 2 * (10 * Math.log(.5) + 30 * Math.log(1.5));
    expect(fit.deviance).toBeCloseTo(expectedDeviance, 10);
    expect(fit.reason).toContain('does not establish absence');
  });

  it('returns an explicit limiting fit and analytic one-sided support for earliest-only positive counts', () => {
    const fit = fitInactivation([plate(0, 100), plate(10, 0)], support);
    // With x=exp(-10k), profile deviance from the limiting MLE is 200 log(1+x).
    const lower = -Math.log(Math.expm1(support.supportDeviance / 200)) / 10;
    expect(fit.status).toBe('unbounded-rate');
    expect(fit.fittedBasis).toBe('limiting-mle');
    expect(fit.decayRatePerMin).toBeNull();
    expect(fit.halfLifeMin).toBeNull();
    expect(fit.oneLogReductionMin).toBeNull();
    expect(fit.referencePFUPerMl).toBeCloseTo(100, 10);
    expect(fit.support.lowerRatePerMin).toBeCloseTo(lower, 12);
    expect(fit.support.upperRatePerMin).toBeNull();
    expect(fit.support.upperStatus).toBe('unbounded');
    expect(fit.fitted[1].expectedCount).toBe(0);
    expect(fit.fitted[1].logExpectedCount).toBeNull();
    expect(fit.deviance).toBeLessThan(1e-10);
    const weak = fitInactivation([plate(0, 1), plate(10, 0)], support);
    expect(weak.support.lowerRatePerMin).toBe(0);
    expect(weak.support.upperRatePerMin).toBeNull();
  });

  it('reports all-zero and no-time-span data as unidentified without inventing a half-life', () => {
    const zero = fitInactivation([plate(0, 0), plate(10, 0), plate(20, 0)], support);
    expect(zero.status).toBe('unidentifiable');
    expect(zero.referencePFUPerMl).toBe(0);
    expect(zero.decayRatePerMin).toBeNull();
    expect(zero.deviance).toBe(0);
    expect(zero.support.lowerRatePerMin).toBe(0);
    expect(zero.support.upperRatePerMin).toBeNull();
    expect(zero.fitted.every(p => p.expectedCount === 0 && p.logExpectedCount === null)).toBe(true);
    const noSpan = fitInactivation([plate(25, 100, 1, .1), plate(25, 200, 1, .2)], support);
    expect(noSpan.status).toBe('unidentifiable');
    expect(noSpan.referencePFUPerMl).toBeCloseTo(1000, 9);
    expect(noSpan.fittedBasis).toBe('common-time-concentration');
    expect(noSpan.decayRatePerMin).toBeNull();
    expect(noSpan.halfLifeMin).toBeNull();
    expect(noSpan.support.upperRatePerMin).toBeNull();
    expect(fitInactivation([plate(0, 1)], support).status).toBe('unidentifiable');
  });

  it('keeps finite log predictions when large rate-times underflow ordinary means', () => {
    const fit = fitInactivation([plate(0, 100), plate(1, 50), plate(1_000_000, 0)], support);
    expect(fit.status).toBe('estimated');
    expect(fit.decayRatePerMin!).toBeCloseTo(Math.LN2, 10);
    expect(fit.fitted[2].expectedCount).toBe(0);
    expect(fit.fitted[2].logExpectedCount!).toBeLessThan(-100_000);
    expect(Number.isFinite(fit.fitted[2].logExpectedCount)).toBe(true);
    expect(fit.warnings.join(' ')).toContain('underflow');
    expect(fit.support.upperRatePerMin!).toBeGreaterThan(fit.decayRatePerMin!);
  });

  it('refuses unrepresentable rates or collapsed numerical time separations directly', () => {
    expect(() => fitInactivation([plate(0, 100), plate(Number.MIN_VALUE, 50)], support)).toThrow('numerical range');
    expect(() => fitInactivation([plate(0, 100), plate(Number.MIN_VALUE, 50), plate(1e7, 0)], support)).toThrow('numerical range');
  });

  it('strictly validates exact count/exposure input and explicit metadata', () => {
    const template = createInactivationTemplate();
    expect(parseInactivationInput(JSON.stringify(template))).toEqual(template);
    expect(parseInactivationCSV('\uFEFFtime_min\tplaque_count\tdilution_fraction\tvolume_ml\r\n0\t0\t1e-6\t.1\r\n')).toEqual([plate(0, 0, 1e-6, .1)]);
    expect(() => parseInactivationCSV('time_min,plaque_count,dilution_fraction,volume_ml,count_status\n0,0,1,.1,at-most')).toThrow('unsupported');
    for (const value of ['TNTC', '<10', '', 'NA', 'Infinity', 'NaN', '.5', '-1', '1000001']) {
      expect(() => parseInactivationCSV('time_min,plaque_count,dilution_fraction,volume_ml\n0,' + value + ',1,.1')).toThrow();
    }
    for (const change of [{ dilution: 100 }, { dilution: 0 }, { volumeMl: 0 }, { countStatus: 'exact' }, { timeMin: -1 }, { count: NaN }]) {
      expect(() => fitInactivation([{ ...plate(0, 1), ...change }], support)).toThrow();
    }
    for (const value of [0, 101, NaN, Infinity]) expect(() => fitInactivation([plate(0, 1)], { supportDeviance: value })).toThrow();
    expect(() => fitInactivation([], support)).toThrow();
    expect(() => fitInactivation(Array.from({ length: INACTIVATION_LIMITS.rows + 1 }, () => plate(0, 0)), support)).toThrow();
    expect(() => parseInactivationInput(' '.repeat(INACTIVATION_LIMITS.bytes + 1))).toThrow('UTF-8');
    expect(() => parseInactivationInput(JSON.stringify({ ...template, conditions: { ...template.conditions, temperatureC: null } }))).toThrow();
    expect(() => parseInactivationInput(JSON.stringify({ ...template, preparation: { ...template.preparation, batchId: '' } }))).toThrow();
    expect(() => parseInactivationInput(JSON.stringify({ ...template, provenance: { ...template.provenance, license: '' } }))).toThrow();
    expect(() => parseInactivationInput(JSON.stringify({ ...template, options: { ...template.options, seed: 1 } }))).toThrow('unsupported');
  });
});

describe('inactivation evidence, complete export and strict replay', () => {
  it('binds exact input bytes, context, source and all observations to shared evidence fields', async () => {
    const input = measuredInput(), text = JSON.stringify(input, null, 2);
    const record = await createInactivationRecord(text);
    expect(record.method).toEqual(INACTIVATION_METHOD);
    expect(record.inputs).toHaveLength(1);
    expect(record.inputs[0].id).toBe('experiment');
    expect(record.inputs[0].data).toBe(text);
    expect(record.inputs[0].accession).toBeNull();
    expect(record.inputs[0].source).toBe('local');
    expect(record.parameters).toEqual({ ...input.options });
    expect(record.seed).toBeNull();
    expect(record.fields.fit.kind).toBe('fitted-estimate');
    expect(record.fields.plates.kind).toBe('observation');
    expect(record.fields.plates.value).toEqual(analysisJson(parseInactivationCSV(input.csv)));
    expect(record.references[0].description).toContain(input.provenance.license);
    expect(record.fields.fit.kind === 'fitted-estimate' && record.fields.fit.fit.uncertainty.kind).toBe('not-estimated');
    expect(await createInactivationRecord(text)).toEqual(record);
    expect(await replayInactivationRecord(serializeAnalysisRecord(record))).toEqual(record);
    const whitespaceChanged = await createInactivationRecord(JSON.stringify(input));
    expect(whitespaceChanged.cacheKey).not.toBe(record.cacheKey);
    expect(fitValue(whitespaceChanged)).toEqual(fitValue(record));
  });

  it('keeps synthetic source/evidence explicit without borrowing a selected catalog identity', async () => {
    const input = createInactivationTemplate(), record = await createInactivationRecord(JSON.stringify(input));
    expect(record.inputs[0].source).toBe('demo');
    expect(record.fields.fit.kind).toBe('demo');
    expect(record.fields.plates.kind).toBe('demo');
    expect(input.preparation.phageId).toBe('synthetic-phage');
    expect(input.preparation.accession).toBeNull();
    expect(await replayInactivationRecord(serializeAnalysisRecord(record))).toEqual(record);
  });

  it('rejects rehashed numerical, interpretation, method and parameter changes', async () => {
    const record = await createInactivationRecord(JSON.stringify(measuredInput()));
    const changedRate = structuredClone(record);
    fitValue(changedRate).decayRatePerMin = .123;
    await expect(replayInactivationRecord(serializeAnalysisRecord(await rehash(changedRate)))).rejects.toThrow('Recomputed');
    const changedSupport = structuredClone(record);
    fitValue(changedSupport).support.upperRatePerMin = 123;
    await expect(replayInactivationRecord(serializeAnalysisRecord(await rehash(changedSupport)))).rejects.toThrow('Recomputed');
    const changedInterpretation = structuredClone(record);
    changedInterpretation.fields.fit.label = 'Biologically validated storage lifetime';
    await expect(replayInactivationRecord(serializeAnalysisRecord(await rehash(changedInterpretation)))).rejects.toThrow('Recomputed');
    const changedMethod = structuredClone(record);
    changedMethod.method.implementation += '; unrecorded modification';
    await expect(replayInactivationRecord(serializeAnalysisRecord(await rehash(changedMethod)))).rejects.toThrow('Recomputed');
    const changedOptions = structuredClone(record);
    changedOptions.parameters.supportDeviance = 4;
    await expect(replayInactivationRecord(serializeAnalysisRecord(await rehash(changedOptions)))).rejects.toThrow('Recomputed');
    const changedBytes = structuredClone(record);
    const input = measuredInput(); input.options.supportDeviance = 4;
    changedBytes.inputs[0].data = JSON.stringify(input);
    changedBytes.parameters.supportDeviance = 4;
    await expect(replayInactivationRecord(serializeAnalysisRecord(await rehash(changedBytes)))).rejects.toThrow('Recomputed');
  });

  it('exports all plate rows and full source/model context, including exact zero observations', async () => {
    const input = measuredInput();
    input.csv = 'time_min,plaque_count,dilution_fraction,volume_ml\n'
      + Array.from({ length: 125 }, (_, i) => `${i},${i < 120 ? 125 - i : 0},0.001,0.1`).join('\n') + '\n';
    input.title = '=FORMULA()'; input.provenance.source = '+SOURCE';
    const record = await createInactivationRecord(JSON.stringify(input)), tsv = exportInactivationTsv(record);
    const rows = tsv.trimEnd().split('\n').filter(line => !line.startsWith('#'));
    expect(rows).toHaveLength(126);
    expect(rows[0]).toContain('log_expected_count');
    expect(rows[125].split('\t').slice(0, 4)).toEqual(['124', '0', '0.001', '0.1']);
    expect(tsv).toContain('Private research use');
    expect(tsv).toContain('synthetic-preparation');
    expect(tsv).toContain('support_is_not_a_calibrated_confidence_interval');
    expect(tsv).toContain('null_upper=unbounded');
    expect(tsv.split('\n').some(line => /^[=+@]/.test(line))).toBe(false);
    expect(rows[125].split('\t').at(-1)!.startsWith('-')).toBe(true);
    expect(exportInactivationTsv(await replayInactivationRecord(serializeAnalysisRecord(record)))).toBe(tsv);
  });

  it('records and replays unidentified and limiting estimates without JSON nonfinite values', async () => {
    for (const counts of [[0, 0], [100, 0]]) {
      const input = measuredInput();
      input.csv = `time_min,plaque_count,dilution_fraction,volume_ml\n0,${counts[0]},1,1\n10,${counts[1]},1,1\n`;
      const record = await createInactivationRecord(JSON.stringify(input));
      expect(fitValue(record).decayRatePerMin).toBeNull();
      expect(fitValue(record).support.upperRatePerMin).toBeNull();
      expect(await replayInactivationRecord(serializeAnalysisRecord(record))).toEqual(record);
      expect(exportInactivationTsv(record)).toContain('decay_rate_per_min=NA');
    }
  });
});
