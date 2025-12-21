/**
 * Principal Component Analysis (PCA)
 *
 * Implements PCA for dimensionality reduction of high-dimensional
 * genomic signature vectors (e.g., tetranucleotide frequencies).
 *
 * Uses power iteration for efficient computation of top principal components.
 */

import type { KmerVector } from './kmer-frequencies';
import { indexToKmer } from './kmer-frequencies';

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

  // Initialize with random vector - use explicit type to allow reassignment
  let v: Float32Array = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() - 0.5;
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

  // The eigenvalue is scaled by n-1 for sample covariance
  return { eigenvector: v, eigenvalue: eigenvalue / (n - 1) };
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

  // Compute mean and center data
  const mean = computeMean(data, dim);
  const centered = centerData(data, mean);

  // Compute total variance
  let totalVariance = 0;
  for (const sample of centered) {
    for (let i = 0; i < dim; i++) {
      totalVariance += sample[i] * sample[i];
    }
  }
  totalVariance /= n - 1;

  // Find top principal components using power iteration
  const eigenvalues: number[] = [];
  const loadings: Float32Array[] = [];
  const nComponents = Math.min(numComponents, Math.min(n, dim));

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
