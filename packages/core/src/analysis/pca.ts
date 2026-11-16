/**
 * Principal Component Analysis (PCA)
 *
 * Implements PCA for dimensionality reduction of high-dimensional
 * genomic signature vectors (e.g., tetranucleotide frequencies).
 *
 * Uses power iteration for efficient computation of top principal components.
 */

import type { KmerVector } from './kmer-frequencies';
import { euclideanDistance, indexToKmer } from './kmer-frequencies';
import { analysisJson, createAnalysisRecord, type AnalysisRecord } from '../analysis-result';

// ============================================================================
// WASM PCA Loader (best-effort, sync callers)
// ============================================================================

interface WasmPcaResultF32 {
  eigenvectors: Float32Array;
  eigenvalues: Float32Array;
  mean: Float32Array;
  total_variance: number;
  n_components: number;
  n_features: number;
  free(): void;
}

type WasmPcaFn = (
  data: Float32Array,
  nSamples: number,
  nFeatures: number,
  nComponents: number,
  maxIterations: number,
  tolerance: number
) => WasmPcaResultF32;

let wasmPca: WasmPcaFn | null = null;
let wasmPcaAvailable = false;
let wasmPcaInitStarted = false;

// Heuristic: only use WASM when the matrix is large enough to amortize boundary/copy overhead.
// `nSamples * nFeatures` roughly corresponds to the hot-loop work per power-iteration step.
// Lowered from 80k to 20k: WASM wins even for smaller matrices due to vectorized loops.
// For typical 256-dim k-mer vectors, this enables WASM at ~78 samples (vs ~312 before).
const PCA_WASM_MIN_ELEMENTS = 20_000;

async function initWasmPca(): Promise<void> {
  if (wasmPcaInitStarted) return;
  wasmPcaInitStarted = true;

  try {
    const wasm = await import('@phage/wasm-compute');
    // wasm-compute may require explicit async init (depending on build target).
    // Keep this best-effort so we can fall back cleanly if init fails.
    const maybeInit = (wasm as unknown as { default?: () => Promise<void> }).default;
    if (typeof maybeInit === 'function') {
      await maybeInit();
    }

    const fn = (wasm as unknown as { pca_power_iteration_f32?: unknown }).pca_power_iteration_f32;
    if (typeof fn !== 'function') return;

    wasmPca = fn as WasmPcaFn;

    // Quick smoke-test so we don't mark available with a mismatched ABI.
    const test = wasmPca(new Float32Array([0, 0, 2, 0, 0, 1, 2, 1]), 4, 2, 2, 50, 1e-6);
    wasmPcaAvailable = test.n_features === 2 && test.n_components === 2;
    test.free();
  } catch {
    wasmPcaAvailable = false;
    wasmPca = null;
  }
}

// Initialize on module load (non-blocking)
initWasmPca().catch(() => { /* WASM unavailable */ });

export interface PCAProjection {
  phageId: number;
  name: string;
  pc1: number;
  pc2: number;
  pc3?: number; // Optional third component
  gcContent: number;
  genomeLength: number;
}

export interface PCAResult {
  projections: PCAProjection[];
  eigenvalues: number[];
  varianceExplained: number[]; // Proportion of variance explained by each PC
  cumulativeVariance: number[]; // Cumulative proportion
  loadings: Float32Array[]; // Principal component loadings (eigenvectors)
  mean: Float32Array; // Mean vector used for centering
  totalVariance: number;
}

export interface PCAOptions {
  numComponents?: number; // Default: 3
  maxIterations?: number; // For power iteration, default: 100
  tolerance?: number; // Convergence tolerance, default: 1e-8
}

export interface SignatureNeighbor {
  phageId: number;
  name: string;
  /** Euclidean distance across every normalized k-mer frequency. Used for ranking. */
  featureDistance: number;
  /** Descriptive distance in the PC1/PC2 plot; never used for ranking. */
  projectedDistance: number | null;
}

