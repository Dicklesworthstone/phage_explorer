// Dinucleotide & codon bias decomposition utilities (lightweight PCA/NMF style)
// Provides frequency extraction and small-matrix PCA for text-only visualization.

import { computeMatrixPCA } from './analysis/pca';

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
  const decomposition = computeMatrixPCA(matrix, { numComponents: 2 });
  const means = Array.from(decomposition.mean);
  const centered = matrix.map(row => row.map((value, j) => value - means[j]));
  const pc1 = Array.from(decomposition.loadings[0]);
  const pc2 = Array.from(decomposition.loadings[1] ?? new Float64Array(means.length));
  const coords = project2(centered, pc1, pc2);
  const explained = (i: number) => decomposition.totalVariance > 0
    ? (decomposition.eigenvalues[i] ?? 0) / decomposition.totalVariance : 0;

  return {
    components: [
      { id: 1, loadings: pc1, explained: explained(0) },
      { id: 2, loadings: pc2, explained: explained(1) },
    ],
    projections: rows.map((r, i) => ({ name: r.name, coords: coords[i] })),
    means,
  };
}

export { DINUCLEOTIDES };
