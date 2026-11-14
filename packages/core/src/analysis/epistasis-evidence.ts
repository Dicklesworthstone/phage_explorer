/**
 * Measured four-genotype assay contrasts, separate from the BLOSUM illustration.
 * e = mean(g(AB)) - mean(g(A)) - mean(g(B)) + mean(g(WT)).
 * g is explicitly identity or natural log; no assay is silently called fitness.
 *
 * Scale choice: Sackman & Rokyta, Genetics 208 (2018), 339–348,
 * https://doi.org/10.1534/genetics.117.300451 . This is a general contrast,
 * not a reproduction or a reanalysis of their experimental data.
 * Bootstrap sampling units follow the declared independent/paired design:
 * https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html
 */
import {
  analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord,
  type AnalysisField, type AnalysisRecord,
} from '../analysis-result';

export const EPISTASIS_ASSAY_METHOD = {
  id: 'measured-epistasis-assay', version: '1',
  implementation: 'four-genotype sample-mean contrast on an explicit identity/natural-log scale; independent or complete-block paired replicates; optional seeded percentile bootstrap',
} as const;
export const EPISTASIS_ASSAY_LIMITS = {
  bytes: 2 * 1024 * 1024, proteinResidues: 20_000, observations: 4096, variants: 1024,
  pairs: 512, pairObservationUses: 50_000, bootstrapSamples: 2000, bootstrapDraws: 20_000_000,
} as const;

export interface EpistasisAssayDataset {
  format: 'phage-explorer-epistasis-assay';
  version: 1;
  name: string;
  source: { kind: 'local' | 'demo'; description: string; reference: string | null; license: string };
  protein: { id: string; accession: string | null; sequence: string };
  assay: {
    name: string; units: string; conditions: string;
    scale: 'identity' | 'natural-log';
    /** Replicate IDs identify independent units, or matched blocks across genotypes. */
    replicateDesign: 'independent' | 'paired';
  };
  observations: Array<{ variant: string; replicateId: string; value: number }>;
}
export interface EpistasisAssayOptions { bootstrapSamples: number; seed: number }
export interface EpistasisAssayMutation { position: number; from: string; to: string }
export interface EpistasisAssayVariant {
  variant: string;
  mutations: EpistasisAssayMutation[];
  observations: number;
  rawMean: number;
  transformedMean: number;
  transformedStandardDeviation: number | null;
}
export interface EpistasisAssayPair {
  variant: string;
  singleA: string;
  singleB: string;
  positions: [number, number];
  status: 'estimated' | 'unavailable';
  /** Means and counts actually used for this contrast, not unmatched global means. */
  components: Array<{ variant: string; observations: number; transformedMean: number | null }>;
  missingVariants: string[];
  completeBlocks: string[];
  incompleteBlocks: Array<{ replicateId: string; missingVariants: string[] }>;
  observedDouble: number | null;
  expectedDouble: number | null;
  contrast: number | null;
  standardError: number | null;
  interval95: [number, number] | null;
  uncertainty: {
    method: 'independent-replicate-variance' | 'paired-block-contrast-variance' | null;
    bootstrapSamples: number;
    reason: string;
  };
  warnings: string[];
}
export interface EpistasisAssayResult {
  scale: EpistasisAssayDataset['assay']['scale'];
  replicateDesign: EpistasisAssayDataset['assay']['replicateDesign'];
  /** Identity: the supplied assay unit. Natural log: a dimensionless log contrast. */
  contrastUnits: string;
  formula: string;
  options: EpistasisAssayOptions;
  observations: Array<EpistasisAssayDataset['observations'][number] & { transformedValue: number }>;
  variants: EpistasisAssayVariant[];
  pairs: EpistasisAssayPair[];
  coverage: { observations: number; variants: number; doubleVariants: number; estimatedPairs: number; unavailablePairs: number };
  warnings: string[];
}
export interface EpistasisAssayExperiment {
  dataset: EpistasisAssayDataset;
  result: EpistasisAssayResult;
  record: AnalysisRecord;
}

