/**
 * Codon Usage Bias Analysis
 *
 * Computes Relative Synonymous Codon Usage (RSCU) and other codon bias
 * metrics for understanding translational selection in phage genomes.
 */

import { countCodonUsage } from '../codons';

// All 64 codons organized by amino acid
export const CODON_FAMILIES: Record<string, string[]> = {
  F: ['TTT', 'TTC'],
  L: ['TTA', 'TTG', 'CTT', 'CTC', 'CTA', 'CTG'],
  I: ['ATT', 'ATC', 'ATA'],
  M: ['ATG'],
  V: ['GTT', 'GTC', 'GTA', 'GTG'],
  S: ['TCT', 'TCC', 'TCA', 'TCG', 'AGT', 'AGC'],
  P: ['CCT', 'CCC', 'CCA', 'CCG'],
  T: ['ACT', 'ACC', 'ACA', 'ACG'],
  A: ['GCT', 'GCC', 'GCA', 'GCG'],
  Y: ['TAT', 'TAC'],
  H: ['CAT', 'CAC'],
  Q: ['CAA', 'CAG'],
  N: ['AAT', 'AAC'],
  K: ['AAA', 'AAG'],
  D: ['GAT', 'GAC'],
  E: ['GAA', 'GAG'],
  C: ['TGT', 'TGC'],
  W: ['TGG'],
  R: ['CGT', 'CGC', 'CGA', 'CGG', 'AGA', 'AGG'],
  G: ['GGT', 'GGC', 'GGA', 'GGG'],
  '*': ['TAA', 'TAG', 'TGA'], // Stop codons
};

// Amino acid to codon family lookup
export const AMINO_ACID_CODONS = Object.entries(CODON_FAMILIES).reduce(
  (acc, [aa, codons]) => {
    for (const codon of codons) {
      acc[codon] = { aminoAcid: aa, familySize: codons.length };
    }
    return acc;
  },
  {} as Record<string, { aminoAcid: string; familySize: number }>
);

export interface RSCUResult {
  codon: string;
  aminoAcid: string;
  count: number;
  rscu: number; // Relative Synonymous Codon Usage
  frequency: number; // Relative frequency within amino acid family
  isPreferred: boolean; // Above 1.0 RSCU
  familySize: number; // Number of synonymous codons
}

export interface CodonBiasAnalysis {
  rscu: RSCUResult[];
  totalCodons: number;
  gcContent: number;
  gc3Content: number; // GC at third codon position
  effectiveNumberOfCodons: number; // Nc metric
  preferredCodons: string[]; // Codons with RSCU > 1.5
  avoidedCodons: string[]; // Codons with RSCU < 0.5
  biasScore: number; // 0-1, higher = more biased
}

/**
 * Compute Relative Synonymous Codon Usage (RSCU)
 *
 * RSCU = (observed count) / (expected count if uniform)
 * Expected = (total for amino acid) / (number of synonymous codons)
 *
 * RSCU = 1.0 means codon is used as expected
 * RSCU > 1.0 means codon is preferred
 * RSCU < 1.0 means codon is avoided
 */
export function computeRSCU(codonCounts: Record<string, number>): RSCUResult[] {
  const results: RSCUResult[] = [];

  // Calculate total counts per amino acid family
  const familyTotals: Record<string, number> = {};
  for (const [aa, codons] of Object.entries(CODON_FAMILIES)) {
    familyTotals[aa] = codons.reduce((sum, codon) => sum + (codonCounts[codon] || 0), 0);
  }

  // Calculate RSCU for each codon
  for (const [aa, codons] of Object.entries(CODON_FAMILIES)) {
    const familyTotal = familyTotals[aa];
    const familySize = codons.length;

    for (const codon of codons) {
      const count = codonCounts[codon] || 0;

      // Expected count if all synonymous codons used equally
      const expected = familyTotal / familySize;

      // RSCU = observed / expected (handle division by zero)
      const rscu = expected > 0 ? count / expected : 0;

      // Frequency within family
      const frequency = familyTotal > 0 ? count / familyTotal : 0;

      results.push({
        codon,
        aminoAcid: aa,
        count,
        rscu,
        frequency,
        isPreferred: rscu > 1.0,
        familySize,
      });
    }
  }

  return results;
}

/**
 * Compute GC content at third codon position (GC3)
 * This is a strong indicator of mutational pressure vs selection
 */
export function computeGC3(sequence: string): number {
  const seq = sequence.toUpperCase();
  let gc3 = 0;
  let total = 0;

  // Process complete codons
  for (let i = 0; i + 3 <= seq.length; i += 3) {
    const thirdBase = seq[i + 2];
    // Exclude unknown third positions without shifting the frame.
    if (!'ACGT'.includes(thirdBase)) continue;
    if (thirdBase === 'G' || thirdBase === 'C') {
      gc3++;
    }
    total++;
  }

  return total > 0 ? gc3 / total : 0;
}

/**
 * Compute Effective Number of Codons (Nc)
 * Lower values (closer to 20) indicate stronger codon bias
 * Higher values (closer to 61) indicate more uniform usage
 *
 * Simplified Wright (1990) method
 */
