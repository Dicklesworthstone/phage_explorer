/** Unsampled fixed-length direct/inverted DNA pairs and portable evidence.
 * This is a separate method from the sampled mixed repeat overview: it enumerates
 * all non-overlapping resolved arms of a chosen length, not maximal repeat families.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export const EXACT_REPEAT_LIMITS = { bases: 5000000, armLength: 256, gap: 100000, pairs: 20000, comparisons: 50000000 } as const;
export interface ExactRepeatOptions {
  armLength?: number; maxGap?: number; maxPairs?: number;
  /** Circular is an explicit assertion of a complete molecule, never inferred. */
  topology?: 'linear' | 'circular';
}
// Omit linear topology from resolved data to preserve existing v1 identities.
export interface ResolvedExactRepeatOptions {
  armLength: number; maxGap: number; maxPairs: number; topology?: 'circular';
}
export interface ExactRepeatPair {
  // Circular starts are in [0,n); ends are unrolled start+length and may exceed n.
  type: 'direct' | 'inverted'; leftStart: number; leftEnd: number; rightStart: number; rightEnd: number; gap: number;
}
export interface ExactRepeatScan {
  pairs: ExactRepeatPair[];
  search: {
    sequenceLength: number; resolvedBases: number; options: ResolvedExactRepeatOptions;
    complete: boolean; stoppedAtRightStart: number | null; rightStartsVisited: number;
    comparedBases: number; comparisonBudget: number;
  };
}
export const EXACT_REPEAT_METHOD = { id: 'exact-repeat-pairs', version: '1',
  implementation: 'bounded sliding-prefix index; unsampled fixed-arm direct/reverse-complement verification' };
export const CIRCULAR_EXACT_REPEAT_METHOD = { id: 'exact-repeat-pairs', version: '2',
  implementation: 'bounded cyclic sliding-prefix index; shortest-arc canonical non-overlapping fixed-arm direct/reverse-complement verification' };
function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
export function resolveExactRepeatOptions(options: ExactRepeatOptions = {}): ResolvedExactRepeatOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['armLength', 'maxGap', 'maxPairs', 'topology'].includes(key))) throw new Error('Unsupported exact repeat options.');
  if (options.topology !== undefined && options.topology !== 'linear' && options.topology !== 'circular') throw new Error('Exact repeat topology must be linear or circular.');
  return {
    armLength: integer(options.armLength ?? 8, 4, EXACT_REPEAT_LIMITS.armLength, 'Arm length'),
    maxGap: integer(options.maxGap ?? 5000, 0, EXACT_REPEAT_LIMITS.gap, 'Maximum gap'),
    maxPairs: integer(options.maxPairs ?? 2000, 1, EXACT_REPEAT_LIMITS.pairs, 'Pair limit'),
    ...(options.topology === 'circular' ? { topology: 'circular' as const } : {}),
  };
}
/** Split a forward-traversed unrolled arm into original 0-based half-open spans.
 * Concatenate these spans in returned order; inverted matching does not change
 * either arm's genomic coordinate direction. Empty/repeated-circle arms fail.
 */
export function exactRepeatArmSegments(sequenceLength: number, start: number, end: number): Array<{ start: number; end: number }> {
  integer(sequenceLength, 1, EXACT_REPEAT_LIMITS.bases, 'Sequence length');
  integer(start, 0, sequenceLength - 1, 'Arm start');
  integer(end, start + 1, start + sequenceLength, 'Unrolled arm end');
  return end <= sequenceLength ? [{ start, end }] : [{ start, end: sequenceLength }, { start: 0, end: end - sequenceLength }];
}
/** Right starts ascend; at each start, direct then inverted pairs have ascending
 * left starts. Circular pairs use the shorter spacer arc (antipodal ties choose
 * the lower first start), so each unordered pair appears once per orientation.
 * Circular left starts follow arc order, possibly crossing zero. One extra match
 * proves truncation: reaching the pair limit alone does not imply incompleteness.
 * A lower comparison budget is allowed for callers; exhaustion throws, never
 * returns a partial success. The portable producer uses the fixed method budget.
 */