const AMINO_ACIDS = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function keys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) {
    throw new Error(label + ' has missing or unsupported fields.');
  }
}
function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(label + ' requires nonempty plain text, at most ' + maximum + ' characters.');
  }
  return value.trim();
}
function size(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > EPISTASIS_ASSAY_LIMITS.bytes) {
    throw new Error('Epistasis assay input exceeds the 2 MiB limit.');
  }
}
function variant(value: unknown, sequence: string): { variant: string; mutations: EpistasisAssayMutation[] } {
  const id = text(value, 'Variant', 64);
  if (id === 'WT') return { variant: id, mutations: [] };
  const parts = id.split(':');
  if (parts.length > 2) throw new Error('Use WT, one substitution (A1C), or two substitutions (A1C:C2D). Higher-order variants are unsupported.');
  const mutations = parts.map(part => {
    const match = /^([ACDEFGHIKLMNPQRSTVWY])([1-9][0-9]*)([ACDEFGHIKLMNPQRSTVWY])$/.exec(part);
    if (!match) throw new Error('Variant ' + id + ' must use uppercase amino-acid substitutions and one-based positions; indels, stops and ambiguous residues are unsupported.');
    const position = Number(match[2]), from = match[1], to = match[3];
    if (!Number.isSafeInteger(position) || position > sequence.length || sequence[position - 1] !== from) {
      throw new Error('Variant ' + id + ' does not match the exact reference protein at its one-based position.');
    }
    if (from === to) throw new Error('A substitution must change the reference residue; use WT for the unmodified protein.');
    return { position, from, to };
  }).sort((a, b) => a.position - b.position);
  if (mutations.length === 2 && mutations[0].position === mutations[1].position) {
    throw new Error('A double mutant must affect two different positions.');
  }
  return { variant: mutations.map(mutation => mutation.from + mutation.position + mutation.to).join(':'), mutations };
}

