/**
 * Sliding-window reference similarity for mosaic exploration.
 *
 * Canonical DNA k-mer Jaccard is strand independent. It measures similarity to
 * the supplied panel, not a donor, recombination event, direction or transfer age.
 * Windows and display segments use 0-based, end-exclusive genome coordinates.
 */

import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisField, type AnalysisRecord } from '../analysis-result';

export interface ReferenceSketch {
  label: string;
  sequence: string;
}

export type MosaicMatchStatus = 'matched' | 'ambiguous' | 'below-threshold' | 'no-evidence';

export interface MosaicWindow {
  start: number;
  end: number;
  /** Historical field name: a uniquely closest reference, never an inferred donor. */
  donor: string | null;
  status: MosaicMatchStatus;
  score: number;
  validKmerCount: number;
  tiedReferences: string[];
  topDonors: Array<{ label: string; score: number }>;
}

export interface MosaicSegment {
  start: number;
  end: number;
  donor: string | null;
  status: MosaicMatchStatus;
  tiedReferences: string[];
  /** Window scores weighted by the nonoverlapping display spans they represent. */
  meanScore: number;
  windows: number;
}

export interface MosaicReferenceSwitch {
  from: string;
  to: string;
  /** Bounds are supporting window centers, not an inferred biological breakpoint. */
  start: number;
  end: number;
  position: number;
}

export interface MosaicRadarResult {
  windows: MosaicWindow[];
  segments: MosaicSegment[];
  /** Midpoints for navigation; referenceSwitches carries the actual resolution. */
  breakpoints: number[];
  referenceSwitches: MosaicReferenceSwitch[];
  k: number;
  window: number;
  step: number;
  referencePanel: {
    supplied: number;
    selected: number;
    usable: number;
    omitted: number;
    excludedLabels: string[];
  };
  /** Display partition lengths in bases, not per-base sequence alignments. */
  coverage: Record<MosaicMatchStatus, number>;
}

export interface MosaicRadarConfig {
  k?: number;             // integer 1..16 (default 5)
  window?: number;        // positive integer; minimum 200 bp, default 2000
  step?: number;          // positive integer; minimum 100 bp, at most window
  minSimilarity?: number; // 0..1, default 0.05; zero shared k-mers never match
  maxReferences?: number; // positive integer, default 30; selected by label
  topN?: number;          // positive integer, default 3
}

