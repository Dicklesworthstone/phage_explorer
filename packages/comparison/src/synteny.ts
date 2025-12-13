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
}

function preprocessGene(g: GeneInfo): GeneTokens {
  const n = (g.product || g.name || '').toLowerCase();
  const terms = n.split(/[\s-]+/).filter(t => t.length > 3);
  return { name: n, terms };
}

// Optimized gene distance using pre-processed tokens
function geneDistanceOptimized(t1: GeneTokens, t2: GeneTokens): number {
  if (!t1.name || !t2.name) return 1.0;
  if (t1.name === t2.name) return 0.0;
  if (t1.name.includes(t2.name) || t2.name.includes(t1.name)) return 0.2;
  
  // Check common terms
  // Optimization: Loop smaller array
  const [small, large] = t1.terms.length < t2.terms.length ? [t1.terms, t2.terms] : [t2.terms, t1.terms];
  for (const term of small) {
    if (large.includes(term)) return 0.5;
  }
  
  return 1.0;
}

// Dynamic Time Warping for gene lists
export function alignSynteny(genesA: GeneInfo[], genesB: GeneInfo[]): SyntenyAnalysis {
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
    path.push([i - 1, j - 1]);
    
    if (i === 0) { j--; continue; }
    if (j === 0) { i--; continue; }

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

  for (const [idxA, idxB] of path) {
    if (idxA < 0 || idxB < 0) continue; // Skip boundary pads if any

    const dist = geneDistanceOptimized(tokensA[idxA], tokensB[idxB]);
    const isMatch = dist < 0.8; // Threshold for "related"

    if (isMatch) {
      if (!currentBlock) {
        currentBlock = {
          startIdxA: idxA,
          endIdxA: idxA,
          startIdxB: idxB,
          endIdxB: idxB,
          score: 1.0 - dist,
          orientation: 'forward' // Simplified: DTW typically assumes monotonic, need Smith-Waterman for inversions
        };
      } else {
        // Extend block
        // Check if contiguous (indices increment by 1)
        const isContiguousA = idxA === currentBlock.endIdxA! + 1;
        const isContiguousB = idxB === currentBlock.endIdxB! + 1;

        if (isContiguousA && isContiguousB) {
            currentBlock.endIdxA = idxA;
            currentBlock.endIdxB = idxB;
            // Update average score? Keep simple for now
        } else {
            // End current block, start new
            blocks.push(currentBlock as SyntenyBlock);
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