export function validateEpistasisAssayDataset(value: unknown): EpistasisAssayDataset {
  if (!object(value) || value.format !== 'phage-explorer-epistasis-assay' || value.version !== 1) {
    throw new Error('Unsupported epistasis assay format/version.');
  }
  keys(value, ['format', 'version', 'name', 'source', 'protein', 'assay', 'observations'], 'Epistasis assay');
  if (!object(value.source) || !object(value.protein) || !object(value.assay)) throw new Error('Explicit source, reference protein and assay metadata are required.');
  keys(value.source, ['kind', 'description', 'reference', 'license'], 'Assay source');
  if (value.source.kind !== 'local' && value.source.kind !== 'demo') throw new Error('Assay source must be local or demo; provenance is supplied, not independently authenticated.');
  const source: EpistasisAssayDataset['source'] = {
    kind: value.source.kind, description: text(value.source.description, 'Source description', 2000),
    reference: value.source.reference === null ? null : text(value.source.reference, 'Source reference', 2000),
    license: text(value.source.license, 'Source license or use restriction', 4000),
  };
  keys(value.protein, ['id', 'accession', 'sequence'], 'Reference protein');
  const sequence = value.protein.sequence;
  if (typeof sequence !== 'string' || !sequence.length || sequence.length > EPISTASIS_ASSAY_LIMITS.proteinResidues || !AMINO_ACIDS.test(sequence)) {
    throw new Error('Reference protein requires 1–20,000 exact uppercase canonical amino acids; gaps, unknown residues and stops are unsupported.');
  }
  const protein: EpistasisAssayDataset['protein'] = {
    id: text(value.protein.id, 'Protein ID', 120), sequence,
    accession: value.protein.accession === null ? null : text(value.protein.accession, 'Protein accession', 120),
  };
  keys(value.assay, ['name', 'units', 'conditions', 'scale', 'replicateDesign'], 'Assay metadata');
  if (value.assay.scale !== 'identity' && value.assay.scale !== 'natural-log') throw new Error('Choose identity or natural-log explicitly; assay units do not imply a transformation.');
  if (value.assay.replicateDesign !== 'independent' && value.assay.replicateDesign !== 'paired') throw new Error('Declare independent replicates or matched paired blocks explicitly.');
  const assay: EpistasisAssayDataset['assay'] = {
    name: text(value.assay.name, 'Assay name'), units: text(value.assay.units, 'Assay units', 120),
    conditions: text(value.assay.conditions, 'Assay conditions and independent sampling unit', 2000),
    scale: value.assay.scale, replicateDesign: value.assay.replicateDesign,
  };
  if (!Array.isArray(value.observations) || !value.observations.length || value.observations.length > EPISTASIS_ASSAY_LIMITS.observations) {
    throw new Error('Supply 1–4096 measured replicate observations. Missing values cannot be represented as zero.');
  }
  const identities = new Map<string, Set<string>>(), variants = new Set<string>(), doubles = new Set<string>();
  const observations = Array.from(value.observations, (row): EpistasisAssayDataset['observations'][number] => {
    if (!object(row)) throw new Error('Assay observations must be plain objects.');
    keys(row, ['variant', 'replicateId', 'value'], 'Assay observation');
    const parsed = variant(row.variant, sequence), replicateId = text(row.replicateId, 'Independent replicate or block ID', 120);
    const measured = row.value;
    if (typeof measured !== 'number' || !Number.isFinite(measured) || Math.abs(measured) > 1e12) {
      throw new Error('Observed assay values must be finite numbers with magnitude at most 1e12; blanks, censoring and NA are not zeros.');
    }
    if (assay.scale === 'natural-log' && measured <= 0) throw new Error('Natural-log analysis requires strictly positive observed values; no pseudocount is added.');
    let seen = identities.get(parsed.variant);
    if (!seen) { seen = new Set(); identities.set(parsed.variant, seen); }
    if (seen.has(replicateId)) throw new Error('Duplicate variant/replicate identity: ' + parsed.variant + ' / ' + replicateId + '. Technical replicates must first be summarized within their independent unit.');
    seen.add(replicateId); variants.add(parsed.variant);
    if (parsed.mutations.length === 2) doubles.add(parsed.variant);
    return { variant: parsed.variant, replicateId, value: measured };
  }).sort((a, b) => order(a.variant, b.variant) || order(a.replicateId, b.replicateId));
  if (variants.size > EPISTASIS_ASSAY_LIMITS.variants || doubles.size > EPISTASIS_ASSAY_LIMITS.pairs) {
    throw new Error('Assay input exceeds 1024 variant groups or 512 measured double mutants. No variants are silently truncated.');
  }
  const dataset: EpistasisAssayDataset = {
    format: 'phage-explorer-epistasis-assay', version: 1, name: text(value.name, 'Dataset name'), source, protein, assay, observations,
  };
  size(dataset);
  return dataset;
}

export function parseEpistasisAssayDataset(content: string): EpistasisAssayDataset {
  if (typeof content !== 'string' || content.length > EPISTASIS_ASSAY_LIMITS.bytes || new TextEncoder().encode(content).length > EPISTASIS_ASSAY_LIMITS.bytes) {
    throw new Error('Epistasis assay input exceeds the 2 MiB limit.');
  }
  return validateEpistasisAssayDataset(JSON.parse(content.replace(/^\uFEFF/, '')));
}

