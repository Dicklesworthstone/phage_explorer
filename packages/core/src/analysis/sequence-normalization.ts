/** Reversible strand/origin normalization for the bounded, collinear pangenome aligner.
 * Circular mode is an explicit assertion that BOTH inputs are complete circles.
 * Exact equivalence uses linear-time KMP. Otherwise unique, non-overlapping
 * ACGT 15-mers select a strand/anchor; WFA is exact conditional on that anchor,
 * not an exhaustive optimum over all circular rotations or rearrangements.
 */
import { alignWavefront, WAVEFRONT_LIMITS, type WavefrontAlignment, type WavefrontOptions } from './wavefront-alignment';

export type SequenceNormalization = 'strand' | 'circular';
/** normalized = rotateLeft(strand === '-' ? reverseComplement(original) : original, offset). */
export interface SequenceTransform { strand: '+' | '-'; offset: number }
export interface NormalizationEvidence {
  method: 'exact-equivalence' | 'unique-kmer-anchor';
  forwardSupport: number; reverseSupport: number;
  equivalentForwardOrigins: number; equivalentReverseOrigins: number;
  anchor: { k: number; referenceStart: number; queryStart: number } | null;
  limitations: string[];
}
export interface NormalizedWavefrontAlignment extends WavefrontAlignment {
  transform: SequenceTransform;
  normalization: NormalizationEvidence;
}
const K = 15, MASK = 0x3fffffff;
const COMPLEMENT: Readonly<Record<string, string>> = {
  A: 'T', C: 'G', G: 'C', T: 'A', R: 'Y', Y: 'R', S: 'S', W: 'W',
  K: 'M', M: 'K', B: 'V', D: 'H', H: 'D', V: 'B', N: 'N',
};
function validateLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 1 || length > WAVEFRONT_LIMITS.length) {
    throw new Error('Normalization requires 1–250,000 bases per sequence.');
  }
}
function validateSequence(sequence: string): void {
  if (typeof sequence !== 'string') throw new Error('Normalization requires a DNA string.');
  validateLength(sequence.length);
  if (/[^ACGTRYSWKMBDHVN]/.test(sequence)) throw new Error('Normalization requires uppercase ungapped IUPAC DNA.');
}
function validateTransform(length: number, transform: SequenceTransform): void {
  validateLength(length);
  if (!transform || !['+', '-'].includes(transform.strand) || !Number.isSafeInteger(transform.offset)
      || transform.offset < 0 || transform.offset >= length) throw new Error('Invalid sequence strand/origin transform.');
}
const rotate = (sequence: string, offset: number) => sequence.slice(offset) + sequence.slice(0, offset);
function reverse(sequence: string): string {
  const bases = new Array<string>(sequence.length);
  for (let i = 0; i < sequence.length; i++) bases[i] = COMPLEMENT[sequence[sequence.length - 1 - i]];
  return bases.join('');
}
export function transformSequence(sequence: string, transform: SequenceTransform): string {
  validateSequence(sequence); validateTransform(sequence.length, transform);
  return rotate(transform.strand === '-' ? reverse(sequence) : sequence, transform.offset);
}
export function restoreSequence(sequence: string, transform: SequenceTransform): string {
  validateSequence(sequence); validateTransform(sequence.length, transform);
  const oriented = rotate(sequence, (sequence.length - transform.offset) % sequence.length);
  return transform.strand === '-' ? reverse(oriented) : oriented;
}
/** Map a normalized 0-based half-open interval to original input segments in
 * traversal order. Reverse-strand segments must be reverse-complemented before
 * concatenating them. An interval crossing the old origin produces two segments.
 */
export function mapNormalizedInterval(length: number, transform: SequenceTransform, start: number, end: number):
  Array<{ start: number; end: number; strand: '+' | '-' }> {
  validateTransform(length, transform);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > length) {
    throw new Error('Invalid normalized sequence interval.');
  }
  const segments: Array<{ start: number; end: number; strand: '+' | '-' }> = [];
  let position = (transform.offset + start) % length, remaining = end - start;
  while (remaining > 0) {
    const take = Math.min(remaining, length - position);
    segments.push(transform.strand === '+' ? { start: position, end: position + take, strand: '+' }
      : { start: length - position - take, end: length - position, strand: '-' });
    remaining -= take; position = 0;
  }
  return segments;
}

