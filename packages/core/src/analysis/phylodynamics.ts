/**
 * Phylodynamic Trajectory Explorer
 *
 * Implements phylodynamic analysis for viral evolution:
 * - Distance-based tree construction (UPGMA)
 * - Molecular clock estimation via root-to-tip regression
 * - Coalescent skyline for effective population size Ne(t)
 * - dN/dS estimation for selection pressure
 *
 * References:
 * - UPGMA: Sokal & Michener (1958)
 * - Molecular clock: Drummond et al. (2006)
 * - Skyline: Pybus et al. (2000)
 * - dN/dS: Nei & Gojobori (1986)
 */

// =============================================================================
// Types
// =============================================================================

/** A dated sequence for phylodynamic analysis */
export interface DatedSequence {
  id: string;
  sequence: string;
  /** Collection date (decimal year, e.g., 2023.5 for mid-2023) */
  date: number;
  /** Optional metadata */
  metadata?: Record<string, string | number>;
}

/** A node in the phylogenetic tree */
export interface TreeNode {
  id: string;
  /** Distance to parent (branch length) */
  distance: number;
  /** Height from root (time units if clock-calibrated) */
  height: number;
  /** Child nodes (empty for leaves) */
  children: TreeNode[];
  /** Is this a leaf node? */
  isLeaf: boolean;
  /** For leaves: original sequence data */
  sequence?: DatedSequence;
  /** dN/dS ratio for this branch (if computed) */
  dnds?: number;
}

/** Phylogenetic tree with metadata */
export interface PhylogeneticTree {
  root: TreeNode;
  /** Total number of leaves */
  leafCount: number;
  /** Tree height (root to farthest leaf) */
  height: number;
  /** Is the tree clock-calibrated? */
  isClockCalibrated: boolean;
  /** Estimated substitution rate (if clock-calibrated) */
  substitutionRate?: number;
  /** R² of root-to-tip regression */
  clockR2?: number;
}

/** Root-to-tip regression result */
export interface ClockRegressionResult {
  /** Substitution rate (substitutions per site per year) */
  rate: number;
  /** Root age (decimal year) */
  rootAge: number;
  /** R² (goodness of fit) */
  r2: number;
  /** Residuals for each tip */
  residuals: Array<{ id: string; observed: number; expected: number; residual: number }>;
}

/** Coalescent interval for skyline plot */
export interface CoalescentInterval {
  /** Start time (years before present) */
  startTime: number;
  /** End time (years before present) */
  endTime: number;
  /** Number of lineages during this interval */
  lineages: number;
  /** Estimated Ne for this interval */
  ne: number;
  /** Interval width (years) */
  width: number;
}

/** Skyline plot data */
export interface SkylinePlot {
  intervals: CoalescentInterval[];
  /** Time points for plotting */
  times: number[];
  /** Ne values for plotting */
  neValues: number[];
  /** Total time span */
  timeSpan: number;
}

/** Selection pressure result */
export interface SelectionResult {
  /** Per-branch dN/dS */
  branchDnDs: Array<{ nodeId: string; dnds: number; dn: number; ds: number }>;
  /** Per-site dN/dS (averaged across tree) */
  siteDnDs?: number[];
  /** Overall tree dN/dS */
  treeDnDs: number;
}

/** Complete phylodynamics analysis result */
export interface PhylodynamicsResult {
  tree: PhylogeneticTree;
  clockRegression: ClockRegressionResult | null;
  skyline: SkylinePlot | null;
  selection: SelectionResult | null;
  selectionUnavailableReason?: string;
}

// =============================================================================
// Distance Computation
// =============================================================================

/**
 * Compute Jukes-Cantor distance between two sequences
 * JC distance: d = -3/4 * ln(1 - 4p/3) where p is proportion of differences
 */