/** CSV/TSV only supplies observations; the caller must supply the exact assay/protein metadata. */
export function parseEpistasisAssayCsv(content: string, metadata: Omit<EpistasisAssayDataset, 'observations'>): EpistasisAssayDataset {
  if (typeof content !== 'string' || content.length > EPISTASIS_ASSAY_LIMITS.bytes || new TextEncoder().encode(content).length > EPISTASIS_ASSAY_LIMITS.bytes) {
    throw new Error('Epistasis assay table exceeds the 2 MiB limit.');
  }
  const lines = content.replace(/^\uFEFF/, '').trim().split(/\r\n?|\n/), separator = lines[0].includes('\t') ? '\t' : ',';
  if (lines[0].split(separator).map(cell => cell.trim()).join(',') !== 'variant,replicate_id,value') {
    throw new Error('Expected variant,replicate_id,value CSV/TSV header with explicit assay/protein metadata supplied separately.');
  }
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const observations = lines.slice(1).map((line, index) => {
    const cells = line.split(separator).map(cell => cell.trim());
    if (cells.length !== 3 || cells.some(cell => cell.includes('"')) || !numeric.test(cells[2])) throw new Error('Invalid assay observation at line ' + (index + 2) + '; blanks, quoted tables and censoring require an explicit supported dataset.');
    return { variant: cells[0], replicateId: cells[1], value: Number(cells[2]) };
  });
  return validateEpistasisAssayDataset({ ...metadata, observations });
}

export function resolveEpistasisAssayOptions(value: unknown = {}): EpistasisAssayOptions {
  if (!object(value) || Object.keys(value).some(key => key !== 'bootstrapSamples' && key !== 'seed')) throw new Error('Unsupported epistasis assay options.');
  const bootstrapSamples = value.bootstrapSamples === undefined ? 1000 : value.bootstrapSamples;
  const seed = value.seed === undefined ? 1 : value.seed;
  if (!Number.isInteger(bootstrapSamples) || typeof bootstrapSamples !== 'number'
    || (bootstrapSamples !== 0 && (bootstrapSamples < 200 || bootstrapSamples > EPISTASIS_ASSAY_LIMITS.bootstrapSamples))) {
    throw new Error('Bootstrap samples must be 0 (disabled) or an integer from 200 to 2000.');
  }
  if (!Number.isInteger(seed) || typeof seed !== 'number' || seed < 0 || seed > 0xffffffff) throw new Error('Bootstrap seed must be an unsigned 32-bit integer; zero is supported.');
  return { bootstrapSamples, seed };
}

function mean(values: readonly number[]): number {
  let sum = 0, correction = 0;
  for (const value of values) {
    const adjusted = value - correction, next = sum + adjusted;
    correction = (next - sum) - adjusted; sum = next;
  }
  return sum / values.length;
}
function sampleVariance(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  return mean(values.map(value => (value - average) ** 2)) * values.length / (values.length - 1);
}
function randomFor(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
function resampledMean(values: readonly number[], random: () => number): number {
  let sum = 0, correction = 0;
  for (let i = 0; i < values.length; i++) {
    const adjusted = values[Math.floor(random() * values.length)] - correction, next = sum + adjusted;
    correction = (next - sum) - adjusted; sum = next;
  }
  return sum / values.length;
}
function quantile(sorted: number[], probability: number): number {
  const index = (sorted.length - 1) * probability, lower = Math.floor(index), fraction = index - lower;
  return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]);
}
function contrast(values: readonly number[]): number { return (values[3] - values[1]) - (values[2] - values[0]); }

