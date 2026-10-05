/** Exact global unit-edit alignment using furthest-reaching wavefronts.
 * k = consumed reference - consumed query; W[d,k] stores the greatest reference
 * offset reachable at edit cost d after extending equal symbols. No heuristic
 * pruning/banding: the first wavefront reaching both ends has optimal distance.
 * This is the unit-edit specialization, not gap-affine WFA2 or an SV caller.
 * Method background: https://github.com/smarco/WFA2-lib (edit distance mode).
 */
export const WAVEFRONT_LIMITS = { length: 250000, states: 4000000, comparisons: 50000000 } as const;
export interface WavefrontOptions { maxStates?: number; maxComparisons?: number }
export interface WavefrontAlignment {
  reference: string; query: string; distance: number;
  /** Actual allocated frontier entries and attempted symbol comparisons. */
  states: number; comparisons: number;
}

function limit(value: number | undefined, maximum: number, name: string): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new Error(`Invalid wavefront ${name} budget.`);
  return result;
}

/** Returns a complete optimal alignment or throws; never a partial/approximate result.
 * Equal-cost predecessor ties: substitution, reference deletion, query insertion.
 * The resulting optimum can differ from a DP traceback in repetitive sequence.
 * Symbols must be uppercase ungapped IUPAC DNA. Ambiguity matches literally here;
 * downstream biological variant calling must exclude unresolved nucleotides.
 */
export function alignWavefront(reference: string, query: string, options: WavefrontOptions = {}): WavefrontAlignment {
  if (typeof reference !== 'string' || typeof query !== 'string' || reference.length > WAVEFRONT_LIMITS.length
      || query.length > WAVEFRONT_LIMITS.length || /[^ACGTRYSWKMBDHVN]/.test(reference + query)) {
    throw new Error('Wavefront alignment requires at most 250,000 uppercase ungapped IUPAC DNA characters per sequence.');
  }
  if (!options || typeof options !== 'object' || Object.keys(options).some(k => !['maxStates', 'maxComparisons'].includes(k))) {
    throw new Error('Unsupported wavefront options.');
  }
  const maxStates = limit(options.maxStates, WAVEFRONT_LIMITS.states, 'state');
  const maxComparisons = limit(options.maxComparisons, WAVEFRONT_LIMITS.comparisons, 'comparison');
  const m = reference.length, n = query.length;
  // Trivial empty paths require no frontier storage or comparisons.
  if (!m || !n) return { reference: reference || '-'.repeat(n), query: query || '-'.repeat(m), distance: m + n, states: 0, comparisons: 0 };
  const budgetError = (kind: string): never => {
    throw new Error(`Exact wavefront alignment exceeded its ${kind} budget. Supply an external alignment or a smaller, more closely related region; no approximate result was produced.`);
  };
  // All frontiers through score d contain (d+1)^2 entries. Length difference is
  // a lower bound on score: refuse impossible budgets before doing long scans.
  if ((Math.abs(m - n) + 1) ** 2 > maxStates) budgetError('state');
  let states = 0, comparisons = 0;
  const frontiers: Int32Array[] = [];
  const extend = (x: number, k: number): number => {
    while (x < m && x - k < n) {
      if (comparisons >= maxComparisons) budgetError('comparison');
      comparisons++;
      if (reference.charCodeAt(x) !== query.charCodeAt(x - k)) break;
      x++;
    }
    return x;
  };
  const allocate = (score: number): Int32Array => {
    const size = 2 * score + 1;
    if (states + size > maxStates) budgetError('state');
    states += size;
    const wave = new Int32Array(size).fill(-1);
    frontiers.push(wave);
    return wave;
  };
  const first = allocate(0);
  first[0] = extend(0, 0);
  let distance = 0;
  // Compute the best pre-extension offset from valid predecessors, excluding
  // transitions that would consume beyond either end. -1 means unreachable.
  const predecessor = (previous: Int32Array, score: number, k: number): { x: number; move: number } => {
    const get = (diagonal: number) => Math.abs(diagonal) > score - 1 ? -1 : previous[diagonal + score - 1];
    let x = -1, move = 0;
    const same = get(k);
    if (same >= 0 && same < m && same - k < n) { x = same + 1; move = 0; }
    const deletion = get(k - 1);
    if (deletion >= 0 && deletion < m && deletion + 1 > x) { x = deletion + 1; move = 1; }
    const insertion = get(k + 1);
    if (insertion >= 0 && insertion - (k + 1) < n && insertion > x) { x = insertion; move = 2; }
    return { x, move };
  };
  if (first[0] !== m || first[0] !== n) {
    for (distance = 1; ; distance++) {
      const wave = allocate(distance), previous = frontiers[distance - 1];
      for (let k = Math.max(-distance, -n); k <= Math.min(distance, m); k++) {
        const candidate = predecessor(previous, distance, k);
        if (candidate.x < 0) continue;
        const x = extend(candidate.x, k);
        wave[k + distance] = x;
      }
      const terminal = m - n;
      if (Math.abs(terminal) <= distance && wave[terminal + distance] === m) break;
    }
  }
  // Traceback stores runs, not one JS object per base. The frontier itself is
  // the trace: recomputing a predecessor repeats the exact same tie rule.
  const a: string[] = [], b: string[] = [];
  let x = m, y = n;
  for (let score = distance; score > 0; score--) {
    const k = x - y, prior = predecessor(frontiers[score - 1], score, k);
    const beforeExtension = prior.x, queryBeforeExtension = beforeExtension - k;
    a.push(reference.slice(beforeExtension, x)); b.push(query.slice(queryBeforeExtension, y));
    if (prior.move === 0) {
      a.push(reference[beforeExtension - 1]); b.push(query[queryBeforeExtension - 1]);
      x = beforeExtension - 1; y = queryBeforeExtension - 1;
    } else if (prior.move === 1) {
      a.push(reference[beforeExtension - 1]); b.push('-');
      x = beforeExtension - 1; y = queryBeforeExtension;
    } else {
      a.push('-'); b.push(query[queryBeforeExtension - 1]);
      x = beforeExtension; y = queryBeforeExtension - 1;
    }
  }
  a.push(reference.slice(0, x)); b.push(query.slice(0, y));
  return { reference: a.reverse().join(''), query: b.reverse().join(''), distance, states, comparisons };
}