export function jukesCantor(seq1: string, seq2: string): number {
  if (seq1.length !== seq2.length) {
    throw new Error('Sequences must have equal length');
  }

  let differences = 0;
  let validPositions = 0;

  for (let i = 0; i < seq1.length; i++) {
    const c1 = seq1[i].toUpperCase();
    const c2 = seq2[i].toUpperCase();
    // Skip gaps and ambiguous bases
    if (c1 === '-' || c2 === '-' || c1 === 'N' || c2 === 'N') continue;
    validPositions++;
    if (c1 !== c2) differences++;
  }

  if (validPositions === 0) return 0;

  const p = differences / validPositions;

  // Saturation. The correction blows up as p approaches 0.75 and is undefined
  // beyond it, so the result is capped at the same ceiling in both directions.
  //
  // Capping only the p >= 0.75 branch left the function discontinuous: p = 0.75
  // returned 3.0 while p = 0.7499 returned about 6.7, so a pair one substitution
  // short of saturation scored more than twice as distant as a pair past it.
  // Distances above the stated maximum reached UPGMA and inverted the topology.
  if (p >= 0.75) return JC_MAX_DISTANCE;

  const d = -0.75 * Math.log(1 - (4 * p) / 3);
  return Math.min(JC_MAX_DISTANCE, Math.max(0, d));
}

/**
 * Ceiling for Jukes-Cantor distance, and the value reported at saturation.
 */
export const JC_MAX_DISTANCE = 3.0;

/**
 * Mash distance between two k-mer Jaccard-similar sequences.
 *
 * Jukes-Cantor above requires ALIGNED sequences of equal length, which is why
 * this overlay previously fabricated its input: aligning 30 fetched genomes in
 * a browser is not practical, so a hash of each accession was substituted and
 * the whole tree was built on it.
 *
 * Mash distance removes the alignment requirement. Given the Jaccard
 * similarity j of two genomes' k-mer sets:
 *
 *     D = -(1/k) * ln( 2j / (1 + j) )
 *
 * which estimates the per-base substitution rate under a Poisson model of
 * mutations breaking shared k-mers (Ondov et al. 2016). It is the standard
 * alignment-free genome distance and is directly comparable to a
 * Jukes-Cantor distance for tree building.
 *
 * @param jaccard k-mer Jaccard similarity in [0,1]
 * @param k k-mer size the Jaccard was computed at
 */
export function mashDistance(jaccard: number, k: number): number {
  if (k <= 0) return 1;
  // No shared k-mers: saturated.
  //
  // Mash distance is a per-site substitution rate in [0, 1], NOT on the
  // Jukes-Cantor scale, which runs to JC_MAX_DISTANCE = 3. The two are not
  // interchangeable and an earlier comment here claimed they were. A caller
  // must build a matrix from one or the other, never a mixture, or the tree is
  // drawn on two scales at once.
  if (jaccard <= 0) return 1;
  if (jaccard >= 1) return 0;
  const d = -(1 / k) * Math.log((2 * jaccard) / (1 + jaccard));
  return Math.max(0, Math.min(1, d));
}

/**
 * Pairwise distance matrix from precomputed alignment-free similarities.
 *
 * `similarity(i, j)` returns the k-mer Jaccard of sequences i and j. Callers
 * supply it from a sketch cache, so the matrix costs O(n^2) cheap signature
 * comparisons rather than O(n^2) full sequence alignments.
 */
export function computeAlignmentFreeDistanceMatrix(
  sequences: DatedSequence[],
  similarity: (a: DatedSequence, b: DatedSequence) => number,
  k: number
): number[][] {
  const n = sequences.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = mashDistance(similarity(sequences[i], sequences[j]), k);
      matrix[i][j] = d;
      matrix[j][i] = d;
    }
  }
  return matrix;
}

/**
 * Compute pairwise genetic distance matrix for all sequence pairs
 */
export function computeGeneticDistanceMatrix(sequences: DatedSequence[]): number[][] {
  const n = sequences.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = jukesCantor(sequences[i].sequence, sequences[j].sequence);
      matrix[i][j] = d;
      matrix[j][i] = d;
    }
  }

  return matrix;
}