export function analyzeEpistasisAssay(
  input: EpistasisAssayDataset, settings: Partial<EpistasisAssayOptions> = {}, progress: (phase: string) => void = () => {},
): EpistasisAssayResult {
  const dataset = validateEpistasisAssayDataset(input), options = resolveEpistasisAssayOptions(settings);
  const { assay } = dataset, paired = assay.replicateDesign === 'paired';
  const observations = dataset.observations.map(row => ({ ...row, transformedValue: assay.scale === 'natural-log' ? Math.log(row.value) : row.value }));
  const groups = new Map<string, typeof observations>();
  for (const row of observations) {
    const group = groups.get(row.variant);
    if (group) group.push(row); else groups.set(row.variant, [row]);
  }
  const variants: EpistasisAssayVariant[] = [...groups].map(([id, rows]) => {
    const values = rows.map(row => row.transformedValue), variance = sampleVariance(values);
    return { ...variant(id, dataset.protein.sequence), observations: rows.length,
      rawMean: mean(rows.map(row => row.value)), transformedMean: mean(values),
      transformedStandardDeviation: variance === null ? null : Math.sqrt(variance) };
  });
  const doubles = variants.filter(row => row.mutations.length === 2);
  const random = randomFor(options.seed); let draws = 0, observationUses = 0;
  const pairs: EpistasisAssayPair[] = doubles.map((double, index) => {
    progress('Measured epistasis contrasts ' + (index + 1) + '/' + doubles.length);
    const [singleA, singleB] = double.variant.split(':'), ids = ['WT', singleA, singleB, double.variant];
    const original = ids.map(id => groups.get(id) ?? []), missingVariants = ids.filter((_, i) => !original[i].length);
    observationUses += original.reduce((sum, rows) => sum + rows.length, 0);
    if (observationUses > EPISTASIS_ASSAY_LIMITS.pairObservationUses) {
      throw new Error('Epistasis evidence exceeds 50,000 observation uses across its four-genotype comparisons. Analyze fewer double mutants; no incomplete-block lists are silently truncated.');
    }
    const completeBlocks: string[] = [], incompleteBlocks: EpistasisAssayPair['incompleteBlocks'] = [];
    if (paired) {
      const blocks = [...new Set(original.flatMap(rows => rows.map(row => row.replicateId)))].sort(order);
      const blockSets = original.map(rows => new Set(rows.map(row => row.replicateId)));
      for (const replicateId of blocks) {
        const missing = ids.filter((_, i) => !blockSets[i].has(replicateId));
        if (missing.length) incompleteBlocks.push({ replicateId, missingVariants: missing }); else completeBlocks.push(replicateId);
      }
    }
    const complete = new Set(completeBlocks);
    const selected = original.map(rows => paired ? rows.filter(row => complete.has(row.replicateId)) : rows);
    const values = selected.map(rows => rows.map(row => row.transformedValue));
    const available = !missingVariants.length && (!paired || completeBlocks.length > 0);
    const pair: EpistasisAssayPair = {
      variant: double.variant, singleA, singleB, positions: [double.mutations[0].position, double.mutations[1].position],
      status: available ? 'estimated' : 'unavailable',
      components: ids.map((id, i) => ({ variant: id, observations: selected[i].length, transformedMean: selected[i].length ? mean(values[i]) : null })),
      missingVariants, completeBlocks, incompleteBlocks,
      observedDouble: null, expectedDouble: null, contrast: null, standardError: null, interval95: null,
      uncertainty: { method: null, bootstrapSamples: 0, reason: '' }, warnings: [],
    };
    if (!available) {
      pair.uncertainty.reason = missingVariants.length ? 'Missing measured genotypes: ' + missingVariants.join(', ') + '.'
        : 'No complete matched block contains WT, both singles and the double mutant.';
      return pair;
    }
    const means = values.map(mean), blockContrasts = paired ? completeBlocks.map((_, i) => contrast(values.map(group => group[i]))) : [];
    pair.observedDouble = means[3]; pair.expectedDouble = means[1] + (means[2] - means[0]);
    pair.contrast = paired ? mean(blockContrasts) : contrast(means);
    if (incompleteBlocks.length) pair.warnings.push('Only complete matched blocks enter this contrast; every excluded incomplete block remains listed. Missingness may bias the retained comparison.');
    const samples = paired ? [blockContrasts] : values;
    const variances = samples.map(sampleVariance);
    if (variances.some(value => value === null)) {
      pair.uncertainty.reason = paired ? 'At least two complete independent blocks are needed for an empirical standard error.'
        : 'At least two independent replicates per genotype are needed for an empirical standard error.';
      return pair;
    }
    pair.uncertainty.method = paired ? 'paired-block-contrast-variance' : 'independent-replicate-variance';
    pair.standardError = Math.sqrt(variances.reduce<number>((sum, variance, i) => sum + variance! / samples[i].length, 0));
    if (!options.bootstrapSamples) {
      pair.uncertainty.reason = 'Bootstrap disabled. Standard error is estimated from the declared independent sampling units; no interval is supplied.';
      return pair;
    }
    if (samples.some(rows => rows.length < 3)) {
      pair.uncertainty.reason = 'Bootstrap interval unavailable with fewer than three independent units in any required group; the empirical standard error alone does not establish precision.';
      return pair;
    }
    if (pair.standardError === 0) {
      pair.uncertainty.reason = 'Observed sampling-unit contrasts have no empirical variation. A zero-width bootstrap interval would not establish zero measurement uncertainty.';
      return pair;
    }
    draws += options.bootstrapSamples * samples.reduce((sum, rows) => sum + rows.length, 0);
    if (draws > EPISTASIS_ASSAY_LIMITS.bootstrapDraws) throw new Error('Epistasis bootstrap exceeds 20,000,000 draws. Reduce bootstrap samples, analyze fewer double mutants, or disable intervals. No partial result is accepted.');
    const distribution: number[] = [];
    for (let iteration = 0; iteration < options.bootstrapSamples; iteration++) {
      const averages = samples.map(rows => resampledMean(rows, random));
      distribution.push(paired ? averages[0] : contrast(averages));
    }
    distribution.sort((a, b) => a - b);
    const lower = quantile(distribution, .025), upper = quantile(distribution, .975);
    pair.uncertainty.bootstrapSamples = options.bootstrapSamples;
    if (!(lower < upper)) {
      pair.uncertainty.reason = 'Resampled contrast distribution is degenerate at the requested resolution; no zero-width interval is reported.';
      return pair;
    }
    pair.interval95 = [lower, upper];
    pair.uncertainty.reason = 'Central 95% percentile interval from empirical ' + (paired ? 'complete-block' : 'within-genotype')
      + ' resampling. Conditional on the declared independent units; small samples, bias and unobserved assay error can invalidate nominal coverage. Not a simultaneous or multiple-testing-adjusted interval.';
    return pair;
  });
  const estimatedPairs = pairs.filter(pair => pair.status === 'estimated').length;
  return {
    scale: assay.scale, replicateDesign: assay.replicateDesign,
    contrastUnits: assay.scale === 'identity' ? assay.units : 'dimensionless natural-log contrast',
    formula: 'mean(g(AB)) - mean(g(A)) - mean(g(B)) + mean(g(WT)); g = ' + (assay.scale === 'identity' ? 'identity' : 'natural log of each observed value'),
    options, observations, variants, pairs,
    coverage: { observations: observations.length, variants: variants.length, doubleVariants: doubles.length,
      estimatedPairs, unavailablePairs: pairs.length - estimatedPairs },
    warnings: [
      'Contrasts describe the supplied assay, protein background and conditions. They do not predict unmeasured mutants, binding energy, escape probability, host range or organismal fitness.',
      'The sign means a larger or smaller assay response than the chosen null. It does not by itself mean beneficial, antagonistic, synergistic or biologically significant.',
      'The scale is part of the estimand. Identity assumes additivity of reported values; natural log assumes multiplicative geometric-mean responses and is not the log of arithmetic means.',
      'Replicate IDs must identify independent experimental units. Technical replicates and shared normalization controls must be handled before independent analysis; matched designs require paired blocks.',
      'Empirical standard errors and percentile intervals omit systematic and unmeasured error. Pairwise results sharing controls are correlated; intervals are not simultaneous and no p-values or significance claims are supplied.',
      'Missing WT/singles or incomplete blocks remain unavailable/excluded, never imputed or treated as zero. Assay values cannot contain unknown censoring thresholds.',
      'Input attribution and licenses are preserved as supplied; hashes identify content and do not authenticate biological observations.',
      ...(dataset.source.kind === 'demo' ? ['Explicit synthetic arithmetic demonstration; none of these observations is biological evidence.'] : []),
      ...(!doubles.length ? ['No measured double mutant was supplied, so no four-genotype contrast can be estimated.'] : []),
    ],
  };
}

