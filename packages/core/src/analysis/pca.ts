/**
 * Principal Component Analysis (PCA)
 *
 * Implements PCA for dimensionality reduction of high-dimensional
 * genomic signature vectors (e.g., tetranucleotide frequencies).
 *
 * Uses a rank-aware symmetric decomposition of the smaller sample/feature
 * matrix. Optional native results must pass the same numerical contract.
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

    // An ABI smoke test alone accepts the old deflation kernel, which can
    // return PC1 again as a nominally zero-variance PC2. Check rank as well.
    const test = wasmPca(new Float32Array([0, 0, 2, 0, 0, 1, 2, 1]), 4, 2, 2, 50, 1e-6);
    try {
      wasmPcaAvailable = test.n_features === 2 && test.n_components === 2;
    } finally { test.free(); }
    if (wasmPcaAvailable) {
      const rankOne = wasmPca(new Float32Array([0.5, 0, 0.5, 0, 0, 1, 0, 0]), 2, 4, 2, 100, 1e-8);
      try {
        const values = rankOne.eigenvalues;
        const axes = rankOne.eigenvectors;
        wasmPcaAvailable = values.length === 2 && axes.length === 8
          && Math.abs(values[0] - 0.75) < 1e-5 && values[1] === 0
          && axes.subarray(4).every(value => value === 0);
      } finally { rankOne.free(); }
    }
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
  maxIterations?: number; // Maximum eigensolver sweeps, default: 100
  tolerance?: number; // Relative residual tolerance, default: 1e-8
}

/** A bounded shared solver for genomic signatures, bias and protein properties.
 * Double precision prevents roundoff-sized deflation residuals from becoming a
 * second unit axis. Zero-variance components are represented by zero vectors.
 */
export interface MatrixPCA {
  mean: Float64Array;
  loadings: Float64Array[];
  eigenvalues: number[];
  totalVariance: number;
}

const PCA_MATRIX_LIMIT = 256;
const PCA_ELEMENT_LIMIT = 8_000_000;
const PCA_OPERATION_LIMIT = 100_000_000;

function resolvePcaOptions(options: PCAOptions): Required<PCAOptions> {
  const { numComponents = 3, maxIterations = 100, tolerance = 1e-8 } = options;
  if (!Number.isSafeInteger(numComponents) || numComponents < 1
    || !Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 1000
    || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 1) {
    throw new Error('PCA requires a positive component count, 1–1000 iterations and a relative tolerance strictly between 0 and 1.');
  }
  return { numComponents, maxIterations, tolerance };
}

/** Centered sample covariance (division by n-1), without feature standardization.
 * Jacobi rotations resolve repeated eigenvalues without a privileged starting
 * vector. For n < d the n×n Gram matrix avoids constructing a d×d covariance;
 * otherwise the d×d covariance avoids a matrix quadratic in window count.
 * Work exhaustion fails explicitly instead of returning unconverged axes.
 */
