// Amino-acid property phase portraits
// Compute sliding-window property vectors, PCA projection, and dominant property calls.

import { reconstructCdsReference, type CdsReference } from './analysis/cds-consequences';
import type { GeneInfo } from './types';

export type DominantProperty = 'hydrophobic' | 'charged' | 'aromatic' | 'flexible' | 'disordered' | 'flat';

/** Names describe the scoring rule, without inferring protein structure or function. */
export const PHASE_PROPERTY_LABELS: Record<DominantProperty, string> = {
  hydrophobic: 'Hydropathy magnitude',
  charged: 'Charge magnitude',
  aromatic: 'Aromatic fraction',
  flexible: 'Flexibility propensity',
  disordered: 'Disorder propensity',
  flat: 'No dominant score',
};

export interface PropertyVector {
  hydropathy: number;
  charge: number;
  aromaticity: number;
  flexibility: number;
  disorder: number;
}

export interface PortraitPoint extends PropertyVector {
  index: number;          // window index
  start: number;          // start position (aa)
  end: number;            // end position (aa, exclusive)
  dominant: DominantProperty;
  coord: { x: number; y: number }; // normalized 0..1 after PCA
}

export interface PhasePortraitResult {
  points: PortraitPoint[];
  explained: [number, number]; // approximate explained variance proportions
}

export interface CdsPhasePortraitInput {
  reference: CdsReference;
  /** Supported, verified CDS translation without its optional terminal stop. */
  protein: string | null;
}

/** Both interfaces analyze the same annotated transcript, never its genomic envelope. */
export function prepareCdsPhasePortraitInput(genome: string, gene: GeneInfo): CdsPhasePortraitInput {
  const reference = reconstructCdsReference(gene, genome.toUpperCase());
  if (gene.type !== 'CDS') reference.reasons.push('The selected feature is not an annotated CDS.');
  const protein = reference.reasons.length === 0 ? reference.protein?.replace(/\*$/, '') ?? null : null;
  if (protein === '') reference.reasons.push('The CDS has no translated protein residues.');
  return { reference, protein: protein || null };
}

/** Map a zero-based, half-open residue window to genomic segments in transcript order.
 * codon_start has already trimmed reference.segments. A codon may cross a join/origin;
 * noncoding gaps are never substituted for those coding bases.
 */
export function mapCdsResidueRange(reference: CdsReference, start: number, end: number): CdsReference['segments'] {
  const length = reference.protein?.replace(/\*$/, '').length ?? 0;
  if (reference.reasons.length || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end <= start || end > length) return [];
  const segments: CdsReference['segments'] = [];
  let offset = 0;
  for (const segment of reference.segments) {
    const size = segment.end - segment.start;
    const from = Math.max(0, start * 3 - offset), to = Math.min(size, end * 3 - offset);
    if (from < to) segments.push(segment.strand === '+'
      ? { start: segment.start + from, end: segment.start + to, strand: '+' }
      : { start: segment.end - to, end: segment.end - from, strand: '-' });
    offset += size;
  }
  return segments;
}

// Kyte-Doolittle hydropathy
const HYDROPATHY: Record<string, number> = {
  A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5, Q: -3.5, E: -3.5, G: -0.4,
  H: -3.2, I: 4.5, L: 3.8, K: -3.9, M: 1.9, F: 2.8, P: -1.6, S: -0.8,
  T: -0.7, W: -0.9, Y: -1.3, V: 4.2,
};

// Flexibility (normalized B-factor proxy; smaller = rigid)
const FLEXIBILITY: Record<string, number> = {
  A: 0.36, R: 0.52, N: 0.46, D: 0.51, C: 0.35, Q: 0.49, E: 0.50, G: 0.54,
  H: 0.44, I: 0.38, L: 0.39, K: 0.52, M: 0.40, F: 0.30, P: 0.51, S: 0.53,
  T: 0.44, W: 0.31, Y: 0.42, V: 0.39,
};

// Disorder propensity (rough IUPred-like scale; higher = disordered)
const DISORDER: Record<string, number> = {
  A: 0.37, R: 0.53, N: 0.63, D: 0.54, C: 0.26, Q: 0.53, E: 0.51, G: 0.67,
  H: 0.44, I: 0.32, L: 0.32, K: 0.56, M: 0.36, F: 0.29, P: 0.62, S: 0.51,
  T: 0.44, W: 0.28, Y: 0.42, V: 0.33,
};

// Compute properties for a window of amino acids
function computeVector(window: string): PropertyVector {
  if (!window.length) {
    return { hydropathy: 0, charge: 0, aromaticity: 0, flexibility: 0, disorder: 0 };
  }

  let hyd = 0;
  let charge = 0;
  let aromatic = 0;
  let flex = 0;
  let disorder = 0;

  for (const aa of window) {
    const upper = aa.toUpperCase();
    hyd += HYDROPATHY[upper] ?? 0;
    if (upper === 'K' || upper === 'R') charge += 1;
    else if (upper === 'D' || upper === 'E') charge -= 1;
    if (upper === 'F' || upper === 'W' || upper === 'Y') aromatic += 1;
    flex += FLEXIBILITY[upper] ?? 0.4;
    disorder += DISORDER[upper] ?? 0.4;
  }

  const len = window.length;
  return {
    hydropathy: hyd / len,
    charge: charge / len,
    aromaticity: aromatic / len,
    flexibility: flex / len,
    disorder: disorder / len,
  };
}

