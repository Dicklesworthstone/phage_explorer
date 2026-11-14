import type { PhageFull } from '../types';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord,
  type AnalysisField, type AnalysisRecord } from '../analysis-result';
import { poissonCountLogProbability, type GrowthPlate } from './plaque-growth';

export interface StabilityInputs {
  genomeLength?: number | null;
  /** GC percentage (0–100), consistent with DB storage */
  gcContent?: number | null;
  morphology?: string | null;
  /** Taxonomic family, used to identify lipid-containing virions. */
  family?: string | null;
  baltimoreGroup?: string | null;
  pdbIds?: string[];
}

export interface StabilityEnvironment {
  temperatureC: number; // Current handling temperature
  saltMilliMolar: number; // Approximate ionic strength in mM
}

export type StabilityStatus = 'robust' | 'moderate' | 'fragile';

export interface StabilityEstimate {
  baseIndex: number; // Intrinsic stability (capsid design, genome load)
  packagingPenalty: number; // Pressure from genome length
  temperatureFactor: number;
  saltFactor: number;
  integrity: number; // 0–1 combined estimate under current env
  meltingTempC: number;
  /**
   * Storage advice, or null when none can be derived.
   *
   * This used to be the constant `{ 4 °C, 100 mM }` for every phage in the
   * catalogue, presented in the UI as a per-phage recommendation. It sits
   * inside the phage-therapy screening story the README tells, so it is exactly
   * the kind of output a wet-lab user might act on, and a constant is
   * indistinguishable from a computed one.
   *
   * It is now derived only where the catalogue carries something that actually
   * bears on it -- a lipid-containing envelope, which genuinely changes handling
   * -- and is null otherwise. Null means "we have nothing to base this on",
   * which is the honest answer for most of the catalogue.
   */
  recommendedStorage: {
    temperatureC: number;
    saltMilliMolar: number;
    /** Why these conditions, so the user can judge the advice. */
    rationale: string;
  } | null;
  status: StabilityStatus;
  warnings: string[];
  notes: string[];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const normalize = (v: number, min: number, max: number) => clamp01((v - min) / (max - min));

/**
 * Where the coefficients below come from, and what they are not.
 *
 * They are NOT fitted to data and they are not from a published model. They are
 * ordinal encodings of qualitative statements that are uncontroversial in the
 * phage literature, chosen so the ranking they produce is defensible even
 * though the magnitudes are not:
 *
 * - Contractile- and short-tailed virions (myo-, podo-) tolerate handling
 *   better than long flexible-tailed (sipho-), and filamentous virions
 *   (ino-) are the most fragile to shear.
 * - dsDNA genomes are more robust to handling than ssDNA or ssRNA.
 * - Higher GC raises duplex melting temperature; this one has a real
 *   quantitative basis and is used through `estimateMeltingTemp`.
 *
 * So the OUTPUT of this model is an ordering, not a measurement, and the
 * overlay is badged `heuristic` for that reason. Anyone replacing these with a
 * fitted model should treat the numbers here as placeholders with the right
 * sign, not as parameters worth preserving.
 */
function morphologyBoost(morphology?: string | null): number {
  const m = morphology?.toLowerCase() ?? '';
  if (!m) return 0;
  if (m.includes('myovir') || m.includes('podovir')) return 0.06;
  if (m.includes('siphov')) return 0.04;
  if (m.includes('inovir') || m.includes('filament')) return -0.05;
  return 0;
}

function baltimoreBoost(group?: string | null): number {
  const g = (group ?? '').toUpperCase();
  if (g === 'I' || g === 'VII') return 0.05; // dsDNA / dsDNA-RT
  if (g === 'II' || g === 'V') return -0.05; // ssDNA / ssRNA
  if (g === 'III') return -0.03; // dsRNA often more fragile in handling
  return 0;
}

function packagingPenalty(genomeLength?: number | null): number {
  if (!genomeLength || genomeLength <= 0) return 0.05;
  const threshold = 65000;
  if (genomeLength <= threshold) return 0.05;
  const excess = genomeLength - threshold;
  const penalty = excess / 150000; // Rough scaling; cap below 0.35
  return Math.min(0.35, 0.05 + penalty);
}

function estimateMeltingTemp(gcContent?: number | null, baseIndex = 0.5): number {
  const gc = gcContent ?? 50;
  const gcNorm = normalize(gc, 35, 70);
  // Baseline 45–65°C depending on GC and intrinsic stability
  const baseTm = 45 + gcNorm * 15;
  const bonus = (baseIndex - 0.5) * 25;
  return Math.max(35, Math.min(85, baseTm + bonus));
}

function temperatureFactor(tempC: number, meltingTemp: number): number {
  if (tempC <= 4) return 1;
  if (tempC <= 25) {
    return clamp01(1 - (tempC - 4) * 0.012); // Gentle slope to room temp
  }
  if (tempC >= meltingTemp) return 0.1;
  const span = Math.max(1, meltingTemp - 25);
  const drop = (tempC - 25) / span;
  return clamp01(0.748 - drop * 0.65); // Falls toward ~0.1 near melting
}

function saltFactor(saltMilliMolar: number): number {
  const delta = Math.abs(saltMilliMolar - 100); // 100 mM sweet spot
  if (delta <= 50) return 1;
  if (delta <= 150) return clamp01(1 - delta / 300);
  return clamp01(0.55 - (delta - 150) / 500);
}

function statusFromIntegrity(integrity: number): StabilityStatus {
  if (integrity >= 0.75) return 'robust';
  if (integrity >= 0.5) return 'moderate';
  return 'fragile';
}

/**
 * Storage conditions, derived where the catalogue supports it.
 *
 * Only one distinction in the shipped data bears on storage strongly enough to
 * state: lipid-containing virions (PRD1 and PM2 in this catalogue) lose
 * infectivity on freezing and on contact with organic solvents, which is a
 * well-established handling difference and not a modelling choice. Everything
 * else -- exact temperature, exact ionic strength -- depends on buffer, titre
 * and the specific isolate, none of which this app knows.
 *
 * So this returns advice for the case it can justify and null for the rest,
 * rather than a plausible number for everyone.
 */
function deriveStorage(inputs: StabilityInputs): StabilityEstimate['recommendedStorage'] {
  const family = `${inputs.morphology ?? ''} ${inputs.family ?? ''}`.toLowerCase();
  const lipidContaining =
    family.includes('tectivir') || family.includes('corticovir') || family.includes('cystovir');

  if (lipidContaining) {
    return {
      temperatureC: 4,
      saltMilliMolar: 100,
      rationale:
        'Lipid-containing virion: refrigerate rather than freeze, and keep away from ' +
        'organic solvents such as chloroform, which strip the lipid envelope.',
    };
  }

  return null;
}

export function predictVirionStability(
  inputs: StabilityInputs,
  env: StabilityEnvironment
): StabilityEstimate {
  const gc = inputs.gcContent ?? 50;
  const gcNorm = normalize(gc, 35, 70);
  const morph = morphologyBoost(inputs.morphology);
  const baltimore = baltimoreBoost(inputs.baltimoreGroup);
  const packaging = packagingPenalty(inputs.genomeLength);

  const intrinsic = 0.53 + 0.32 * (gcNorm - 0.5) + morph + baltimore - packaging;
  const intrinsicClamped = clamp01(intrinsic);

  const meltingTemp = estimateMeltingTemp(gc, intrinsicClamped);
  const tempFactor = temperatureFactor(env.temperatureC, meltingTemp);
  const ionicFactor = saltFactor(env.saltMilliMolar);

  const integrity = clamp01(intrinsicClamped * tempFactor * ionicFactor);
  const status = statusFromIntegrity(integrity);

  const warnings: string[] = [];
  const notes: string[] = [];

  if (inputs.gcContent !== null && inputs.gcContent !== undefined && inputs.gcContent < 42) warnings.push('Low GC content reduces thermal robustness.');
  if ((inputs.genomeLength ?? 0) > 120_000) warnings.push('Large genome increases capsid pressure; avoid high temp.');
  if (env.temperatureC > 37) warnings.push('Handling above 37°C risks premature capsid softening.');
  if (env.saltMilliMolar < 30) warnings.push('Very low salt can disrupt capsid charge shielding.');
  if (env.saltMilliMolar > 250) warnings.push('High salt may destabilize some tail fibers / baseplates.');
  if (!inputs.pdbIds || inputs.pdbIds.length === 0) {
    notes.push('No PDB models linked; stability estimate uses heuristics only.');
  }

  const recommendedStorage = deriveStorage(inputs);

  return {
    baseIndex: intrinsicClamped,
    packagingPenalty: packaging,
    temperatureFactor: tempFactor,
    saltFactor: ionicFactor,
    integrity,
    meltingTempC: Math.round(meltingTemp * 10) / 10,
    recommendedStorage,
    status,
    warnings,
    notes,
  };
}

export function predictVirionStabilityFromPhage(
  phage: PhageFull | null,
  env: StabilityEnvironment
): StabilityEstimate {
  return predictVirionStability(
    {
      genomeLength: phage?.genomeLength,
      gcContent: phage?.gcContent,
      morphology: phage?.morphology,
      family: phage?.family,
      baltimoreGroup: phage?.baltimoreGroup,
      pdbIds: phage?.pdbIds,
    },
    env
  );
}

/** Measured first-order loss of plaque-forming infectivity, independent of the
 * composition illustration above. E[N_i] = exposure_i C_ref exp(-k (t_i-t_ref)).
 * The intercept is profiled analytically, not fixed to the first observed plate.
 * Poisson assay context: https://doi.org/10.1128/am.23.4.784-790.1972
 * First-order infectivity-loss context: https://pmc.ncbi.nlm.nih.gov/articles/PMC5040123/
 * These equations define a conditional model, not a reproduction of either study.
 */
export const INACTIVATION_METHOD = { id: 'plaque-count-inactivation', version: '1',
  implementation: 'Exact independent Poisson plate counts; exposure-aware exponential loss; analytic concentration profiling; monotone decay-rate score and likelihood support' } as const;
export const INACTIVATION_LIMITS = { bytes: 1_000_000, rows: 2048, count: 1_000_000, minutes: 10_000_000 } as const;
export interface InactivationOptions { supportDeviance: number }
export interface InactivationInput {
  format: 'phage-explorer-inactivation-input'; version: 1;
  measurement: 'infectious-plaque-counts'; title: string;
  provenance: { kind: 'user-supplied' | 'synthetic'; source: string; reference: string | null; license: string };
  preparation: { phageId: string; accession: string | null; batchId: string };
  conditions: { temperatureC: number; buffer: string; pH: number | null; assayHost: string; description: string };
  csv: string; options: InactivationOptions;
}
export interface InactivationFit {
  status: 'estimated' | 'zero-rate-boundary' | 'unbounded-rate' | 'unidentifiable';
  reason: string;
  referenceTimeMin: number; lastTimeMin: number;
  referencePFUPerMl: number;
  decayRatePerMin: number | null;
  log10LossPerMin: number | null;
  /** Conditional model times; null for zero, unbounded or unidentified rates. */
  halfLifeMin: number | null; oneLogReductionMin: number | null;
  support: {
    devianceCutoff: number; lowerRatePerMin: number; upperRatePerMin: number | null;
    lowerStatus: 'crossed' | 'zero-boundary'; upperStatus: 'crossed' | 'unbounded';
  };
  deviance: number;
  observations: number; distinctTimes: number; totalPlaques: number;
  fittedBasis: 'finite-mle' | 'limiting-mle' | 'zero-concentration' | 'common-time-concentration';
  fitted: Array<GrowthPlate & {
    predictedPFUPerMl: number; expectedCount: number;
    /** Null denotes an exact zero or a limiting zero, never a fabricated finite log. */
    logPredictedPFUPerMl: number | null; logExpectedCount: number | null;
    devianceResidual: number;
  }>;
  warnings: string[];
}

const inactivationObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function inactivationKeys(value: unknown, names: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!inactivationObject(value) || Object.keys(value).length !== names.length
    || Object.keys(value).some(key => !names.includes(key))) throw new Error(label + ' has missing or unsupported fields.');
}
function inactivationNumber(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(label + ' must be finite, between ' + min + ' and ' + max + '.');
  }
  return value;
}
function inactivationText(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(label + ' requires nonempty plain text, at most ' + max + ' characters.');
  }
  return value.trim();
}
function inactivationBoundedText(value: unknown): string {
  if (typeof value !== 'string' || value.length > INACTIVATION_LIMITS.bytes
    || new TextEncoder().encode(value).length > INACTIVATION_LIMITS.bytes) throw new Error('Inactivation input exceeds 1,000,000 UTF-8 bytes.');
  return value.replace(/^\uFEFF/, '');
}
function inactivationOptions(value: unknown): InactivationOptions {
  inactivationKeys(value, ['supportDeviance'], 'Inactivation options');
  return { supportDeviance: inactivationNumber(value.supportDeviance, .01, 100, 'Likelihood support deviance cutoff') };
}
function inactivationPlates(value: readonly GrowthPlate[]): GrowthPlate[] {
  if (!Array.isArray(value) || !value.length || value.length > INACTIVATION_LIMITS.rows) throw new Error('Provide 1–2048 independent exact-count plates.');
  return Array.from(value, (raw, i) => {
    if (inactivationObject(raw) && ('countStatus' in raw || 'censoring' in raw)) {
      throw new Error('Inactivation v1 supports exact plaque counts only; censored bounds and TNTC are unsupported.');
    }
    inactivationKeys(raw, ['timeMin', 'count', 'dilution', 'volumeMl'], 'Plate ' + (i + 1));
    const count = inactivationNumber(raw.count, 0, INACTIVATION_LIMITS.count, 'Exact plaque count');
    if (!Number.isSafeInteger(count)) throw new Error('Plaque counts must be exact nonnegative integers; bounds, TNTC and corrected PFU/mL are unsupported.');
    return {
      timeMin: inactivationNumber(raw.timeMin, 0, INACTIVATION_LIMITS.minutes, 'Time in minutes'), count,
      dilution: inactivationNumber(raw.dilution, 1e-12, 1, 'Dilution fraction, not its reciprocal'),
      volumeMl: inactivationNumber(raw.volumeMl, 1e-6, 10, 'Plated volume in mL'),
    };
  }).sort((a, b) => a.timeMin - b.timeMin || a.dilution - b.dilution || a.volumeMl - b.volumeMl || a.count - b.count);
}

