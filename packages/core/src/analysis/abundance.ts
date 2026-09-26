/** Local abundance datasets and reproducible, exploratory CLR association analysis.
 * Rows are taxa; columns are samples. This is Pearson correlation of sample-wise
 * CLR coordinates, NOT SparCC or evidence of ecological/causal interaction.
 * CLR definition: https://scikit.bio/docs/dev/generated/skbio.stats.composition.clr.html
 * Pairing null: https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.permutation_test.html
 */
import { nmf, createSeededRng, type AbundanceTable, type SampleMetadata, type NMFResult } from './metagenomic-niche';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export const ABUNDANCE_LIMITS = { bytes: 4 * 1024 * 1024, taxa: 100, samples: 500, cells: 50000, pairOperations: 50000000 } as const;
export interface AbundanceDataset {
  format: 'phage-explorer-abundance';
  version: 1;
  name: string;
  units: 'counts' | 'relative-abundance';
  source: { kind: 'local' | 'demo'; description: string; reference: string | null };
  table: AbundanceTable;
  metadata: SampleMetadata[];
}
export interface AbundanceOptions {
  pseudocount: number;
  numNiches: number;
  correlationThreshold: number;
  qvalueThreshold: number;
  permutations: number;
  seed: number;
  includeNegative: boolean;
}
export interface AbundanceAssociation { source: string; target: string; correlation: number; pvalue: number; qvalue: number }
export interface AbundanceAnalysis {
  options: AbundanceOptions;
  taxa: string[];
  samples: string[];
  relativeAbundance: number[][];
  clr: number[][];
  nmfResult: NMFResult;
  associations: AbundanceAssociation[];
  edges: AbundanceAssociation[];
  profiles: Array<{ taxon: string; factorWeights: number[]; primaryFactor: number;
    habitats: Array<{ habitat: string; samples: number; meanRelativeAbundance: number }> }>;
  diagnostics: { excludedTaxa: string[]; excludedSamples: string[]; constantTaxa: string[]; metadataSamples: number;
    permutationMode: 'exact' | 'monte-carlo'; permutationsUsed: number; warnings: string[] };
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function label(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${context} must be nonempty text (at most 512 characters, without control characters).`);
  }
  return value.trim();
}
function names(value: unknown, context: string, limit: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) throw new Error(`${context} requires 1–${limit} identifiers.`);
  const result = value.map(item => label(item, context));
  if (new Set(result).size !== result.length) throw new Error(`${context} contains duplicate identifiers.`);
  return result;
}
function checkBytes(content: string): void {
  if (new TextEncoder().encode(content).length > ABUNDANCE_LIMITS.bytes) throw new Error('Abundance input exceeds the 4 MiB limit.');
}

/** Validate and snapshot before hashing, worker admission, or replacing a user's dataset. */
export function validateAbundanceDataset(value: unknown): AbundanceDataset {
  if (!object(value) || value.format !== 'phage-explorer-abundance' || value.version !== 1 || !object(value.table) ||
    !object(value.source) || !['local', 'demo'].includes(String(value.source.kind)) ||
    !['counts', 'relative-abundance'].includes(String(value.units))) throw new Error('Unsupported abundance dataset format, version, source or units.');
  const taxa = names(value.table.taxa, 'Taxa', ABUNDANCE_LIMITS.taxa);
  const samples = names(value.table.samples, 'Samples', ABUNDANCE_LIMITS.samples);
  const matrix = value.table.counts;
  if (taxa.length * samples.length > ABUNDANCE_LIMITS.cells || !Array.isArray(matrix) || matrix.length !== taxa.length) {
    throw new Error('Abundance matrix dimensions do not match the taxon and sample identifiers.');
  }
  const counts = matrix.map((row, i) => {
    if (!Array.isArray(row) || row.length !== samples.length) throw new Error(`Abundance row ${i + 1} has the wrong number of samples.`);
    return row.map((cell, j) => {
      if (typeof cell !== 'number' || !Number.isFinite(cell) || cell < 0 || cell > 1e12) {
        throw new Error(`Abundance row ${i + 1}, sample ${j + 1} requires a finite nonnegative value at most 1e12; missing values are not zeros.`);
      }
      return cell;
    });
  });
  if (value.units === 'relative-abundance') {
    for (let s = 0; s < samples.length; s++) {
      const total = counts.reduce((sum, row) => sum + row[s], 0);
      if (total !== 0 && Math.abs(total - 1) > 1e-6) throw new Error(`Relative abundances in sample ${s + 1} must sum to 1 (or 0 for an empty sample).`);
    }
  }
  const rawMetadata = value.metadata ?? [];
  if (!Array.isArray(rawMetadata) || rawMetadata.length > samples.length) throw new Error('Sample metadata must have at most one record per sample.');
  const seen = new Set<string>();
  const metadata: SampleMetadata[] = rawMetadata.map(row => {
    if (!object(row)) throw new Error('Sample metadata must be objects keyed by sampleId.');
    const sampleId = label(row.sampleId, 'Metadata sampleId');
    if (!samples.includes(sampleId) || seen.has(sampleId)) throw new Error('Metadata contains an unknown or duplicate sampleId.');
    seen.add(sampleId);
    const fields = Object.entries(row).map(([key, cell]) => {
      label(key, 'Metadata field');
      if (typeof cell === 'number' && Number.isFinite(cell)) return [key, cell] as const;
      return [key, label(cell, 'Metadata value')] as const;
    });
    // sampleId is canonical even when surrounding whitespace was supplied.
    return { ...Object.fromEntries(fields), sampleId };
  });
  const result: AbundanceDataset = {
    format: 'phage-explorer-abundance', version: 1, name: label(value.name, 'Dataset name'),
    units: value.units as AbundanceDataset['units'],
    source: { kind: value.source.kind as 'local' | 'demo', description: label(value.source.description, 'Source description'),
      reference: value.source.reference === null ? null : label(value.source.reference, 'Source reference') },
    table: { taxa, samples, counts }, metadata,
  };
  checkBytes(JSON.stringify(result));
  return result;
}

/** RFC-style quoted CSV/TSV, with a strict header and no silent numeric coercion. */
function delimitedRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  const finishCell = () => { row.push(cell); cell = ''; closed = false; };
  const finishRow = () => {
    finishCell(); rows.push(row); row = [];
    if (rows.length > ABUNDANCE_LIMITS.taxa + 1) throw new Error('Abundance input has too many taxa.');
  };
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"') {
        if (content[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; }
      } else cell += c;
    } else if (c === delimiter) finishCell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && content[i + 1] === '\n') i++; finishRow(); }
    else if (c === '"' && !cell && !closed) quoted = true;
    else if (closed || c === '"') throw new Error('Malformed quoted field in abundance input.');
    else cell += c;
    if (row.length > ABUNDANCE_LIMITS.samples) throw new Error('Abundance input has too many samples.');
  }
  if (quoted) throw new Error('Unclosed quoted field in abundance input.');
  if (cell || row.length || closed) finishRow();
  return rows;
}
export function parseAbundanceDataset(content: string, filename = 'Local abundance data'): AbundanceDataset {
  checkBytes(content);
  const text = content.replace(/^\uFEFF/, '');
  if (text.trimStart().startsWith('{')) return validateAbundanceDataset(JSON.parse(text));
  const delimiter = text.slice(0, text.search(/[\r\n]/) < 0 ? undefined : text.search(/[\r\n]/)).includes('\t') ? '\t' : ',';
  const rows = delimitedRows(text, delimiter);
  if (rows.length < 2 || !['taxon', 'taxon_id'].includes(rows[0][0]?.trim().toLowerCase())) {
    throw new Error('CSV/TSV must begin with taxon,sample1,sample2,… and contain taxa in rows, samples in columns.');
  }
  const samples = rows[0].slice(1);
  const counts = rows.slice(1).map((row, i) => {
    if (row.length !== samples.length + 1) throw new Error(`Abundance row ${i + 2} has the wrong number of columns.`);
    return row.slice(1).map((cell, j) => {
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(cell.trim())) {
        throw new Error(`Abundance row ${i + 2}, column ${j + 2} is not a nonnegative number; blank/NA values are not zeros.`);
      }
      return Number(cell);
    });
  });
  return validateAbundanceDataset({ format: 'phage-explorer-abundance', version: 1, name: filename,
    units: 'counts', source: { kind: 'local', description: filename, reference: null },
    table: { taxa: rows.slice(1).map(row => row[0]), samples, counts }, metadata: [] });
}
export function serializeAbundanceDataset(dataset: AbundanceDataset): string {
  const content = JSON.stringify(validateAbundanceDataset(dataset), null, 2);
  checkBytes(content);
  return content;
}

export function resolveAbundanceOptions(dataset: AbundanceDataset, options: Partial<AbundanceOptions> = {}): AbundanceOptions {
  const resolved = { pseudocount: dataset.units === 'counts' ? 1 : 1e-6,
    numNiches: Math.max(1, Math.min(3, dataset.table.counts.filter(row => row.some(x => x > 0)).length,
      dataset.table.samples.filter((_, s) => dataset.table.counts.some(row => row[s] > 0)).length)), correlationThreshold: 0.3,
    qvalueThreshold: 0.05, permutations: 199, seed: 42, includeNegative: true, ...options };
  for (const key of Object.keys(options)) if (!Object.hasOwn(resolved, key) || !['pseudocount', 'numNiches', 'correlationThreshold', 'qvalueThreshold', 'permutations', 'seed', 'includeNegative'].includes(key)) {
    throw new Error(`Unsupported abundance parameter: ${key}`);
  }
  for (const key of ['pseudocount', 'correlationThreshold', 'qvalueThreshold'] as const) {
    if (!Number.isFinite(resolved[key]) || resolved[key] < 0 || resolved[key] > (key === 'pseudocount' ? 1e12 : 1)) throw new Error(`Invalid ${key}.`);
  }
  if (!Number.isInteger(resolved.numNiches) || resolved.numNiches < 1 || resolved.numNiches > 8 ||
    !Number.isInteger(resolved.permutations) || resolved.permutations < 19 || resolved.permutations > 999 ||
    !Number.isInteger(resolved.seed) || resolved.seed < 0 || resolved.seed > 0xffffffff || typeof resolved.includeNegative !== 'boolean') {
    throw new Error('Factors require 1–8, permutations 19–999, seed a uint32, and includeNegative a boolean.');
  }
  return resolved;
}

/** BH-adjusted p-values over ALL tested pairs, never only threshold-selected edges. */
export function adjustAbundancePValues(pvalues: number[]): number[] {
  if (pvalues.some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error('Invalid association p-value.');
  const ranked = pvalues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = Array(pvalues.length).fill(1);
  let previous = 1;
  for (let i = ranked.length - 1; i >= 0; i--) {
    previous = Math.min(previous, ranked[i].p * ranked.length / (i + 1));
    adjusted[ranked[i].index] = previous;
  }
  return adjusted;
}
const dot = (a: number[], b: number[], order?: number[]) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[order ? order[i] : i];
  return Math.max(-1, Math.min(1, sum));
};
function centeredUnit(row: number[]): number[] | null {
  const mean = row.reduce((a, b) => a + b, 0) / row.length;
  const centered = row.map(x => x - mean);
  const norm = Math.sqrt(centered.reduce((a, b) => a + b * b, 0));
  return norm <= 1e-12 * Math.max(1, ...row.map(Math.abs)) ? null : centered.map(x => x / norm);
}
function permutationOrders(size: number, draws: number, rng: () => number): { mode: 'exact' | 'monte-carlo'; orders: number[][] } {
  let factorial = 1;
  for (let i = 2; i <= size && factorial <= draws; i++) factorial *= i;
  const identity = Array.from({ length: size }, (_, i) => i);
  const orders: number[][] = [];
  if (factorial <= draws) {
    const visit = (at: number) => {
      if (at === size) { orders.push([...identity]); return; }
      for (let i = at; i < size; i++) {
        [identity[at], identity[i]] = [identity[i], identity[at]];
        visit(at + 1);
        [identity[at], identity[i]] = [identity[i], identity[at]];
      }
    };
    visit(0);
    return { mode: 'exact', orders };
  }
  for (let b = 0; b < draws; b++) {
    const order = [...identity];
    for (let i = size - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(rng() * (i + 1)));
      [order[i], order[j]] = [order[j], order[i]];
    }
    orders.push(order);
  }
  return { mode: 'monte-carlo', orders };
}

export function analyzeAbundanceDataset(input: AbundanceDataset, options: Partial<AbundanceOptions> = {}): AbundanceAnalysis {
  const dataset = validateAbundanceDataset(input);
  const config = resolveAbundanceOptions(dataset, options);
  const table = dataset.table;
  const ti = table.taxa.map((_, i) => i).filter(i => table.counts[i].some(x => x > 0));
  const si = table.samples.map((_, s) => s).filter(s => ti.some(i => table.counts[i][s] > 0));
  if (ti.length < 2 || si.length < 3) throw new Error('Association analysis requires at least 2 nonempty taxa and 3 nonempty samples; empty data cannot become evidence via pseudocounts.');
  if (config.numNiches > Math.min(ti.length, si.length)) throw new Error('Number of factors exceeds the retained taxa/sample dimensions.');
  if (ti.length * (ti.length - 1) / 2 * si.length * config.permutations > ABUNDANCE_LIMITS.pairOperations) {
    throw new Error('Association workload exceeds the supported limit. Reduce taxa, samples or permutations.');
  }
  const taxa = ti.map(i => table.taxa[i]), samples = si.map(i => table.samples[i]);
  const raw = ti.map(i => si.map(s => table.counts[i][s]));
  const totals = si.map((_, s) => raw.reduce((sum, row) => sum + row[s], 0));
  const relativeAbundance = raw.map(row => row.map((x, s) => x / totals[s]));
  // Each sample, NOT each taxon's trajectory, is a composition. Compute logs
  // directly to avoid underflow after normalization; closure cancels in CLR.
  const logs = raw.map(row => row.map(x => {
    if (x + config.pseudocount <= 0) throw new Error('Zero abundances require a positive pseudocount.');
    return Math.log(x + config.pseudocount);
  }));
  const means = si.map((_, s) => logs.reduce((sum, row) => sum + row[s], 0) / ti.length);
  const clr = logs.map(row => row.map((x, s) => x - means[s]));
  const standardized = clr.map(centeredUnit);
  const { mode, orders } = permutationOrders(samples.length, config.permutations, createSeededRng(`abundance-permutation:${config.seed}`));
  const associations: AbundanceAssociation[] = [];
  for (let i = 0; i < taxa.length; i++) for (let j = i + 1; j < taxa.length; j++) {
    const a = standardized[i], b = standardized[j];
    if (!a || !b) continue; // Undefined correlations are not zeros or significant tests.
    const correlation = dot(a, b);
    const extreme = orders.reduce((n, order) => n + (Math.abs(dot(a, b, order)) >= Math.abs(correlation) - 1e-12 ? 1 : 0), 0);
    const pvalue = mode === 'exact' ? extreme / orders.length : (extreme + 1) / (orders.length + 1);
    associations.push({ source: taxa[i], target: taxa[j], correlation, pvalue, qvalue: 1 });
  }
  const qvalues = adjustAbundancePValues(associations.map(a => a.pvalue));
  associations.forEach((a, i) => { a.qvalue = qvalues[i]; });
  const edges = associations.filter(a => Math.abs(a.correlation) > 0 && Math.abs(a.correlation) >= config.correlationThreshold &&
    a.qvalue <= config.qvalueThreshold && (config.includeNegative || a.correlation > 0));
  // Independent stream: changing permutation count must not rotate NMF factors.
  const nmfResult = nmf(relativeAbundance, config.numNiches, 200, 1e-7, createSeededRng(`abundance-nmf:${config.seed}`));
  // Remove arbitrary per-factor scaling before reporting memberships. W*H stays unchanged.
  for (let k = 0; k < nmfResult.k; k++) {
    const scale = nmfResult.H[k].reduce((a, b) => a + b, 0);
    if (scale > 0) {
      nmfResult.H[k] = nmfResult.H[k].map(x => x / scale);
      for (const row of nmfResult.W) row[k] *= scale;
    }
  }
  const metadata = new Map(dataset.metadata.map(row => [row.sampleId, row]));
  const profiles = taxa.map((taxon, t) => {
    const total = nmfResult.W[t].reduce((a, b) => a + b, 0);
    const factorWeights = nmfResult.W[t].map(x => total > 0 ? x / total : 0);
    const habitats = new Map<string, { total: number; samples: number }>();
    for (let s = 0; s < samples.length; s++) {
      const habitat = metadata.get(samples[s])?.habitat;
      if (typeof habitat !== 'string') continue;
      const group = habitats.get(habitat) ?? { total: 0, samples: 0 };
      group.total += relativeAbundance[t][s]; group.samples++;
      habitats.set(habitat, group);
    }
    return { taxon, factorWeights, primaryFactor: factorWeights.indexOf(Math.max(...factorWeights)),
      habitats: [...habitats].map(([habitat, group]) => ({ habitat, samples: group.samples, meanRelativeAbundance: group.total / group.samples }))
        .sort((a, b) => b.meanRelativeAbundance - a.meanRelativeAbundance || (a.habitat < b.habitat ? -1 : a.habitat > b.habitat ? 1 : 0)) };
  });
  return { options: config, taxa, samples, relativeAbundance, clr, nmfResult, associations, edges, profiles,
    diagnostics: { excludedTaxa: table.taxa.filter((_, i) => !ti.includes(i)), excludedSamples: table.samples.filter((_, s) => !si.includes(s)),
      constantTaxa: taxa.filter((_, i) => !standardized[i]), metadataSamples: samples.filter(s => metadata.has(s)).length,
      permutationMode: mode, permutationsUsed: orders.length,
      warnings: ['CLR correlations are exploratory associations, not SparCC, absolute-abundance correlations, host links or causal interactions.',
        'Unrestricted pairing permutations assume exchangeable samples; repeated measures, batches and time series need an appropriate design.',
        'BH adjustment covers all nonconstant taxon pairs; its FDR interpretation requires appropriate dependence assumptions.',
        'Zeros, pseudocounts and retained taxa affect CLR coordinates. Factor weights are descriptive NMF memberships, not calibrated probabilities.'] } };
}

const METHOD = { id: 'abundance-clr-nmf', version: '1', implementation: 'sample-wise CLR; Pearson |r| pairing permutation; BH; seeded multiplicative-update NMF' };
const REFERENCES = [
  { id: 'clr', version: 'Aitchison-1986', description: 'Per-sample log abundance minus mean log abundance across retained taxa.' },
  { id: 'permutation', version: 'Phipson-Smyth-2010', description: 'Exact pairing enumeration when feasible; otherwise (extreme + 1)/(draws + 1). Two-sided statistic is |Pearson r|.' },
  { id: 'multiple-testing', version: 'Benjamini-Hochberg-1995', description: 'Step-up adjusted p-values over all tested nonconstant taxon pairs.' },
  { id: 'nmf', version: 'Lee-Seung-2001', description: 'Nonnegative multiplicative updates on sample-relative abundances; 200 iterations, tolerance 1e-7.' },
];
export async function createAbundanceAnalysisRecord(dataset: AbundanceDataset, result: AbundanceAnalysis): Promise<AnalysisRecord> {
  const data = validateAbundanceDataset(dataset);
  const coverage = { available: result.samples.length, total: data.table.samples.length, unit: 'records' as const };
  const limitations = [...result.diagnostics.warnings];
  const fit = { dataInput: 'abundanceData', objective: 'Describe associations and nonnegative latent factors in the supplied abundance table.', uncertainty: { kind: 'not-estimated' as const } };
  const inferred = (label: string, value: unknown) => data.source.kind === 'demo'
    ? { label, kind: 'demo' as const, value: analysisJson(value), units: 'records' as const, coverage, limitations,
      assumptions: ['Synthetic abundance data explicitly selected by the user.', ...limitations] }
    : { label, kind: 'fitted-estimate' as const, value: analysisJson(value), units: 'records' as const, coverage, limitations, fit };
  return createAnalysisRecord({ method: METHOD, inputs: [{ id: 'abundanceData', accession: null, source: data.source.kind,
    description: data.source.description, data: analysisJson(data) }], parameters: analysisJson(result.options) as AnalysisRecord['parameters'],
    seed: result.options.seed, references: REFERENCES,
    fields: { associations: inferred('Exploratory CLR associations (raw and BH-adjusted permutation p-values)', result.associations),
      factors: inferred('Descriptive NMF factorization and sample-linked habitat summaries', { nmf: result.nmfResult, profiles: result.profiles }),
      coverage: inferred('Retained data, exclusions and method limitations', { taxa: result.taxa, samples: result.samples, diagnostics: result.diagnostics }) } });
}

/** Recompute; never accept stored fitted outputs merely because their hashes agree. */
export async function replayAbundanceAnalysis(content: string): Promise<{ dataset: AbundanceDataset; result: AbundanceAnalysis; record: AnalysisRecord }> {
  const saved = await parseAnalysisRecord(content, { methodId: METHOD.id, methodVersion: METHOD.version });
  if (saved.method.implementation !== METHOD.implementation || JSON.stringify(analysisJson(saved.references)) !== JSON.stringify(analysisJson(REFERENCES)) ||
    saved.inputs.length !== 1 || saved.inputs[0].id !== 'abundanceData') throw new Error('Abundance method, reference or input contract differs.');
  const dataset = validateAbundanceDataset(saved.inputs[0].data);
  const result = analyzeAbundanceDataset(dataset, saved.parameters as Partial<AbundanceOptions>);
  const record = await createAbundanceAnalysisRecord(dataset, result);
  if (record.cacheKey !== saved.cacheKey || record.resultId !== saved.resultId) throw new Error('Recomputed abundance result differs from the saved analysis.');
  return { dataset, result, record };
}