// Dominant property call for visualization
function dominantProperty(v: PropertyVector): DominantProperty {
  const scored: Array<{ key: DominantProperty; value: number }> = [
    { key: 'hydrophobic', value: Math.abs(v.hydropathy) },
    { key: 'charged', value: Math.abs(v.charge) },
    { key: 'aromatic', value: v.aromaticity },
    { key: 'flexible', value: v.flexibility },
    { key: 'disordered', value: v.disorder },
  ];
  scored.sort((a, b) => b.value - a.value);
  return scored[0].value === 0 ? 'flat' : scored[0].key;
}

// Basic covariance of centered matrix (rows = samples, cols = dims)
function covariance(matrix: number[][]): number[][] {
  const n = matrix.length;
  const d = matrix[0].length;
  const cov = Array.from({ length: d }, () => Array(d).fill(0));
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < d; r++) {
      for (let c = 0; c < d; c++) {
        cov[r][c] += matrix[i][r] * matrix[i][c];
      }
    }
  }
  const denom = Math.max(1, n - 1);
  for (let r = 0; r < d; r++) {
    for (let c = 0; c < d; c++) {
      cov[r][c] /= denom;
    }
  }
  return cov;
}

// Power iteration to get leading eigenvector/value
function powerIteration(mat: number[][], iters = 40): { vector: number[]; value: number } {
  const n = mat.length;
  // Initialize with deterministic vector (matches Rust implementation logic)
  let v = Array.from({ length: n }, (_, i) => ((i * 7919 + 104729) % 1000) / 1000.0 - 0.5);
  const normInit = Math.hypot(...v) || 1;
  v = v.map(x => x / normInit);

  const mv = () => mat.map(row => row.reduce((acc, val, idx) => acc + val * v[idx], 0));

  for (let i = 0; i < iters; i++) {
    const w = mv();
    const norm = Math.hypot(...w) || 1;
    v = w.map(x => x / norm);
  }

  // Canonicalize sign: make largest element positive
  let maxAbs = -1;
  let maxIdx = -1;
  v.forEach((val, i) => {
      if (Math.abs(val) > maxAbs) {
          maxAbs = Math.abs(val);
          maxIdx = i;
      }
  });
  if (maxIdx >= 0 && v[maxIdx] < 0) {
      v = v.map(x => -x);
  }

  const Av = mv();
  const value = v.reduce((sum, vi, idx) => sum + vi * Av[idx], 0);
  return { vector: v, value };
}

// Project centered data onto eigenvectors (top 2)
function project(matrix: number[][], eig1: number[], eig2: number[]): { coords: { x: number; y: number }[] } {
  const coords = matrix.map(row => ({
    x: row.reduce((acc, val, idx) => acc + val * eig1[idx], 0),
    y: row.reduce((acc, val, idx) => acc + val * eig2[idx], 0),
  }));

  // Normalize to 0..1 for plotting, preserving aspect ratio
  const xs = coords.map(c => c.x);
  const ys = coords.map(c => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const maxSpan = Math.max(spanX, spanY);

  const normalized = coords.map(c => ({
    x: (c.x - minX) / maxSpan + (maxSpan - spanX) / (2 * maxSpan), // Center horizontally if narrower
    y: (c.y - minY) / maxSpan + (maxSpan - spanY) / (2 * maxSpan), // Center vertically if shorter
  }));

  return { coords: normalized };
}

export function computePhasePortrait(aaSequence: string, window = 30, step = 5): PhasePortraitResult {
  if (!Number.isSafeInteger(window) || window < 1 || !Number.isSafeInteger(step) || step < 1) {
    throw new Error('Phase portrait window and step must be positive integers.');
  }
  if (/[^ACDEFGHIKLMNPQRSTVWY]/i.test(aaSequence)) {
    throw new Error('Phase portraits require a supported protein sequence without stops or unresolved residues.');
  }
  if (!aaSequence || aaSequence.length < window) {
    return { points: [], explained: [0, 0] };
  }

  const vectors: PropertyVector[] = [];
  const starts: number[] = [];
  for (let i = 0; i <= Math.max(0, aaSequence.length - window); i += step) {
    const slice = aaSequence.slice(i, i + window);
    vectors.push(computeVector(slice));
    starts.push(i);
  }

  if (vectors.length === 0) {
    return { points: [], explained: [0, 0] };
  }

  // Matrix of centered vectors
  const means = ['hydropathy', 'charge', 'aromaticity', 'flexibility', 'disorder'].map((key) =>
    vectors.reduce((sum, v) => sum + (v as any)[key], 0) / vectors.length
  );

  const centered = vectors.map(v => [
    v.hydropathy - means[0],
    v.charge - means[1],
    v.aromaticity - means[2],
    v.flexibility - means[3],
    v.disorder - means[4],
  ]);

  const cov = covariance(centered);
  
  // Calculate total variance (trace)
  const totalVariance = cov.reduce((sum, row, i) => sum + row[i], 0);
  const safeTotalVar = Math.max(1e-9, totalVariance);

  const { vector: eig1, value: val1 } = powerIteration(cov);

  // Deflate matrix for second eigenvector
  const covDeflated = cov.map((row, r) =>
    row.map((c, colIdx) => c - val1 * eig1[r] * eig1[colIdx])
  );
  const { vector: eig2, value: val2 } = powerIteration(covDeflated);

  const { coords } = project(centered, eig1, eig2);
  const explained: [number, number] = [Math.abs(val1) / safeTotalVar, Math.abs(val2) / safeTotalVar];

  const points: PortraitPoint[] = vectors.map((v, idx) => ({
    ...v,
    index: idx,
    start: starts[idx],
    end: Math.min(aaSequence.length, starts[idx] + window),
    dominant: dominantProperty(v),
    coord: coords[idx],
  }));

  return { points, explained };
}
