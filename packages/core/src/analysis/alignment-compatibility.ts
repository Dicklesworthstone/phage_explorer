/** Exact observed four-gamete evidence in a user-declared homologous DNA alignment.
 * Hudson & Kaplan (1985), Genetics 111:147–164, https://doi.org/10.1093/genetics/111.1.147
 * https://pmc.ncbi.nlm.nih.gov/articles/PMC1202594/
 * All four haplotypes at two biallelic sites are incompatible with a single tree
 * under the infinite-sites assumption. Recurrent mutation or alignment/sequence
 * errors are alternatives to recombination. This module counts evidence only;
 * incompatible pairs are NOT independent events, breakpoint calls or p-values.
 */
import { parseAlignedDNA, PHYLOGENY_LIMITS, type AlignedTaxon } from './aligned-phylogeny';
import {
  analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord,
  type AnalysisRecord,
} from '../analysis-result';

export const COMPATIBILITY_METHOD = {
  id: 'aligned-dna-site-compatibility', version: '1',
  implementation: 'complete-column ACGT deletion; biallelic non-singleton columns; exhaustive four-haplotype counts; original alignment coordinates',
} as const;
export const COMPATIBILITY_LIMITS = {
  inputBytes: 2 * 1024 * 1024, recordBytes: 10 * 1024 * 1024,
  taxa: PHYLOGENY_LIMITS.taxa, columns: PHYLOGENY_LIMITS.sites, eligibleSites: 256,
} as const;
export interface CompatibilityInput {
  format: 'phage-explorer-alignment-compatibility'; version: 1; name: string;
  source: { kind: 'local' | 'external' | 'demo'; reference: string; version: string; license: string | null };
  alignment: { fasta: string; homologous: true; method: string; reference: string };
}
/** Zero-based, half-open ORIGINAL alignment interval; never filtered-site coordinates. */
export interface CompatibilityOptions { start: number; end: number }
export interface CompatibilitySite {
  column: number; alleles: [string, string]; counts: [number, number];
  /** One 0/1 allele code per taxon in result.taxa order; retains exact witnesses. */
  assignments: string;
}
/** [left eligible-site index, right index, n00, n01, n10, n11].
 * Allele labels live in sites[index].alleles. Each taxon contributes exactly once.
 */