export async function createEpistasisAssayExperiment(
  input: EpistasisAssayDataset, settings: Partial<EpistasisAssayOptions> = {}, progress: (phase: string) => void = () => {},
): Promise<EpistasisAssayExperiment> {
  const dataset = validateEpistasisAssayDataset(input), result = analyzeEpistasisAssay(dataset, settings, progress);
  const inputId = 'assay', demo = dataset.source.kind === 'demo';
  const tableField = (label: string, value: unknown, available: number, total: number, estimate = false): AnalysisField => {
    const base = { label, value: analysisJson(value), units: 'records' as const,
      coverage: { available, total, unit: 'records' as const }, limitations: result.warnings };
    if (demo) return { ...base, kind: 'demo', assumptions: ['Explicit synthetic observations; same arithmetic and replication rules as supplied assays.'] };
    if (estimate) return { ...base, kind: 'fitted-estimate', fit: { dataInput: inputId,
      objective: 'Four sample-mean contrast on the explicitly declared assay scale. Per-row standard errors and conditional intervals are retained in the table; no joint interval is estimated.',
      uncertainty: { kind: 'not-estimated' } } };
    return { ...base, kind: 'observation', sourceInput: inputId };
  };
  const record = await createAnalysisRecord({
    method: EPISTASIS_ASSAY_METHOD,
    inputs: [{ id: inputId, accession: dataset.protein.accession, source: dataset.source.kind,
      description: dataset.name + ': exact reference protein, assay context and measured replicate table', data: analysisJson(dataset) }],
    parameters: analysisJson(result.options) as AnalysisRecord['parameters'], seed: result.options.seed,
    references: [
      { id: 'assay-source', version: 'author-supplied', description: dataset.source.description + '; reference ' + (dataset.source.reference ?? 'not supplied') + '; license ' + dataset.source.license },
      { id: 'epistasis-scale', version: 'Sackman-Rokyta-2018', description: 'https://doi.org/10.1534/genetics.117.300451; context for scale-dependent additive contrasts, not a reproduction of this study.' },
      { id: 'bootstrap-sampling', version: 'percentile-within-group-or-complete-block-v1', description: 'https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html; independent samples resampled separately, or paired blocks together; linear 2.5/97.5 percentile interpolation.' },
    ],
    fields: {
      observations: tableField('Complete supplied observations and explicitly transformed assay values', result.observations, result.observations.length, result.observations.length),
      result: tableField('Measured assay-contrast rows; units, replication and uncertainty are specified per result', result,
        result.coverage.estimatedPairs, result.coverage.doubleVariants, true),
    },
  });
  return { dataset, result, record };
}

