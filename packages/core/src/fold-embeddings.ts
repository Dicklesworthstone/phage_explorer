import type { GeneInfo } from './types';

export interface FoldEmbedding {
  geneId: number;
  vector: number[]; // normalized embedding
  length: number;
  name: string | null;
  product: string | null;
}

export function encodeFloat32VectorLE(vector: number[]): Uint8Array {
  const buffer = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < vector.length; i++) {
    view.setFloat32(i * 4, vector[i] ?? 0, true);
  }
  return new Uint8Array(buffer);
}

export function decodeFloat32VectorLE(bytes: Uint8Array | ArrayBuffer, dims?: number): number[] {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const count = dims ?? Math.floor(data.byteLength / 4);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

export interface Neighbor {
  geneId: number;
  distance: number; // lower = closer
  name: string | null;
  product: string | null;
}

export interface QuickviewResult {
  novelty: number; // 0..1, higher = more novel
  neighbors: Neighbor[];
  note?: string;
}

export interface SelfSimilarityMatrixResult {
  bins: number;
  matrix: Float32Array; // row-major, length = bins * bins, values 0..1
}

// Lightweight cosine distance for small vectors
function cosineDistance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return 1 - dot / denom;
}

export function nearestNeighbors(
  target: FoldEmbedding,
  corpus: FoldEmbedding[],
  k = 5
): Neighbor[] {
  const scored = corpus
    .filter(e => e.geneId !== target.geneId && e.vector.length && target.vector.length)
    .map(e => ({
      geneId: e.geneId,
      distance: cosineDistance(target.vector, e.vector),
      name: e.name,
      product: e.product,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);

  return scored;
}

export function computeNovelty(
  target: FoldEmbedding,
  corpus: FoldEmbedding[],
  k = 10
): QuickviewResult {
  const neighbors = nearestNeighbors(target, corpus, k);
  if (neighbors.length === 0) {
    return { novelty: 1, neighbors, note: 'No neighbors found' };
  }

  // Novelty heuristic: mean distance of top-k neighbors
  const meanDist = neighbors.reduce((s, n) => s + n.distance, 0) / neighbors.length;
  const novelty = Math.min(1, Math.max(0, meanDist)); // cosine distance in [0,2]; clamp to 0..1

  return { novelty, neighbors };
}

function countKmers(sequence: string, k: number): Map<string, number> {
  const counts = new Map<string, number>();
  const upper = sequence.toUpperCase();
  if (upper.length < k) return counts;

  for (let i = 0; i <= upper.length - k; i++) {
    const kmer = upper.slice(i, i + k);
    // Skip windows that contain stop codons/unknowns; this is a visualization, so be conservative.
    if (kmer.includes('*')) continue;
    counts.set(kmer, (counts.get(kmer) ?? 0) + 1);
  }
  return counts;
}

function cosineSimilaritySparse(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];

  let dot = 0;
  let na = 0;
  let nb = 0;

  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;

  for (const [key, v] of small.entries()) {
    const w = large.get(key);
    if (w) dot += v * w;
  }

  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  const sim = dot / denom;
  return Math.max(0, Math.min(1, sim));
}

/**
 * Compute a lightweight protein self-similarity matrix suitable for an ASCII thumbnail.
 *
 * This is NOT a physical contact map; it's a k-mer composition similarity map between
 * bins along the protein. It’s meant as a cheap “shape” hint for quickviews.
 */
export function computeProteinSelfSimilarityMatrix(
  aminoAcids: string,
  options: { k?: number; bins?: number } = {}
): SelfSimilarityMatrixResult {
  const seq = aminoAcids.trim();
  const len = seq.length;
  if (len === 0) return { bins: 0, matrix: new Float32Array(0) };

  const k = Math.max(2, Math.min(5, options.k ?? 3));
  const targetBins = options.bins ?? Math.min(24, Math.max(8, Math.floor(len / 10)));
  const bins = Math.max(1, Math.min(targetBins, len));

  const windows: Array<Map<string, number>> = new Array(bins);
  for (let i = 0; i < bins; i++) {
    const start = Math.floor((i / bins) * len);
    const end = Math.max(start + 1, Math.floor(((i + 1) / bins) * len));
    windows[i] = countKmers(seq.slice(start, Math.min(len, end)), k);
  }

  const matrix = new Float32Array(bins * bins);
  for (let y = 0; y < bins; y++) {
    for (let x = 0; x < bins; x++) {
      matrix[y * bins + x] = cosineSimilaritySparse(windows[y], windows[x]);
    }
  }

  return { bins, matrix };
}

// Map genes to embeddings by geneId
export function buildEmbeddingMap(embeddings: FoldEmbedding[]): Map<number, FoldEmbedding> {
  const map = new Map<number, FoldEmbedding>();
  for (const e of embeddings) {
    map.set(e.geneId, e);
  }
  return map;
}

export function attachEmbeddingInfo(
  genes: GeneInfo[],
  embeddings: Map<number, FoldEmbedding>
): Array<GeneInfo & { embedding?: FoldEmbedding }> {
  return genes.map(g => ({
    ...g,
    embedding: embeddings.get(g.id),
  }));
}