// =============================================================================
// UPGMA Tree Construction
// =============================================================================

interface UPGMACluster {
  id: string;
  members: number[];
  height: number;
  node: TreeNode;
}

/**
 * Build a phylogenetic tree using UPGMA (Unweighted Pair Group Method with Arithmetic Mean)
 *
 * @param sequences Sequences with dates
 * @param distances Optional precomputed pairwise distance matrix. Supply this
 *   when the sequences are NOT aligned: the default path uses Jukes-Cantor,
 *   which compares position by position and throws on unequal lengths. Records
 *   fetched from GenBank differ in start coordinate and in completeness, so the
 *   default path is wrong for them even when it does not throw. Build the
 *   matrix with `computeAlignmentFreeDistanceMatrix` instead.
 * @returns Phylogenetic tree
 */
export function buildUPGMATree(
  sequences: DatedSequence[],
  distances?: number[][]
): PhylogeneticTree {
  const n = sequences.length;
  if (n === 0) {
    throw new Error('No sequences provided');
  }
  if (n === 1) {
    const leaf: TreeNode = {
      id: sequences[0].id,
      distance: 0,
      height: 0,
      children: [],
      isLeaf: true,
      sequence: sequences[0],
    };
    return { root: leaf, leafCount: 1, height: 0, isClockCalibrated: false };
  }

  // Compute distance matrix, unless the caller supplied one.
  if (distances && (distances.length !== n || distances.some(row => row.length !== n))) {
    throw new Error(
      `Distance matrix is ${distances.length}x${distances[0]?.length ?? 0}, expected ${n}x${n}`
    );
  }
  const resolvedDistances = distances ?? computeGeneticDistanceMatrix(sequences);

  // Initialize clusters (each sequence is its own cluster)
  const clusters: UPGMACluster[] = sequences.map((seq, i) => ({
    id: seq.id,
    members: [i],
    height: 0,
    node: {
      id: seq.id,
      distance: 0,
      height: 0,
      children: [],
      isLeaf: true,
      sequence: seq,
    },
  }));

  // Working distance matrix (will be modified)
  const workDist: number[][] = resolvedDistances.map(row => [...row]);

  let nodeCounter = n;

  // UPGMA: iteratively merge closest clusters
  while (clusters.length > 1) {
    // Find minimum distance pair
    let minDist = Infinity;
    let minI = 0;
    let minJ = 1;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (workDist[i][j] < minDist) {
          minDist = workDist[i][j];
          minI = i;
          minJ = j;
        }
      }
    }

    const clusterI = clusters[minI];
    const clusterJ = clusters[minJ];

    // New cluster height is half the distance (UPGMA assumption)
    const newHeight = minDist / 2;

    // Create new internal node
    const newNodeId = `internal_${nodeCounter++}`;
    const newNode: TreeNode = {
      id: newNodeId,
      distance: 0,
      height: newHeight,
      children: [
        { ...clusterI.node, distance: newHeight - clusterI.height },
        { ...clusterJ.node, distance: newHeight - clusterJ.height },
      ],
      isLeaf: false,
    };

    // Merge clusters
    const newCluster: UPGMACluster = {
      id: newNodeId,
      members: [...clusterI.members, ...clusterJ.members],
      height: newHeight,
      node: newNode,
    };

    // Update distance matrix (average linkage)
    const newRow: number[] = [];
    for (let k = 0; k < clusters.length; k++) {
      if (k === minI || k === minJ) {
        newRow.push(0);
      } else {
        // Average distance to new cluster
        const ni = clusterI.members.length;
        const nj = clusterJ.members.length;
        const avgDist = (workDist[minI][k] * ni + workDist[minJ][k] * nj) / (ni + nj);
        newRow.push(avgDist);
      }
    }

    // Remove old clusters and add new one
    // Remove in reverse order to preserve indices
    const higher = Math.max(minI, minJ);
    const lower = Math.min(minI, minJ);
    clusters.splice(higher, 1);
    clusters.splice(lower, 1);

    // Update workDist: remove rows/cols, add new one
    workDist.splice(higher, 1);
    workDist.splice(lower, 1);
    for (const row of workDist) {
      row.splice(higher, 1);
      row.splice(lower, 1);
    }

    // Add new cluster distances
    const finalNewRow: number[] = [];
    for (let k = 0; k < clusters.length; k++) {
      const ni = clusterI.members.length;
      const nj = clusterJ.members.length;
      // Recalculate average distance
      let sum = 0;
      for (const mi of clusterI.members) {
        for (const mk of clusters[k].members) {
          sum += resolvedDistances[mi][mk];
        }
      }
      for (const mj of clusterJ.members) {
        for (const mk of clusters[k].members) {
          sum += resolvedDistances[mj][mk];
        }
      }
      finalNewRow.push(sum / ((ni + nj) * clusters[k].members.length));
    }
    finalNewRow.push(0); // Distance to self

    for (let k = 0; k < workDist.length; k++) {
      workDist[k].push(finalNewRow[k]);
    }
    workDist.push([...finalNewRow]);

    clusters.push(newCluster);
  }

  const root = clusters[0].node;
  root.distance = 0;

  return {
    root,
    leafCount: n,
    height: root.height,
    isClockCalibrated: false,
  };
}