export type CompatibilityPair = [number, number, number, number, number, number];
export type CompatibilityExclusion = 'missing' | 'monomorphic' | 'multiallelic' | 'singleton';
export interface CompatibilityResult {
  options: CompatibilityOptions;
  taxa: string[];
  alignmentColumns: number;
  sites: CompatibilitySite[];
  excluded: Record<CompatibilityExclusion, number[]>;
  pairs: CompatibilityPair[];
  coverage: { selectedColumns: number; completeColumns: number; eligibleColumns: number; comparedPairs: number; incompatiblePairs: number };
  status: 'insufficient-sites' | 'no-incompatibility-observed' | 'incompatibility-observed';
  warnings: string[];
}
export interface CompatibilityExperiment {
  input: CompatibilityInput; options: CompatibilityOptions; result: CompatibilityResult; record: AnalysisRecord;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) {
    throw new Error(label + ' has missing or unsupported fields.');
  }
}
function text(value: unknown, label: string, maximum = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(label + ' requires nonempty plain text, at most ' + maximum + ' characters.');
  }
  return value.trim();
}
export function validateCompatibilityInput(value: unknown): CompatibilityInput {
  if (!object(value) || value.format !== 'phage-explorer-alignment-compatibility' || value.version !== 1) {
    throw new Error('Unsupported aligned-site compatibility input format/version.');
  }
  keys(value, ['format', 'version', 'name', 'source', 'alignment'], 'Compatibility input');
  if (!object(value.source) || !object(value.alignment)) throw new Error('Explicit source and alignment declarations are required.');
  keys(value.source, ['kind', 'reference', 'version', 'license'], 'Alignment source');
  keys(value.alignment, ['fasta', 'homologous', 'method', 'reference'], 'Alignment declaration');
  if (value.source.kind !== 'local' && value.source.kind !== 'external' && value.source.kind !== 'demo') {
    throw new Error('Source kind must be local, external or demo; provenance remains user-supplied.');
  }
  if (value.alignment.homologous !== true) throw new Error('Explicitly declare that the supplied columns are intended to be homologous. No alignment is inferred here.');
  if (typeof value.alignment.fasta !== 'string' || value.alignment.fasta.length > COMPATIBILITY_LIMITS.inputBytes) {
    throw new Error('Aligned FASTA exceeds the 2 MiB input limit.');
  }
  const input: CompatibilityInput = {
    format: 'phage-explorer-alignment-compatibility', version: 1,
    name: text(value.name, 'Experiment name', 200),
    source: { kind: value.source.kind, reference: text(value.source.reference, 'Source reference or provenance'),
      version: text(value.source.version, 'Source version', 200), license: value.source.license === null ? null : text(value.source.license, 'Source license or permissions') },
    alignment: { fasta: value.alignment.fasta, homologous: true, method: text(value.alignment.method, 'Alignment method'),
      reference: text(value.alignment.reference, 'Alignment evidence or explicit hypothesis') },
  };
  if (new TextEncoder().encode(JSON.stringify(input)).length > COMPATIBILITY_LIMITS.inputBytes) {
    throw new Error('Exact alignment and metadata exceed the 2 MiB input limit.');
  }
  return input;
}
export function resolveCompatibilityOptions(value: unknown, columns: number): CompatibilityOptions {
  if (value === undefined) return { start: 0, end: columns };
  if (!object(value)) throw new Error('An explicit alignment interval is required.');
  keys(value, ['start', 'end'], 'Compatibility options');
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
      || Number(value.start) < 0 || Number(value.start) >= Number(value.end) || Number(value.end) > columns) {
    throw new Error('Alignment interval must be nonempty, zero-based and half-open within the original alignment.');
  }
  return { start: Number(value.start), end: Number(value.end) };
}
const bases = ['A', 'C', 'G', 'T'] as const;
function columnCounts(taxa: AlignedTaxon[], column: number): [number, number, number, number, number] {
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const taxon of taxa) {
    const index = bases.indexOf(taxon.sequence[column] as typeof bases[number]);
    counts[index === -1 ? 4 : index]++;
  }
  return counts;
}
function exclusion(counts: ReturnType<typeof columnCounts>): CompatibilityExclusion | null {
  if (counts[4] > 0) return 'missing';
  const present = counts.slice(0, 4).filter(count => count > 0);
  if (present.length === 1) return 'monomorphic';
  if (present.length > 2) return 'multiallelic';
  if (present.some(count => count < 2)) return 'singleton';
  return null;
}
function prepare(raw: unknown, rawOptions?: unknown): { input: CompatibilityInput; taxa: AlignedTaxon[]; options: CompatibilityOptions } {
  const input = validateCompatibilityInput(raw), taxa = parseAlignedDNA(input.alignment.fasta);
  if (taxa.length < 4) throw new Error('Four-gamete evidence requires at least four aligned taxa.');
  return { input, taxa, options: resolveCompatibilityOptions(rawOptions, taxa[0].sequence.length) };
}
function evaluate(taxa: AlignedTaxon[], options: CompatibilityOptions): CompatibilityResult {
  const sites: CompatibilitySite[] = [], excluded: CompatibilityResult['excluded'] = { missing: [], monomorphic: [], multiallelic: [], singleton: [] };
  for (let column = options.start; column < options.end; column++) {
    const counts = columnCounts(taxa, column), reason = exclusion(counts);
    if (reason) { excluded[reason].push(column); continue; }
    if (sites.length === COMPATIBILITY_LIMITS.eligibleSites) {
      throw new Error('Selected interval exceeds 256 eligible columns. Choose a narrower alignment interval; no sites or pairs are sampled or silently omitted.');
    }
    const alleles = bases.filter((_, index) => counts[index] > 0) as [string, string];
    sites.push({ column, alleles, counts: alleles.map(allele => counts[bases.indexOf(allele as typeof bases[number])]) as [number, number],
      assignments: taxa.map(taxon => taxon.sequence[column] === alleles[0] ? '0' : '1').join('') });
  }
  const pairs: CompatibilityPair[] = []; let incompatiblePairs = 0;
  for (let left = 0; left < sites.length; left++) {
    for (let right = left + 1; right < sites.length; right++) {
      const pair: CompatibilityPair = [left, right, 0, 0, 0, 0];
      for (let taxon = 0; taxon < taxa.length; taxon++) {
        const code = (sites[left].assignments.charCodeAt(taxon) - 48) * 2 + sites[right].assignments.charCodeAt(taxon) - 48;
        pair[2 + code]++;
      }
      if (isIncompatiblePair(pair)) incompatiblePairs++;
      pairs.push(pair);
    }
  }
  const selectedColumns = options.end - options.start;
  return { options, taxa: taxa.map(taxon => taxon.id), alignmentColumns: taxa[0].sequence.length, sites, excluded, pairs,
    coverage: { selectedColumns, completeColumns: selectedColumns - excluded.missing.length, eligibleColumns: sites.length,
      comparedPairs: pairs.length, incompatiblePairs },
    status: sites.length < 2 ? 'insufficient-sites' : incompatiblePairs ? 'incompatibility-observed' : 'no-incompatibility-observed',
    warnings: [
      'Columns are declared homologous by the supplier; this workflow does not align sequences or validate their homology.',
      'A gap, ambiguity symbol or missing call in any taxon excludes that entire column. Only biallelic columns with each allele observed at least twice are compared.',
      'Four observed haplotypes are incompatible with a single tree under the infinite-sites assumption. Recurrent mutation and sequence or alignment errors are alternatives to recombination.',
      'Incompatible pairs are dependent observations, not recombination-event counts, donors, transfer times, breakpoint calls or p-values. No incompatible pairs does not establish absence of recombination.',
      'Coordinates refer to the original supplied alignment, including excluded columns; they are not mapped genomic coordinates.',
    ] };
}
export function isIncompatiblePair(pair: CompatibilityPair): boolean { return pair[2] > 0 && pair[3] > 0 && pair[4] > 0 && pair[5] > 0; }
/** Validate bounded transport shape, source witnesses and count conservation.
 * The worker remains responsible for numerical calculation; fresh replay still
 * recomputes every pair instead of treating these checks as a scientific proof. */
