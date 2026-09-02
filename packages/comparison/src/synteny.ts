import type { GeneInfo } from '@phage-explorer/core';

export interface SyntenyBlock {
  startIdxA: number; // Gene index in A
  endIdxA: number;
  startIdxB: number; // Gene index in B
  endIdxB: number;
  score: number; // Similarity/Conservation score
  orientation: 'forward' | 'reverse';
}

export interface SyntenyAnalysis {
  blocks: SyntenyBlock[];
  breakpoints: number[]; // Indices in A where synteny breaks
  globalScore: number; // 0-1
  dtwDistance: number;
}

interface GeneTokens {
  name: string;
  terms: string[];
  informativeTerms: string[];
  informativeSet: Set<string>;
}

const STOPWORDS = new Set([
  'protein',
  'putative',
  'hypothetical',
  'phage',
  'viral',
  'probable',
  'predicted',
  'conserved',
  'domain',
  'family',
  'uncharacterized',
  'gp',
  'orf',
]);

function preprocessGene(g: GeneInfo): GeneTokens {
  const n = (g.product || g.name || '').toLowerCase();
  // Split on whitespace, commas, semicolons, dots, hyphens
  // Keep all terms (length >= 1) to support single-letter genes like Lambda A, B, C
  const terms = n.split(/[\s,;.-]+/).filter(t => t.length > 0);
  const informativeTerms = terms.filter(t => !STOPWORDS.has(t));
  return {
    name: n,
    terms,
    informativeTerms,
    informativeSet: new Set(informativeTerms),
  };
}

// Optimized gene distance using pre-processed tokens
function geneDistanceOptimized(t1: GeneTokens, t2: GeneTokens): number {
  if (!t1.name || !t2.name) return 1.0;

  // If filtering removed all terms (e.g. "hypothetical protein"), no match
  // This takes precedence over exact name match to avoid aligning junk
  if (t1.informativeSet.size === 0 || t2.informativeTerms.length === 0) return 1.0;

  // Exact match on informative names
  if (t1.name === t2.name) return 0.0;

  for (const term of t2.informativeTerms) {
    if (t1.informativeSet.has(term)) return 0.5;
  }
  
  return 1.0;
}

// Dynamic Time Warping for gene lists.
//
// DTW is monotonic: its traceback can only move forward through both
// sequences, so it structurally cannot represent an inversion. Every block it
// returns is therefore `orientation: 'forward'`, which is why the exported
// `alignSynteny` below runs it twice -- once against B, once against B
// reversed -- rather than calling this directly.
function alignSyntenyForward(genesA: GeneInfo[], genesB: GeneInfo[]): SyntenyAnalysis {
  const n = genesA.length;
  const m = genesB.length;
  
  if (n === 0 || m === 0) {
    return { blocks: [], breakpoints: [], globalScore: 0, dtwDistance: Infinity };
  }

  // Pre-process genes
  const tokensA = genesA.map(preprocessGene);
  const tokensB = genesB.map(preprocessGene);

  // Initialize DTW matrix
  const dtw = Array(n + 1).fill(0).map(() => Array(m + 1).fill(Infinity));
  dtw[0][0] = 0;

  // Fill matrix
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = geneDistanceOptimized(tokensA[i - 1], tokensB[j - 1]);
      dtw[i][j] = cost + Math.min(
        dtw[i - 1][j],      // Insertion
        dtw[i][j - 1],      // Deletion
        dtw[i - 1][j - 1]   // Match
      );
    }
  }

  // Traceback
  let i = n;
  let j = m;
  const path: [number, number][] = [];
  
  while (i > 0 || j > 0) {
    if (i === 0) { j--; continue; }
    if (j === 0) { i--; continue; }

    path.push([i - 1, j - 1]);

    const minPrev = Math.min(dtw[i - 1][j], dtw[i][j - 1], dtw[i - 1][j - 1]);

    if (Math.abs(dtw[i - 1][j - 1] - minPrev) < 0.001) { // Match
      i--; j--;
    } else if (Math.abs(dtw[i - 1][j] - minPrev) < 0.001) { // Insertion
      i--;
    } else { // Deletion
      j--;
    }
  }

  path.reverse();

  // Extract blocks
  // A block is a sequence of diagonal moves (matches/mismatches) in the traceback
  const blocks: SyntenyBlock[] = [];
  let currentBlock: Partial<SyntenyBlock> | null = null;
  let scoreSum = 0;
  let pairCount = 0;

  for (const [idxA, idxB] of path) {
    if (idxA < 0 || idxB < 0) continue; // Skip boundary pads if any

    const dist = geneDistanceOptimized(tokensA[idxA], tokensB[idxB]);
    const isMatch = dist < 0.8; // Threshold for "related"

    if (isMatch) {
      if (!currentBlock) {
        scoreSum = 1.0 - dist;
        pairCount = 1;
        currentBlock = {
          startIdxA: idxA,
          endIdxA: idxA,
          startIdxB: idxB,
          endIdxB: idxB,
          score: 1.0 - dist,
          orientation: 'forward'
        };
      } else {
        // Extend block
        // Check if contiguous (indices increment by 1)
        const isContiguousA = idxA === currentBlock.endIdxA! + 1;
        const isContiguousB = idxB === currentBlock.endIdxB! + 1;

        if (isContiguousA && isContiguousB) {
            currentBlock.endIdxA = idxA;
            currentBlock.endIdxB = idxB;
            // Average the score across every pair in the block. It used to keep
            // the first pair's score for the whole run, so a 50-gene block was
            // scored by one gene.
            pairCount++;
            scoreSum += 1.0 - dist;
            currentBlock.score = scoreSum / pairCount;
        } else {
            // End current block, start new
            blocks.push(currentBlock as SyntenyBlock);
            scoreSum = 1.0 - dist;
            pairCount = 1;
            currentBlock = {
                startIdxA: idxA,
                endIdxA: idxA,
                startIdxB: idxB,
                endIdxB: idxB,
                score: 1.0 - dist,
                orientation: 'forward'
            };
        }
      }
    } else {
        // Gap or Mismatch -> End current block
        if (currentBlock) {
            blocks.push(currentBlock as SyntenyBlock);
            currentBlock = null;
        }
    }
  }
  
  if (currentBlock) {
    blocks.push(currentBlock as SyntenyBlock);
  }

  // Identify breakpoints (indices in A where we switch blocks)
  const breakpoints = blocks.slice(1).map(b => b.startIdxA);

  // Global score: coverage of A by syntenic blocks
  const coverageA = blocks.reduce((sum, b) => sum + (b.endIdxA - b.startIdxA + 1), 0);
  
  return {
    blocks,
    breakpoints,
    globalScore: coverageA / n,
    dtwDistance: dtw[n][m]
  };
}

