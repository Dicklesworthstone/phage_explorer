import { translateCodon, CODON_TABLE } from '../codons';

export interface SelectionWindow {
  start: number;
  end: number;
  dN: number;
  dS: number;
  omega: number; // dN/dS
  classification: 'purifying' | 'neutral' | 'positive' | 'unknown';
}

export interface SelectionAnalysis {
  windows: SelectionWindow[];
  globalOmega: number;
}

// Helper to count synonymous and non-synonymous sites for a codon
function countSites(codon: string): { syn: number; nonSyn: number } {
  const bases = ['A', 'C', 'G', 'T'];
  let syn = 0;
  let nonSyn = 0;
  const aa = CODON_TABLE[codon];

  if (!aa || aa === '*') return { syn: 0, nonSyn: 0 }; // Skip stop/unknown

  for (let pos = 0; pos < 3; pos++) {
    const originalBase = codon[pos];
    for (const base of bases) {
      if (base === originalBase) continue;
      const mutatedCodon = codon.slice(0, pos) + base + codon.slice(pos + 1);
      const mutatedAA = CODON_TABLE[mutatedCodon];
      if (mutatedAA === aa) syn++;
      else nonSyn++;
    }
  }
  // Normalize: each position has 3 mutations. Total = 9.
  // This is a simplified counting method (Nei-Gojobori approximate)
  return { syn: syn / 3, nonSyn: nonSyn / 3 };
}

// Simplified dN/dS estimator
// Requires aligned sequences, but we'll implement a windowed version comparing against a "consensus" or just hypothetical
// Since we don't have a multiple sequence alignment handy in the single-genome view,
// we will implement a "Codon Volatility" metric or similar proxy if single sequence.
// However, the prompt says "Requires comparison phage".
// So this function expects TWO aligned sequences.

export function calculateSelectionPressure(
  seqA: string,
  seqB: string,
  windowSize = 150
): SelectionAnalysis {
  // Naive alignment check: must be same length
  const len = Math.min(seqA.length, seqB.length);
  const windows: SelectionWindow[] = [];
  let totalDN = 0;
  let totalDS = 0;
  let validWindows = 0;

  // Process in codon windows
  for (let i = 0; i < len - windowSize; i += windowSize) {
    // Adjust to codon boundary
    const start = i - (i % 3);
    const end = Math.min(len, start + windowSize);
    
    let Sd = 0; // Synonymous differences
    let Nd = 0; // Non-synonymous differences
    let S_sites = 0; // Synonymous sites
    let N_sites = 0; // Non-synonymous sites

    for (let j = start; j < end - 3; j += 3) {
      const codonA = seqA.slice(j, j + 3).toUpperCase();
      const codonB = seqB.slice(j, j + 3).toUpperCase();

      if (codonA.length < 3 || codonB.length < 3) continue;
      if (codonA.includes('N') || codonB.includes('N')) continue;

      // Estimate sites (average of both)
      const sitesA = countSites(codonA);
      const sitesB = countSites(codonB);
      const S_site_avg = (sitesA.syn + sitesB.syn) / 2;
      const N_site_avg = (sitesA.nonSyn + sitesB.nonSyn) / 2;

      S_sites += S_site_avg;
      N_sites += N_site_avg;

      // Compare
      if (codonA !== codonB) {
        const aaA = translateCodon(codonA);
        const aaB = translateCodon(codonB);
        
        // Simply count diffs (simplified, ignores multiple mutations per codon path)
        // Hamming distance for codon bases
        let diffs = 0;
        if (codonA[0] !== codonB[0]) diffs++;
        if (codonA[1] !== codonB[1]) diffs++;
        if (codonA[2] !== codonB[2]) diffs++;

        if (aaA === aaB) {
          Sd += diffs; // All changes synonymous
        } else {
          Nd += diffs; // Assume non-synonymous (simplification)
        }
      }
    }

    // Jukes-Cantor correction (simplified)
    const pN = N_sites > 0 ? Nd / N_sites : 0;
    const pS = S_sites > 0 ? Sd / S_sites : 0;

    // Avoid log(0)
    const dN = pN < 0.75 ? -0.75 * Math.log(1 - 4 * pN / 3) : pN;
    const dS = pS < 0.75 ? -0.75 * Math.log(1 - 4 * pS / 3) : pS;

    let omega = 1.0;
    let classification: SelectionWindow['classification'] = 'neutral';

    if (dS > 0) {
      omega = dN / dS;
      if (omega < 0.5) classification = 'purifying';
      else if (omega > 1.5) classification = 'positive';
    } else if (dN > 0) {
      omega = 10.0; // Infinite/High
      classification = 'positive';
    } else {
      omega = 1.0; // No changes
      classification = 'unknown';
    }

    if (S_sites > 0 && N_sites > 0) {
        windows.push({
            start,
            end,
            dN,
            dS,
            omega,
            classification
        });
        totalDN += dN;
        totalDS += dS;
        validWindows++;
    }
  }

  const globalOmega = (totalDS > 0 && validWindows > 0) ? (totalDN / totalDS) : 1.0;

  return {
    windows,
    globalOmega
  };
}
