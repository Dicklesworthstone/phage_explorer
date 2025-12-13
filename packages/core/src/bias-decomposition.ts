// Dinucleotide & codon bias decomposition utilities (lightweight PCA/NMF style)
// Provides frequency extraction and small-matrix PCA for text-only visualization.

const DINUCLEOTIDES = [
  'AA', 'AC', 'AG', 'AT',
  'CA', 'CC', 'CG', 'CT',
  'GA', 'GC', 'GG', 'GT',
  'TA', 'TC', 'TG', 'TT',
] as const;

export type Dinucleotide = typeof DINUCLEOTIDES[number];

export interface BiasComponent {
  id: number;
  loadings: number[];       // per-feature weights (length = 16)
  explained: number;        // fraction of variance
}

export interface BiasProjection {
  name: string;
  coords: [number, number]; // PC1/PC2 coordinates
}

export interface BiasDecomposition {
  components: [BiasComponent, BiasComponent];
  projections: BiasProjection[];
  means: number[];
}

const BASES = ['A', 'C', 'G', 'T'];
const CODONS: string[] = [];
for (const a of BASES) for (const b of BASES) for (const c of BASES) CODONS.push(a + b + c);

export { CODONS };

// Codon frequency vector (64 codons) for future extension
export function computeCodonFrequencies(seq: string): number[] {
  const upper = seq.toUpperCase();
  const counts: Record<string, number> = {};
  let total = 0;
  for (let i = 0; i + 3 <= upper.length; i += 3) {
    const codon = upper.slice(i, i + 3);
    if (!/^[ACGT]{3}$/.test(codon)) continue;
    counts[codon] = (counts[codon] ?? 0) + 1;
    total++;
  }
  return CODONS.map(c => (counts[c] ?? 0) / Math.max(1, total));
}

// Compute 16-element dinucleotide frequency vector (normalized)
export function computeDinucleotideFrequencies(seq: string): number[] {
  const upper = seq.toUpperCase();
  const counts = Array(16).fill(0);
  let total = 0;

  for (let i = 0; i < upper.length - 1; i++) {
    const a = upper[i];
    const b = upper[i + 1];
    if (!'ACGT'.includes(a) || !'ACGT'.includes(b)) continue;
    const key = (a + b) as Dinucleotide;
    const idx = DINUCLEOTIDES.indexOf(key);
    if (idx >= 0) {
      counts[idx] += 1;
      total += 1;
    }
  }

  if (total === 0) return counts;
  return counts.map(c => c / total);
}

// Center matrix rows by feature mean
function centerMatrix(rows: number[][]): { centered: number[][]; means: number[] } {
  if (rows.length === 0) return { centered: [], means: [] };
  const dims = rows[0].length;
  const means = Array(dims).fill(0);
  for (const r of rows) {
    for (let i = 0; i < dims; i++) means[i] += r[i];
  }
  for (let i = 0; i < dims; i++) means[i] /= rows.length;

  const centered = rows.map(r => r.map((v, i) => v - means[i]));
  return { centered, means };
}

// Covariance matrix (rows = samples, cols = features)
function covariance(centered: number[][]): number[][] {
  const n = centered.length;
  if (n === 0) return [];
  const d = centered[0].length;
  const cov = Array.from({ length: d }, () => Array(d).fill(0));
  for (const row of centered) {
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        cov[i][j] += row[i] * row[j];
      }
    }
  }
  const denom = Math.max(1, n - 1);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      cov[i][j] /= denom;
    }
  }
  return cov;
}

// Power iteration for top eigenvector/value
function powerIteration(mat: number[][], iters = 64): { vec: number[]; val: number } {
  const n = mat.length;
  // Initialize with random vector
  let v = Array.from({ length: n }, () => Math.random() - 0.5);
  const normInit = Math.hypot(...v) || 1;
  v = v.map(x => x / normInit);

  const mv = (vector: number[]) => mat.map(row => row.reduce((sum, val, idx) => sum + val * vector[idx], 0));

  for (let i = 0; i < iters; i++) {
    const w = mv(v);
    const norm = Math.hypot(...w) || 1;
    v = w.map(x => x / norm);
  }

  const Av = mv(v);
  const val = v.reduce((sum, vi, idx) => sum + vi * Av[idx], 0);
  return { vec: v, val };
}

// Project rows onto two principal components
function project2(centered: number[][], pc1: number[], pc2: number[]): [number, number][] {
  return centered.map(row => {
    const x = row.reduce((s, v, i) => s + v * pc1[i], 0);
    const y = row.reduce((s, v, i) => s + v * pc2[i], 0);
    return [x, y];
  });
}

// Compute two-component PCA for dinucleotide bias vectors
export function decomposeBias(
  rows: Array<{ name: string; vector: number[] }>
): BiasDecomposition | null {
  if (rows.length < 2) return null;
  const matrix = rows.map(r => r.vector);
  const { centered, means } = centerMatrix(matrix);
  const cov = covariance(centered);

  const { vec: pc1, val: val1 } = powerIteration(cov);
  // Deflate for PC2
  const covDeflated = cov.map((row, i) =>
    row.map((c, j) => c - val1 * pc1[i] * pc1[j])
  );
  const { vec: pc2, val: val2 } = powerIteration(covDeflated);

  const coords = project2(centered, pc1, pc2);
  // Total variance = trace of covariance matrix (sum of eigenvalues)
  const totalVar = cov.reduce((sum, row, i) => sum + row[i], 0);
  const safeTotalVar = Math.max(1e-9, totalVar);

  return {
    components: [
      { id: 1, loadings: pc1, explained: Math.abs(val1) / safeTotalVar },
      { id: 2, loadings: pc2, explained: Math.abs(val2) / safeTotalVar },
    ],
    projections: rows.map((r, i) => ({ name: r.name, coords: coords[i] })),
    means,
  };
}

export { DINUCLEOTIDES };
