// Quick overlay computations for GC skew, complexity, bendability, promoters, repeats.
// These are lightweight, computed once per loaded phage sequence.

import {
  detectPromoters,
  computeRegulatoryConstellation,
  type RegulatoryConstellation,
} from '@phage-explorer/core';

export type OverlayId =
  | 'gcSkew'
  | 'complexity'
  | 'bendability'
  | 'promoter'
  | 'repeats'
  | 'kmerAnomaly';

export interface NumericOverlay {
  id: OverlayId;
  label: string;
  values: number[]; // normalized 0..1
  width: number; // number of windows
}

export interface MarkOverlay {
  id: OverlayId;
  label: string;
  positions: number[]; // absolute base positions of marks
  motifs?: string[]; // optional motif labels aligned to positions
}

export interface KmerHotspot {
  start: number;
  end: number;
  score: number; // normalized 0..1
  topKmers: string[];
}

export interface KmerAnomalyOverlay extends NumericOverlay {
  id: 'kmerAnomaly';
  k: number;
  window: number;
  step: number;
  rawScores: number[];
  hotspots: KmerHotspot[];
}

export type OverlayResult = NumericOverlay | MarkOverlay | KmerAnomalyOverlay;

export type OverlayData = Partial<Record<OverlayId, OverlayResult>>;
export type ConstellationData = RegulatoryConstellation;

// Utility: normalize array to 0..1
function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map(v => (v - min) / (max - min));
}

// Sliding window helper
function sliding(sequence: string, window: number, fn: (chunk: string) => number): number[] {
  const values: number[] = [];
  for (let i = 0; i <= sequence.length - window; i += window) {
    const chunk = sequence.slice(i, i + window);
    values.push(fn(chunk));
  }
  return values;
}

export function computeGCskew(sequence: string, window = 500): NumericOverlay {
  const values = sliding(sequence, window, (chunk) => {
    let g = 0, c = 0;
    for (const ch of chunk) {
      if (ch === 'G' || ch === 'g') g++;
      else if (ch === 'C' || ch === 'c') c++;
    }
    const denom = g + c || 1;
    return (g - c) / denom; // -1..1
  });
  return { id: 'gcSkew', label: 'GC skew', values: normalize(values), width: values.length };
}

export function computeComplexity(sequence: string, window = 500): NumericOverlay {
  const values = sliding(sequence, window, (chunk) => {
    const freq: Record<string, number> = {};
    let total = 0;
    for (const ch of chunk) {
      if (!'ACGTacgt'.includes(ch)) continue;
      const u = ch.toUpperCase();
      freq[u] = (freq[u] ?? 0) + 1;
      total++;
    }
    const denom = total || 1;
    let h = 0;
    for (const v of Object.values(freq)) {
      const p = v / denom;
      h -= p * Math.log2(p);
    }
    return h; // 0..2 for DNA
  });
  return { id: 'complexity', label: 'Shannon complexity', values: normalize(values), width: values.length };
}

export function computeBendability(sequence: string, window = 400): NumericOverlay {
  // Simple proxy: AT-rich regions are generally more bendable.
  const values = sliding(sequence, window, (chunk) => {
    let at = 0, gc = 0;
    for (const ch of chunk) {
      const u = ch.toUpperCase();
      if (u === 'A' || u === 'T') at++;
      else if (u === 'G' || u === 'C') gc++;
    }
    const total = at + gc || 1;
    return at / total; // 0..1
  });
  return { id: 'bendability', label: 'AT bendability proxy', values: normalize(values), width: values.length };
}

export function computePromoterMarks(sequence: string): MarkOverlay {
  const hits = detectPromoters(sequence);
  const marks = hits.map(h => h.pos);
  const motifsFound = hits.map(h => `${h.motif} (${h.strand})`);
  return {
    id: 'promoter',
    label: 'Promoter/RBS motifs',
    positions: marks,
    motifs: motifsFound,
  };
}

export function computeRepeatMarks(sequence: string, minLen = 6): MarkOverlay {
  const marks: number[] = [];
  const seq = sequence.toUpperCase();
  const len = seq.length;

  // Pre-compute complement for speed
  // (Optional, but direct charAt lookup is fast enough)

  for (let i = 0; i <= len - minLen; i++) {
    // Check lengths 6 to 10
    // We only need to find the *shortest* palindrome at this position to mark it?
    // Or longest? The original code marked 'i' if ANY found.
    // Optimization: Check the palindrome property directly.
    
    for (let l = minLen; l <= minLen + 4 && i + l <= len; l++) {
      let isPalindrome = true;
      for (let j = 0; j < Math.floor(l / 2); j++) {
        const startChar = seq[i + j];
        const endChar = seq[i + l - 1 - j];
        
        // Simple complement check without map allocation
        let expectedEnd = '';
        if (startChar === 'A') expectedEnd = 'T';
        else if (startChar === 'T') expectedEnd = 'A';
        else if (startChar === 'G') expectedEnd = 'C';
        else if (startChar === 'C') expectedEnd = 'G';
        else expectedEnd = startChar; // N or other matches self? Or should fail?
        // Original logic: split().reverse().map(...) used identity for unknown.
        // map((c) => { if(c=='A')... else return c })
        
        if (endChar !== expectedEnd) {
          isPalindrome = false;
          break;
        }
      }

      if (isPalindrome) {
        marks.push(i);
        break; // Found one at this position, move to next pos
      }
    }
  }
  return { id: 'repeats', label: 'Repeats/Palindromes', positions: marks };
}

