/**
 * Restriction Digest Logic
 *
 * Simulates digestion of DNA by restriction enzymes.
 * Handles linear and circular genomes.
 */

import { type RestrictionEnzyme, expandSiteRegex, RESTRICTION_ENZYMES } from '../data/restriction-enzymes';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export interface DigestFragment {
  start: number;
  end: number;
  length: number;
  sequence: string; // Optional, might be heavy
}

export interface DigestResult {
  enzyme: string;
  fragments: DigestFragment[];
  cutSites: number[];
}

/**
 * Definite cuts on the supplied strand for the catalog's palindromic sites.
 * Coordinates are boundaries between bases, in [0, length] for linear DNA and
 * [0, length) for circular DNA. Unresolved sequence bases do not imply a cut.
 */
export function findRestrictionCutSites(
  sequence: string,
  enzyme: RestrictionEnzyme,
  isCircular = false,
  maxCuts = Number.POSITIVE_INFINITY
): number[] {
  if (maxCuts !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxCuts) || maxCuts < 0)) {
    throw new RangeError('The restriction cut limit must be a nonnegative integer');
  }
  if (!enzyme.site || !/^[ACGTRYSWKMBDHVN]+$/i.test(enzyme.site) || !Number.isInteger(enzyme.cutOffset)) {
    throw new RangeError('A restriction enzyme needs an IUPAC recognition site and an integer cut offset');
  }
  const seq = sequence.toUpperCase();
  if (seq.length < enzyme.site.length) return [];
  const search = isCircular ? seq + seq.slice(0, enzyme.site.length - 1) : seq;
  const regex = expandSiteRegex(enzyme.site);
  const cuts = new Set<number>();
  let match;
  while ((match = regex.exec(search)) !== null && match.index < seq.length) {
    const cutPos = match.index + enzyme.cutOffset;
    if (isCircular) {
      cuts.add(((cutPos % seq.length) + seq.length) % seq.length);
    } else if (cutPos >= 0 && cutPos <= seq.length) {
      cuts.add(cutPos);
    }
    if (cuts.size > maxCuts) throw new RangeError(`Restriction digest exceeds ${maxCuts} cut sites; no partial result was returned.`);
    // Global regex matching otherwise skips overlapping recognition sites.
    regex.lastIndex = match.index + 1;
  }
  return [...cuts].sort((a, b) => a - b);
}

/** Ideal complete digest with one or several enzymes; shared by web and TUI. */
export function digestGenome(
  sequence: string,
  enzyme: RestrictionEnzyme | readonly RestrictionEnzyme[],
  isCircular = false
): DigestResult {
  const enzymes: readonly RestrictionEnzyme[] = 'site' in enzyme ? [enzyme] : enzyme;
  const name = enzymes.map(item => item.name).join('+');
  const seq = sequence.toUpperCase();
  const cutSites = [...new Set(enzymes.flatMap(item => findRestrictionCutSites(seq, item, isCircular)))].sort((a, b) => a - b);

  return digestAtCuts(seq, name, cutSites, isCircular);
}

/** Shared interval construction keeps portable records and both gel viewers identical. */
function digestAtCuts(seq: string, name: string, cutSites: number[], isCircular: boolean): DigestResult {

  if (cutSites.length === 0) {
    return {
      enzyme: name,
      fragments: seq.length ? [{ start: 0, end: seq.length, length: seq.length, sequence: seq }] : [],
      cutSites: [],
    };
  }

  const fragments: DigestFragment[] = [];
  
  for (let i = 0; i < cutSites.length - 1; i++) {
    const start = cutSites[i];
    const end = cutSites[i + 1];
    fragments.push({
      start,
      end,
      length: end - start,
      sequence: seq.slice(start, end),
    });
  }

  // Handle ends
  if (isCircular) {
    // Circular: Last fragment wraps from last cut to first cut
    const lastStart = cutSites[cutSites.length - 1];
    const firstEnd = cutSites[0];
    const length = (seq.length - lastStart) + firstEnd;
    // Note: Sequence construction for wrap-around
    fragments.push({
      start: lastStart,
      end: firstEnd,
      length,
      sequence: seq.slice(lastStart) + seq.slice(0, firstEnd),
    });
  } else {
    // Linear: First fragment (0 to first cut) and Last fragment (last cut to end)
    if (cutSites[0] > 0) {
      fragments.unshift({
        start: 0,
        end: cutSites[0],
        length: cutSites[0],
        sequence: seq.slice(0, cutSites[0]),
      });
    }
    const lastCut = cutSites[cutSites.length - 1];
    if (lastCut < seq.length) {
      fragments.push({
        start: lastCut,
        end: seq.length,
        length: seq.length - lastCut,
        sequence: seq.slice(lastCut),
      });
    }
  }

  // Sort fragments by length (descending) for gel visualization
  fragments.sort((a, b) => b.length - a.length);

  return {
    enzyme: name,
    fragments,
    cutSites,
  };
}