/** Same exact count/exposure columns as plaque growth; a different time design.
 * One-time and all-zero inputs remain evidence with unidentified decay, not errors.
 */
export function parseInactivationCSV(content: string): GrowthPlate[] {
  const lines = inactivationBoundedText(content).split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
  const delimiter = lines[0]?.includes('\t') ? '\t' : ',';
  if (lines[0]?.split(delimiter).map(s => s.trim()).join(',') !== 'time_min,plaque_count,dilution_fraction,volume_ml') {
    throw new Error('Expected time_min,plaque_count,dilution_fraction,volume_ml. Inactivation v1 accepts exact counts only; count_status bounds and TNTC are unsupported.');
  }
  if (lines.length > INACTIVATION_LIMITS.rows + 1) throw new Error('Provide at most 2048 plates.');
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  return inactivationPlates(lines.slice(1).map((line, i) => {
    const cells = line.split(delimiter).map(s => s.trim());
    if (cells.length !== 4 || cells.some(cell => !decimal.test(cell))) {
      throw new Error('Line ' + (i + 2) + ': four explicit numeric values are required; blanks, missing values, bounds and TNTC are not exact counts.');
    }
    const [timeMin, count, dilution, volumeMl] = cells.map(Number);
    return { timeMin, count, dilution, volumeMl };
  }));
}
export function parseInactivationInput(content: string): InactivationInput {
  const value: unknown = JSON.parse(inactivationBoundedText(content));
  inactivationKeys(value, ['format', 'version', 'measurement', 'title', 'provenance', 'preparation', 'conditions', 'csv', 'options'], 'Inactivation input');
  if (value.format !== 'phage-explorer-inactivation-input' || value.version !== 1 || value.measurement !== 'infectious-plaque-counts') {
    throw new Error('Expected version 1 infectious-plaque-count inactivation input; growth curves, corrected titers and other assay endpoints are different models.');
  }
  inactivationKeys(value.provenance, ['kind', 'source', 'reference', 'license'], 'Inactivation provenance');
  if (value.provenance.kind !== 'user-supplied' && value.provenance.kind !== 'synthetic') throw new Error('Declare user-supplied or synthetic provenance explicitly.');
  inactivationKeys(value.preparation, ['phageId', 'accession', 'batchId'], 'Single phage preparation');
  inactivationKeys(value.conditions, ['temperatureC', 'buffer', 'pH', 'assayHost', 'description'], 'Fixed inactivation/assay conditions');
  if (typeof value.csv !== 'string') throw new Error('Embed the original exact-count plate CSV, not a filename.');
  parseInactivationCSV(value.csv);
  return {
    format: 'phage-explorer-inactivation-input', version: 1, measurement: 'infectious-plaque-counts',
    title: inactivationText(value.title, 'Title'),
    provenance: { kind: value.provenance.kind, source: inactivationText(value.provenance.source, 'Source', 2000),
      reference: value.provenance.reference === null ? null : inactivationText(value.provenance.reference, 'Reference', 2000),
      license: inactivationText(value.provenance.license, 'License or use restriction', 4000) },
    preparation: { phageId: inactivationText(value.preparation.phageId, 'Phage identity'),
      accession: value.preparation.accession === null ? null : inactivationText(value.preparation.accession, 'Accession'),
      batchId: inactivationText(value.preparation.batchId, 'Preparation/batch identity') },
    conditions: { temperatureC: inactivationNumber(value.conditions.temperatureC, -200, 200, 'Fixed temperature in degrees C'),
      buffer: inactivationText(value.conditions.buffer, 'Buffer description'),
      pH: value.conditions.pH === null ? null : inactivationNumber(value.conditions.pH, 0, 14, 'Reported pH'),
      assayHost: inactivationText(value.conditions.assayHost, 'Plating assay host'),
      description: inactivationText(value.conditions.description, 'Fixed conditions and independent-plate sampling description', 2000) },
    csv: value.csv, options: inactivationOptions(value.options),
  };
}