function positiveInteger(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}.`);
  }
  return value;
}

function compareLabels(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rolling two-bit encodings avoid allocating a string for every k-mer. */
function canonicalKmers(sequence: string, k: number, start = 0, end = sequence.length): {
  kmers: Set<number>;
  count: number;
} {
  const kmers = new Set<number>();
  const mask = k === 16 ? 0xffffffff : (1 << (2 * k)) - 1;
  const reverseShift = 2 * (k - 1);
  let forward = 0;
  let reverse = 0;
  let run = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    // Normalize ASCII case only: Unicode uppercasing can change sequence length.
    const char = sequence.charCodeAt(i) | 32;
    const base = char === 97 ? 0 : char === 99 ? 1 : char === 103 ? 2 : char === 116 ? 3 : -1;
    if (base < 0) {
      forward = 0;
      reverse = 0;
      run = 0;
      continue;
    }
    forward = (((forward << 2) | base) & mask) >>> 0;
    reverse = ((reverse >>> 2) | ((3 - base) << reverseShift)) >>> 0;
    if (++run >= k) {
      kmers.add(Math.min(forward, reverse));
      count++;
    }
  }
  return { kmers, count };
}

function jaccard(a: Set<number>, b: Set<number>): number {
  // Two missing observations cannot provide perfect sequence evidence.
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const kmer of small) if (large.has(kmer)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

const center = (window: MosaicWindow): number => (window.start + window.end) / 2;

export function computeMosaicRadar(
  sequence: string,
  references: ReferenceSketch[],
  config: MosaicRadarConfig = {}
): MosaicRadarResult {
  if (typeof sequence !== 'string' || !Array.isArray(references)) {
    throw new Error('Mosaic analysis requires a DNA string and a reference array.');
  }
  const k = positiveInteger(config.k === undefined ? 5 : config.k, 'k', 16);
  const window = Math.max(200, positiveInteger(config.window === undefined ? 2000 : config.window, 'window'));
  const step = Math.max(100, positiveInteger(config.step === undefined ? Math.floor(window / 2) : config.step, 'step'));
  const minSimilarity = config.minSimilarity === undefined ? 0.05 : config.minSimilarity;
  const topN = positiveInteger(config.topN === undefined ? 3 : config.topN, 'topN');
  const maxRefs = positiveInteger(config.maxReferences === undefined ? 30 : config.maxReferences, 'maxReferences');
  if (step > window) throw new Error('step must not exceed window; unobserved gaps cannot be assigned to a reference.');
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
    throw new Error('minSimilarity must be a finite number from 0 to 1.');
  }

  const labels = new Set<string>();
  const panel = references.map(reference => {
    if (!reference || typeof reference.label !== 'string' || !reference.label.trim() ||
      typeof reference.sequence !== 'string') throw new Error('Each reference needs a nonempty label and a DNA string.');
    const label = reference.label.trim();
    if (labels.has(label)) throw new Error(`Duplicate reference label: ${label}. Use unique source identifiers.`);
    labels.add(label);
    return { label, sequence: reference.sequence };
  }).sort((a, b) => compareLabels(a.label, b.label)).slice(0, maxRefs);
  const selected = panel.map(reference => ({
    label: reference.label,
    kmers: canonicalKmers(reference.sequence, k).kmers,
  }));
  const refSets = selected.filter(reference => reference.kmers.size > 0);
  const referencePanel = {
    supplied: references.length,
    selected: selected.length,
    usable: refSets.length,
    omitted: references.length - selected.length,
    excludedLabels: selected.filter(reference => reference.kmers.size === 0).map(reference => reference.label),
  };
  const coverage: Record<MosaicMatchStatus, number> = {
    matched: 0, ambiguous: 0, 'below-threshold': 0, 'no-evidence': 0,
  };
  const windows: MosaicWindow[] = [];
  if (sequence.length >= k && references.length > 0) {
    let start = 0;
    while (start < sequence.length) {
      const end = start + Math.min(window, sequence.length - start);
      const query = canonicalKmers(sequence, k, start, end);
      const scored = query.kmers.size === 0 ? [] : refSets
        .map(reference => ({ label: reference.label, score: jaccard(query.kmers, reference.kmers) }))
        .sort((a, b) => b.score - a.score || compareLabels(a.label, b.label));
      const best = scored[0];
      const supported = best !== undefined && best.score > 0 && best.score >= minSimilarity;
      const tiedReferences = supported ? scored.filter(candidate => candidate.score === best.score).map(candidate => candidate.label) : [];
      const status: MosaicMatchStatus = !query.kmers.size || !refSets.length ? 'no-evidence'
        : !supported ? 'below-threshold' : tiedReferences.length > 1 ? 'ambiguous' : 'matched';
      windows.push({
        start, end, donor: status === 'matched' ? best.label : null, status,
        score: best?.score ?? 0, validKmerCount: query.count,
        tiedReferences: status === 'ambiguous' ? tiedReferences : [],
        topDonors: scored.slice(0, topN),
      });
      if (end === sequence.length) break;
      // Anchor the last full window at the sequence end, so a short trailing
      // fragment never disappears or supplies a tiny, misleading comparison.
      start = Math.min(start + step, sequence.length - window);
    }
  }

  // Partition the genome at midpoints between sampled window centers. Unlike
  // merging full overlapping windows, these display spans count each base once.
  const segments: MosaicSegment[] = [];
  let start = 0;
  for (let i = 0; i < windows.length; i++) {
    const current = windows[i];
    const end = i + 1 === windows.length ? sequence.length : Math.floor((center(current) + center(windows[i + 1])) / 2);
    const span = end - start;
    coverage[current.status] += span;
    const previous = segments[segments.length - 1];
    if (previous && previous.donor === current.donor && previous.status === current.status &&
      previous.tiedReferences.length === current.tiedReferences.length &&
      previous.tiedReferences.every((label, index) => label === current.tiedReferences[index])) {
      const previousSpan = previous.end - previous.start;
      previous.meanScore = (previous.meanScore * previousSpan + current.score * span) / (previousSpan + span);
      previous.end = end;
      previous.windows++;
    } else {
      segments.push({
        start, end, donor: current.donor, status: current.status,
        tiedReferences: [...current.tiedReferences], meanScore: current.score, windows: 1,
      });
    }
    start = end;
  }
  // An absent panel or a query shorter than k leaves the entire query
  // unobserved. Zero observed windows must not imply zero unavailable bases.
  if (windows.length === 0) coverage['no-evidence'] = sequence.length;

  const referenceSwitches: MosaicReferenceSwitch[] = [];
  let previousMatch: MosaicWindow | null = null;
  for (const current of windows) {
    // An evidence gap breaks the comparison chain. Ties retain their ambiguity
    // while allowing a broader range between different supported references.
    if (current.status === 'no-evidence' || current.status === 'below-threshold') previousMatch = null;
    if (!current.donor) continue;
    if (previousMatch?.donor && previousMatch.donor !== current.donor) {
      const left = center(previousMatch);
      const right = center(current);
      referenceSwitches.push({
        from: previousMatch.donor, to: current.donor,
        start: Math.floor(left), end: Math.ceil(right), position: Math.floor((left + right) / 2),
      });
    }
    previousMatch = current;
  }

  return {
    windows, segments, breakpoints: referenceSwitches.map(change => change.position),
    referenceSwitches, k, window, step, referencePanel, coverage,
  };
}

export default computeMosaicRadar;

/** Portable experiments deliberately retain the analyzed slices, not just
 * accession names. Source ranges describe missing sequence without inventing it.
 */
export const MOSAIC_LIMITS = {
  bytes: 6 * 1024 * 1024,
  bases: 5_000_000,
  sequenceBases: 5_000_000,
  references: 30,
  excludedReferences: 500,
  windows: 5_000,
  operations: 50_000_000,
} as const;
export const MOSAIC_METHOD = { id: 'canonical-kmer-mosaic', version: '1',
  implementation: 'TypeScript exact canonical DNA k-mer Jaccard; bounded linear windows and nonoverlapping midpoint display partition' };
const MOSAIC_REFERENCE = { id: 'canonical-kmer-mosaic-conventions', version: '1',
  description: 'Exact sets of min(forward, reverse-complement) A/C/G/T k-mers. Ambiguity breaks runs. Jaccard is intersection/union; absent evidence never supplies a match. Reference switches describe sampled similarity, not biological events.' };

export interface MosaicSequenceInput {
  id: string;
  label: string;
  accession: string | null;
  sequence: string;
  source: 'local' | 'catalog' | 'external' | 'demo';
  sourceDescription: string;
  sourceReference: string | null;
  sourceLicense: string | null;
  /** Length of the source before any explicit slice was taken. */
  sourceLength: number;
  /** Offset of this exact sequence in that source; always zero-based. */
  sourceStart: number;
}
export interface MosaicExcludedReference { id: string; label: string; accession: string | null; reason: string }
export interface MosaicDataset {
  format: 'phage-explorer-mosaic-dataset';
  version: 1;
  name: string;
  query: MosaicSequenceInput;
  references: MosaicSequenceInput[];
  /** Known candidate records whose bases were not supplied. Not biological nonmatches. */
  excludedReferences: MosaicExcludedReference[];
}
export type ResolvedMosaicRadarConfig = Required<MosaicRadarConfig>;
export interface MosaicExperiment {
  dataset: MosaicDataset;
  options: ResolvedMosaicRadarConfig;
  result: MosaicRadarResult;
  record: AnalysisRecord;
}
export type MosaicTsvSection = 'windows' | 'segments' | 'switches';
const canonical = (value: unknown) => JSON.stringify(analysisJson(value));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value: unknown, keys: readonly string[], context: string): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) {
    throw new Error(`${context} requires exactly ${keys.join(', ')}.`);
  }
}
function metadataText(value: unknown, context: string, maximum = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${context} requires 1–${maximum} characters without control characters.`);
  }
  return value.trim();
}
function nullableText(value: unknown, context: string, maximum = 512): string | null {
  return value === null ? null : metadataText(value, context, maximum);
}
function sourceId(value: unknown): string {
  const id = metadataText(value, 'Mosaic source ID', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) throw new Error('Mosaic source IDs require letters, digits, dots, colons, hyphens or underscores.');
  return id;
}
function mosaicBytes(content: string): void {
  if (typeof content !== 'string' || content.length > MOSAIC_LIMITS.bytes || new TextEncoder().encode(content).length > MOSAIC_LIMITS.bytes) {
    throw new Error('Mosaic dataset exceeds the 6 MiB UTF-8 limit.');
  }
}
function sequenceSource(value: unknown): MosaicSequenceInput {
  exactKeys(value, ['id', 'label', 'accession', 'sequence', 'source', 'sourceDescription', 'sourceReference', 'sourceLicense', 'sourceLength', 'sourceStart'], 'Mosaic sequence source');
  if (typeof value.sequence !== 'string' || !value.sequence.length || value.sequence.length > MOSAIC_LIMITS.sequenceBases
    || /[^ACGTRYSWKMBDHVN]/i.test(value.sequence)) throw new Error('Mosaic sources require 1–5,000,000 IUPAC DNA bases without gaps or formatting characters.');
  if (!['local', 'catalog', 'external', 'demo'].includes(String(value.source))) throw new Error('Specify local, catalog, external or demo mosaic provenance.');
  if (typeof value.sourceLength !== 'number' || !Number.isSafeInteger(value.sourceLength) || value.sourceLength < 1
    || typeof value.sourceStart !== 'number' || !Number.isSafeInteger(value.sourceStart) || value.sourceStart < 0
    || value.sourceStart > value.sourceLength - value.sequence.length) throw new Error('Mosaic source range must fit its declared original length.');
  return { id: sourceId(value.id), label: metadataText(value.label, 'Mosaic source label', 256),
    accession: nullableText(value.accession, 'Mosaic accession'), sequence: value.sequence,
    source: value.source as MosaicSequenceInput['source'], sourceDescription: metadataText(value.sourceDescription, 'Mosaic source description', 2000),
    sourceReference: nullableText(value.sourceReference, 'Mosaic source reference', 2000),
    sourceLicense: nullableText(value.sourceLicense, 'Mosaic source license'), sourceLength: value.sourceLength, sourceStart: value.sourceStart };
}