export function computeMatrixPCA(rows: readonly ArrayLike<number>[], options: PCAOptions = {}): MatrixPCA {
  const { numComponents, maxIterations, tolerance } = resolvePcaOptions(options);
  const n = rows.length, dim = rows[0]?.length ?? 0;
  if (!n) return { mean: new Float64Array(0), loadings: [], eigenvalues: [], totalVariance: 0 };
  const size = Math.min(n, dim), count = Math.min(numComponents, size);
  if (!Number.isSafeInteger(dim) || dim < 1 || n * dim > PCA_ELEMENT_LIMIT || size > PCA_MATRIX_LIMIT) {
    throw new Error('PCA supports at most 8,000,000 matrix elements and 256 in the smaller sample/feature dimension. Use fewer genomes or features.');
  }
  const mean = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    if (rows[i].length !== dim) throw new Error('PCA rows must have equal nonempty dimensions.');
    for (let j = 0; j < dim; j++) {
      const value = rows[i][j];
      if (!Number.isFinite(value)) throw new Error('PCA input values must be finite.');
      // The incremental mean also preserves an exactly constant feature.
      mean[j] += (value - mean[j]) / (i + 1);
    }
  }
  const centered = rows.map(row => Float64Array.from({ length: dim }, (_, j) => row[j] - mean[j]));
  const denominator = Math.max(1, n - 1);
  let totalVariance = 0;
  for (const row of centered) for (const value of row) totalVariance += value * value / denominator;
  if (!Number.isFinite(totalVariance)) throw new Error('PCA covariance is outside the finite numeric range.');
  const empty = (): MatrixPCA => ({ mean, totalVariance,
    eigenvalues: Array<number>(count).fill(0), loadings: Array.from({ length: count }, () => new Float64Array(dim)) });
  if (totalVariance === 0) return empty();

  const sampleSpace = n < dim;
  const inner = sampleSpace ? dim : n;
  // Reserve all requested axes before doing the expensive covariance work.
  // Besides the Gram conversion and Rayleigh products, two reorthogonalization
  // passes visit every prior axis twice (dot product, then subtraction).
  // Rank-zero axes may use less than this conservative reservation.
  const axisWork = count * ((sampleSpace ? n * dim : dim) + 4 * dim + n * (dim + 1))
    + 2 * count * (count - 1) * dim;
  let work = 3 * n * dim + size * (size + 1) / 2 * inner + axisWork;
  if (work > PCA_OPERATION_LIMIT) throw new Error('PCA covariance work limit exceeded. Use fewer windows, genomes or features.');
  const matrix = new Float64Array(size * size), axes = new Float64Array(size * size);
  for (let i = 0; i < size; i++) {
    axes[i * size + i] = 1;
    for (let j = i; j < size; j++) {
      let sum = 0;
      for (let k = 0; k < inner; k++) {
        sum += sampleSpace ? centered[i][k] * centered[j][k] : centered[k][i] * centered[k][j];
      }
      matrix[i * size + j] = matrix[j * size + i] = sum / denominator;
    }
  }
  const relativeTolerance = Math.max(tolerance, Number.EPSILON * 32);
  const rankThreshold = Math.max(Number.EPSILON * 64 * size, tolerance * tolerance) * totalVariance;
  const unresolvedPair = (p: number, q: number): boolean => {
    const offDiagonal = Math.abs(matrix[p * size + q]);
    if (offDiagonal === 0) return false;
    const diagonalP = Math.abs(matrix[p * size + p]), diagonalQ = Math.abs(matrix[q * size + q]);
    // A trace-scaled stopping rule can miss a correlated low-variance block
    // while still reporting its diagonal entries as separate components. Use
    // pair-relative correlation instead, so every retained scale is resolved.
    // Only skip absolute roundoff when the whole possible residual block has
    // spectral norm below the explicit numerical-rank threshold.
    if (Math.max(diagonalP, diagonalQ, offDiagonal) <= rankThreshold / size) return false;
    return offDiagonal > relativeTolerance * Math.sqrt(diagonalP) * Math.sqrt(diagonalQ);
  };
  let converged = false;
  for (let sweep = 0; sweep <= maxIterations; sweep++) {
    let unresolved = false;
    for (let p = 0; p < size && !unresolved; p++) for (let q = p + 1; q < size; q++) {
      if (unresolvedPair(p, q)) { unresolved = true; break; }
    }
    if (!unresolved) { converged = true; break; }
    if (sweep === maxIterations) break;
    for (let p = 0; p < size; p++) for (let q = p + 1; q < size; q++) {
      const pq = matrix[p * size + q];
      if (!unresolvedPair(p, q)) continue;
      work += 4 * size;
      if (work > PCA_OPERATION_LIMIT) throw new Error('PCA eigensolver work limit exceeded; no unconverged projection was returned.');
      const tau = (matrix[q * size + q] - matrix[p * size + p]) / (2 * pq);
      const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.hypot(1, tau));
      const c = 1 / Math.hypot(1, t), s = t * c;
      matrix[p * size + p] -= t * pq;
      matrix[q * size + q] += t * pq;
      matrix[p * size + q] = matrix[q * size + p] = 0;
      for (let k = 0; k < size; k++) {
        if (k !== p && k !== q) {
          const kp = matrix[k * size + p], kq = matrix[k * size + q];
          matrix[k * size + p] = matrix[p * size + k] = c * kp - s * kq;
          matrix[k * size + q] = matrix[q * size + k] = s * kp + c * kq;
        }
        const kp = axes[k * size + p], kq = axes[k * size + q];
        axes[k * size + p] = c * kp - s * kq;
        axes[k * size + q] = s * kp + c * kq;
      }
    }
  }
  if (!converged) throw new Error('PCA did not converge within its iteration limit; no unconverged projection was returned.');

  const order = Array.from({ length: size }, (_, i) => i).sort((a, b) => matrix[b * size + b] - matrix[a * size + a] || a - b);
  const result = empty();
  for (let component = 0; component < count; component++) {
    const index = order[component], value = matrix[index * size + index];
    if (value <= rankThreshold || component >= n - 1) continue;
    const loading = result.loadings[component];
    for (let j = 0; j < dim; j++) {
      if (sampleSpace) {
        for (let i = 0; i < n; i++) loading[j] += centered[i][j] * axes[i * size + index];
        loading[j] /= Math.sqrt(value * denominator);
      } else loading[j] = axes[j * size + index];
    }
    // Reorthogonalize after Gram-to-feature conversion, retaining the entire
    // eigenspace when eigenvalues repeat. Two passes limit cancellation error.
    for (let pass = 0; pass < 2; pass++) for (let previous = 0; previous < component; previous++) {
      const prior = result.loadings[previous];
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += loading[j] * prior[j];
      for (let j = 0; j < dim; j++) loading[j] -= dot * prior[j];
    }
    let normSquared = 0;
    for (const v of loading) normSquared += v * v;
    if (!(normSquared > 0)) { loading.fill(0); continue; }
    const norm = Math.sqrt(normSquared);
    for (let j = 0; j < dim; j++) loading[j] /= norm;
    let maxIndex = 0;
    for (let j = 1; j < dim; j++) if (Math.abs(loading[j]) > Math.abs(loading[maxIndex])) maxIndex = j;
    if (loading[maxIndex] < 0) for (let j = 0; j < dim; j++) loading[j] *= -1;
    // Recompute the Rayleigh quotient for the returned axis, never reuse the
    // quotient of a previous iterate or take abs() of a negative eigenvalue.
    for (const row of centered) {
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += row[j] * loading[j];
      result.eigenvalues[component] += dot * dot / denominator;
    }
  }
  return result;
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