export function validateCompatibilityExperiment(value: CompatibilityExperiment): CompatibilityExperiment {
  if (!value || typeof value !== 'object') throw new Error('Missing compatibility result.');
  const input = validateCompatibilityInput(value.input), result = value.result, record = value.record;
  const taxa = parseAlignedDNA(input.alignment.fasta);
  const same = (left: unknown, right: unknown) => JSON.stringify(analysisJson(left)) === JSON.stringify(analysisJson(right));
  if (taxa.length < 4 || !result || result.alignmentColumns !== taxa[0].sequence.length
      || !same(result.taxa, taxa.map(taxon => taxon.id))) throw new Error('Invalid alignment dimensions or taxa.');
  const options = resolveCompatibilityOptions(value.options, result.alignmentColumns);
  if (!same(options, result.options) || !Array.isArray(result.sites) || result.sites.length > COMPATIBILITY_LIMITS.eligibleSites
      || !Array.isArray(result.pairs) || !Array.isArray(result.warnings) || !result.warnings.length || result.warnings.length > 32
      || result.warnings.some(warning => typeof warning !== 'string' || !warning.trim() || warning.length > 4000)) throw new Error('Invalid compatibility result shape.');
  const seen = new Set<number>();
  const column = (position: number) => {
    if (!Number.isSafeInteger(position) || position < options.start || position >= options.end || seen.has(position)) throw new Error('Invalid or duplicated alignment coordinate.');
    seen.add(position);
  };
  for (const [index, site] of result.sites.entries()) {
    if (!site || !Array.isArray(site.alleles) || site.alleles.length !== 2 || site.alleles.some(allele => typeof allele !== 'string' || !/^[ACGT]$/.test(allele))
        || site.alleles[0] >= site.alleles[1] || !Array.isArray(site.counts) || site.counts.length !== 2
        || site.counts.some(count => !Number.isSafeInteger(count) || count < 2) || site.counts[0] + site.counts[1] !== taxa.length
        || typeof site.assignments !== 'string' || site.assignments.length !== taxa.length || /[^01]/.test(site.assignments)
        || [...site.assignments].filter(allele => allele === '0').length !== site.counts[0]
        || index > 0 && result.sites[index - 1].column >= site.column) throw new Error('Invalid eligible-site evidence.');
    column(site.column);
    if (taxa.some((taxon, taxonIndex) => taxon.sequence[site.column] !== site.alleles[Number(site.assignments[taxonIndex])])) {
      throw new Error('Eligible-site assignments do not match the supplied alignment.');
    }
  }
  const selectedColumns = options.end - options.start;
  for (const reason of ['missing', 'monomorphic', 'multiallelic', 'singleton'] as const) {
    const excluded = result.excluded?.[reason];
    if (!Array.isArray(excluded) || excluded.length > selectedColumns) throw new Error('Missing or excessive exclusion coverage.');
    for (const [index, position] of excluded.entries()) {
      if (index > 0 && excluded[index - 1] >= position) throw new Error('Unordered exclusion coordinates.');
      column(position);
      if (exclusion(columnCounts(taxa, position)) !== reason) throw new Error('Excluded column classification does not match the supplied alignment.');
    }
  }
  if (seen.size !== selectedColumns || result.pairs.length !== result.sites.length * (result.sites.length - 1) / 2) throw new Error('Incomplete site or pair coverage.');
  let pairIndex = 0, incompatible = 0;
  for (let left = 0; left < result.sites.length; left++) for (let right = left + 1; right < result.sites.length; right++) {
    const pair = result.pairs[pairIndex++];
    if (!Array.isArray(pair) || pair.length !== 6 || pair[0] !== left || pair[1] !== right
        || pair.slice(2).some(count => !Number.isSafeInteger(count) || count < 0)
        || pair.slice(2).reduce((sum, count) => sum + count, 0) !== taxa.length
        || pair[2] + pair[3] !== result.sites[left].counts[0] || pair[4] + pair[5] !== result.sites[left].counts[1]
        || pair[2] + pair[4] !== result.sites[right].counts[0] || pair[3] + pair[5] !== result.sites[right].counts[1]) throw new Error('Invalid pair haplotypes.');
    if (isIncompatiblePair(pair)) incompatible++;
  }
  if (!same(result.coverage, { selectedColumns, completeColumns: selectedColumns - result.excluded.missing.length,
    eligibleColumns: result.sites.length, comparedPairs: result.pairs.length, incompatiblePairs: incompatible })
      || result.status !== (result.sites.length < 2 ? 'insufficient-sites' : incompatible ? 'incompatibility-observed' : 'no-incompatibility-observed')) throw new Error('Inconsistent compatibility summary.');
  serializeAnalysisRecord(record);
  if (!same(record.method, COMPATIBILITY_METHOD) || record.seed !== null || record.inputs.length !== 1 || record.inputs[0].id !== 'alignment'
      || record.inputs[0].source !== input.source.kind || !same(record.inputs[0].data, input) || !same(record.parameters, options)
      || Object.keys(record.fields).length !== 1 || !same(record.fields.compatibility?.value, result)
      || record.fields.compatibility.kind !== (input.source.kind === 'demo' ? 'demo' : 'sequence-score')) throw new Error('Unbound compatibility result.');
  return value;
}
export function analyzeAlignmentCompatibility(raw: unknown, options?: unknown): CompatibilityResult {
  const prepared = prepare(raw, options); return evaluate(prepared.taxa, prepared.options);
}
export async function createCompatibilityExperiment(raw: unknown, rawOptions?: unknown): Promise<CompatibilityExperiment> {
  const { input, taxa, options } = prepare(raw, rawOptions), result = evaluate(taxa, options);
  const context = { label: 'Observed aligned-site haplotypes and four-gamete incompatibility', units: 'records' as const,
    value: analysisJson(result), coverage: { available: result.sites.length, total: result.coverage.selectedColumns, unit: 'bases' as const }, limitations: result.warnings };
  const record = await createAnalysisRecord({ method: COMPATIBILITY_METHOD,
    inputs: [{ id: 'alignment', accession: null, source: input.source.kind, description: 'Exact supplied aligned FASTA, provenance and explicit homology declaration.', data: analysisJson(input) }],
    parameters: { start: options.start, end: options.end }, seed: null,
    references: [{ id: 'doi:10.1093/genetics/111.1.147', version: '1985', description: 'Hudson and Kaplan: four-gamete incompatibility under the infinite-sites model. No recombination-event estimate is produced here.' }],
    fields: { compatibility: input.source.kind === 'demo'
      ? { ...context, kind: 'demo', assumptions: ['Synthetic aligned sequences explicitly supplied as a demonstration.'] }
      : { ...context, kind: 'sequence-score' } },
  });
  return { input, options, result, record };
}
export async function replayCompatibilityExperiment(content: string): Promise<CompatibilityExperiment> {
  if (typeof content !== 'string' || content.length > COMPATIBILITY_LIMITS.recordBytes
      || new TextEncoder().encode(content).length > COMPATIBILITY_LIMITS.recordBytes) throw new Error('Saved compatibility experiment exceeds the 10 MiB limit.');
  const saved = await parseAnalysisRecord(content.replace(/^\uFEFF/, ''), { methodId: COMPATIBILITY_METHOD.id, methodVersion: COMPATIBILITY_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'alignment' || saved.seed !== null) throw new Error('Unsupported compatibility record input or seed.');
  const experiment = await createCompatibilityExperiment(saved.inputs[0].data, saved.parameters);
  if (serializeAnalysisRecord(experiment.record) !== serializeAnalysisRecord(saved)) {
    throw new Error('Fresh aligned-site calculation differs from the saved output, provenance or method contract.');
  }
  return experiment;
}
export function compatibilityPairWitnesses(result: CompatibilityResult, pair: CompatibilityPair): Array<{ haplotype: string; taxa: string[]; count: number }> {
  const left = result.sites[pair[0]], right = result.sites[pair[1]];
  return [0, 1, 2, 3].map(code => {
    const a = Math.floor(code / 2), b = code % 2;
    return { haplotype: left.alleles[a] + right.alleles[b], count: pair[code + 2],
      taxa: result.taxa.filter((_, index) => left.assignments[index] === String(a) && right.assignments[index] === String(b)) };
  });
}
function tsv(value: string | number): string {
  const raw = String(value).replace(/[\t\r\n]/g, ' ');
  return /^[=+@-]/.test(raw) ? "'" + raw : raw;
}
export function exportCompatibilityPairsTsv(experiment: CompatibilityExperiment): string {
  const { result, record } = experiment;
  return ['# aligned-dna-site-compatibility v1; result_id=' + record.resultId,
    '# Counts are observed taxa, not events. Columns are 1-based original alignment positions.',
    'left_column\tright_column\tleft_allele0\tleft_allele1\tright_allele0\tright_allele1\tn00\tn01\tn10\tn11\tfour_gametes',
    ...result.pairs.map(pair => [result.sites[pair[0]].column + 1, result.sites[pair[1]].column + 1,
      ...result.sites[pair[0]].alleles, ...result.sites[pair[1]].alleles, ...pair.slice(2), isIncompatiblePair(pair) ? 'yes' : 'no'].map(tsv).join('\t'))].join('\n') + '\n';
}
export function exportCompatibilitySitesTsv(experiment: CompatibilityExperiment): string {
  const taxa = parseAlignedDNA(experiment.input.alignment.fasta), { start, end } = experiment.options;
  const lines = ['# aligned-dna-site-compatibility v1; result_id=' + experiment.record.resultId,
    '# One row per selected ORIGINAL alignment column; complete-column deletion precedes all other classifications.',
    'alignment_column\tstatus\tA\tC\tG\tT\tnon_ACGT'];
  for (let column = start; column < end; column++) {
    const counts = columnCounts(taxa, column);
    lines.push([column + 1, exclusion(counts) ?? 'eligible', ...counts].map(tsv).join('\t'));
  }
  return lines.join('\n') + '\n';
}
