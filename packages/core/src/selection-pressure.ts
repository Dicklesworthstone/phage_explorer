import { translateCodon, CODON_TABLE } from './codons';

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

// Memoize site counts for all 64 codons
const SITE_COUNTS_CACHE = new Map<string, { syn: number; nonSyn: number }>();

// Helper to count synonymous and non-synonymous sites for a codon
function countSites(codon: string): { syn: number; nonSyn: number } {
  const cached = SITE_COUNTS_CACHE.get(codon);
  if (cached) return cached;

  const bases = ['A', 'C', 'G', 'T'];
  let syn = 0;
  let nonSyn = 0;
  const aa = CODON_TABLE[codon];

  if (!aa || aa === '*') {
    const result = { syn: 0, nonSyn: 0 };
    SITE_COUNTS_CACHE.set(codon, result);
    return result;
  }

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
  const result = { syn: syn / 3, nonSyn: nonSyn / 3 };
  SITE_COUNTS_CACHE.set(codon, result);
  return result;
}

// Simplified dN/dS estimator
export function calculateSelectionPressure(
  seqA: string,
  seqB: string,
  windowSize = 150
): SelectionAnalysis {
  const len = Math.min(seqA.length, seqB.length);
  if (len < 3) {
    return { windows: [], globalOmega: 1.0 };
  }

  // Align window to codons
  let effectiveWindow = Math.max(3, Math.min(windowSize, len));
  effectiveWindow -= (effectiveWindow % 3);
  
  const windows: SelectionWindow[] = [];
  let totalDN = 0;
  let totalDS = 0;
  let validWindows = 0;

  // Process in codon windows
  for (let i = 0; i < len; i += effectiveWindow) {
    const start = i;
    const end = Math.min(len, start + effectiveWindow);
    
    // Skip if remainder is too small for a codon
    if (end - start < 3) break;
    
    let Sd = 0; // Synonymous differences
    let Nd = 0; // Non-synonymous differences
    let S_sites = 0; // Synonymous sites
    let N_sites = 0; // Non-synonymous sites

    for (let j = start; j < end; j += 3) {
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
        
        // Count differences per position
        for (let pos = 0; pos < 3; pos++) {
          if (codonA[pos] !== codonB[pos]) {
             // Create a hypothetical intermediate codon with just this single base change
             const mutantCodon = codonA.slice(0, pos) + codonB[pos] + codonA.slice(pos + 1);
             const mutantAA = translateCodon(mutantCodon);
             
             if (mutantAA === aaA) {
               Sd++;
             } else {
               Nd++;
             }
          }
        }
      }
    }

    // Jukes-Cantor correction (simplified)
    // Clamp proportions to < 0.75 to avoid log domain errors
    const pN = N_sites > 0 ? Math.min(0.74, Nd / N_sites) : 0;
    const pS = S_sites > 0 ? Math.min(0.74, Sd / S_sites) : 0;

    const dN = -0.75 * Math.log(1 - 4 * pN / 3);
    const dS = -0.75 * Math.log(1 - 4 * pS / 3);

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
