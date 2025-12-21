/**
 * Restriction Digest Logic
 *
 * Simulates digestion of DNA by restriction enzymes.
 * Handles linear and circular genomes.
 */

import { type RestrictionEnzyme, expandSiteRegex } from '../data/restriction-enzymes';

export interface DigestFragment {
  start: number;
  end: number;
  length: number;
  sequence: string; // Optional, might be heavy
}

export interface DigestResult {
  enzyme: string;
  fragments: DigestFragment[];
  cutSites: number[];
}

/**
 * Digest a genome with a single enzyme
 */
export function digestGenome(
  sequence: string,
  enzyme: RestrictionEnzyme,
  isCircular = false
): DigestResult {
  const seq = sequence.toUpperCase();
  const regex = expandSiteRegex(enzyme.site);
  const cutSites: number[] = [];
  let match;

  // Find all matches
  while ((match = regex.exec(seq)) !== null) {
    const cutPos = match.index + enzyme.cutOffset;
    if (cutPos >= 0 && cutPos <= seq.length) {
      cutSites.push(cutPos);
    }
  }

  if (cutSites.length === 0) {
    return {
      enzyme: enzyme.name,
      fragments: [{ start: 0, end: seq.length, length: seq.length, sequence: seq }],
      cutSites: [],
    };
  }

  const fragments: DigestFragment[] = [];
  
  // If circular, we might wrap around
  // Sort cut sites just in case (though regex exec is ordered)
  cutSites.sort((a, b) => a - b);

  for (let i = 0; i < cutSites.length - 1; i++) {
    const start = cutSites[i];
    const end = cutSites[i + 1];
    fragments.push({
      start,
      end,
      length: end - start,
      sequence: seq.slice(start, end),
    });
  }

  // Handle ends
  if (isCircular) {
    // Circular: Last fragment wraps from last cut to first cut
    const lastStart = cutSites[cutSites.length - 1];
    const firstEnd = cutSites[0];
    const length = (seq.length - lastStart) + firstEnd;
    // Note: Sequence construction for wrap-around
    fragments.push({
      start: lastStart,
      end: firstEnd,
      length,
      sequence: seq.slice(lastStart) + seq.slice(0, firstEnd),
    });
  } else {
    // Linear: First fragment (0 to first cut) and Last fragment (last cut to end)
    if (cutSites[0] > 0) {
      fragments.unshift({
        start: 0,
        end: cutSites[0],
        length: cutSites[0],
        sequence: seq.slice(0, cutSites[0]),
      });
    }
    const lastCut = cutSites[cutSites.length - 1];
    if (lastCut < seq.length) {
      fragments.push({
        start: lastCut,
        end: seq.length,
        length: seq.length - lastCut,
        sequence: seq.slice(lastCut),
      });
    }
  }

  // Sort fragments by length (descending) for gel visualization
  fragments.sort((a, b) => b.length - a.length);

  return {
    enzyme: enzyme.name,
    fragments,
    cutSites,
  };
}

/**
 * Compute band migration distance
 * Ogston model approximation: d ~ 1/log(L)
 * Simplified: d = 100 - k * log10(L)
 */
export function calculateMigration(length: number, maxRun = 100): number {
  // Map 20kb -> 5%, 100bp -> 95%
  // log10(20000) = 4.3
  // log10(100) = 2
  // d = m * log(L) + c
  // 5 = m * 4.3 + c
  // 95 = m * 2 + c
  // -90 = m * 2.3 => m = -39.1
  // 95 = -39.1 * 2 + c => c = 173.2
  // d = 173.2 - 39.1 * log10(L)
  
  if (length <= 0) return maxRun;
  const logL = Math.log10(length);
  const dist = 173.2 - 39.1 * logL;
  return Math.max(0, Math.min(maxRun, dist));
}