// =============================================================================
// Molecular Clock Regression
// =============================================================================

/**
 * Collect all leaf nodes from a tree
 */
function collectLeaves(node: TreeNode): TreeNode[] {
  if (node.isLeaf) return [node];
  return node.children.flatMap(collectLeaves);
}

/**
 * Compute root-to-tip distance for a leaf
 */
function rootToTipDistance(root: TreeNode, leafId: string): number {
  function search(node: TreeNode, distance: number): number | null {
    if (node.isLeaf && node.id === leafId) {
      return distance;
    }
    for (const child of node.children) {
      const result = search(child, distance + child.distance);
      if (result !== null) return result;
    }
    return null;
  }
  return search(root, 0) ?? 0;
}

/**
 * Perform root-to-tip regression to estimate molecular clock
 *
 * @param tree Phylogenetic tree
 * @returns Clock regression result with rate and root age
 */
export function clockRegression(tree: PhylogeneticTree): ClockRegressionResult {
  const leaves = collectLeaves(tree.root);

  // Collect (date, root-to-tip distance) pairs
  const points: Array<{ id: string; date: number; distance: number }> = [];
  for (const leaf of leaves) {
    const date = leaf.sequence?.date;
    if (typeof date === 'number' && Number.isFinite(date)) {
      const d = rootToTipDistance(tree.root, leaf.id);
      points.push({ id: leaf.id, date, distance: d });
    }
  }

  if (points.length < 2) {
    return {
      rate: 0,
      rootAge: 0,
      r2: 0,
      residuals: [],
    };
  }

  // Linear regression: distance = rate * (date - rootAge)
  // Rearranged: distance = rate * date - rate * rootAge
  // So: y = slope * x + intercept where slope=rate, intercept = -rate*rootAge

  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.date, 0);
  const sumY = points.reduce((a, p) => a + p.distance, 0);
  const sumXX = points.reduce((a, p) => a + p.date * p.date, 0);
  const sumXY = points.reduce((a, p) => a + p.date * p.distance, 0);

  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-10) {
    return { rate: 0, rootAge: 0, r2: 0, residuals: [] };
  }

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const meanY = sumY / n;

  // Reject non-positive clock signals (negative slope implies no meaningful molecular clock).
  // When slope <= 0, the best constant predictor is the mean distance.
  if (!(slope > 0)) {
    const residuals: ClockRegressionResult['residuals'] = points.map((p) => ({
      id: p.id,
      observed: p.distance,
      expected: meanY,
      residual: p.distance - meanY,
    }));

    return {
      rate: 0,
      rootAge: points[0].date,
      r2: 0,
      residuals,
    };
  }

  // Rate is the slope
  const rate = slope;

  // Root age: when distance = 0, date = -intercept/slope
  const rootAge = rate > 0 ? -intercept / rate : points[0].date;

  // R² calculation
  let ssTot = 0;
  let ssRes = 0;
  const residuals: ClockRegressionResult['residuals'] = [];

  for (const p of points) {
    const predicted = rate * p.date + intercept;
    ssTot += (p.distance - meanY) ** 2;
    ssRes += (p.distance - predicted) ** 2;
    residuals.push({
      id: p.id,
      observed: p.distance,
      expected: predicted,
      residual: p.distance - predicted,
    });
  }

  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return {
    rate,
    rootAge,
    r2: Math.max(0, r2),
    residuals,
  };
}

