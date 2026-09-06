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
 * Definite cuts on the supplied strand for the catalog's palindromic sites.
 * Coordinates are boundaries between bases, in [0, length] for linear DNA and
 * [0, length) for circular DNA. Unresolved sequence bases do not imply a cut.
 */
export function findRestrictionCutSites(
  sequence: string,
  enzyme: RestrictionEnzyme,
  isCircular = false
): number[] {
  if (!enzyme.site || !/^[ACGTRYSWKMBDHVN]+$/i.test(enzyme.site) || !Number.isInteger(enzyme.cutOffset)) {
    throw new RangeError('A restriction enzyme needs an IUPAC recognition site and an integer cut offset');
  }
  const seq = sequence.toUpperCase();
  if (seq.length < enzyme.site.length) return [];
  const search = isCircular ? seq + seq.slice(0, enzyme.site.length - 1) : seq;
  const regex = expandSiteRegex(enzyme.site);
  const cuts = new Set<number>();
  let match;
  while ((match = regex.exec(search)) !== null && match.index < seq.length) {
    const cutPos = match.index + enzyme.cutOffset;
    if (isCircular) {
      cuts.add(((cutPos % seq.length) + seq.length) % seq.length);
    } else if (cutPos >= 0 && cutPos <= seq.length) {
      cuts.add(cutPos);
    }
    // Global regex matching otherwise skips overlapping recognition sites.
    regex.lastIndex = match.index + 1;
  }
  return [...cuts].sort((a, b) => a - b);
}

/** Ideal complete digest with one or several enzymes; shared by web and TUI. */
export function digestGenome(
  sequence: string,
  enzyme: RestrictionEnzyme | readonly RestrictionEnzyme[],
  isCircular = false
): DigestResult {
  const enzymes: readonly RestrictionEnzyme[] = 'site' in enzyme ? [enzyme] : enzyme;
  const name = enzymes.map(item => item.name).join('+');
  const seq = sequence.toUpperCase();
  const cutSites = [...new Set(enzymes.flatMap(item => findRestrictionCutSites(seq, item, isCircular)))].sort((a, b) => a - b);

  if (cutSites.length === 0) {
    return {
      enzyme: name,
      fragments: seq.length ? [{ start: 0, end: seq.length, length: seq.length, sequence: seq }] : [],
      cutSites: [],
    };
  }

  const fragments: DigestFragment[] = [];
  
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
    enzyme: name,
    fragments,
    cutSites,
  };
}

/**
 * Compute band migration distance
 * Illustrative log-size calibration, not a physical gel mobility prediction.
 * Map the percentage migration onto maxRun (e.g. terminal rows).
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
  return Math.max(0, Math.min(100, dist)) * maxRun / 100;
}