export function computeEffectiveNumberOfCodons(
  rscu: RSCUResult[]
): number {
  // Group by amino acid family
  const families: Record<string, RSCUResult[]> = {};
  for (const r of rscu) {
    if (!families[r.aminoAcid]) families[r.aminoAcid] = [];
    families[r.aminoAcid].push(r);
  }

  let F2 = 0, F3 = 0, F4 = 0, F6 = 0;
  let n2 = 0, n3 = 0, n4 = 0, n6 = 0;

  for (const [aa, codons] of Object.entries(families)) {
    if (aa === '*' || aa === 'M' || aa === 'W') continue; // Skip stop, Met, Trp

    const n = codons.reduce((sum, c) => sum + c.count, 0);
    if (n <= 1) continue;

    // Calculate F = Σ(p_i^2) for this family
    let sumPSq = 0;
    for (const c of codons) {
      const p = c.count / n;
      sumPSq += p * p;
    }

    // Homozygosity corrected: F = (n*Σp² - 1) / (n - 1)
    const F = (n * sumPSq - 1) / (n - 1);
    const familySize = codons.length;

    if (familySize === 2) { F2 += F; n2++; }
    else if (familySize === 3) { F3 += F; n3++; }
    else if (familySize === 4) { F4 += F; n4++; }
    else if (familySize === 6) { F6 += F; n6++; }
  }

  // Average F values per family size
  const avgF2 = n2 > 0 ? F2 / n2 : 0.5;
  const avgF3 = n3 > 0 ? F3 / n3 : 0.333;
  const avgF4 = n4 > 0 ? F4 / n4 : 0.25;
  const avgF6 = n6 > 0 ? F6 / n6 : 0.167;

  // Nc = 2 + 9/F2 + 1/F3 + 5/F4 + 3/F6 (for standard genetic code)
  // Handle zeros by using expected uniform values
  const Nc = 2 +
    (avgF2 > 0 ? 9 / avgF2 : 18) +
    (avgF3 > 0 ? 1 / avgF3 : 3) +
    (avgF4 > 0 ? 5 / avgF4 : 20) +
    (avgF6 > 0 ? 3 / avgF6 : 18);

  // Clamp to valid range [20, 61]
  return Math.max(20, Math.min(61, Nc));
}

/**
 * Full codon bias analysis
 */
export function analyzeCodonBias(sequence: string): CodonBiasAnalysis {
  // Get codon counts
  const codonCounts = countCodonUsage(sequence, 0);

  // Compute RSCU
  const rscu = computeRSCU(codonCounts);

  // Calculate totals
  const totalCodons = rscu.reduce((sum, r) => sum + r.count, 0);

  // GC content
  const seq = sequence.toUpperCase().replace(/[^ACGT]/g, '');
  const gcCount = (seq.match(/[GC]/g) || []).length;
  const gcContent = seq.length > 0 ? gcCount / seq.length : 0;

  // GC3 content
  const gc3Content = computeGC3(sequence);

  // Effective number of codons
  const effectiveNumberOfCodons = computeEffectiveNumberOfCodons(rscu);

  // Find preferred and avoided codons (exclude singletons Met, Trp)
  const preferredCodons = rscu
    .filter(r => r.rscu > 1.5 && r.familySize > 1 && r.count >= 5)
    .map(r => r.codon);

  const avoidedCodons = rscu
    .filter(r => r.rscu < 0.5 && r.familySize > 1)
    .map(r => r.codon);

  // Bias score: 1 - (Nc - 20) / 41
  // Closer to 1 = more biased, closer to 0 = more uniform
  const biasScore = 1 - (effectiveNumberOfCodons - 20) / 41;

  return {
    rscu,
    totalCodons,
    gcContent,
    gc3Content,
    effectiveNumberOfCodons,
    preferredCodons,
    avoidedCodons,
    biasScore: Math.max(0, Math.min(1, biasScore)),
  };
}

/**
 * Get codon bias per gene/window
 */
export function analyzeCodonBiasPerWindow(
  sequence: string,
  windowSize: number = 1000,
  stepSize: number = 500
): Array<{ start: number; end: number; bias: CodonBiasAnalysis }> {
  const results: Array<{ start: number; end: number; bias: CodonBiasAnalysis }> = [];

  for (let start = 0; start + windowSize <= sequence.length; start += stepSize) {
    const window = sequence.slice(start, start + windowSize);
    const bias = analyzeCodonBias(window);
    results.push({ start, end: start + windowSize, bias });
  }

  return results;
}

/**
 * Compare codon usage between two sequences
 */
export function compareCodonUsage(
  seq1: string,
  seq2: string
): { codon: string; rscu1: number; rscu2: number; delta: number }[] {
  const bias1 = analyzeCodonBias(seq1);
  const bias2 = analyzeCodonBias(seq2);

  const rscuMap1 = new Map(bias1.rscu.map(r => [r.codon, r.rscu]));
  const rscuMap2 = new Map(bias2.rscu.map(r => [r.codon, r.rscu]));

  return bias1.rscu.map(r => ({
    codon: r.codon,
    rscu1: rscuMap1.get(r.codon) || 0,
    rscu2: rscuMap2.get(r.codon) || 0,
    delta: (rscuMap1.get(r.codon) || 0) - (rscuMap2.get(r.codon) || 0),
  }));
}