/**
 * Calibrate tree with molecular clock
 */
export function calibrateTree(
  tree: PhylogeneticTree,
  regression: ClockRegressionResult
): PhylogeneticTree {
  if (regression.rate <= 0) {
    return { ...tree, isClockCalibrated: false };
  }

  // Convert branch lengths from substitutions to time
  function calibrateNode(node: TreeNode): TreeNode {
    const timeDistance = regression.rate > 0 ? node.distance / regression.rate : node.distance;
    return {
      ...node,
      distance: timeDistance,
      children: node.children.map(calibrateNode),
    };
  }

  const calibratedRoot = calibrateNode(tree.root);

  // Recompute heights
  function updateHeights(node: TreeNode, parentHeight: number): TreeNode {
    const height = parentHeight + node.distance;
    return {
      ...node,
      height,
      children: node.children.map(c => updateHeights(c, height)),
    };
  }

  const rootWithHeights = updateHeights(calibratedRoot, 0);

  return {
    root: rootWithHeights,
    leafCount: tree.leafCount,
    height: regression.rate > 0 ? tree.height / regression.rate : tree.height,
    isClockCalibrated: true,
    substitutionRate: regression.rate,
    clockR2: regression.r2,
  };
}

// =============================================================================
// Coalescent Skyline
// =============================================================================

/**
 * Collect coalescent event times from tree
 */
function collectCoalescentTimes(node: TreeNode): number[] {
  if (node.isLeaf) return [];
  // Internal node represents a coalescent event
  const times = [node.height];
  for (const child of node.children) {
    times.push(...collectCoalescentTimes(child));
  }
  return times;
}

/**
 * Compute coalescent skyline plot
 *
 * Uses the classic skyline estimator: Ne(t) = (k choose 2) * dt / n_coalescent
 * where k is the number of lineages and dt is the interval duration
 *
 * @param tree Clock-calibrated phylogenetic tree
 * @returns Skyline plot data
 */
export function computeSkyline(tree: PhylogeneticTree): SkylinePlot {
  // Get all coalescent times (heights of internal nodes)
  const coalescentTimes = collectCoalescentTimes(tree.root);
  coalescentTimes.sort((a, b) => a - b);

  if (coalescentTimes.length === 0) {
    return { intervals: [], times: [], neValues: [], timeSpan: 0 };
  }

  // Also need leaf times (sampling times)
  const leaves = collectLeaves(tree.root);
  const leafTimes = leaves
    .map(l => l.height)
    .sort((a, b) => a - b);

  // Combine all event times
  const allTimes = [...new Set([...coalescentTimes, ...leafTimes])].sort((a, b) => a - b);

  // Build intervals
  const intervals: CoalescentInterval[] = [];

  // Start with all lineages at present (time 0 = most recent sample)
  // Go backwards in time (increasing height)

  let currentLineages = tree.leafCount;
  const maxTime = Math.max(...allTimes);

  for (let i = 0; i < allTimes.length - 1; i++) {
    const startTime = allTimes[i];
    const endTime = allTimes[i + 1];
    const width = endTime - startTime;

    if (width <= 0) continue;

    // Check if this is a coalescent event (lineages decrease)
    const isCoalescent = coalescentTimes.includes(endTime);

    // Ne estimation: Ne = k(k-1)/2 * dt / coalescent_rate
    // For classic skyline: assume one coalescent per interval
    const k = currentLineages;
    const ne = isCoalescent && k >= 2
      ? (k * (k - 1) / 2) * width
      : (k * (k - 1) / 2) * width * 10; // No coalescent = larger Ne estimate

    intervals.push({
      startTime,
      endTime,
      lineages: currentLineages,
      ne: Math.max(1, ne),
      width,
    });

    // Update lineage count
    if (isCoalescent) {
      currentLineages = Math.max(1, currentLineages - 1);
    }
  }

  // Generate plotting arrays
  const times: number[] = [];
  const neValues: number[] = [];
  for (const interval of intervals) {
    times.push(interval.startTime);
    neValues.push(interval.ne);
    times.push(interval.endTime);
    neValues.push(interval.ne);
  }

  return {
    intervals,
    times,
    neValues,
    timeSpan: maxTime,
  };
}