/**
 * Compute band migration distance
 * Illustrative log-size calibration, not a physical gel mobility prediction.
 * Map the percentage migration onto maxRun (e.g. terminal rows).
 */
export function calculateMigration(length: number, maxRun = 100): number {
  // Map 20kb -> 5%, 100bp -> 95%
  // log10(20000) = 4.3
  // log10(100) = 2
  // d = m * log(L) + c
  // 5 = m * 4.3 + c
  // 95 = m * 2 + c
  // -90 = m * 2.3 => m = -39.1
  // 95 = -39.1 * 2 + c => c = 173.2
  // d = 173.2 - 39.1 * log10(L)
  
  if (length <= 0) return maxRun;
  const logL = Math.log10(length);
  const dist = 173.2 - 39.1 * logL;
  return Math.max(0, Math.min(100, dist)) * maxRun / 100;
}

export const RESTRICTION_DIGEST_LIMITS = { bases: 5000000, cuts: 20000 } as const;
export const RESTRICTION_DIGEST_METHOD = { id: 'restriction-digest', version: '1',
  implementation: 'TypeScript overlapping IUPAC-site scan and exact forward-strand cut intervals' };
const DIGEST_REFERENCE = { id: 'restriction-digest-conventions', version: '1',
  description: 'Embedded palindromic enzyme definitions; definite A/C/G/T matches; ideal complete digestion; forward-strand boundary coordinates.' };
export interface RestrictionDigestOptions {
  /** An empty selection explicitly requests the uncut control. */
  enzymes: readonly string[];
  topology: 'linear' | 'circular';
}
export interface RestrictionDigestFragment {
  start: number;
  end: number;
  length: number;
  wrapsOrigin: boolean;
}
const canonicalDigest = (value: unknown) => JSON.stringify(analysisJson(value));

/** No ambient topology or enzyme defaults are allowed in portable experiments. */
export function resolveRestrictionDigestOptions(value: unknown): RestrictionDigestOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== 'enzymes|topology') throw new Error('Specify only enzymes and topology for restriction digestion.');
  const options = value as Record<string, unknown>;
  if (options.topology !== 'linear' && options.topology !== 'circular') throw new Error('Specify linear or circular molecule topology.');
  if (!Array.isArray(options.enzymes) || options.enzymes.length > RESTRICTION_ENZYMES.length
    || options.enzymes.some(name => typeof name !== 'string' || !RESTRICTION_ENZYMES.some(enzyme => enzyme.name === name))
    || new Set(options.enzymes).size !== options.enzymes.length) throw new Error('Select distinct enzymes from the restriction catalog.');
  return { enzymes: [...options.enzymes].sort(), topology: options.topology };
}

function digestEnzymes(options: RestrictionDigestOptions): RestrictionEnzyme[] {
  return options.enzymes.map(name => ({ ...RESTRICTION_ENZYMES.find(enzyme => enzyme.name === name)! }));
}

/** The source is retained once; fragments contain coordinates, not duplicated genomes. */
export async function createRestrictionDigestRecord(sequence: string, settings: RestrictionDigestOptions,
  context: { accession: string | null; source: 'local' | 'catalog' } = { accession: null, source: 'local' }): Promise<AnalysisRecord> {
  if (typeof sequence !== 'string' || !sequence.length || sequence.length > RESTRICTION_DIGEST_LIMITS.bases
    || /[^ACGTRYSWKMBDHVN]/i.test(sequence)) throw new Error('Restriction experiments require 1–5,000,000 IUPAC DNA bases without gaps or formatting.');
  const options = resolveRestrictionDigestOptions(settings), enzymes = digestEnzymes(options);
  const circular = options.topology === 'circular';
  const cuts = new Set<number>();
  for (const enzyme of enzymes) {
    for (const cut of findRestrictionCutSites(sequence, enzyme, circular, RESTRICTION_DIGEST_LIMITS.cuts)) cuts.add(cut);
    if (cuts.size > RESTRICTION_DIGEST_LIMITS.cuts) throw new Error('Restriction experiment exceeds 20,000 combined cut sites; no partial result was returned.');
  }
  const result = digestAtCuts(sequence.toUpperCase(), enzymes.map(enzyme => enzyme.name).join('+'), [...cuts].sort((a, b) => a - b), circular);
  const fragments: RestrictionDigestFragment[] = result.fragments.map(({ start, end, length }) => ({
    start, end, length, wrapsOrigin: circular && result.cutSites.length > 0 && end <= start,
  }));
  let resolvedBases = 0;
  for (let i = 0; i < sequence.length; i++) if ('ACGTacgt'.includes(sequence[i])) resolvedBases++;
  const coverage = { available: resolvedBases, total: sequence.length, unit: 'bases' as const };
  const limitations = [
    'Ideal complete digestion at definite sites only; methylation, partial digestion, star activity and reaction conditions are not modeled.',
    'Ambiguous bases retain their coordinates but cannot establish a cut. Zero definite sites does not exclude sites hidden by unresolved bases.',
    'Coordinates are forward-strand boundaries, not sticky-end sequences or experimentally measured gel mobility.',
    'For circular cut products, wrapsOrigin means [start, molecule length) followed by [0, end); start=end denotes one full-length cut product.',
    'An uncut circular molecule remains circular; the whole-molecule interval is not evidence of linearization or a calibrated gel band.',
  ];
  return createAnalysisRecord({ method: RESTRICTION_DIGEST_METHOD, inputs: [
    { id: 'sequence', ...context, description: 'Exact nucleotide string, including original case and unresolved IUPAC bases.', data: sequence },
    { id: 'enzymes', accession: null, source: 'catalog', description: 'Exact recognition sites, forward cut offsets and overhang classes used for this digest.', data: analysisJson(enzymes) },
  ], parameters: analysisJson(options) as AnalysisRecord['parameters'], seed: null, references: [DIGEST_REFERENCE], fields: {
    cutSites: { label: 'Definite forward-strand cut boundaries', kind: 'sequence-score', units: 'records', value: result.cutSites, coverage, limitations },
    fragments: { label: 'Ideal complete-digest fragment coordinates', kind: 'sequence-score', units: 'records', value: analysisJson(fragments), coverage, limitations },
    summary: { label: 'Molecule and digest coverage', kind: 'sequence-score', units: 'records', coverage, limitations,
      value: { sequenceLength: sequence.length, resolvedBases, ambiguousBases: sequence.length - resolvedBases,
        cutCount: result.cutSites.length, fragmentCount: fragments.length, uncutCircular: circular && !result.cutSites.length } },
  } });
}

