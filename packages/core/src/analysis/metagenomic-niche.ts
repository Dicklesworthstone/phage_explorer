/**
 * Metagenomic Co-Occurrence & Niche Profiler
 *
 * Implements ecological niche inference from metagenomic abundance data:
 * - SparCC-like compositional correlation estimation
 * - NMF for latent niche vector extraction
 * - Co-occurrence network construction
 *
 * References:
 * - SparCC: Friedman & Alm (2012) PLOS Computational Biology
 * - CLR transformation: Aitchison (1986) compositional data analysis
 */

// =============================================================================
// Types
// =============================================================================

/** Abundance table: rows = taxa, columns = samples */
export interface AbundanceTable {
  taxa: string[];
  samples: string[];
  /** Row-major matrix [taxa][sample] */
  counts: number[][];
}

/** Sample metadata for niche annotation */
export interface SampleMetadata {
  sampleId: string;
  habitat?: string;
  host?: string;
  location?: string;
  /** Custom metadata fields */
  [key: string]: string | number | undefined;
}

/** Compositional correlation result */
export interface CorrelationMatrix {
  taxa: string[];
  /** Symmetric correlation matrix [i][j] */
  correlations: number[][];
  /** P-values (bootstrapped) [i][j] */
  pvalues?: number[][];
}

/** Edge in co-occurrence network */
export interface CoOccurrenceEdge {
  source: string;
  target: string;
  correlation: number;
  pvalue?: number;
  type: 'positive' | 'negative';
}

/** Node in co-occurrence network */
export interface CoOccurrenceNode {
  taxon: string;
  /** Niche vector assignments (from NMF) */
  nicheWeights: number[];
  /** Primary niche (highest weight) */
  primaryNiche: number;
  /** Degree in filtered network */
  degree: number;
  /** Sum of edge weights */
  strength: number;
}

/** Complete co-occurrence network */
export interface CoOccurrenceNetwork {
  nodes: CoOccurrenceNode[];
  edges: CoOccurrenceEdge[];
  /** Niche labels (derived from metadata or indices) */
  nicheLabels: string[];
  /** Statistics */
  stats: {
    nodeCount: number;
    edgeCount: number;
    density: number;
    positiveRatio: number;
  };
}

/** NMF result for niche decomposition */
export interface NMFResult {
  /** W matrix: taxa × niches (niche membership) */
  W: number[][];
  /** H matrix: niches × samples (niche expression) */
  H: number[][];
  /** Reconstruction error */
  error: number;
  /** Number of niches (k) */
  k: number;
}

/** Niche profile for a single taxon */
export interface NicheProfile {
  taxon: string;
  nicheWeights: number[];
  primaryNiche: number;
  nicheConfidence: number;
  associatedHabitats: string[];
  coOccurringTaxa: Array<{ taxon: string; correlation: number }>;
}

// =============================================================================
// Compositional Data Handling
// =============================================================================

/**
 * Add pseudocount and normalize to relative abundances
 */
export function normalizeAbundance(
  counts: number[][],
  pseudocount = 1
): number[][] {
  return counts.map(row => {
    const withPseudo = row.map(c => c + pseudocount);
    const total = withPseudo.reduce((a, b) => a + b, 0);
    return withPseudo.map(c => c / total);
  });
}

/**
 * Center Log-Ratio (CLR) transformation for compositional data
 * CLR(x_i) = log(x_i / geometric_mean(x))
 */
export function clrTransform(abundances: number[][]): number[][] {
  return abundances.map(row => {
    // Geometric mean (use log sum for numerical stability)
    const logSum = row.reduce((acc, v) => acc + Math.log(v), 0);
    const logGeomMean = logSum / row.length;
    // CLR transform
    return row.map(v => Math.log(v) - logGeomMean);
  });
}

// =============================================================================
// SparCC-like Correlation Estimation
// =============================================================================

/**
 * Estimate basis correlations using iterative exclusion
 * Simplified SparCC-like algorithm for compositional data
 *
 * @param clrData CLR-transformed abundance matrix [taxa][samples]
 * @param iterations Number of iterative refinement steps
 * @returns Estimated true correlations
 */