// =============================================================================
// dN/dS Estimation
// =============================================================================

/** Standard genetic code for translation */
const CODON_TABLE: Record<string, string> = {
  TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L',
  CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
  ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M',
  GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
  TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S',
  CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
  ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
  GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
  TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*',
  CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
  AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
  GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
  TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W',
  CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
  AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
  GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
};

/**
 * Count synonymous and nonsynonymous differences between two codons
 * (Nei-Gojobori method, simplified)
 */
function countSynNonsyn(codon1: string, codon2: string): { syn: number; nonsyn: number } {
  if (codon1.length !== 3 || codon2.length !== 3) {
    return { syn: 0, nonsyn: 0 };
  }

  const aa1 = CODON_TABLE[codon1.toUpperCase()];
  const aa2 = CODON_TABLE[codon2.toUpperCase()];

  if (!aa1 || !aa2) return { syn: 0, nonsyn: 0 };

  // Count differences
  let diffs = 0;
  for (let i = 0; i < 3; i++) {
    if (codon1[i] !== codon2[i]) diffs++;
  }

  if (diffs === 0) return { syn: 0, nonsyn: 0 };

  // If same amino acid, all differences are synonymous
  if (aa1 === aa2) {
    return { syn: diffs, nonsyn: 0 };
  }

  // Different amino acid: all differences are nonsynonymous (simplified)
  return { syn: 0, nonsyn: diffs };
}

/**
 * Compute dN/dS between two sequences
 *
 * @param seq1 First sequence (coding region)
 * @param seq2 Second sequence (coding region)
 * @returns dN/dS ratio, or null if cannot compute
 */
export function computeDnDs(seq1: string, seq2: string): { dnds: number; dn: number; ds: number } | null {
  const len = Math.min(seq1.length, seq2.length);
  const codonLen = Math.floor(len / 3) * 3;

  if (codonLen < 3) return null;

  let totalSyn = 0;
  let totalNonsyn = 0;
  let synSites = 0;
  let nonsynSites = 0;

  for (let i = 0; i < codonLen; i += 3) {
    const codon1 = seq1.slice(i, i + 3).toUpperCase();
    const codon2 = seq2.slice(i, i + 3).toUpperCase();

    // Skip if contains gaps or N
    if (codon1.includes('-') || codon2.includes('-') ||
        codon1.includes('N') || codon2.includes('N')) {
      continue;
    }

    const { syn, nonsyn } = countSynNonsyn(codon1, codon2);
    totalSyn += syn;
    totalNonsyn += nonsyn;

    // Approximate site counts (simplified)
    synSites += 1;
    nonsynSites += 2;
  }

  if (synSites === 0 || nonsynSites === 0) return null;

  const pS = totalSyn / synSites;
  const pN = totalNonsyn / nonsynSites;

  // Jukes-Cantor correction
  const dS = pS < 0.75 ? -0.75 * Math.log(1 - 4 * pS / 3) : 1;
  const dN = pN < 0.75 ? -0.75 * Math.log(1 - 4 * pN / 3) : 1;

  const dnds = dS > 0 ? dN / dS : (dN > 0 ? Infinity : 1);

  return { dnds, dn: dN, ds: dS };
}