export async function replayEpistasisAssayExperiment(
  content: string, progress: (phase: string) => void = () => {},
): Promise<EpistasisAssayExperiment> {
  const saved = await parseAnalysisRecord(content, { methodId: EPISTASIS_ASSAY_METHOD.id, methodVersion: EPISTASIS_ASSAY_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'assay') throw new Error('Epistasis assay replay requires one exact assay dataset.');
  const dataset = validateEpistasisAssayDataset(saved.inputs[0].data), options = resolveEpistasisAssayOptions(saved.parameters);
  const fresh = await createEpistasisAssayExperiment(dataset, options, progress);
  if (serializeAnalysisRecord(fresh.record) !== serializeAnalysisRecord(saved)) {
    throw new Error('Recomputed epistasis assay evidence differs from the saved experiment.');
  }
  return fresh;
}

const tsvCell = (value: unknown): string => {
  // Spreadsheet readers may evaluate textual labels as formulas, even when quoted.
  // Only text receives the safety prefix; signed numerical observations stay numerical.
  const raw = value === null ? 'NA' : typeof value === 'string'
    ? (/^[=+\-@]/.test(value) ? "'" + value : value) : JSON.stringify(value);
  if (typeof raw !== 'string') throw new Error('Assay TSV export requires accepted JSON data.');
  return /[\t\r\n"]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
};
/** Export an accepted experiment. Consumers replay imported records before export. */
export function exportEpistasisAssayTsv(record: AnalysisRecord, section: 'pairs' | 'observations' = 'pairs'): string {
  if (record.method.id !== EPISTASIS_ASSAY_METHOD.id || record.method.version !== EPISTASIS_ASSAY_METHOD.version
      || record.inputs.length !== 1 || record.inputs[0].id !== 'assay' || !record.fields.result) throw new Error('Expected an accepted measured epistasis assay experiment.');
  if (section !== 'pairs' && section !== 'observations') throw new Error('Epistasis TSV section must be pairs or observations.');
  const dataset = validateEpistasisAssayDataset(record.inputs[0].data), result = record.fields.result.value as unknown as EpistasisAssayResult;
  const metadata = [
    '# method=' + record.method.id + '; version=' + record.method.version + '; result=' + record.resultId,
    '# dataset=' + JSON.stringify(dataset.name) + '; protein=' + JSON.stringify(dataset.protein.id) + '; source_kind=' + dataset.source.kind,
    '# assay=' + JSON.stringify(dataset.assay.name) + '; conditions=' + JSON.stringify(dataset.assay.conditions),
    '# source=' + JSON.stringify(dataset.source.description) + '; reference=' + JSON.stringify(dataset.source.reference) + '; license=' + JSON.stringify(dataset.source.license),
    '# scale=' + result.scale + '; replicate_design=' + result.replicateDesign + '; contrast_units=' + JSON.stringify(result.contrastUnits),
    '# formula=' + result.formula + '; bootstrap_samples=' + result.options.bootstrapSamples + '; seed=' + result.options.seed,
    '# No inferred fitness, binding, escape probability or significance; pairwise intervals are conditional on the recorded sampling assumptions.',
  ];
  if (section === 'observations') {
    return [...metadata, 'variant\treplicate_id\tobserved_value\tassay_units\ttransformed_value',
      ...result.observations.map(row => [row.variant, row.replicateId, row.value, dataset.assay.units, row.transformedValue].map(tsvCell).join('\t'))].join('\n') + '\n';
  }
  const columns = ['double_variant', 'single_a', 'single_b', 'position_a', 'position_b', 'status',
    'observed_double', 'expected_double', 'interaction_contrast', 'standard_error', 'interval_lower', 'interval_upper',
    'components', 'missing_variants', 'complete_blocks', 'incomplete_blocks', 'uncertainty_method', 'bootstrap_samples', 'uncertainty_reason', 'warnings'];
  return [...metadata, columns.join('\t'), ...result.pairs.map(pair => [
    pair.variant, pair.singleA, pair.singleB, ...pair.positions, pair.status,
    pair.observedDouble, pair.expectedDouble, pair.contrast, pair.standardError, pair.interval95?.[0] ?? null, pair.interval95?.[1] ?? null,
    pair.components, pair.missingVariants, pair.completeBlocks, pair.incompleteBlocks,
    pair.uncertainty.method, pair.uncertainty.bootstrapSamples, pair.uncertainty.reason, pair.warnings,
  ].map(tsvCell).join('\t'))].join('\n') + '\n';
}

/** A local editable arithmetic example, deliberately unrelated to any catalog genome. */
export function createEpistasisAssayTemplate(): EpistasisAssayDataset {
  return {
    format: 'phage-explorer-epistasis-assay', version: 1, name: 'Synthetic four-genotype assay example',
    source: { kind: 'demo', description: 'Hand-specified arithmetic fixture; not experimental observations.', reference: null, license: 'CC0-1.0' },
    protein: { id: 'synthetic-peptide', accession: null, sequence: 'ACDEFGHIK' },
    assay: { name: 'Synthetic response', units: 'arbitrary response units',
      conditions: 'Independent synthetic values, one observation per independent replicate; replace all metadata before analyzing an actual assay.',
      scale: 'identity', replicateDesign: 'independent' },
    observations: ['WT', 'A1V', 'C2S', 'A1V:C2S'].flatMap((id, i) =>
      [0, -1, 1, -.5, .5, 1.5].map((noise, j) => ({ variant: id, replicateId: 'rep-' + (j + 1), value: [10, 12, 13, 18][i] + noise }))),
  };
}