/**
 * Align two gene orders, detecting both conserved and INVERTED blocks.
 *
 * ## Why two passes
 *
 * The DTW pass above is monotonic, so every block it can produce is
 * forward-oriented. `orientation` was therefore hardcoded to `'forward'` and
 * `'reverse'` was unreachable -- while the web overlay rendered an "Inverted
 * orientation" legend entry and told the user that "inverted blocks (red)
 * suggest genome rearrangements". The UI documented and colour-coded an
 * outcome the algorithm could not return, so a genuine inversion showed as
 * nothing at all.
 *
 * Inversions are among the most interesting signals in phage comparative
 * genomics, so the fix detects them rather than removing the legend.
 *
 * The method is the standard one for gene-order synteny: run the same
 * monotonic alignment a second time against B's gene order reversed. A run of
 * genes that aligns well in that pass is, in the original coordinates, a block
 * whose order runs backwards -- an inversion. Coordinates are mapped back to
 * the original indices so callers never see reversed ones.
 *
 * Where a forward and a reverse block claim overlapping genes in A, the
 * higher-scoring one wins. Both cannot be true, and preferring the better
 * explanation is what an aligner does.
 */
export function alignSynteny(genesA: GeneInfo[], genesB: GeneInfo[]): SyntenyAnalysis {
  const forward = alignSyntenyForward(genesA, genesB);

  const m = genesB.length;
  if (m === 0 || genesA.length === 0) return forward;

  // Second pass against reversed B.
  const reversedB = [...genesB].reverse();
  const reverse = alignSyntenyForward(genesA, reversedB);

  // Map reversed indices back to the original coordinate space and mark the
  // orientation. Reversing swaps which end is the start, so the endpoints
  // exchange roles.
  const reverseBlocks: SyntenyBlock[] = reverse.blocks.map(b => ({
    ...b,
    startIdxB: m - 1 - b.endIdxB,
    endIdxB: m - 1 - b.startIdxB,
    orientation: 'reverse' as const,
  }));

  // A single-gene "block" carries no order information, so it cannot evidence
  // an inversion; it would match equally well either way round.
  const meaningfulReverse = reverseBlocks.filter(b => b.endIdxA > b.startIdxA);

  const overlapsInA = (x: SyntenyBlock, y: SyntenyBlock): boolean =>
    x.startIdxA <= y.endIdxA && y.startIdxA <= x.endIdxA;

  const merged: SyntenyBlock[] = [...forward.blocks];
  for (const candidate of meaningfulReverse) {
    const conflicts = merged.filter(b => overlapsInA(b, candidate));
    if (conflicts.length === 0) {
      merged.push(candidate);
      continue;
    }
    // Only displace the forward interpretation when the inversion explains
    // those genes better than every forward block it would replace.
    if (conflicts.every(c => candidate.score > c.score)) {
      for (const c of conflicts) {
        const idx = merged.indexOf(c);
        if (idx >= 0) merged.splice(idx, 1);
      }
      merged.push(candidate);
    }
  }

  merged.sort((a, b) => a.startIdxA - b.startIdxA);

  const coverageA = merged.reduce((sum, b) => sum + (b.endIdxA - b.startIdxA + 1), 0);

  return {
    blocks: merged,
    breakpoints: merged.slice(1).map(b => b.startIdxA),
    globalScore: Math.min(1, coverageA / genesA.length),
    // The forward pass's DTW cost remains the comparable global figure; the
    // reverse pass is a search for local rearrangements, not a rival alignment.
    dtwDistance: forward.dtwDistance,
  };
}
