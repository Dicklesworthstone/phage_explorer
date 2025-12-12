/**
 * Recombination / Mosaicism Radar
 *
 * Lightweight sliding‑window donor inference for phage genomes.
 * Uses k‑mer Jaccard similarity against a panel of reference sketches.
 *
 * This is a first‑pass implementation intended for interactive TUI use:
 * - O(numWindows * numRefs * kmers) but with small windows and downsampled refs.
 * - Breakpoints are called when the top donor changes.
 */

export interface ReferenceSketch {
  label: string;
  sequence: string; // ideally downsampled
}

export interface MosaicWindow {
  start: number;
  end: number;
  donor: string | null;
  score: number; // 0..1 Jaccard to top donor
  topDonors: Array<{ label: string; score: number }>;
}

export interface MosaicSegment {
  start: number;
  end: number;
  donor: string | null;
  meanScore: number;
  windows: number;
}

export interface MosaicRadarResult {
  windows: MosaicWindow[];
  segments: MosaicSegment[];
  breakpoints: number[]; // genome positions
  k: number;
  window: number;
  step: number;
}

export interface MosaicRadarConfig {
  k?: number;            // k‑mer size (default 5)
  window?: number;       // window size (default 2000 bp)
  step?: number;         // step between windows (default window/2)
  minSimilarity?: number; // below this, donor = null (default 0.05)
  maxReferences?: number; // cap refs for speed (default 30)
  topN?: number;         // store N best donors per window (default 3)
}

function extractKmerSet(sequence: string, k: number): Set<string> {
  const set = new Set<string>();
  const upper = sequence.toUpperCase();
  for (let i = 0; i <= upper.length - k; i++) {
    const kmer = upper.slice(i, i + k);
    if (!/^[ACGT]+$/.test(kmer)) continue;
    set.add(kmer);
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  // Iterate smaller set
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const kmer of small) {
    if (large.has(kmer)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function computeMosaicRadar(
  sequence: string,
  references: ReferenceSketch[],
  config: MosaicRadarConfig = {}
): MosaicRadarResult {
  const seq = sequence.toUpperCase();
  if (!seq.length || references.length === 0) {
    return { windows: [], segments: [], breakpoints: [], k: config.k ?? 5, window: config.window ?? 0, step: config.step ?? 0 };
  }

  const k = config.k ?? 5;
  const window = Math.max(200, config.window ?? 2000);
  const step = Math.max(100, config.step ?? Math.floor(window / 2));
  const minSimilarity = config.minSimilarity ?? 0.05;
  const topN = config.topN ?? 3;
  const maxRefs = config.maxReferences ?? 30;

  const panel = references.slice(0, maxRefs);
  const refSets = panel.map(r => ({
    label: r.label,
    kmers: extractKmerSet(r.sequence, k),
  }));

  const windows: MosaicWindow[] = [];
  for (let start = 0; start < seq.length; start += step) {
    const end = Math.min(seq.length, start + window);
    const slice = seq.slice(start, end);
    if (slice.length < k) break;
    const winSet = extractKmerSet(slice, k);
    const scored = refSets
      .map(r => ({ label: r.label, score: jaccard(winSet, r.kmers) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const donor = best && best.score >= minSimilarity ? best.label : null;
    const score = donor ? best.score : 0;

    windows.push({
      start,
      end,
      donor,
      score,
      topDonors: scored.slice(0, topN),
    });

    if (end === seq.length) break;
  }

  // Build segments by merging consecutive windows with same donor
  const segments: MosaicSegment[] = [];
  let current: MosaicSegment | null = null;
  for (const w of windows) {
    if (!current || current.donor !== w.donor) {
      if (current) segments.push(current);
      current = {
        start: w.start,
        end: w.end,
        donor: w.donor,
        meanScore: w.score,
        windows: 1,
      };
    } else {
      current.end = w.end;
      current.meanScore = (current.meanScore * current.windows + w.score) / (current.windows + 1);
      current.windows += 1;
    }
  }
  if (current) segments.push(current);

  // Breakpoints when donor changes between windows
  const breakpoints: number[] = [];
  for (let i = 1; i < windows.length; i++) {
    const prev = windows[i - 1];
    const next = windows[i];
    if (prev.donor !== next.donor) {
      breakpoints.push(next.start);
    }
  }

  return { windows, segments, breakpoints, k, window, step };
}

export default computeMosaicRadar;