export function estimateBasisCorrelations(
  clrData: number[][],
  iterations = 10
): number[][] {
  const n = clrData.length; // number of taxa
  const m = clrData[0]?.length ?? 0; // number of samples

  if (n === 0 || m === 0) {
    return [];
  }

  // Initialize with standard Pearson correlations
  const variances = clrData.map(row => {
    const mean = row.reduce((a, b) => a + b, 0) / row.length;
    return row.reduce((a, b) => a + (b - mean) ** 2, 0) / row.length;
  });

  const covariances: number[][] = Array.from({ length: n }, () =>
    Array(n).fill(0)
  );

  // Calculate CLR covariance matrix
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const meanI = clrData[i].reduce((a, b) => a + b, 0) / m;
      const meanJ = clrData[j].reduce((a, b) => a + b, 0) / m;
      let cov = 0;
      for (let k = 0; k < m; k++) {
        cov += (clrData[i][k] - meanI) * (clrData[j][k] - meanJ);
      }
      cov /= m;
      covariances[i][j] = cov;
      covariances[j][i] = cov;
    }
  }

  // Convert to correlations
  const correlations: number[][] = Array.from({ length: n }, () =>
    Array(n).fill(0)
  );
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const denom = Math.sqrt(variances[i] * variances[j]);
      correlations[i][j] = denom > 0 ? covariances[i][j] / denom : 0;
    }
  }

  // Iterative refinement (simplified SparCC approach)
  // In each iteration, identify and downweight outlier correlations
  for (let iter = 0; iter < iterations; iter++) {
    // Calculate median absolute correlation
    const absCorrs: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        absCorrs.push(Math.abs(correlations[i][j]));
      }
    }
    absCorrs.sort((a, b) => a - b);
    const medianAbs = absCorrs[Math.floor(absCorrs.length / 2)] || 0;

    // Shrink extreme correlations toward median
    const shrinkFactor = 0.9;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(correlations[i][j]) > 2 * medianAbs) {
          const sign = correlations[i][j] > 0 ? 1 : -1;
          const shrunk = sign * medianAbs + shrinkFactor * (correlations[i][j] - sign * medianAbs);
          correlations[i][j] = shrunk;
          correlations[j][i] = shrunk;
        }
      }
    }
  }

  // Ensure diagonal is 1
  for (let i = 0; i < n; i++) {
    correlations[i][i] = 1;
  }

  return correlations;
}

/**
 * Bootstrap p-values for correlations
 */
export function bootstrapPValues(
  abundances: number[][],
  correlations: number[][],
  nBootstrap = 100,
  rng: () => number = Math.random
): number[][] {
  const n = abundances.length;
  const m = abundances[0]?.length ?? 0;
  const pvalues: number[][] = Array.from({ length: n }, () =>
    Array(n).fill(1)
  );

  if (n === 0 || m < 3) return pvalues;

  // Count how many bootstrap samples exceed observed correlation
  const exceedCounts: number[][] = Array.from({ length: n }, () =>
    Array(n).fill(0)
  );

  for (let b = 0; b < nBootstrap; b++) {
    // Resample with replacement
    const indices = Array.from({ length: m }, () => Math.floor(rng() * m));
    const resampledAbundances = abundances.map(row =>
      indices.map(i => row[i])
    );

    // Compute correlations on resampled data
    const normalized = normalizeAbundance(resampledAbundances);
    const clrData = clrTransform(normalized);
    const bootCorrs = estimateBasisCorrelations(clrData, 3);

    // Compare to observed
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(bootCorrs[i]?.[j] ?? 0) >= Math.abs(correlations[i][j])) {
          exceedCounts[i][j]++;
        }
      }
    }
  }

  // Convert to p-values
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = exceedCounts[i][j] / nBootstrap;
      pvalues[i][j] = p;
      pvalues[j][i] = p;
    }
    pvalues[i][i] = 0;
  }

  return pvalues;
}

// =============================================================================
// Non-negative Matrix Factorization (NMF)
// =============================================================================

/**
 * Perform NMF using multiplicative update rules (Lee & Seung 2001)
 *
 * V ≈ W × H where V is non-negative
 *
 * @param V Input matrix [taxa][samples], must be non-negative
 * @param k Number of latent factors (niches)
 * @param maxIter Maximum iterations
 * @param tol Convergence tolerance
 * @param rng Random number generator
 */