/** Validate and copy before any asynchronous computation or replacement of a
 * visible result. Reordering the supplied panel cannot change experiment identity.
 */
export function validateMosaicDataset(value: unknown): MosaicDataset {
  exactKeys(value, ['format', 'version', 'name', 'query', 'references', 'excludedReferences'], 'Mosaic dataset');
  if (value.format !== 'phage-explorer-mosaic-dataset' || value.version !== 1) throw new Error('Unsupported mosaic dataset format or version.');
  if (!Array.isArray(value.references) || value.references.length > MOSAIC_LIMITS.references) throw new Error('Supply at most 30 exact mosaic reference sequences.');
  if (!Array.isArray(value.excludedReferences) || value.excludedReferences.length > MOSAIC_LIMITS.excludedReferences) throw new Error('Supply at most 500 explicitly excluded mosaic references.');
  const suppliedBases = [value.query, ...value.references].reduce((sum: number, item: unknown) =>
    sum + (object(item) && typeof item.sequence === 'string' ? item.sequence.length : 0), 0);
  if (suppliedBases > MOSAIC_LIMITS.bases) throw new Error('Mosaic query and reference sequences exceed 5,000,000 supplied bases. Select a smaller explicit panel.');
  const query = sequenceSource(value.query);
  const references = value.references.map(sequenceSource).sort((a, b) => compareLabels(a.label, b.label));
  const excludedReferences = value.excludedReferences.map(item => {
    exactKeys(item, ['id', 'label', 'accession', 'reason'], 'Excluded mosaic reference');
    return { id: sourceId(item.id), label: metadataText(item.label, 'Excluded reference label', 256),
      accession: nullableText(item.accession, 'Excluded reference accession'), reason: metadataText(item.reason, 'Reference exclusion reason', 2000) };
  }).sort((a, b) => compareLabels(a.label, b.label));
  const identities = [query, ...references, ...excludedReferences];
  if (new Set(identities.map(item => item.id)).size !== identities.length) throw new Error('Mosaic query, references and exclusions require unique source IDs.');
  if (new Set(identities.map(item => item.label)).size !== identities.length) throw new Error('Mosaic query, references and exclusions require unique labels.');
  const result: MosaicDataset = { format: 'phage-explorer-mosaic-dataset', version: 1,
    name: metadataText(value.name, 'Mosaic dataset name'), query, references, excludedReferences };
  mosaicBytes(JSON.stringify(result));
  return result;
}
export function parseMosaicDataset(content: string): MosaicDataset {
  mosaicBytes(content);
  return validateMosaicDataset(JSON.parse(content.replace(/^\uFEFF/, '')));
}
export function serializeMosaicDataset(dataset: MosaicDataset): string {
  const text = JSON.stringify(validateMosaicDataset(dataset), null, 2);
  mosaicBytes(text);
  return text;
}