export interface SignatureNeighborhood {
  selectedPhageId: number;
  dimensions: number;
  neighbors: SignatureNeighbor[];
  /** Zero vectors have no counted k-mers and cannot support a neighbor claim. */
  excludedPhageIds: number[];
  unavailableReason: string | null;
}

export interface SignatureSource {
  phageId: number;
  accession: string | null;
  source: 'catalog' | 'local';
  /** SHA-256 of the exact UTF-8 sequence supplied to the vector computation. */
  sequenceSha256: string;
}

/** Compare original signatures rather than a lossy display projection. Centering
 * does not change Euclidean distances, but dropping principal components does.
 * Distances describe sequence composition, not function, ancestry or likelihood.
 * Input order and display names do not affect ranking; ID breaks exact ties.
 */
export function computeSignatureNeighborhood(
  vectors: readonly KmerVector[],
  selectedPhageId: number,
  projections: readonly PCAProjection[] = [],
): SignatureNeighborhood {
  const dimensions = vectors[0]?.frequencies.length ?? 0;
  const byId = new Map<number, KmerVector>();
  const excluded = new Set<number>();
  for (const vector of vectors) {
    if (!Number.isSafeInteger(vector.phageId) || byId.has(vector.phageId)) {
      throw new Error('Signature neighbors require unique integer genome IDs.');
    }
    if (!dimensions || vector.frequencies.length !== dimensions) {
      throw new Error('Signature neighbors require equal, nonempty frequency dimensions.');
    }
    let total = 0;
    for (const value of vector.frequencies) {
      if (!Number.isFinite(value) || value < 0) throw new Error('Signature frequencies must be finite and nonnegative.');
      total += value;
    }
    if (total === 0) excluded.add(vector.phageId);
    // Float32 normalization can accumulate rounding error across many features.
    else if (Math.abs(total - 1) > 1e-5) throw new Error('Signature neighbors require normalized frequency vectors.');
    byId.set(vector.phageId, vector);
  }
  const selected = byId.get(selectedPhageId);
  if (!selected) throw new Error('The selected genome is absent from the signature matrix.');
  const projected = new Map<number, PCAProjection>();
  for (const point of projections) {
    if (!byId.has(point.phageId) || projected.has(point.phageId) || !Number.isFinite(point.pc1) || !Number.isFinite(point.pc2)) {
      throw new Error('Signature projections must be finite and belong to unique matrix rows.');
    }
    projected.set(point.phageId, point);
  }
  const result: SignatureNeighborhood = { selectedPhageId, dimensions, neighbors: [],
    excludedPhageIds: [...excluded].sort((a, b) => a - b), unavailableReason: null };
  if (excluded.has(selectedPhageId)) {
    result.unavailableReason = 'The selected genome has no counted k-mers for these settings.';
    return result;
  }
  const selectedPoint = projected.get(selectedPhageId);
  result.neighbors = vectors.filter(vector => vector.phageId !== selectedPhageId && !excluded.has(vector.phageId))
    .map(vector => {
      const point = projected.get(vector.phageId);
      return { phageId: vector.phageId, name: vector.name,
        featureDistance: euclideanDistance(selected.frequencies, vector.frequencies),
        projectedDistance: selectedPoint && point ? Math.hypot(point.pc1 - selectedPoint.pc1, point.pc2 - selectedPoint.pc2) : null };
    }).sort((a, b) => a.featureDistance - b.featureDistance || a.phageId - b.phageId);
  if (result.neighbors.length === 0) result.unavailableReason = 'No other genome has counted k-mers for these settings.';
  return result;
}

/** Export the exact vectors and display coordinates accepted by the caller.
 * The source-sequence digest identifies provenance; raw sequences are not bundled.
 * This record reproduces neighbor distances, not vector extraction or PCA fitting.
 */