export function nmf(
  V: number[][],
  k: number,
  maxIter = 200,
  tol = 1e-4,
  rng: () => number = Math.random
): NMFResult {
  const n = V.length; // taxa
  const m = V[0]?.length ?? 0; // samples

  if (n === 0 || m === 0 || k <= 0) {
    return { W: [], H: [], error: Infinity, k: 0 };
  }

  // Initialize W and H with small random values
  let W: number[][] = Array.from({ length: n }, () =>
    Array.from({ length: k }, () => rng() * 0.1 + 0.01)
  );
  let H: number[][] = Array.from({ length: k }, () =>
    Array.from({ length: m }, () => rng() * 0.1 + 0.01)
  );

  // Small epsilon to avoid division by zero
  const eps = 1e-10;

  let prevError = Infinity;

  for (let iter = 0; iter < maxIter; iter++) {
    // Update H: H = H * (W^T V) / (W^T W H)
    // Compute W^T V
    const WtV: number[][] = Array.from({ length: k }, () => Array(m).fill(0));
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < m; j++) {
        for (let t = 0; t < n; t++) {
          WtV[i][j] += W[t][i] * V[t][j];
        }
      }
    }

    // Compute W^T W H
    const WtW: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        for (let t = 0; t < n; t++) {
          WtW[i][j] += W[t][i] * W[t][j];
        }
      }
    }

    const WtWH: number[][] = Array.from({ length: k }, () => Array(m).fill(0));
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < m; j++) {
        for (let l = 0; l < k; l++) {
          WtWH[i][j] += WtW[i][l] * H[l][j];
        }
      }
    }

    // Update H
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < m; j++) {
        H[i][j] = H[i][j] * (WtV[i][j] / (WtWH[i][j] + eps));
      }
    }

    // Update W: W = W * (V H^T) / (W H H^T)
    // Compute V H^T
    const VHt: number[][] = Array.from({ length: n }, () => Array(k).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < k; j++) {
        for (let t = 0; t < m; t++) {
          VHt[i][j] += V[i][t] * H[j][t];
        }
      }
    }

    // Compute H H^T
    const HHt: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        for (let t = 0; t < m; t++) {
          HHt[i][j] += H[i][t] * H[j][t];
        }
      }
    }

    // Compute W H H^T
    const WHHt: number[][] = Array.from({ length: n }, () => Array(k).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < k; j++) {
        for (let l = 0; l < k; l++) {
          WHHt[i][j] += W[i][l] * HHt[l][j];
        }
      }
    }

    // Update W
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < k; j++) {
        W[i][j] = W[i][j] * (VHt[i][j] / (WHHt[i][j] + eps));
      }
    }

    // Compute reconstruction error: ||V - WH||_F^2
    let error = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        let approx = 0;
        for (let l = 0; l < k; l++) {
          approx += W[i][l] * H[l][j];
        }
        error += (V[i][j] - approx) ** 2;
      }
    }
    error = Math.sqrt(error);

    // Check convergence
    if (Math.abs(prevError - error) < tol) {
      return { W, H, error, k };
    }
    prevError = error;
  }

  return { W, H, error: prevError, k };
}

/**
 * Determine optimal number of niches using elbow method on reconstruction error
 */
export function findOptimalK(
  V: number[][],
  maxK = 10,
  rng: () => number = Math.random
): number {
  const errors: number[] = [];

  for (let k = 1; k <= maxK; k++) {
    const result = nmf(V, k, 100, 1e-3, rng);
    errors.push(result.error);
  }

  // Find elbow using second derivative
  if (errors.length < 3) return 2;

  let maxCurvature = 0;
  let optimalK = 2;

  for (let i = 1; i < errors.length - 1; i++) {
    // Second derivative approximation
    const curvature = errors[i - 1] - 2 * errors[i] + errors[i + 1];
    if (curvature > maxCurvature) {
      maxCurvature = curvature;
      optimalK = i + 1;
    }
  }

  return Math.max(2, Math.min(optimalK, maxK));
}