function dotCentered(sample: Float32Array, mean: Float32Array, loading: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < sample.length; i++) {
    sum += (sample[i] - mean[i]) * loading[i];
  }
  return sum;
}

/**
 * Perform PCA on k-mer frequency vectors
 */
export function performPCA(
  vectors: KmerVector[],
  options: PCAOptions = {}
): PCAResult {
  const { numComponents, maxIterations, tolerance } = resolvePcaOptions(options);

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
  if (!dim || n * dim > PCA_ELEMENT_LIMIT || Math.min(n, dim) > PCA_MATRIX_LIMIT) {
    throw new Error('PCA supports nonempty dimensions, at most 8,000,000 matrix elements and 256 in the smaller sample/feature dimension.');
  }
  if (vectors.some(vector => vector.frequencies.length !== dim || !vector.frequencies.every(Number.isFinite))) {
    throw new Error('PCA rows must have equal dimensions and finite values.');
  }

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
        const eigenvectors = result.eigenvectors;
        if (result.n_components !== nComponents || result.n_features !== dim
          || mean.length !== dim || eigenvalues.length !== nComponents || eigenvectors.length !== nComponents * dim
          || !mean.every(Number.isFinite) || !eigenvectors.every(Number.isFinite)
          || !eigenvalues.every(value => Number.isFinite(value) && value >= 0)
          || !Number.isFinite(totalVariance) || totalVariance < 0) throw new Error('Invalid native PCA result.');

        const loadings: Float32Array[] = [];
        for (let k = 0; k < result.n_components; k++) {
          const slice = eigenvectors.subarray(k * dim, (k + 1) * dim);
          const loading = new Float32Array(slice);
          canonicalizeSign(loading);
          const lengthSquared = dotProduct(loading, loading);
          if (eigenvalues[k] === 0 ? lengthSquared !== 0 : Math.abs(lengthSquared - 1) > 1e-5) throw new Error('Invalid native PCA rank.');
          if (loadings.some(prior => Math.abs(dotProduct(prior, loading)) > 1e-5)) throw new Error('Native PCA axes are not orthogonal.');
          loadings.push(loading);
        }
        if (eigenvalues.reduce((sum, value) => sum + value, 0) > totalVariance * (1 + 1e-5)) throw new Error('Native PCA explained variance exceeds total variance.');

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

  const decomposition = computeMatrixPCA(data, options);
  const mean = new Float32Array(decomposition.mean);
  const loadings = decomposition.loadings.map(loading => new Float32Array(loading));
  const { eigenvalues, totalVariance } = decomposition;

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
  const projections: PCAProjection[] = vectors.map((vec) => {
    const proj: PCAProjection = {
      phageId: vec.phageId,
      name: vec.name,
      pc1: dotCentered(vec.frequencies, mean, loadings[0]),
      pc2: loadings.length > 1 ? dotCentered(vec.frequencies, mean, loadings[1]) : 0,
      gcContent: vec.gcContent,
      genomeLength: vec.genomeLength,
    };
    if (loadings.length > 2) {
      proj.pc3 = dotCentered(vec.frequencies, mean, loadings[2]);
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