/** Resolve historical kernel minima once; recordings retain the effective values. */
export function resolveMosaicRadarConfig(config: MosaicRadarConfig = {}): ResolvedMosaicRadarConfig {
  if (!object(config) || Object.keys(config).some(key => !['k', 'window', 'step', 'minSimilarity', 'maxReferences', 'topN'].includes(key))) throw new Error('Unsupported mosaic options.');
  const k = positiveInteger(config.k === undefined ? 5 : config.k, 'k', 16);
  const window = Math.max(200, positiveInteger(config.window === undefined ? 2000 : config.window, 'window', MOSAIC_LIMITS.sequenceBases));
  const step = Math.max(100, positiveInteger(config.step === undefined ? Math.floor(window / 2) : config.step, 'step', MOSAIC_LIMITS.sequenceBases));
  if (step > window) throw new Error('Mosaic step must not exceed window.');
  const minSimilarity = config.minSimilarity === undefined ? 0.05 : config.minSimilarity;
  if (typeof minSimilarity !== 'number' || !Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) throw new Error('Mosaic minSimilarity must be between 0 and 1.');
  return { k, window, step, minSimilarity,
    maxReferences: positiveInteger(config.maxReferences === undefined ? 30 : config.maxReferences, 'maxReferences', MOSAIC_LIMITS.references),
    topN: positiveInteger(config.topN === undefined ? 3 : config.topN, 'topN', MOSAIC_LIMITS.references) };
}
function mosaicBudget(dataset: MosaicDataset, options: ResolvedMosaicRadarConfig): void {
  const length = dataset.query.sequence.length;
  const panel = dataset.references.slice(0, options.maxReferences);
  const count = !panel.length || length < options.k ? 0 : length <= options.window ? 1 : Math.ceil((length - options.window) / options.step) + 1;
  if (count > MOSAIC_LIMITS.windows) throw new Error('Mosaic output exceeds 5,000 windows. Increase the step size.');
  // Upper bounds on visited sequence bases and set-membership comparisons, not
  // a timing claim. No sequences are sampled or silently truncated to fit.
  const windowBases = Math.min(options.window, length);
  const possibleKmers = Math.max(0, windowBases - options.k + 1);
  const operations = panel.reduce((sum, reference) => sum + reference.sequence.length, 0) + count * windowBases
    + count * panel.reduce((sum, reference) => sum + Math.min(possibleKmers, Math.max(0, reference.sequence.length - options.k + 1), 4 ** options.k), 0);
  if (operations > MOSAIC_LIMITS.operations) throw new Error('Mosaic workload exceeds 50,000,000 bounded scan/comparison operations. Increase the step size or select a smaller panel/window explicitly.');
}
function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Mosaic experiment cancelled.', 'AbortError');
}
function sourceCoverage(source: MosaicSequenceInput) {
  return { id: source.id, label: source.label, accession: source.accession, source: source.source,
    sourceLength: source.sourceLength, sourceStart: source.sourceStart, sourceEnd: source.sourceStart + source.sequence.length,
    analyzedBases: source.sequence.length, omittedBases: source.sourceLength - source.sequence.length };
}
const MOSAIC_LIMITATIONS = [
  'Jaccard measures canonical k-mer set overlap with this exact supplied panel. It is not alignment identity, probability, donor assignment, a recombination event, transfer direction or transfer age.',
  'Only A/C/G/T runs contribute k-mers. IUPAC ambiguity, absent references and zero overlap never establish biological absence or susceptibility.',
  'Windows are linear and 0-based/end-exclusive within the analyzed query slice. Source offsets and omitted bases are explicit; circular-origin windows are not inferred.',
  'Display segments partition query coordinates at midpoints between sampled window centers. Their lengths are display coverage, not aligned or matching bases.',
  'Reference-switch intervals span supporting window centers. Their navigation midpoint is not an inferred biological breakpoint.',
];