export function scanExactRepeatPairs(sequence: string, settings: ExactRepeatOptions = {}, comparisonBudget: number = EXACT_REPEAT_LIMITS.comparisons): ExactRepeatScan {
  const options = resolveExactRepeatOptions(settings), { armLength: length, maxGap, maxPairs } = options;
  const circular = options.topology === 'circular';
  integer(comparisonBudget, 0, EXACT_REPEAT_LIMITS.comparisons, 'Comparison budget');
  if (typeof sequence !== 'string' || sequence.length > EXACT_REPEAT_LIMITS.bases || /[^ACGTRYSWKMBDHVN]/i.test(sequence)) {
    throw new Error('Exact pairs require at most 5,000,000 IUPAC DNA bases; RNA, gaps and formatting characters are unsupported.');
  }
  if (circular && !sequence.length) throw new Error('A complete circular input must contain at least one base.');
  const bases = new Uint8Array(sequence.length);
  let resolvedBases = 0;
  for (let i = 0; i < bases.length; i++) {
    const c = sequence.charCodeAt(i) | 32;
    bases[i] = c === 97 ? 0 : c === 99 ? 1 : c === 103 ? 2 : c === 116 ? 3 : 4;
    if (bases[i] < 4) resolvedBases++;
  }
  const result: ExactRepeatScan = { pairs: [], search: { sequenceLength: sequence.length, resolvedBases, options,
    complete: true, stoppedAtRightStart: null, rightStartsVisited: 0, comparedBases: 0, comparisonBudget } };
  if (bases.length < 2 * length) return result;
  const n = bases.length;
  const effectiveGap = circular ? Math.min(maxGap, Math.floor(n / 2) - length) : maxGap;
  // Warm only the eligible predecessor arc; never duplicate the whole genome
  // or index all n windows. Virtual indices make the same FIFO work at the origin.
  const firstRight = circular ? n - length - effectiveGap : 0;
  const lastRight = circular ? 2 * n - 1 : n - length;
  const baseAt = (position: number): number => bases[circular ? position % n : position];
  // Collision-free key for at most 15 bases; longer arms are always verified in
  // full. Unknowns may enter rolling keys but an unresolved arm is never indexed.
  const k = Math.min(length, 15), mask = (1 << (2 * k)) - 1, high = 2 * (k - 1);
  let prefix = 0, reverse = 0, unknown = 0;
  for (let i = 0; i < length; i++) {
    if (baseAt(firstRight + i) === 4) unknown++;
    if (i < k) prefix = (prefix << 2) | (baseAt(firstRight + i) & 3);
    if (i < k) reverse = (reverse << 2) | ((baseAt(firstRight + length - 1 - i) & 3) ^ 3);
  }
  // Delay insertion by one arm, so the indexed arms never overlap the query.
  const delayedKeys = new Int32Array(length + 1), delayedValid = new Uint8Array(length + 1);
  // At most maxGap+1 candidate starts are live. FIFO links avoid shifting arrays,
  // retaining expired positions, or keeping an O(genome-length) position index.
  const capacity = effectiveGap + 1, positions = new Int32Array(capacity).fill(-1);
  const keys = new Int32Array(capacity), next = new Int32Array(capacity).fill(-1);
  const buckets = new Map<number, { head: number; tail: number }>();
  const matches = (left: number, right: number, inverted: boolean): boolean => {
    for (let i = 0; i < length; i++) {
      if (result.search.comparedBases >= comparisonBudget) throw new Error('Exact repeat comparison budget exhausted; no result was produced. Use a smaller region, gap or pair limit.');
      result.search.comparedBases++;
      const b = inverted ? baseAt(right + length - 1 - i) ^ 3 : baseAt(right + i);
      if (baseAt(left + i) !== b) return false;
    }
    return true;
  };
  for (let right = firstRight; right <= lastRight; right++) {
    const expired = right - length - effectiveGap - 1;
    if (expired >= firstRight) {
      const slot = expired % capacity;
      if (positions[slot] === expired) {
        const bucket = buckets.get(keys[slot])!;
        bucket.head = next[slot];
        if (bucket.head < 0) buckets.delete(keys[slot]);
        positions[slot] = -1;
      }
    }
    const left = right - length;
    if (left >= firstRight && delayedValid[left % (length + 1)]) {
      const key = delayedKeys[left % (length + 1)], slot = left % capacity;
      positions[slot] = left; keys[slot] = key; next[slot] = -1;
      const bucket = buckets.get(key);
      if (bucket) { next[bucket.tail] = slot; bucket.tail = slot; }
      else buckets.set(key, { head: slot, tail: slot });
    }
    delayedKeys[right % (length + 1)] = prefix;
    delayedValid[right % (length + 1)] = unknown === 0 ? 1 : 0;
    if (right >= (circular ? n : length)) {
      result.search.rightStartsVisited++;
      if (unknown === 0) for (const type of ['direct', 'inverted'] as const) {
        let slot = buckets.get(type === 'direct' ? prefix : reverse)?.head ?? -1;
        while (slot >= 0) {
          const start = positions[slot];
          // Equal-length complementary arcs describe the same physical pair.
          // Decide before verification so the discarded representation costs no
          // comparisons and cannot incorrectly prove output truncation.
          if (circular && 2 * (right - start) === n && start % n > right % n) { slot = next[slot]; continue; }
          if (matches(start, right, type === 'inverted')) {
            if (result.pairs.length === maxPairs) {
              result.search.complete = false; result.search.stoppedAtRightStart = circular ? right % n : right; return result;
            }
            const first = circular ? start % n : start, second = circular ? right % n : right;
            result.pairs.push({ type, leftStart: first, leftEnd: first + length,
              rightStart: second, rightEnd: second + length, gap: right - start - length });
          }
          slot = next[slot];
        }
      }
    }
    if (right < lastRight) {
      prefix = ((prefix << 2) | (baseAt(right + k) & 3)) & mask;
      reverse = (reverse >>> 2) | (((baseAt(right + length) & 3) ^ 3) << high);
      if (baseAt(right) === 4) unknown--;
      if (baseAt(right + length) === 4) unknown++;
    }
  }
  return result;
}
const LIMITATIONS = [
  'Fixed-length non-overlapping arms on a linear sequence; every eligible start and partner is searched unless the explicit output limit truncates the ordered prefix.',
  'Only resolved A/C/G/T arms match. IUPAC ambiguity is retained in coordinates and permitted in spacers, never treated as matching evidence. RNA is unsupported.',
  'Order is right start, direct before inverted, then left start. Self-complementary pairs can appear in both orientations. Overlapping occurrences and nested fixed-length windows are not merged.',
  'Complete applies only to these arm/gap/orientation parameters. This is not maximal-repeat annotation, circular-origin search, biological structure prediction or statistical significance.',
  'Comparison-budget exhaustion fails the operation. An incomplete successful result is an explicitly identified output prefix, not an exhaustive negative result.',
];
const CIRCULAR_LIMITATIONS = [
  'Complete circular topology is asserted by the caller, not inferred from sequence or accession. Every eligible origin-crossing arm is searched unless the explicit output limit truncates the prefix.',
  LIMITATIONS[1],
  'Each unordered non-overlapping arm pair is represented along its shorter spacer arc; equal arcs choose the lower first start. Both match orientations remain distinct. Order is second start, direct before inverted, then first-start arc order.',
  'Starts are original coordinates in [0,n); ends are unrolled start+length and may exceed n. Split wrapped arms at n into traversal-ordered half-open intervals. Neither arm may overlap the other on the circle.',
  'Complete applies to these fixed-arm, shortest-spacer and orientation parameters, not maximal-repeat families, mismatches, biological structure or statistical significance.',
  LIMITATIONS[4],
];
/** Same identity in browser and terminal: execution transport is not the method. */
export async function createExactRepeatRecord(sequence: string, options: ExactRepeatOptions,
  context: { accession: string | null; source: 'local' | 'catalog' }): Promise<AnalysisRecord> {
  const scan = scanExactRepeatPairs(sequence, options);
  const circular = scan.search.options.topology === 'circular';
  const limitations = circular ? CIRCULAR_LIMITATIONS : LIMITATIONS;
  const coverage = { available: scan.search.resolvedBases, total: sequence.length, unit: 'bases' as const };
  return createAnalysisRecord({ method: circular ? CIRCULAR_EXACT_REPEAT_METHOD : EXACT_REPEAT_METHOD, seed: null, references: [],
    inputs: [{ id: 'sequence', accession: context.accession, source: context.source, description: 'Exact original IUPAC DNA string; case is retained for input identity.', data: sequence }],
    parameters: { ...scan.search.options }, fields: {
      pairs: { label: 'Exact fixed-length repeat pairs (0-based half-open arms)', kind: 'sequence-score', units: 'records', value: analysisJson(scan.pairs), coverage, limitations },
      search: { label: 'Search coverage, completeness and work', kind: 'sequence-score', units: 'records', value: analysisJson(scan.search), coverage, limitations },
    } });
}
export async function replayExactRepeatRecord(content: string): Promise<AnalysisRecord> {
  const saved = await parseAnalysisRecord(content, { methodId: EXACT_REPEAT_METHOD.id });
  if (![EXACT_REPEAT_METHOD.version, CIRCULAR_EXACT_REPEAT_METHOD.version].includes(saved.method.version)) throw new Error('Unsupported exact repeat method version.');
  const input = saved.inputs[0];
  if (saved.inputs.length !== 1 || input.id !== 'sequence' || typeof input.data !== 'string'
      || (input.source !== 'local' && input.source !== 'catalog')) throw new Error('Exact repeat replay needs one local or catalog DNA input.');
  const fresh = await createExactRepeatRecord(input.data, saved.parameters as ExactRepeatOptions, { accession: input.accession, source: input.source });
  if (fresh.cacheKey !== saved.cacheKey || fresh.resultId !== saved.resultId) throw new Error('Recomputed exact repeat inputs, method, pairs or coverage differ from the saved result.');
  return fresh;
}
/** Include completeness and parameters in the table itself, not only in its filename. */
export function exportExactRepeatPairsTsv(record: AnalysisRecord): string {
  if (record.method.id !== EXACT_REPEAT_METHOD.id || ![EXACT_REPEAT_METHOD.version, CIRCULAR_EXACT_REPEAT_METHOD.version].includes(record.method.version)) throw new Error('Expected an accepted exact-repeat-pairs record.');
  const search = record.fields.search.value as unknown as ExactRepeatScan['search'];
  const pairs = record.fields.pairs.value as unknown as ExactRepeatPair[];
  if (record.method.version === CIRCULAR_EXACT_REPEAT_METHOD.version) {
    if (search.options.topology !== 'circular') throw new Error('Circular repeat evidence lacks its topology.');
    const spans = (start: number, end: number) => exactRepeatArmSegments(search.sequenceLength, start, end).map(s => `[${s.start},${s.end})`).join(';');
    return [`# exact-repeat-pairs v2; result=${record.resultId}; topology=circular; sequenceLength=${search.sequenceLength}; complete=${search.complete}; armLength=${search.options.armLength}; maxGap=${search.options.maxGap}; maxPairs=${search.options.maxPairs}`,
      '# Coordinates: 0-based; unrolled ends may exceed sequenceLength. Segment columns are half-open, in traversal order. Pairs use the shortest spacer arc; ties choose the lower first start.',
      'type\tleft_start\tleft_end\tright_start\tright_end\tgap\tleft_segments\tright_segments',
      ...pairs.map(p => [p.type, p.leftStart, p.leftEnd, p.rightStart, p.rightEnd, p.gap, spans(p.leftStart, p.leftEnd), spans(p.rightStart, p.rightEnd)].join('\t')), ''].join('\n');
  }
  return [`# exact-repeat-pairs v1; result=${record.resultId}; complete=${search.complete}; armLength=${search.options.armLength}; maxGap=${search.options.maxGap}; maxPairs=${search.options.maxPairs}`,
    '# Coordinates: 0-based half-open. Incomplete tables are an ordered prefix; not a complete annotation.',
    'type\tleft_start\tleft_end\tright_start\tright_end\tgap',
    ...pairs.map(p => [p.type, p.leftStart, p.leftEnd, p.rightStart, p.rightEnd, p.gap].join('\t')), ''].join('\n');
}