/** Affine gap cost is gapOpen + length * gapExtend (including the first base).
 * Positive mismatch/extension and nonnegative opening penalties; matches cost 0.
 * Model and recurrence: Marco-Sola et al., doi:10.1093/bioinformatics/btaa777.
 */
export interface AffinePenalties { mismatch: number; gapOpen: number; gapExtend: number }
export const DEFAULT_AFFINE_PENALTIES: Readonly<AffinePenalties> = Object.freeze({ mismatch: 4, gapOpen: 6, gapExtend: 1 });
export const AFFINE_WAVEFRONT_LIMITS = { ...WAVEFRONT_LIMITS, scoreLayers: 100000 } as const;
export interface AffineWavefrontOptions extends WavefrontOptions { penalties?: AffinePenalties; maxScoreLayers?: number }
export interface AffineWavefrontAlignment extends Omit<WavefrontAlignment, 'distance'> {
  /** Minimum nonnegative cost under the supplied penalties, NOT unit edit distance. */
  score: number; penalties: AffinePenalties; scoreLayers: number;
}
export function resolveAffinePenalties(value: unknown = DEFAULT_AFFINE_PENALTIES): AffinePenalties {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Affine penalties require mismatch, gapOpen and gapExtend.');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'gapExtend,gapOpen,mismatch' ||
      !['mismatch', 'gapOpen', 'gapExtend'].every(k => Number.isSafeInteger(p[k]) && Number(p[k]) <= 64 && Number(p[k]) >= (k === 'gapOpen' ? 0 : 1))) {
    throw new Error('Affine penalties must be integers: mismatch/extension 1–64, opening 0–64.');
  }
  return { mismatch: Number(p.mismatch), gapOpen: Number(p.gapOpen), gapExtend: Number(p.gapExtend) };
}
interface AffineWave { lo: number; values: Int32Array }
interface AffineLayer { m: AffineWave | null; d: AffineWave | null; i: AffineWave | null }
const affineGet = (wave: AffineWave | null | undefined, k: number): number =>
  wave && k >= wave.lo && k < wave.lo + wave.values.length ? wave.values[k - wave.lo] : -1;