/** Compensated sums preserve small exposures and near-zero profile contrasts. */
function inactivationSum(values: readonly number[]): number {
  let sum = 0, correction = 0;
  for (const value of values) { const adjusted = value - correction, next = sum + adjusted; correction = (next - sum) - adjusted; sum = next; }
  return sum;
}
function inactivationLogSum(values: readonly number[]): number {
  const maximum = Math.max(...values);
  if (maximum === -Infinity) return -Infinity;
  return maximum + Math.log(inactivationSum(values.map(value => Math.exp(value - maximum))));
}
/** Monotone root with an explicit bracket. A budget failure never becomes a fit. */
function inactivationRoot(fn: (value: number) => number, low: number, high: number, increasing: boolean): number {
  for (let i = 0; i < 180; i++) {
    const middle = low + (high - low) / 2;
    if (middle === low || middle === high || high - low <= 2e-14 * Math.max(high, Number.MIN_VALUE)) return middle;
    const value = fn(middle);
    if (!Number.isFinite(value)) throw new Error('Inactivation profile exceeded the supported numerical range.');
    if (value === 0) return middle;
    if ((value < 0) === increasing) low = middle; else high = middle;
  }
  throw new Error('Inactivation profile did not converge within its bounded work budget.');
}
function inactivationBracket(fn: (value: number) => boolean, initial = 1): number {
  let high = initial;
  for (let i = 0; i < 256; i++, high *= 2) if (fn(high)) return high;
  throw new Error('Inactivation profile could not be bracketed within its supported numerical range; no finite bound was invented.');
}
const INACTIVATION_WARNINGS = [
  'Independent exact Poisson plaque counts with known dilution fractions and plated volumes, conditional on one preparation, fixed conditions and a constant first-order rate. Dilution error, biological overdispersion, correlated samples, plaque overlap and selective retention of countable plates are not modeled.',
  'Loss of plaque-forming infectivity is the endpoint; no capsid melting temperature, DNA-ejection mechanism, individual-particle lifetime, host susceptibility or genome-derived stability is inferred.',
  'The profile support set reoptimizes concentration at every rate. The supplied deviance cutoff is descriptive likelihood support, not a calibrated confidence interval, a significance test or biological validation.',
  'Half-life and one-log reduction time, when available, are conditional times from this fitted constant-rate model, not storage recommendations. Tail/shoulder kinetics and changes in conditions may violate the model; inspect all residuals.',
  'Temperature, buffer, pH, plating host, preparation identity, provenance and independence are supplied metadata. No cross-temperature Arrhenius model or extrapolation to other preparations, hosts or conditions is fitted.',
];

