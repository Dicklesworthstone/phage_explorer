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