export async function createMosaicExperiment(input: MosaicDataset, config: MosaicRadarConfig = {}, signal?: AbortSignal): Promise<MosaicExperiment> {
  active(signal);
  const dataset = validateMosaicDataset(input), options = resolveMosaicRadarConfig(config);
  mosaicBudget(dataset, options);
  const result = computeMosaicRadar(dataset.query.sequence, dataset.references, options);
  const selected = dataset.references.slice(0, options.maxReferences);
  const demo = [dataset.query, ...dataset.references].some(source => source.source === 'demo');
  const field = (label: string, value: unknown, coverage: AnalysisField['coverage']): AnalysisField => demo
    ? { kind: 'demo', label, units: 'records', value: analysisJson(value), coverage, limitations: [...MOSAIC_LIMITATIONS],
      assumptions: ['One or more supplied source sequences are explicitly designated demonstration data; these outputs are not observations of the selected phage.'] }
    : { kind: 'sequence-score', label, units: 'records', value: analysisJson(value), coverage, limitations: [...MOSAIC_LIMITATIONS] };
  const source = demo ? 'demo' : [dataset.query, ...dataset.references].some(item => item.source === 'local') ? 'local'
    : [dataset.query, ...dataset.references].every(item => item.source === 'catalog') ? 'catalog' : 'external';
  const record = await createAnalysisRecord({ method: MOSAIC_METHOD,
    inputs: [{ id: 'dataset', accession: dataset.query.accession, source,
      description: 'Exact query and reference slices, stable source identities, source attribution and explicit exclusions. Accession names do not replace these supplied bases.', data: analysisJson(dataset) }],
    parameters: { ...options }, seed: null, references: [MOSAIC_REFERENCE], fields: {
      mosaic: field('Canonical k-mer reference similarity and sampled switches', result,
        { available: result.windows.filter(window => window.status !== 'no-evidence').length, total: result.windows.length, unit: 'records' }),
      coverage: field('Exact analyzed source ranges and reference-panel coverage', {
        query: sourceCoverage(dataset.query), selectedReferences: selected.map(sourceCoverage),
        omittedReferences: dataset.references.slice(options.maxReferences).map(reference => ({ ...sourceCoverage(reference), reason: 'Excluded by explicit maxReferences after label ordering.' })),
        excludedReferences: dataset.excludedReferences, unusableReferenceLabels: result.referencePanel.excludedLabels,
        unobservedQueryBases: result.windows.length === 0 ? dataset.query.sequence.length : result.coverage['no-evidence'],
        truncation: [dataset.query, ...selected].some(item => item.sequence.length !== item.sourceLength),
      }, { available: result.referencePanel.usable, total: dataset.references.length + dataset.excludedReferences.length, unit: 'records' }),
    } });
  active(signal);
  return { dataset, options, result, record };
}