/** Search only n origins, not the duplicated origin at n; report all ties. */
function equivalentOrigins(pattern: string, sequence: string, circular: boolean): { offset: number; count: number } {
  if (pattern.length !== sequence.length) return { offset: 0, count: 0 };
  if (!circular) return { offset: 0, count: pattern === sequence ? 1 : 0 };
  const n = pattern.length, prefix = new Int32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    while (j > 0 && pattern[i] !== pattern[j]) j = prefix[j - 1];
    if (pattern[i] === pattern[j]) j++;
    prefix[i] = j;
  }
  let count = 0, offset = 0;
  for (let i = 0, j = 0; i < 2 * n - 1; i++) {
    const base = sequence[i % n];
    while (j > 0 && base !== pattern[j]) j = prefix[j - 1];
    if (base === pattern[j]) j++;
    if (j === n) { if (!count) offset = i - n + 1; count++; j = prefix[j - 1]; }
  }
  return { offset, count };
}
/** Collision-free 30-bit encoding. Duplicated/ambiguous windows cannot anchor. */
function uniqueKmers(sequence: string, circular: boolean): Map<number, number> {
  const positions = new Map<number, number>(), n = sequence.length;
  if (n < K) return positions;
  let key = 0, valid = 0;
  for (let i = 0; i < n + (circular ? K - 1 : 0); i++) {
    const base = sequence.charCodeAt(i % n);
    const code = base === 65 ? 0 : base === 67 ? 1 : base === 71 ? 2 : base === 84 ? 3 : -1;
    if (code < 0) { key = 0; valid = 0; continue; }
    key = ((key << 2) | code) & MASK; valid++;
    if (valid >= K) positions.set(key, positions.has(key) ? -1 : i - K + 1);
  }
  return positions;
}
function anchors(reference: Map<number, number>, query: Map<number, number>, referenceLength: number, queryLength: number):
  Array<{ referenceStart: number; queryStart: number }> {
  const result: Array<{ referenceStart: number; queryStart: number }> = [];
  const occupied = new Uint8Array(queryLength), referenceOccupied = new Uint8Array(referenceLength);
  let lastReferenceEnd = -1;
  // Map insertion order is increasing first-reference position, including keys
  // subsequently marked duplicated. Support windows overlap in neither input.
  for (const [key, referenceStart] of reference) {
    const queryStart = query.get(key);
    if (referenceStart < 0 || referenceStart < lastReferenceEnd || queryStart === undefined || queryStart < 0) continue;
    let overlaps = false;
    for (let i = 0; i < K; i++) if (occupied[(queryStart + i) % queryLength] || referenceOccupied[(referenceStart + i) % referenceLength]) { overlaps = true; break; }
    if (overlaps) continue;
    for (let i = 0; i < K; i++) { occupied[(queryStart + i) % queryLength] = 1; referenceOccupied[(referenceStart + i) % referenceLength] = 1; }
    result.push({ referenceStart, queryStart }); lastReferenceEnd = referenceStart + K;
  }
  return result;
}

export function alignNormalizedWavefront(reference: string, query: string, mode: SequenceNormalization,
  options: WavefrontOptions = {}): NormalizedWavefrontAlignment {
  validateSequence(reference); validateSequence(query);
  if (mode !== 'strand' && mode !== 'circular') throw new Error('Unsupported sequence normalization mode.');
  const circular = mode === 'circular', rc = reverse(query);
  const forward = equivalentOrigins(reference, query, circular), backward = equivalentOrigins(reference, rc, circular);
  let strand: '+' | '-' = '+', referenceStart = 0, queryStart = 0;
  const evidence: NormalizationEvidence = {
    method: 'exact-equivalence', forwardSupport: 0, reverseSupport: 0,
    equivalentForwardOrigins: forward.count, equivalentReverseOrigins: backward.count, anchor: null,
    limitations: [circular ? 'Complete circular inputs were asserted by the user; topology is not inferred.' : 'Whole-sequence strand normalization only; origins and internal rearrangements are not searched.'],
  };
  if (forward.count || backward.count) {
    strand = forward.count ? '+' : '-'; queryStart = forward.count ? forward.offset : backward.offset;
    evidence.limitations.push('Exact equivalence compares IUPAC symbols literally, not resolved biological identity.');
    if (forward.count + backward.count > 1) evidence.limitations.push('Multiple equivalent transforms exist; forward strand then lowest offset wins. This does not identify a biological origin or strand.');
  } else {
    const index = uniqueKmers(reference, circular);
    const plus = anchors(index, uniqueKmers(query, circular), reference.length, query.length);
    const minus = anchors(index, uniqueKmers(rc, circular), reference.length, query.length);
    evidence.method = 'unique-kmer-anchor'; evidence.forwardSupport = plus.length; evidence.reverseSupport = minus.length;
    strand = plus.length >= minus.length ? '+' : '-';
    const chosen = strand === '+' ? plus : minus, competing = strand === '+' ? minus : plus;
    if (chosen.length < 3 || chosen.length < 2 * competing.length) {
      throw new Error('Strand/origin normalization lacks decisive unique 15-mer support (at least 3 non-overlapping anchors and twice the opposite-strand support required). Supply a justified orientation/alignment instead; no transform was guessed.');
    }
    evidence.anchor = { k: K, ...chosen[0] };
    if (circular) { referenceStart = chosen[0].referenceStart; queryStart = chosen[0].queryStart; }
    evidence.limitations.push('Unique 15-mer support selects a heuristic strand/anchor, not a confidence value or an exhaustive optimum over orientations/origins. Internal inversions and rearrangements are unsupported.');
  }
  const oriented = strand === '+' ? query : rc;
  const aligned = alignWavefront(rotate(reference, referenceStart), rotate(oriented, queryStart), options);
  // Restore the submitted reference origin by rotating ALIGNMENT COLUMNS, not
  // subtracting anchor coordinates. This accounts for indels before the origin.
  let split = 0, queryBeforeSplit = 0;
  if (referenceStart > 0) {
    const target = reference.length - referenceStart;
    let consumed = 0;
    while (split < aligned.reference.length && consumed < target) {
      if (aligned.reference[split] !== '-') consumed++;
      if (aligned.query[split] !== '-') queryBeforeSplit++;
      split++;
    }
  }
  const result: NormalizedWavefrontAlignment = {
    ...aligned, reference: rotate(aligned.reference, split), query: rotate(aligned.query, split),
    transform: { strand, offset: (queryStart + queryBeforeSplit) % query.length }, normalization: evidence,
  };
  if (result.reference.replaceAll('-', '') !== reference ||
      result.query.replaceAll('-', '') !== transformSequence(query, result.transform)) {
    throw new Error('Normalized alignment failed exact sequence reconstruction.');
  }
  return result;
}