/**
 * Compute selection pressure across tree branches
 */
export function computeSelection(tree: PhylogeneticTree): SelectionResult {
  const branchDnDs: SelectionResult['branchDnDs'] = [];

  function processNode(node: TreeNode, parentSeq: string | null): void {
    if (node.isLeaf && node.sequence && parentSeq) {
      const result = computeDnDs(parentSeq, node.sequence.sequence);
      if (result) {
        branchDnDs.push({
          nodeId: node.id,
          dnds: result.dnds,
          dn: result.dn,
          ds: result.ds,
        });
      }
    }

    const nodeSeq = node.sequence?.sequence ?? parentSeq;
    for (const child of node.children) {
      processNode(child, nodeSeq);
    }
  }

  processNode(tree.root, null);

  // Tree-wide dN/dS
  const totalDn = branchDnDs.reduce((a, b) => a + b.dn, 0);
  const totalDs = branchDnDs.reduce((a, b) => a + b.ds, 0);
  const treeDnDs = totalDs > 0 ? totalDn / totalDs : 1;

  return {
    branchDnDs,
    treeDnDs,
  };
}

// =============================================================================
// Main Analysis Pipeline
// =============================================================================

export interface PhylodynamicsOptions {
  /** Run molecular clock analysis */
  runClock?: boolean;
  /** Run skyline analysis (requires clock) */
  runSkyline?: boolean;
  /** Run selection analysis */
  runSelection?: boolean;
  /** Caller-supplied provenance for a homologous, in-frame coding alignment. */
  codingAlignment?: { source: string; geneticCode: 1 };
  /**
   * Precomputed pairwise distances, for sequences that are not aligned.
   *
   * Without this the tree is built with Jukes-Cantor, which compares position
   * by position. Real GenBank records of the same phage differ by start
   * coordinate, so column i of one is not homologous to column i of another and
   * the resulting distances are meaningless even when the lengths happen to
   * match. Pass a matrix from `computeAlignmentFreeDistanceMatrix`.
   */
  distances?: number[][];
}

/**
 * Run complete phylodynamics analysis
 *
 * @param sequences Aligned, dated sequences
 * @param options Analysis options
 * @returns Complete analysis result
 */
export function analyzePhylodynamics(
  sequences: DatedSequence[],
  options: PhylodynamicsOptions = {}
): PhylodynamicsResult {
  const {
    runClock = true,
    runSkyline = true,
    runSelection = true,
    distances,
  } = options;

  // Build tree
  let tree = buildUPGMATree(sequences, distances);

  // Molecular clock
  let clockResult: ClockRegressionResult | null = null;
  if (runClock) {
    clockResult = clockRegression(tree);
    if (clockResult.r2 > 0.5 && clockResult.rate > 0) {
      tree = calibrateTree(tree, clockResult);
    }
  }

  // Skyline (requires clock-calibrated tree)
  let skyline: SkylinePlot | null = null;
  if (runSkyline && tree.isClockCalibrated) {
    skyline = computeSkyline(tree);
  }

  // Equal genome lengths do not establish homology or a reading frame.
  // The caller must identify a coding alignment; raw FASTA/Mash inputs do not.
  let selection: SelectionResult | null = null;
  const aligned = sequences.length >= 2 && sequences.every(s =>
    s.sequence.length === sequences[0].sequence.length && /^(?:[ACGT]{3}|---)+$/i.test(s.sequence));
  const codingAlignment = options.codingAlignment;
  const hasCodingAlignment = codingAlignment?.geneticCode === 1 && Boolean(codingAlignment.source.trim());
  const selectionUnavailableReason = runSelection && !(aligned && hasCodingAlignment)
    ? 'Selection requires an explicitly identified homologous coding alignment in frame with the standard genetic code. Equal-length raw genomes are insufficient.'
    : undefined;
  if (runSelection && aligned && hasCodingAlignment) {
    // Reconstruct ancestral sequences for internal nodes
    reconstructAncestralSequences(tree.root);
    selection = computeSelection(tree);
  }

  return {
    tree,
    clockRegression: clockResult,
    skyline,
    selection,
    selectionUnavailableReason,
  };
}

