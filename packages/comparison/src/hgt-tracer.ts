import { jaccardIndex, extractKmerSet } from './kmer-analysis';
import { min_hash_jaccard } from '@phage/wasm-compute/pkg/wasm_compute.js';
import type { GeneInfo } from '@phage-explorer/core';
import type { HGTAnalysis, GenomicIsland, DonorCandidate, PassportStamp } from './types';

export interface HGTOptions {
  window?: number;
  step?: number;
  zThreshold?: number;
}

interface WindowStat {
  start: number;
  end: number;
  gc: number;
  z: number;
}

const HALLMARK_KEYWORDS = [
  'integrase',
  'transposase',
  'recombinase',
  'lysogeny',
  'tail fiber',
  'tail-spike',
  'tRNA',
  'capsid',
  'portal',
  'terminase',
  'restriction',
  'methyltransferase',
];

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[], m: number): number {
  if (values.length === 0) return 0;
  const v = values.reduce((s, x) => s + Math.pow(x - m, 2), 0) / values.length;
  return Math.sqrt(v);
}

function computeGC(seq: string): number {
  let gc = 0;
  let total = 0;
  for (const c of seq) {
    const u = c.toUpperCase();
    if (u === 'G' || u === 'C') gc++;
    if (u === 'A' || u === 'T' || u === 'G' || u === 'C') total++;
  }
  return total > 0 ? (gc / total) * 100 : 0;
}

function slidingGC(sequence: string, window = 2000, step = 1000): WindowStat[] {
  const stats: WindowStat[] = [];
  const gcValues: number[] = [];

  for (let start = 0; start < sequence.length; start += step) {
    const slice = sequence.slice(start, start + window);
    if (!slice.length) break;
    const gc = computeGC(slice);
    gcValues.push(gc);
  }

  const mu = mean(gcValues);
  const sigma = std(gcValues, mu) || 1;

  let idx = 0;
  for (let start = 0; start < sequence.length; start += step) {
    const slice = sequence.slice(start, start + window);
    if (!slice.length) break;
    const gc = gcValues[idx] ?? 0;
    const z = (gc - mu) / sigma;
    stats.push({ start, end: start + slice.length, gc, z });
    idx++;
  }

  return stats;
}

function mergeIslands(windows: WindowStat[], zThreshold = 2): GenomicIsland[] {
  const islands: GenomicIsland[] = [];
  let current: GenomicIsland | null = null;

  for (const w of windows) {
    if (Math.abs(w.z) >= zThreshold) {
      if (!current) {
        current = { start: w.start, end: w.end, gc: w.gc, zScore: w.z, genes: [], hallmarks: [], donors: [], amelioration: 'unknown' };
      } else {
        current.end = w.end;
        current.gc = (current.gc + w.gc) / 2;
        current.zScore = (current.zScore + w.z) / 2;
      }
    } else if (current) {
      islands.push(current);
      current = null;
    }
  }
  if (current) islands.push(current);
  return islands;
}

function attachGenes(islands: GenomicIsland[], genes: GeneInfo[]): void {
  for (const island of islands) {
    island.genes = genes.filter(g => g.startPos >= island.start && g.endPos <= island.end);
    island.hallmarks = island.genes
      .filter(g => {
        const text = `${g.name ?? ''} ${g.product ?? ''}`.toLowerCase();
        return HALLMARK_KEYWORDS.some(k => text.includes(k));
      })
      .map(g => g.name || g.product || g.locusTag || 'unknown');
  }
}

function inferDonors(
  islandSeq: string,
  referenceSketches: Record<string, string>,
  k = 15
): DonorCandidate[] {
  const islandSet = extractKmerSet(islandSeq, k);
  if (islandSet.size === 0) return [];
  const candidates: DonorCandidate[] = [];

  for (const [taxon, refSeq] of Object.entries(referenceSketches)) {
    const refSet = extractKmerSet(refSeq, k);
    if (refSet.size === 0) continue;
    let j = jaccardIndex(islandSet, refSet);
    if (typeof min_hash_jaccard === 'function') {
      try {
        const mh = min_hash_jaccard(islandSeq, refSeq, k, 64);
        if (Number.isFinite(mh) && mh >= 0) {
          j = Math.max(j, mh);
        }
      } catch {
        // keep JS-only Jaccard if WASM call fails
      }
    }
    candidates.push({
      taxon,
      similarity: j,
      confidence: j > 0.3 ? 'high' : j > 0.15 ? 'medium' : 'low',
      evidence: 'kmer',
    });
  }

  return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

function estimateAmelioration(gcDelta: number): 'recent' | 'intermediate' | 'ancient' | 'unknown' {
  const abs = Math.abs(gcDelta);
  if (abs > 5) return 'recent';
  if (abs > 2) return 'intermediate';
  if (abs > 0) return 'ancient';
  return 'unknown';
}

export function analyzeHGTProvenance(
  genomeSequence: string,
  genes: GeneInfo[],
  referenceSketches: Record<string, string> = {},
  options?: HGTOptions
): HGTAnalysis {
  const genomeGC = computeGC(genomeSequence);
  const windowSize = options?.window ?? 2000;
  const step = options?.step ?? 1000;
  const zThreshold = options?.zThreshold ?? 2;
  const windows = slidingGC(genomeSequence, windowSize, step);
  const islands = mergeIslands(windows, zThreshold);
  attachGenes(islands, genes);

  const stamps: PassportStamp[] = islands.map(island => {
    const seq = genomeSequence.slice(island.start, island.end);
    const donors = inferDonors(seq, referenceSketches);
    const best = donors[0] ?? null;
    const amelioration = estimateAmelioration(island.gc - genomeGC);
    island.donors = donors;

    return {
      island,
      donor: best,
      donorDistribution: donors,
      amelioration,
      transferMechanism: 'unknown',
      gcDelta: island.gc - genomeGC,
      hallmarks: island.hallmarks,
    };
  });

  return {
    genomeGC,
    islands,
    stamps,
  };
}
