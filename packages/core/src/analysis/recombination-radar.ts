/**
 * Sliding-window reference similarity for mosaic exploration.
 *
 * Canonical DNA k-mer Jaccard is strand independent. It measures similarity to
 * the supplied panel, not a donor, recombination event, direction or transfer age.
 * Windows and display segments use 0-based, end-exclusive genome coordinates.
 */

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

function positiveInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
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