export async function createSignatureNeighborhoodRecord(
  vectors: readonly KmerVector[],
  selectedPhageId: number,
  projections: readonly PCAProjection[],
  options: { k: number; includeReverseComplement: boolean },
  sources: readonly SignatureSource[],
): Promise<AnalysisRecord> {
  const neighborhood = computeSignatureNeighborhood(vectors, selectedPhageId, projections);
  if (!Number.isSafeInteger(options.k) || options.k < 1 || options.k > 12 || 4 ** options.k !== neighborhood.dimensions ||
      typeof options.includeReverseComplement !== 'boolean') throw new Error('Signature settings do not match the frequency dimensions.');
  const vectorIds = new Set(vectors.map(vector => vector.phageId));
  const sourceById = new Map<number, SignatureSource>();
  for (const source of sources) {
    if (sourceById.has(source.phageId) || !vectorIds.has(source.phageId) ||
        !['catalog', 'local'].includes(source.source) || !/^[a-f0-9]{64}$/.test(source.sequenceSha256)) {
      throw new Error('Signature export requires one source-sequence identity per matrix row.');
    }
    sourceById.set(source.phageId, source);
  }
  if (sourceById.size !== vectors.length) throw new Error('Signature source identities are incomplete.');
  const projected = new Map(projections.map(point => [point.phageId, point]));
  const coverage = { available: neighborhood.neighbors.length, total: Math.max(0, vectors.length - 1), unit: 'records' as const };
  const limitations = [
    'Ranking uses Euclidean distance across all normalized k-mer frequencies; PC1/PC2 distance is descriptive only.',
    'Sequence composition and projected proximity do not establish function, ancestry or evolutionary distance.',
    'Exact vectors and display coordinates are bundled for distance recomputation; source-sequence digests do not independently validate vector extraction or PCA fitting.',
    'Genomes without counted k-mers are excluded; absence of a neighbor does not imply biological dissimilarity.',
  ];
  return createAnalysisRecord({
    method: { id: 'genomic-signature-neighborhood', version: '1', implementation: 'Euclidean distance on accepted normalized frequency vectors' },
    inputs: [...vectors].sort((a, b) => a.phageId - b.phageId).map(vector => {
      const source = sourceById.get(vector.phageId)!;
      const point = projected.get(vector.phageId);
      return { id: String(vector.phageId), accession: source.accession, source: source.source,
        description: 'Accepted normalized frequencies and optional PC1/PC2 coordinates; sequenceSha256 hashes the exact source UTF-8 bytes, which are not bundled.',
        data: analysisJson({ phageId: vector.phageId, name: vector.name, frequencies: Array.from(vector.frequencies),
          genomeLength: vector.genomeLength, gcContent: vector.gcContent, sequenceSha256: source.sequenceSha256,
          projection: point ? { pc1: point.pc1, pc2: point.pc2 } : null }) };
    }),
    parameters: { selectedPhageId, k: options.k, includeReverseComplement: options.includeReverseComplement,
      normalize: true, rankingSpace: 'full-kmer-frequencies', metric: 'euclidean' },
    seed: null, references: [],
    fields: {
      neighbors: neighborhood.unavailableReason ? { kind: 'unavailable', label: 'Full-signature nearest neighbors',
        value: null, units: null, coverage, limitations, missingInputs: [neighborhood.unavailableReason] }
        : { kind: 'sequence-score', label: 'Full-signature nearest neighbors', value: analysisJson(neighborhood.neighbors),
          units: 'records', coverage, limitations },
      exclusions: { kind: 'sequence-score', label: 'Genomes without counted k-mers',
        value: analysisJson(neighborhood.excludedPhageIds), units: 'records',
        coverage: { available: vectors.length - neighborhood.excludedPhageIds.length, total: vectors.length, unit: 'records' }, limitations },
    },
  });
}

/**
 * Compute the mean of each dimension across all samples
 */