export async function parseRestrictionDigestRecord(content: string): Promise<{
  record: AnalysisRecord; sequence: string; options: RestrictionDigestOptions;
}> {
  const record = await parseAnalysisRecord(content, { methodId: RESTRICTION_DIGEST_METHOD.id, methodVersion: RESTRICTION_DIGEST_METHOD.version });
  const options = resolveRestrictionDigestOptions(record.parameters);
  const sequence = record.inputs[0], enzymes = record.inputs[1];
  if (canonicalDigest(record.method) !== canonicalDigest(RESTRICTION_DIGEST_METHOD) || record.seed !== null
    || canonicalDigest(record.references) !== canonicalDigest([DIGEST_REFERENCE])
    || canonicalDigest(record.parameters) !== canonicalDigest(options)) throw new Error('Incompatible restriction method, conventions or explicit settings.');
  if (record.inputs.length !== 2 || sequence.id !== 'sequence' || typeof sequence.data !== 'string'
    || !['local', 'catalog'].includes(sequence.source) || enzymes.id !== 'enzymes' || enzymes.source !== 'catalog'
    || enzymes.accession !== null || canonicalDigest(enzymes.data) !== canonicalDigest(digestEnzymes(options))) {
    throw new Error('Restriction replay requires the exact sequence and unchanged catalog enzyme definitions.');
  }
  return { record, sequence: sequence.data, options };
}

/** Recount cuts and reconstruct fragments even when a changed result has valid hashes. */
export async function replayRestrictionDigestRecord(content: string): Promise<AnalysisRecord> {
  const saved = await parseRestrictionDigestRecord(content);
  const fresh = await createRestrictionDigestRecord(saved.sequence, saved.options, {
    accession: saved.record.inputs[0].accession, source: saved.record.inputs[0].source as 'local' | 'catalog',
  });
  if (fresh.resultId !== saved.record.resultId) throw new Error('Recomputed restriction cuts or fragments differ from the saved experiment.');
  return fresh;
}

/** Export a producer/replay result; origin-crossing fragments are never flattened into invalid intervals. */
export function exportRestrictionDigestTsv(record: AnalysisRecord): string {
  if (canonicalDigest(record.method) !== canonicalDigest(RESTRICTION_DIGEST_METHOD)
    || !Array.isArray(record.fields.fragments?.value) || !Array.isArray(record.fields.cutSites?.value)) throw new Error('Expected a portable restriction digest.');
  const options = resolveRestrictionDigestOptions(record.parameters);
  const rows = record.fields.fragments.value as unknown as RestrictionDigestFragment[];
  return [`# method=${record.method.id}; version=${record.method.version}; result=${record.resultId}; inputSha256=${record.inputs[0].sha256}`,
    `# topology=${options.topology}; enzymes=${options.enzymes.join('+') || 'none'}; cuts_0based=${record.fields.cutSites.value.join(',')}`,
    '# Ideal complete digest; ambiguous bases are not cut evidence; uncut circles are not linearized.',
    'start_0based\tend_boundary\tlength_bp\twraps_origin',
    ...rows.map(row => [row.start, row.end, row.length, row.wrapsOrigin].join('\t'))].join('\n') + '\n';
}