// K-mer anomaly map using Jensen-Shannon divergence vs global k-mer distribution
function countKmers(sequence: string, k: number): { counts: Map<string, number>; total: number } {
  const counts = new Map<string, number>();
  let total = 0;
  const upper = sequence.toUpperCase();
  for (let i = 0; i <= upper.length - k; i++) {
    const kmer = upper.slice(i, i + k);
    if (!/^[ACGT]+$/.test(kmer)) continue;
    counts.set(kmer, (counts.get(kmer) ?? 0) + 1);
    total++;
  }
  return { counts, total };
}

function jensenShannon(
  windowCounts: Map<string, number>,
  windowTotal: number,
  globalCounts: Map<string, number>,
  globalTotal: number
): number {
  const epsilon = 1e-9;
  let js = 0;
  const keys = new Set<string>([
    ...windowCounts.keys(),
    ...globalCounts.keys(),
  ]);
  for (const key of keys) {
    const p = (windowCounts.get(key) ?? 0) / Math.max(windowTotal, 1);
    const q = (globalCounts.get(key) ?? 0) / Math.max(globalTotal, 1);
    const m = 0.5 * (p + q);
    if (p > 0) {
      js += 0.5 * p * Math.log2(p / Math.max(m, epsilon));
    }
    if (q > 0) {
      js += 0.5 * q * Math.log2(q / Math.max(m, epsilon));
    }
  }
  // JSD in bits, bounded [0,1]
  return Math.min(1, Math.max(0, js));
}

export function computeKmerAnomaly(
  sequence: string,
  k = 5,
  window = 1000,
  step = 500
): KmerAnomalyOverlay {
  const { counts: globalCounts, total: globalTotal } = countKmers(sequence, k);
  if (globalTotal === 0) {
    return {
      id: 'kmerAnomaly',
      label: 'K-mer anomaly',
      values: [],
      rawScores: [],
      width: 0,
      k,
      window,
      step,
      hotspots: [],
    };
  }

  const scores: number[] = [];
  const rawScores: number[] = [];
  const hotspots: KmerHotspot[] = [];

  for (let start = 0; start < sequence.length; start += step) {
    const slice = sequence.slice(start, start + window);
    if (!slice.length) break;
    const { counts: winCounts, total: winTotal } = countKmers(slice, k);
    const js = jensenShannon(winCounts, winTotal, globalCounts, globalTotal);
    rawScores.push(js);
    scores.push(js); // normalize later

    // top overrepresented kmers in this window
    const entries = Array.from(winCounts.entries())
      .map(([kmer, c]) => {
        const winFreq = c / Math.max(winTotal, 1);
        const globalFreq = (globalCounts.get(kmer) ?? 0) / Math.max(globalTotal, 1);
        return { kmer, ratio: winFreq / Math.max(globalFreq, 1e-9) };
      })
      .filter(e => e.ratio > 1.5)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 3)
      .map(e => e.kmer);

    hotspots.push({
      start,
      end: Math.min(sequence.length, start + slice.length),
      score: js,
      topKmers: entries,
    });
  }

  const normalized = normalize(scores);
  // Update hotspots with normalized scores
  const normalizedHotspots = hotspots.map((h, idx) => ({
    ...h,
    score: normalized[idx] ?? 0,
  })).sort((a, b) => b.score - a.score).slice(0, 5);

  return {
    id: 'kmerAnomaly',
    label: `K-mer anomaly (k=${k})`,
    values: normalized,
    rawScores,
    width: normalized.length,
    k,
    window,
    step,
    hotspots: normalizedHotspots,
  };
}

export function computeAllOverlays(sequence: string): Record<OverlayId, OverlayResult> {
  return {
    gcSkew: computeGCskew(sequence),
    complexity: computeComplexity(sequence),
    bendability: computeBendability(sequence),
    promoter: computePromoterMarks(sequence),
    repeats: computeRepeatMarks(sequence),
    kmerAnomaly: computeKmerAnomaly(sequence),
  };
}

export function computeConstellations(sequence: string): RegulatoryConstellation {
  return computeRegulatoryConstellation(sequence);
}