/** Profile C(k)=sum(count)/sum(exposure*exp(-k*dt)). With u=dt/span and
 * s=k*span, d[-log L_profile]/ds=N*(observed mean u - exposure-weighted mean u).
 * The derivative is monotone because its derivative is N*Var_weighted(u)>=0.
 * Thus a bracketed score finds the global finite optimum without random starts.
 */
export function fitInactivation(input: readonly GrowthPlate[], suppliedOptions: InactivationOptions): InactivationFit {
  const plates = inactivationPlates(input), options = inactivationOptions(suppliedOptions);
  const referenceTimeMin = plates[0].timeMin, lastTimeMin = plates.at(-1)!.timeMin, span = lastTimeMin - referenceTimeMin;
  const totalPlaques = inactivationSum(plates.map(p => p.count));
  const logExposure = plates.map(p => Math.log(p.dilution) + Math.log(p.volumeMl));
  const u = plates.map(p => span ? (p.timeMin - referenceTimeMin) / span : 0);
  if (span && plates.some((p, i) => p.timeMin > referenceTimeMin && u[i] === 0)) {
    throw new Error('Sampling-time separation exceeds the supported numerical range; distinct times cannot be collapsed.');
  }
  const observedMean = totalPlaques ? inactivationSum(plates.map((p, i) => p.count * u[i])) / totalPlaques : 0;
  if (observedMean === 0 && plates.some((p, i) => p.count > 0 && u[i] > 0)) {
    throw new Error('Count-weighted sampling times exceed the supported numerical range; later positive counts cannot be treated as earliest-only evidence.');
  }
  const profile = (s: number) => {
    const logs = logExposure.map((e, i) => e - s * u[i]), maximum = Math.max(...logs);
    const weights = logs.map(value => Math.exp(value - maximum)), sum = inactivationSum(weights);
    return { logExposure: maximum + Math.log(sum), weights, sum,
      mean: inactivationSum(weights.map((weight, i) => weight * u[i])) / sum };
  };
  let status: InactivationFit['status'], reason: string, fittedBasis: InactivationFit['fittedBasis'];
  let s: number | null = null, lower = 0, upper: number | null = null;
  const atZero = profile(0);
  if (!span) {
    status = 'unidentifiable'; reason = 'All plates have one sampling time; concentration is estimable at that time but a decay rate is not.';
    fittedBasis = totalPlaques ? 'common-time-concentration' : 'zero-concentration';
  } else if (!totalPlaques) {
    status = 'unidentifiable'; reason = 'Every plate contains zero plaques. Zero concentration maximizes likelihood for every nonnegative decay rate; these data do not identify an inactivation rate.';
    fittedBasis = 'zero-concentration';
  } else if (observedMean === 0) {
    status = 'unbounded-rate'; reason = 'All positive counts occur at the earliest time, with only zero counts later. Likelihood improves toward an infinite rate; no finite rate or loss time is estimated.';
    fittedBasis = 'limiting-mle';
    const earliest = inactivationLogSum(logExposure.filter((_, i) => u[i] === 0));
    const later = logExposure.flatMap((exposure, i) => u[i] > 0 ? [{ exposure, time: u[i] }] : []);
    const loss = (rate: number) => {
      const ratio = inactivationLogSum(later.map(p => p.exposure - rate * p.time)) - earliest;
      return 2 * totalPlaques * (ratio > 0 ? ratio + Math.log1p(Math.exp(-ratio)) : Math.log1p(Math.exp(ratio)));
    };
    if (loss(0) > options.supportDeviance) {
      const high = inactivationBracket(rate => loss(rate) <= options.supportDeviance);
      lower = inactivationRoot(rate => loss(rate) - options.supportDeviance, 0, high, false);
    }
  } else {
    fittedBasis = 'finite-mle';
    if (observedMean >= atZero.mean) {
      s = 0; status = 'zero-rate-boundary';
      reason = 'The constrained likelihood optimum is zero decay. A boundary estimate does not establish absence of inactivation; the support set includes positive rates.';
    } else {
      const score = (rate: number) => observedMean - profile(rate).mean;
      s = inactivationRoot(score, 0, inactivationBracket(rate => score(rate) >= 0), true);
      status = 'estimated'; reason = 'A finite nonnegative first-order rate and reference concentration maximize the exact-count Poisson likelihood.';
    }
    const best = profile(s), optimum = s;
    const loss = (rate: number) => {
      // Center at the observed mean; the linear log-likelihood term is absorbed.
      // expm1/log1p avoid subtracting two large almost-equal log likelihoods.
      const x = u.map(time => -(rate - optimum) * (time - observedMean));
      const difference = Math.max(...x.map(Math.abs)) <= .5
        ? Math.log1p(inactivationSum(best.weights.map((w, i) => w * Math.expm1(x[i]))) / best.sum)
        : inactivationLogSum(logExposure.map((e, i) => e - optimum * u[i] + x[i])) - best.logExposure;
      return Math.max(0, 2 * totalPlaques * difference);
    };
    if (s > 0 && loss(0) > options.supportDeviance) {
      lower = inactivationRoot(rate => loss(rate) - options.supportDeviance, 0, s, false);
    }
    const high = inactivationBracket(rate => loss(rate) >= options.supportDeviance, Math.max(1, s * 2));
    upper = inactivationRoot(rate => loss(rate) - options.supportDeviance, s, high, true);
  }
  const fittedExposure = fittedBasis === 'limiting-mle'
    ? inactivationLogSum(logExposure.filter((_, i) => u[i] === 0)) : profile(s ?? 0).logExposure;
  const logConcentration = totalPlaques ? Math.log(totalPlaques) - fittedExposure : null;
  const referencePFUPerMl = logConcentration === null ? 0 : Math.exp(logConcentration);
  const fitted = plates.map((p, i) => {
    const zero = !totalPlaques || fittedBasis === 'limiting-mle' && u[i] > 0;
    const logPredictedPFUPerMl = zero ? null : logConcentration! - (s ?? 0) * u[i];
    const logExpectedCount = logPredictedPFUPerMl === null ? null : logPredictedPFUPerMl + logExposure[i];
    const predictedPFUPerMl = logPredictedPFUPerMl === null ? 0 : Math.exp(logPredictedPFUPerMl);
    const expectedCount = logExpectedCount === null ? 0 : Math.exp(logExpectedCount);
    // Shared exact Poisson likelihood supplies normal-range deviance. Preserve
    // finite log means when exp(logMean) underflows, without replacing zero plates.
    const deviance = expectedCount || !p.count
      ? Math.max(0, -2 * (poissonCountLogProbability(p.count, expectedCount, 'exact') - poissonCountLogProbability(p.count, p.count, 'exact')))
      : 2 * (p.count * (Math.log(p.count) - logExpectedCount!) - p.count);
    if (![expectedCount, predictedPFUPerMl, deviance].every(Number.isFinite)) throw new Error('Inactivation fit exceeds supported numerical output range.');
    return { ...p, predictedPFUPerMl, expectedCount, logPredictedPFUPerMl, logExpectedCount,
      devianceResidual: (p.count >= expectedCount ? 1 : -1) * Math.sqrt(deviance) };
  });
  const physicalRate = (value: number): number => {
    const rate = value / span;
    if (!Number.isFinite(rate) || value > 0 && rate === 0) throw new Error('Derived decay rate exceeds the supported numerical range; no finite rate or bound was invented.');
    return rate;
  };
  const decayRatePerMin = s === null ? null : physicalRate(s);
  const lossTime = (amount: number): number | null => {
    if (decayRatePerMin === null || decayRatePerMin === 0) return null;
    const value = amount / decayRatePerMin;
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const warnings = [...INACTIVATION_WARNINGS];
  if (status !== 'estimated') warnings.push(reason);
  if (lower === 0) warnings.push('Zero decay lies in the support set. A finite upper bound on a reduction time is therefore unavailable.');
  if (fitted.some(p => p.expectedCount === 0 && p.logExpectedCount !== null)) warnings.push('Very small positive fitted means underflow in ordinary numeric units; their finite natural-log values remain in the complete output.');
  const halfLifeMin = lossTime(Math.LN2), oneLogReductionMin = lossTime(Math.LN10);
  if ((halfLifeMin !== null && halfLifeMin > span) || (oneLogReductionMin !== null && oneLogReductionMin > span)) {
    warnings.push('At least one conditional reduction time exceeds the observed duration. It is a model extrapolation, not an observed storage lifetime.');
  }
  return {
    status, reason, referenceTimeMin, lastTimeMin, referencePFUPerMl, decayRatePerMin,
    log10LossPerMin: decayRatePerMin === null ? null : decayRatePerMin / Math.LN10,
    halfLifeMin, oneLogReductionMin,
    support: { devianceCutoff: options.supportDeviance, lowerRatePerMin: span ? physicalRate(lower) : 0,
      upperRatePerMin: upper === null ? null : physicalRate(upper),
      lowerStatus: lower > 0 ? 'crossed' : 'zero-boundary', upperStatus: upper === null ? 'unbounded' : 'crossed' },
    deviance: inactivationSum(fitted.map(p => p.devianceResidual ** 2)), observations: plates.length,
    distinctTimes: new Set(plates.map(p => p.timeMin)).size, totalPlaques, fittedBasis, fitted, warnings,
  };
}

export async function createInactivationRecord(content: string): Promise<AnalysisRecord> {
  const input = parseInactivationInput(content), plates = parseInactivationCSV(input.csv), fit = fitInactivation(plates, input.options);
  const demo = input.provenance.kind === 'synthetic';
  const coverage = { available: plates.length, total: plates.length, unit: 'records' as const };
  const base = { units: 'records' as const, coverage, limitations: fit.warnings };
  const assumptions = ['Explicit author-declared synthetic plates; conditional first-order Poisson model, not experimental calibration.'];
  const fitField: AnalysisField = demo
    ? { ...base, label: 'Synthetic inactivation fit and complete likelihood support', kind: 'demo', value: analysisJson(fit), assumptions }
    : { ...base, label: 'Conditional first-order inactivation fit and complete likelihood support', kind: 'fitted-estimate', value: analysisJson(fit),
      fit: { dataInput: 'experiment', objective: 'Exact-count independent Poisson likelihood with exposure and profiled reference concentration; support cutoff does not define calibrated coverage.',
        uncertainty: { kind: 'not-estimated' } } };
  const platesField: AnalysisField = demo
    ? { ...base, label: 'Complete synthetic exact-count plates', kind: 'demo', value: analysisJson(plates), assumptions }
    : { ...base, label: 'Complete supplied exact-count plates and exposures', kind: 'observation', value: analysisJson(plates), sourceInput: 'experiment' };
  return createAnalysisRecord({ method: INACTIVATION_METHOD,
    inputs: [{ id: 'experiment', accession: null, source: demo ? 'demo' : 'local',
      description: 'Exact original inactivation experiment JSON, including preparation, fixed conditions, plate CSV, attribution and license.', data: content }],
    parameters: { ...input.options }, seed: null,
    references: [
      { id: 'assay-source', version: 'author-supplied', description: input.provenance.source + '; reference ' + (input.provenance.reference ?? 'not supplied') + '; license ' + input.provenance.license },
      { id: 'poisson-plate-assay', version: 'Wyshak-Detre-1972', description: 'https://doi.org/10.1128/am.23.4.784-790.1972; context for independent plaque-count likelihood with known exposure.' },
      { id: 'first-order-infectivity-loss', version: 'conditional-model-1', description: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5040123/; exponential infectivity loss is a model assumption, not universal kinetics or a reproduction of the study.' },
      { id: 'profile-support', version: 'Raue-2009', description: 'https://doi.org/10.1093/bioinformatics/btp358; reoptimize reference concentration for every nonnegative decay rate. A supplied deviance cutoff defines descriptive support, not calibrated confidence.' },
    ], fields: { fit: fitField, plates: platesField } });
}
export async function replayInactivationRecord(content: string): Promise<AnalysisRecord> {
  const saved = await parseAnalysisRecord(content, { methodId: INACTIVATION_METHOD.id, methodVersion: INACTIVATION_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'experiment' || typeof saved.inputs[0].data !== 'string') {
    throw new Error('Inactivation replay requires one embedded original experiment.');
  }
  const fresh = await createInactivationRecord(saved.inputs[0].data);
  if (serializeAnalysisRecord(fresh) !== serializeAnalysisRecord(saved)) throw new Error('Recomputed inactivation likelihood, support, source or interpretation differs from the saved evidence.');
  return fresh;
}
/** Export all observations and fitted rows, never only a displayed page. */
export function exportInactivationTsv(record: AnalysisRecord): string {
  if (record.method.id !== INACTIVATION_METHOD.id || record.method.version !== INACTIVATION_METHOD.version
    || record.inputs.length !== 1 || record.inputs[0].id !== 'experiment' || typeof record.inputs[0].data !== 'string' || !record.fields.fit) {
    throw new Error('Expected accepted inactivation evidence. Replay imported records before exporting.');
  }
  const input = parseInactivationInput(record.inputs[0].data), fit = record.fields.fit.value as unknown as InactivationFit;
  const cell = (value: string | number | null): string => {
    const raw = value === null ? 'NA' : typeof value === 'number' ? String(value) : /^[=+\-@]/.test(value) ? "'" + value : value;
    return /[\t\r\n"]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
  };
  const json = (value: unknown) => JSON.stringify(value);
  const metadata = [
    '# method=' + record.method.id + '; version=' + record.method.version + '; result=' + record.resultId,
    '# title=' + json(input.title) + '; provenance=' + json(input.provenance),
    '# preparation=' + json(input.preparation) + '; fixed_conditions=' + json(input.conditions),
    '# model=expected_count=exposure*C_ref*exp(-k*(time-reference_time)); rate_units=1/minute; concentration_units=PFU/mL',
    '# status=' + fit.status + '; reason=' + json(fit.reason) + '; fitted_basis=' + fit.fittedBasis,
    '# reference_time_min=' + fit.referenceTimeMin + '; last_time_min=' + fit.lastTimeMin + '; reference_pfu_per_ml=' + fit.referencePFUPerMl,
    '# decay_rate_per_min=' + cell(fit.decayRatePerMin) + '; log10_loss_per_min=' + cell(fit.log10LossPerMin)
      + '; half_life_min=' + cell(fit.halfLifeMin) + '; one_log_reduction_min=' + cell(fit.oneLogReductionMin),
    '# profile_support=' + json(fit.support) + '; null_upper=unbounded; support_is_not_a_calibrated_confidence_interval',
    '# deviance=' + fit.deviance + '; observations=' + fit.observations + '; distinct_times=' + fit.distinctTimes + '; total_plaques=' + fit.totalPlaques,
    ...fit.warnings.map(warning => '# limitation=' + json(warning)),
  ];
  return [...metadata, 'time_min\tplaque_count\tdilution_fraction\tvolume_ml\tpredicted_pfu_per_ml\texpected_count\tlog_predicted_pfu_per_ml\tlog_expected_count\tdeviance_residual',
    ...fit.fitted.map(p => [p.timeMin, p.count, p.dilution, p.volumeMl, p.predictedPFUPerMl, p.expectedCount,
      p.logPredictedPFUPerMl, p.logExpectedCount, p.devianceResidual].map(cell).join('\t'))].join('\n') + '\n';
}
export function createInactivationTemplate(): InactivationInput {
  return { format: 'phage-explorer-inactivation-input', version: 1, measurement: 'infectious-plaque-counts',
    title: 'Synthetic exponential-loss arithmetic example',
    provenance: { kind: 'synthetic', source: 'Hand-specified counts declining by one half every 10 minutes; not experimental observations.', reference: null, license: 'CC0-1.0' },
    preparation: { phageId: 'synthetic-phage', accession: null, batchId: 'synthetic-preparation' },
    conditions: { temperatureC: 25, buffer: 'Artificial example buffer; no empirical properties.', pH: null,
      assayHost: 'Synthetic assay host', description: 'Independent synthetic exact-count plates from one invented preparation at fixed conditions.' },
    csv: 'time_min,plaque_count,dilution_fraction,volume_ml\n0,160,0.001,0.1\n10,80,0.001,0.1\n20,40,0.001,0.1\n30,20,0.001,0.1\n',
    options: { supportDeviance: 3.84 },
  };
}