function computeMean(data: Float32Array[], dim: number): Float32Array {
  const n = data.length;
  const mean = new Float32Array(dim);

  for (const sample of data) {
    for (let i = 0; i < dim; i++) {
      mean[i] += sample[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    mean[i] /= n;
  }

  return mean;
}

/**
 * Center the data by subtracting the mean
 */
function centerData(data: Float32Array[], mean: Float32Array): Float32Array[] {
  return data.map(sample => {
    const centered = new Float32Array(sample.length);
    for (let i = 0; i < sample.length; i++) {
      centered[i] = sample[i] - mean[i];
    }
    return centered;
  });
}

function canonicalizeSign(v: Float32Array): void {
  if (v.length === 0) return;
  let maxIdx = 0;
  let maxAbs = Math.abs(v[0]);
  for (let i = 1; i < v.length; i++) {
    const abs = Math.abs(v[i]);
    if (abs > maxAbs) {
      maxAbs = abs;
      maxIdx = i;
    }
  }
  if (v[maxIdx] < 0) {
    for (let i = 0; i < v.length; i++) {
      v[i] = -v[i];
    }
  }
}

/**
 * Compute dot product of two vectors
 */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Compute the L2 norm of a vector
 */
function norm(v: Float32Array): number {
  return Math.sqrt(dotProduct(v, v));
}

/**
 * Normalize a vector in place
 */
function normalize(v: Float32Array): void {
  const n = norm(v);
  if (n > 0) {
    for (let i = 0; i < v.length; i++) {
      v[i] /= n;
    }
  }
}

/**
 * Multiply centered data matrix X (n x d) by vector v (d x 1)
 * Returns X * v (n x 1)
 */
function multiplyXv(X: Float32Array[], v: Float32Array): Float32Array {
  const n = X.length;
  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = dotProduct(X[i], v);
  }
  return result;
}

/**
 * Multiply X^T (d x n) by vector u (n x 1)
 * Returns X^T * u (d x 1)
 */
function multiplyXTu(X: Float32Array[], u: Float32Array, dim: number): Float32Array {
  const result = new Float32Array(dim);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < dim; j++) {
      result[j] += X[i][j] * u[i];
    }
  }
  return result;
}

/**
 * Remove projection onto a vector from another vector
 * v = v - (v · u) * u
 */
function deflate(v: Float32Array, u: Float32Array): void {
  const proj = dotProduct(v, u);
  for (let i = 0; i < v.length; i++) {
    v[i] -= proj * u[i];
  }
}

function dotCentered(sample: Float32Array, mean: Float32Array, loading: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < sample.length; i++) {
    sum += (sample[i] - mean[i]) * loading[i];
  }
  return sum;
}

/**
 * Power iteration to find the top eigenvector of X^T * X
 * Uses the trick: X^T * X * v = X^T * (X * v) to avoid forming the d x d matrix
 */
function powerIteration(
  X: Float32Array[],
  dim: number,
  previousComponents: Float32Array[],
  maxIterations: number,
  tolerance: number
): { eigenvector: Float32Array; eigenvalue: number } {
  const n = X.length;

  // Initialize with deterministic vector (avoids Math.random() so output is stable).
  // Mirrors the deterministic initialization used by the WASM PCA kernel.
  let v: Float32Array = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const seed = ((i * 7919 + 104729) % 1000) / 1000;
    v[i] = seed - 0.5;
  }

  // Remove projections onto previous components
  for (const pc of previousComponents) {
    deflate(v, pc);
  }
  normalize(v);

  let eigenvalue = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    // Compute X^T * X * v = X^T * (X * v)
    const Xv = multiplyXv(X, v);
    const XTXv = multiplyXTu(X, Xv, dim);

    // Remove projections onto previous components
    for (const pc of previousComponents) {
      deflate(XTXv, pc);
    }

    // Compute eigenvalue estimate (Rayleigh quotient)
    const newEigenvalue = dotProduct(v, XTXv);

    // Normalize to get new eigenvector estimate
    const vNew = XTXv;
    normalize(vNew);

    // Check convergence (handle sign flip)
    // If v and vNew point in opposite directions (dot product < 0),
    // they represent the same eigenvector. Align them before checking diff.
    const dot = dotProduct(v, vNew);
    if (dot < 0) {
      for (let i = 0; i < dim; i++) {
        vNew[i] = -vNew[i];
      }
    }

    let diff = 0;
    for (let i = 0; i < dim; i++) {
      diff += Math.abs(vNew[i] - v[i]);
    }

    v = vNew;
    eigenvalue = newEigenvalue; // Eigenvalue magnitude is the same regardless of sign

    if (diff < tolerance) {
      break;
    }
  }

  canonicalizeSign(v);

  // The eigenvalue is scaled by n-1 for sample covariance
  // Guard against n=1 (single sample)
  return { eigenvector: v, eigenvalue: eigenvalue / Math.max(1, n - 1) };
}