// =============================================================================
// Network Construction
// =============================================================================

/**
 * Build co-occurrence network from correlation matrix
 */
export function buildCoOccurrenceNetwork(
  correlationMatrix: CorrelationMatrix,
  nmfResult: NMFResult,
  options: {
    correlationThreshold?: number;
    pvalueThreshold?: number;
    includeNegative?: boolean;
  } = {}
): CoOccurrenceNetwork {
  const {
    correlationThreshold = 0.3,
    pvalueThreshold = 0.05,
    includeNegative = true,
  } = options;

  const { taxa, correlations, pvalues } = correlationMatrix;
  const n = taxa.length;
  const { W, k } = nmfResult;

  // Build nodes
  const nodes: CoOccurrenceNode[] = taxa.map((taxon, i) => {
    const nicheWeights = W[i] || Array(k).fill(0);
    const total = nicheWeights.reduce((a, b) => a + b, 0) || 1;
    const normalizedWeights = nicheWeights.map(w => w / total);
    const primaryNiche = normalizedWeights.indexOf(Math.max(...normalizedWeights));

    return {
      taxon,
      nicheWeights: normalizedWeights,
      primaryNiche: primaryNiche >= 0 ? primaryNiche : 0,
      degree: 0,
      strength: 0,
    };
  });

  // Build edges
  const edges: CoOccurrenceEdge[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const corr = correlations[i]?.[j] ?? 0;
      const pval = pvalues?.[i]?.[j] ?? 1;

      // Filter by thresholds
      if (Math.abs(corr) < correlationThreshold) continue;
      if (pval > pvalueThreshold) continue;
      if (!includeNegative && corr < 0) continue;

      edges.push({
        source: taxa[i],
        target: taxa[j],
        correlation: corr,
        pvalue: pval,
        type: corr > 0 ? 'positive' : 'negative',
      });

      // Update node statistics
      nodes[i].degree++;
      nodes[j].degree++;
      nodes[i].strength += Math.abs(corr);
      nodes[j].strength += Math.abs(corr);
    }
  }

  // Generate niche labels
  const nicheLabels = Array.from({ length: k }, (_, i) => `Niche ${i + 1}`);

  // Calculate network statistics
  const maxPossibleEdges = (n * (n - 1)) / 2;
  const positiveEdges = edges.filter(e => e.type === 'positive').length;

  return {
    nodes,
    edges,
    nicheLabels,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      density: maxPossibleEdges > 0 ? edges.length / maxPossibleEdges : 0,
      positiveRatio: edges.length > 0 ? positiveEdges / edges.length : 0,
    },
  };
}

// =============================================================================
// Main Analysis Pipeline
// =============================================================================

export interface NicheAnalysisOptions {
  /** Number of niches (0 = auto-detect) */
  numNiches?: number;
  /** Correlation threshold for network edges */
  correlationThreshold?: number;
  /** P-value threshold for significance */
  pvalueThreshold?: number;
  /** Number of bootstrap iterations for p-values */
  bootstrapIterations?: number;
  /** Include negative correlations in network */
  includeNegative?: boolean;
  /** Random seed function */
  rng?: () => number;
}

export interface NicheAnalysisResult {
  correlationMatrix: CorrelationMatrix;
  nmfResult: NMFResult;
  network: CoOccurrenceNetwork;
  nicheProfiles: NicheProfile[];
}

/**
 * Run complete niche analysis pipeline
 */