/** Envelope integrity is necessary but insufficient: every accepted imported
 * result is recomputed from its embedded dataset, including evidence metadata.
 */
export async function replayMosaicExperiment(content: string, signal?: AbortSignal): Promise<MosaicExperiment> {
  active(signal);
  const saved = await parseAnalysisRecord(content, { methodId: MOSAIC_METHOD.id, methodVersion: MOSAIC_METHOD.version });
  active(signal);
  if (canonical(saved.method) !== canonical(MOSAIC_METHOD) || canonical(saved.references) !== canonical([MOSAIC_REFERENCE]) || saved.seed !== null
    || saved.inputs.length !== 1 || saved.inputs[0].id !== 'dataset') throw new Error('Mosaic method, reference, seed or exact dataset contract differs.');
  const dataset = validateMosaicDataset(saved.inputs[0].data), options = resolveMosaicRadarConfig(saved.parameters);
  if (canonical(saved.parameters) !== canonical(options)) throw new Error('All effective mosaic options must be explicit.');
  const fresh = await createMosaicExperiment(dataset, options, signal);
  if (fresh.record.cacheKey !== saved.cacheKey || fresh.record.resultId !== saved.resultId) throw new Error('Fresh mosaic calculation or source evidence differs from the saved experiment.');
  return fresh;
}