/**
 * Perform PCA on k-mer frequency vectors
 */
export function performPCA(
  vectors: KmerVector[],
  options: PCAOptions = {}
): PCAResult {
  const { numComponents = 3, maxIterations = 100, tolerance = 1e-8 } = options;

  if (vectors.length === 0) {
    return {
      projections: [],
      eigenvalues: [],
      varianceExplained: [],
      cumulativeVariance: [],
      loadings: [],
      mean: new Float32Array(256),
      totalVariance: 0,
    };
  }

  const n = vectors.length;
  const dim = vectors[0].frequencies.length;

  // Extract frequency data
  const data = vectors.map(v => v.frequencies);

  const nComponents = Math.min(numComponents, Math.min(n, dim));
  const matrixElements = n * dim;
  const shouldUseWasm = matrixElements >= PCA_WASM_MIN_ELEMENTS;

  // Fast path: WASM PCA (Float32 ABI), falls back to JS implementation.
  if (shouldUseWasm && wasmPcaAvailable && wasmPca) {
    try {
      const flat = new Float32Array(n * dim);
      for (let i = 0; i < n; i++) {
        flat.set(data[i], i * dim);
      }

      const result = wasmPca(flat, n, dim, nComponents, maxIterations, tolerance);
      try {
        // Copy out WASM-backed buffers before free() to avoid use-after-free.
        const mean = new Float32Array(result.mean);
        const totalVariance = result.total_variance;
        const eigenvalues = Array.from(result.eigenvalues);

        const loadings: Float32Array[] = [];
        for (let k = 0; k < result.n_components; k++) {
          const slice = result.eigenvectors.subarray(k * dim, (k + 1) * dim);
          const loading = new Float32Array(slice);
          canonicalizeSign(loading);
          loadings.push(loading);
        }

        const varianceExplained = eigenvalues.map(ev =>
          totalVariance > 0 ? ev / totalVariance : 0
        );
        const cumulativeVariance: number[] = [];
        let cumSum = 0;
        for (const ve of varianceExplained) {
          cumSum += ve;
          cumulativeVariance.push(cumSum);
        }

        const projections: PCAProjection[] = vectors.map((vec) => {
          const proj: PCAProjection = {
            phageId: vec.phageId,
            name: vec.name,
            pc1: dotCentered(vec.frequencies, mean, loadings[0]!),
            pc2: loadings.length > 1 ? dotCentered(vec.frequencies, mean, loadings[1]!) : 0,
            gcContent: vec.gcContent,
            genomeLength: vec.genomeLength,
          };
          if (loadings.length > 2) {
            proj.pc3 = dotCentered(vec.frequencies, mean, loadings[2]!);
          }
          return proj;
        });

        return {
          projections,
          eigenvalues,
          varianceExplained,
          cumulativeVariance,
          loadings,
          mean,
          totalVariance,
        };
      } finally {
        result.free();
      }
    } catch {
      // Fall through to JS PCA.
    }
  } else if (shouldUseWasm && !wasmPcaInitStarted) {
    // Warm the WASM module for the next call without blocking this synchronous API.
    initWasmPca().catch(() => { /* WASM unavailable */ });
  }

  // JS fallback: Compute mean and center data
  const mean = computeMean(data, dim);
  const centered = centerData(data, mean);

  // Compute total variance
  let totalVariance = 0;
  for (const sample of centered) {
    for (let i = 0; i < dim; i++) {
      totalVariance += sample[i] * sample[i];
    }
  }
  // Guard against n=1 (single sample has undefined variance)
  totalVariance /= Math.max(1, n - 1);

  // Find top principal components using power iteration
  const eigenvalues: number[] = [];
  const loadings: Float32Array[] = [];

  for (let k = 0; k < nComponents; k++) {
    const { eigenvector, eigenvalue } = powerIteration(
      centered,
      dim,
      loadings,
      maxIterations,
      tolerance
    );
    loadings.push(eigenvector);
    eigenvalues.push(eigenvalue);
  }

  // Compute variance explained
  const varianceExplained = eigenvalues.map(ev =>
    totalVariance > 0 ? ev / totalVariance : 0
  );
  const cumulativeVariance: number[] = [];
  let cumSum = 0;
  for (const ve of varianceExplained) {
    cumSum += ve;
    cumulativeVariance.push(cumSum);
  }

  // Project data onto principal components
  const projections: PCAProjection[] = vectors.map((vec, i) => {
    const centered_i = centered[i];
    const proj: PCAProjection = {
      phageId: vec.phageId,
      name: vec.name,
      pc1: dotProduct(centered_i, loadings[0]),
      pc2: loadings.length > 1 ? dotProduct(centered_i, loadings[1]) : 0,
      gcContent: vec.gcContent,
      genomeLength: vec.genomeLength,
    };
    if (loadings.length > 2) {
      proj.pc3 = dotProduct(centered_i, loadings[2]);
    }
    return proj;
  });

  return {
    projections,
    eigenvalues,
    varianceExplained,
    cumulativeVariance,
    loadings,
    mean,
    totalVariance,
  };
}