/** Exact global gap-affine alignment, without heuristic pruning or score dropping.
 * M extends matches, D consumes a reference base, I consumes a query base.
 * Ties: substitution, D, I; within a gap, extension precedes opening.
 * The trace retains bounded M/I/D frontiers; exhaustion throws, never approximates.
 * Common scaling factors are removed from penalties while searching score layers.
 */
export function alignAffineWavefront(reference: string, query: string, options: AffineWavefrontOptions = {}): AffineWavefrontAlignment {
  if (typeof reference !== 'string' || typeof query !== 'string' || reference.length > WAVEFRONT_LIMITS.length ||
      query.length > WAVEFRONT_LIMITS.length || /[^ACGTRYSWKMBDHVN]/.test(reference + query)) {
    throw new Error('Affine alignment requires at most 250,000 uppercase ungapped IUPAC DNA characters per sequence.');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(k => !['maxStates', 'maxComparisons', 'maxScoreLayers', 'penalties'].includes(k))) throw new Error('Unsupported affine wavefront options.');
  const penalties = resolveAffinePenalties(options.penalties);
  const maxStates = limit(options.maxStates, AFFINE_WAVEFRONT_LIMITS.states, 'state');
  const maxComparisons = limit(options.maxComparisons, AFFINE_WAVEFRONT_LIMITS.comparisons, 'comparison');
  const maxLayers = limit(options.maxScoreLayers, AFFINE_WAVEFRONT_LIMITS.scoreLayers, 'score-layer');
  const m = reference.length, n = query.length;
  let states = 0, comparisons = 0, scoreLayers = 0;
  const fail = (kind: string): never => { throw new Error(`Exact affine alignment exceeded its ${kind} budget. Supply an external alignment or a smaller region; no approximate result was produced.`); };
  const equal = (x: number, y: number): boolean => {
    if (comparisons >= maxComparisons) fail('comparison');
    comparisons++;
    return reference.charCodeAt(x) === query.charCodeAt(y);
  };
  const result = (a: string, b: string, score: number): AffineWavefrontAlignment =>
    ({ reference: a, query: b, score, penalties, states, comparisons, scoreLayers });
  if (!m || !n) return result(reference || '-'.repeat(n), query || '-'.repeat(m), m + n ? penalties.gapOpen + (m + n) * penalties.gapExtend : 0);

  // Proven lower-bound shortcut, not heuristic banding. If one contiguous gap
  // suffices, its cost O+|m-n|E is a global lower bound for unequal lengths.
  let prefix = 0;
  while (prefix < Math.min(m, n) && equal(prefix, prefix)) prefix++;
  if (prefix === m && m === n) return result(reference, query, 0);
  if (m !== n) {
    let suffix = 0;
    while (suffix < Math.min(m, n) - prefix && equal(m - 1 - suffix, n - 1 - suffix)) suffix++;
    if (prefix + suffix === Math.min(m, n)) {
      const gap = '-'.repeat(Math.abs(m - n));
      return result(m < n ? reference.slice(0, prefix) + gap + reference.slice(prefix) : reference,
        n < m ? query.slice(0, prefix) + gap + query.slice(prefix) : query,
        penalties.gapOpen + Math.abs(m - n) * penalties.gapExtend);
    }
  }
  const gcd = (a: number, b: number): number => { while (b) [a, b] = [b, a % b]; return a; };
  const scale = gcd(gcd(penalties.mismatch, penalties.gapOpen), penalties.gapExtend);
  const mismatch = penalties.mismatch / scale, extension = penalties.gapExtend / scale;
  const opening = (penalties.gapOpen + penalties.gapExtend) / scale;
  const layers: Array<AffineLayer | undefined> = [];
  const allocate = (sources: Array<[AffineWave | null | undefined, number]>): AffineWave | null => {
    let lo = Infinity, hi = -Infinity;
    for (const [wave, shift] of sources) if (wave) {
      lo = Math.min(lo, wave.lo + shift); hi = Math.max(hi, wave.lo + wave.values.length - 1 + shift);
    }
    lo = Math.max(-n, lo); hi = Math.min(m, hi);
    if (lo > hi) return null;
    const count = hi - lo + 1;
    if (states + count > maxStates) fail('state');
    states += count;
    return { lo, values: new Int32Array(count).fill(-1) };
  };
  const trim = (wave: AffineWave | null): AffineWave | null => {
    if (!wave) return null;
    let first = 0, end = wave.values.length;
    while (first < end && wave.values[first] < 0) first++;
    while (end > first && wave.values[end - 1] < 0) end--;
    return first === end ? null : { lo: wave.lo + first, values: wave.values.subarray(first, end) };
  };
  if (maxLayers < 1) fail('score-layer');
  if (maxStates < 1) fail('state');
  states++; scoreLayers++;
  layers[0] = { m: { lo: 0, values: Int32Array.of(prefix) }, d: null, i: null };
  const advance = (wave: AffineWave | null | undefined, k: number, kind: 'm' | 'd' | 'i'): number => {
    const x = affineGet(wave, k), y = x - k;
    if (x < 0 || y < 0 || x > m || y > n || (kind !== 'i' && x === m) || (kind !== 'd' && y === n)) return -1;
    return x + (kind === 'i' ? 0 : 1);
  };
  let score = 0;
  for (score = 1; ; score++) {
    if (scoreLayers >= maxLayers) fail('score-layer');
    scoreLayers++;
    const fromOpen = layers[score - opening]?.m, fromMismatch = layers[score - mismatch]?.m;
    const fromD = layers[score - extension]?.d, fromI = layers[score - extension]?.i;
    let d = allocate([[fromOpen, 1], [fromD, 1]]), i = allocate([[fromOpen, -1], [fromI, -1]]);
    if (d) for (let at = 0; at < d.values.length; at++) {
      const k = d.lo + at; d.values[at] = Math.max(advance(fromD, k - 1, 'd'), advance(fromOpen, k - 1, 'd'));
    }
    if (i) for (let at = 0; at < i.values.length; at++) {
      const k = i.lo + at; i.values[at] = Math.max(advance(fromI, k + 1, 'i'), advance(fromOpen, k + 1, 'i'));
    }
    d = trim(d); i = trim(i);
    const wave = allocate([[fromMismatch, 0], [d, 0], [i, 0]]);
    if (wave) for (let at = 0; at < wave.values.length; at++) {
      const k = wave.lo + at;
      let x = Math.max(advance(fromMismatch, k, 'm'), affineGet(d, k), affineGet(i, k));
      if (x < 0) continue;
      while (x < m && x - k < n && equal(x, x - k)) x++;
      wave.values[at] = x;
    }
    layers[score] = { m: trim(wave), d, i };
    if (affineGet(layers[score]!.m, m - n) === m) break;
  }
  const optimum = score * scale, a: string[] = [], b: string[] = [];
  let x = m, y = n, state: 'm' | 'd' | 'i' = 'm';
  while (score > 0) {
    const k = x - y, layer = layers[score]!;
    if (state === 'm') {
      const sub = advance(layers[score - mismatch]?.m, k, 'm');
      const deletion = affineGet(layer.d, k), insertion = affineGet(layer.i, k);
      const before = Math.max(sub, deletion, insertion);
      if (before < 0 || before > x) throw new Error('Invalid affine traceback.');
      a.push(reference.slice(before, x)); b.push(query.slice(before - k, y));
      x = before; y = before - k;
      if (before === sub) { a.push(reference[--x]); b.push(query[--y]); score -= mismatch; }
      else state = before === deletion ? 'd' : 'i';
    } else {
      const diagonal = state === 'd' ? k - 1 : k + 1;
      const extended = advance(layers[score - extension]?.[state], diagonal, state);
      if (state === 'd') { a.push(reference[x - 1]); b.push('-'); }
      else { a.push('-'); b.push(query[y - 1]); }
      if (extended === x) score -= extension;
      else { score -= opening; state = 'm'; }
      if (diagonal === k - 1) x--; else y--;
    }
  }
  if (state !== 'm' || x !== y || x !== prefix) throw new Error('Affine traceback did not reach its initial matching prefix.');
  a.push(reference.slice(0, x)); b.push(query.slice(0, y));
  return result(a.reverse().join(''), b.reverse().join(''), optimum);
}