// =============================================================================
// Ancestral Sequence Reconstruction
// =============================================================================

/**
 * Compute consensus sequence from a list of sequences (Majority Vote)
 */
function computeConsensus(sequences: string[]): string {
  if (sequences.length === 0) return '';
  const len = sequences[0].length;
  let consensus = '';

  for (let i = 0; i < len; i++) {
    const counts: Record<string, number> = {};
    let maxCount = 0;
    let bestBase = sequences[0][i]; // Default to first

    for (const seq of sequences) {
      if (i >= seq.length) continue;
      const base = seq[i];
      // Skip gaps/N for consensus if possible
      if (base === '-' || base === 'N') continue;
      
      counts[base] = (counts[base] || 0) + 1;
      if (counts[base] > maxCount) {
        maxCount = counts[base];
        bestBase = base;
      }
    }
    consensus += bestBase;
  }
  return consensus;
}

/**
 * Recursively reconstruct ancestral sequences for internal nodes
 * using majority vote parsimony.
 */
function reconstructAncestralSequences(node: TreeNode): string {
  if (node.isLeaf) {
    return node.sequence?.sequence ?? '';
  }

  const childSequences = node.children.map(reconstructAncestralSequences);
  
  // Verify children have sequences
  const validChildren = childSequences.filter(s => s.length > 0);
  
  if (validChildren.length === 0) return '';

  const ancestralSeq = computeConsensus(validChildren);

  // Store reconstructed sequence in the node
  // Note: Date is unknown/estimated, but not needed for dN/dS
  node.sequence = {
    id: node.id,
    sequence: ancestralSeq,
    date: 0, // Placeholder
  };

  return ancestralSeq;
}

// =============================================================================
// Utility: Generate Demo Data
// =============================================================================

/**
 * Generate synthetic dated sequences for testing
 */
export function generateDemoPhylodynamicsData(
  numSequences = 20,
  seqLength = 300,
  timeSpan = 5,
  rng: () => number = Math.random
): DatedSequence[] {
  const bases = ['A', 'C', 'G', 'T'];

  // Generate ancestor sequence
  let ancestor = '';
  for (let i = 0; i < seqLength; i++) {
    ancestor += bases[Math.floor(rng() * 4)];
  }

  // Generate descendants with mutations over time
  const currentYear = new Date().getFullYear();
  const sequences: DatedSequence[] = [];

  for (let i = 0; i < numSequences; i++) {
    const date = currentYear - timeSpan + rng() * timeSpan;
    const timeSinceAncestor = date - (currentYear - timeSpan);

    // Mutation rate proportional to time
    const mutationProb = 0.001 * timeSinceAncestor; // ~0.1% per year

    let seq = '';
    for (let j = 0; j < seqLength; j++) {
      if (rng() < mutationProb) {
        // Mutate to different base
        const currentBase = ancestor[j];
        const otherBases = bases.filter(b => b !== currentBase);
        seq += otherBases[Math.floor(rng() * 3)];
      } else {
        seq += ancestor[j];
      }
    }

    sequences.push({
      id: `Seq_${i + 1}`,
      sequence: seq,
      date: Math.round(date * 100) / 100, // Round to 2 decimal places
      metadata: {
        location: ['USA', 'UK', 'Germany', 'Japan', 'Brazil'][Math.floor(rng() * 5)],
      },
    });
  }

  return sequences;
}