/**
 * Project a new vector onto the existing PCA space
 */
export function projectToPCA(
  vector: Float32Array,
  mean: Float32Array,
  loadings: Float32Array[]
): { pc1: number; pc2: number; pc3?: number } {
  // Center the vector
  const centered = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    centered[i] = vector[i] - mean[i];
  }

  const result: { pc1: number; pc2: number; pc3?: number } = {
    pc1: dotProduct(centered, loadings[0]),
    pc2: loadings.length > 1 ? dotProduct(centered, loadings[1]) : 0,
  };

  if (loadings.length > 2) {
    result.pc3 = dotProduct(centered, loadings[2]);
  }

  return result;
}

/**
 * Get the top contributing k-mers for each principal component
 */
export function getTopLoadings(
  loadings: Float32Array[],
  k: number = 4,
  topN: number = 10
): Array<Array<{ kmer: string; loading: number }>> {
  return loadings.map(loading => {
    const indexed = Array.from(loading).map((value, index) => ({
      index,
      absValue: Math.abs(value),
      value,
    }));

    indexed.sort((a, b) => b.absValue - a.absValue);

    return indexed.slice(0, topN).map(item => ({
      kmer: indexToKmer(item.index, k),
      loading: item.value,
    }));
  });
}

/**
 * Compute explained variance ratio for a scree plot
 */
export function computeScreePlotData(
  eigenvalues: number[],
  totalVariance: number
): Array<{ component: number; variance: number; cumulative: number }> {
  let cumSum = 0;
  return eigenvalues.map((ev, i) => {
    const variance = totalVariance > 0 ? ev / totalVariance : 0;
    cumSum += variance;
    return {
      component: i + 1,
      variance,
      cumulative: cumSum,
    };
  });
}