export function analyzeNiches(
  abundanceTable: AbundanceTable,
  metadata?: SampleMetadata[],
  options: NicheAnalysisOptions = {}
): NicheAnalysisResult {
  const {
    numNiches = 0,
    correlationThreshold = 0.3,
    pvalueThreshold = 0.05,
    bootstrapIterations = 100,
    includeNegative = true,
    rng = Math.random,
  } = options;

  const { taxa, counts } = abundanceTable;

  // Step 1: Normalize and transform
  const normalized = normalizeAbundance(counts);
  const clrData = clrTransform(normalized);

  // Step 2: Estimate correlations
  const correlations = estimateBasisCorrelations(clrData);
  const pvalues = bootstrapPValues(counts, correlations, bootstrapIterations, rng);

  const correlationMatrix: CorrelationMatrix = {
    taxa,
    correlations,
    pvalues,
  };

  // Step 3: Run NMF for niche decomposition
  const k = numNiches > 0 ? numNiches : findOptimalK(normalized, 8, rng);
  const nmfResult = nmf(normalized, k, 200, 1e-4, rng);

  // Step 4: Build co-occurrence network
  const network = buildCoOccurrenceNetwork(correlationMatrix, nmfResult, {
    correlationThreshold,
    pvalueThreshold,
    includeNegative,
  });

  // Step 5: Build niche profiles
  const nicheProfiles = buildNicheProfiles(
    taxa,
    nmfResult,
    correlationMatrix,
    metadata,
    correlationThreshold
  );

  return {
    correlationMatrix,
    nmfResult,
    network,
    nicheProfiles,
  };
}

/**
 * Build detailed niche profiles for each taxon
 */
function buildNicheProfiles(
  taxa: string[],
  nmfResult: NMFResult,
  correlationMatrix: CorrelationMatrix,
  metadata?: SampleMetadata[],
  correlationThreshold = 0.3
): NicheProfile[] {
  const { W, k } = nmfResult;
  const { correlations } = correlationMatrix;

  return taxa.map((taxon, i) => {
    const nicheWeights = W[i] || Array(k).fill(0);
    const total = nicheWeights.reduce((a, b) => a + b, 0) || 1;
    const normalizedWeights = nicheWeights.map(w => w / total);
    const primaryNiche = normalizedWeights.indexOf(Math.max(...normalizedWeights));
    const nicheConfidence = normalizedWeights[primaryNiche] || 0;

    // Find co-occurring taxa
    const coOccurring: Array<{ taxon: string; correlation: number }> = [];
    for (let j = 0; j < taxa.length; j++) {
      if (i === j) continue;
      const corr = correlations[i]?.[j] ?? 0;
      if (Math.abs(corr) >= correlationThreshold) {
        coOccurring.push({ taxon: taxa[j], correlation: corr });
      }
    }
    coOccurring.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    // Infer associated habitats from metadata
    const associatedHabitats: string[] = [];
    if (metadata) {
      const habitatCounts = new Map<string, number>();
      metadata.forEach(m => {
        if (m.habitat) {
          habitatCounts.set(m.habitat, (habitatCounts.get(m.habitat) || 0) + 1);
        }
      });
      // Top 3 habitats
      const sorted = [...habitatCounts.entries()].sort((a, b) => b[1] - a[1]);
      associatedHabitats.push(...sorted.slice(0, 3).map(([h]) => h));
    }

    return {
      taxon,
      nicheWeights: normalizedWeights,
      primaryNiche: primaryNiche >= 0 ? primaryNiche : 0,
      nicheConfidence,
      associatedHabitats,
      coOccurringTaxa: coOccurring.slice(0, 10),
    };
  });
}

// =============================================================================
// Utility: Generate Demo Data
// =============================================================================

/**
 * Generate synthetic abundance data for testing/demo
 */
export function generateDemoAbundanceTable(
  numTaxa = 20,
  numSamples = 50,
  numNiches = 3,
  rng: () => number = Math.random
): AbundanceTable {
  const taxa = Array.from({ length: numTaxa }, (_, i) => `Taxon_${i + 1}`);
  const samples = Array.from({ length: numSamples }, (_, i) => `Sample_${i + 1}`);

  // Assign taxa to niches
  const taxaNiches = taxa.map(() => Math.floor(rng() * numNiches));

  // Generate counts based on niche structure
  const counts: number[][] = Array.from({ length: numTaxa }, (_, t) => {
    const niche = taxaNiches[t];
    return Array.from({ length: numSamples }, (_, s) => {
      // Each sample has dominant niches
      const sampleNiche = s % numNiches;
      const inNiche = niche === sampleNiche;

      // Base abundance + niche boost + noise
      const base = rng() * 10;
      const boost = inNiche ? rng() * 100 : 0;
      const noise = rng() * 5;

      return Math.max(0, Math.round(base + boost + noise));
    });
  });

  return { taxa, samples, counts };
}