/** Extract only after a successful producer or replay. This helper does not
 * authenticate hashes or replace recomputation of an imported experiment.
 */
export function mosaicResultFromRecord(record: AnalysisRecord): MosaicRadarResult {
  const value = record.fields.mosaic?.value;
  if (canonical(record.method) !== canonical(MOSAIC_METHOD) || !object(value)
    || !Array.isArray(value.windows) || !Array.isArray(value.segments) || !Array.isArray(value.referenceSwitches)
    || !Array.isArray(value.breakpoints) || !object(value.coverage) || !object(value.referencePanel)) throw new Error('Expected a produced or replayed portable mosaic result.');
  return structuredClone(value) as unknown as MosaicRadarResult;
}
function tsvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  // Formula prefixes stay inert when a user opens an exported table in a spreadsheet.
  const text = /^[=+@-]/.test(value) ? `'${value}` : value;
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function exportMosaicTsv(record: AnalysisRecord, section: MosaicTsvSection = 'windows'): string {
  const result = mosaicResultFromRecord(record);
  const dataset = validateMosaicDataset(record.inputs[0]?.data);
  const offset = dataset.query.sourceStart;
  const comments = [
    `# method=${record.method.id}; version=${record.method.version}; result=${record.resultId}; inputSha256=${record.inputs[0].sha256}`,
    `# query=${JSON.stringify(sourceCoverage(dataset.query))}; options=${canonical(record.parameters)}`,
    `# source_attribution=${JSON.stringify([dataset.query, ...dataset.references].map(({ sequence: _sequence, ...source }) => source))}`,
    `# panel_coverage=${canonical(record.fields.coverage?.value)}`,
    '# Linear analyzed-slice coordinates are 0-based/end-exclusive; source coordinates include the declared offset. Scores are k-mer Jaccard, not identity or probability.',
    '# Reference switches describe sampled similarity, not donors, recombination events or biological breakpoints. Empty closest-reference cells retain their explicit evidence status.',
  ];
  let header: string[], rows: Array<Array<string | number | null>>;
  if (section === 'windows') {
    header = ['start_0based', 'end_exclusive', 'source_start_0based', 'source_end_exclusive', 'closest_reference', 'status', 'jaccard', 'valid_kmer_count', 'tied_references', 'top_references'];
    rows = result.windows.map(window => [window.start, window.end, window.start + offset, window.end + offset,
      window.donor, window.status, window.score, window.validKmerCount, JSON.stringify(window.tiedReferences), JSON.stringify(window.topDonors)]);
  } else if (section === 'segments') {
    header = ['start_0based', 'end_exclusive', 'source_start_0based', 'source_end_exclusive', 'closest_reference', 'status', 'weighted_mean_jaccard', 'windows', 'tied_references'];
    rows = result.segments.map(segment => [segment.start, segment.end, segment.start + offset, segment.end + offset,
      segment.donor, segment.status, segment.meanScore, segment.windows, JSON.stringify(segment.tiedReferences)]);
  } else if (section === 'switches') {
    header = ['from_reference', 'to_reference', 'start_0based', 'end_exclusive', 'navigation_midpoint', 'source_start_0based', 'source_end_exclusive', 'source_midpoint'];
    rows = result.referenceSwitches.map(change => [change.from, change.to, change.start, change.end, change.position,
      change.start + offset, change.end + offset, change.position + offset]);
  } else throw new Error('Choose mosaic windows, segments or switches for TSV export.');
  return [...comments, header.join('\t'), ...rows.map(row => row.map(tsvCell).join('\t'))].join('\n') + '\n';
}

