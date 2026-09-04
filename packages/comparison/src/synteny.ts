import type { GeneInfo } from '@phage-explorer/core';

export interface SyntenyBlock {
  startIdxA: number; // Gene index in A
  endIdxA: number;
  startIdxB: number; // Gene index in B
  endIdxB: number;
  score: number; // Similarity/Conservation score
  orientation: 'forward' | 'reverse';
}

export type BreakpointType = 'inversion' | 'translocation' | 'indel';

export interface SyntenyBreakpoint {
  idxA: number; // Gene index in A
  idxB: number; // Gene index in B
  prevBlockIdx: number;
  nextBlockIdx: number;
  type: BreakpointType;
  description: string;
}

export interface SyntenyAnalysis {
  blocks: SyntenyBlock[];
  breakpoints: number[]; // Indices in A where synteny breaks
  breakpointDetails: SyntenyBreakpoint[];
  globalScore: number; // 0-1 (coverage of genome A)
  scsScore: number; // 0-1 (Synteny Continuity Score)
  dtwDistance: number;
  warpingPath: [number, number][]; // [geneIdxA, geneIdxB][]
}

interface GeneTokens {
  name: string;
  terms: string[];
  informativeTerms: string[];
  informativeSet: Set<string>;
  domains: Set<string>;
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

function preprocessGene(
  g: GeneInfo,
  domainMap?: Map<number, string[]> | Record<number, string[]>
): GeneTokens {
  const n = (g.product || g.name || '').toLowerCase();
  // Split on whitespace, commas, semicolons, dots, hyphens
  // Keep all terms (length >= 1) to support single-letter genes like Lambda A, B, C
  const terms = n.split(/[\s,;.-]+/).filter(t => t.length > 0);
  const informativeTerms = terms.filter(t => !STOPWORDS.has(t));

  const doms = new Set<string>();
  if (g.domains && Array.isArray(g.domains)) {
    for (const d of g.domains) {
      if (typeof d === 'string' && d.trim().length > 0) {
        doms.add(d.trim().toUpperCase());
      }
    }
  }
  if (domainMap) {
    const fromMap = domainMap instanceof Map ? domainMap.get(g.id) : (domainMap as Record<number, string[]>)[g.id];
    if (fromMap && Array.isArray(fromMap)) {
      for (const d of fromMap) {
        if (typeof d === 'string' && d.trim().length > 0) {
          doms.add(d.trim().toUpperCase());
        }
      }
    }
  }

  return {
    name: n,
    terms,
    informativeTerms,
    informativeSet: new Set(informativeTerms),
    domains: doms,
  };
}

// Optimized gene distance using pre-processed tokens and Pfam domain sets
function geneDistanceOptimized(t1: GeneTokens, t2: GeneTokens): number {
  // Domain similarity: if both have Pfam domains, compute Jaccard distance
  let domainDist = 1.0;
  if (t1.domains.size > 0 && t2.domains.size > 0) {
    let shared = 0;
    for (const d of t1.domains) {
      if (t2.domains.has(d)) shared++;
    }
    if (shared > 0) {
      const union = t1.domains.size + t2.domains.size - shared;
      // High domain overlap yields distance close to 0.0; partial overlap <= 0.5
      domainDist = 1.0 - shared / union;
    }
  }

  // Name similarity
  let nameDist = 1.0;
  const t1HasName = Boolean(t1.name) && t1.informativeSet.size > 0;
  const t2HasName = Boolean(t2.name) && t2.informativeTerms.length > 0;

  if (t1HasName && t2HasName) {
    if (t1.name === t2.name) {
      nameDist = 0.0;
    } else {
      for (const term of t2.informativeTerms) {
        if (t1.informativeSet.has(term)) {
          nameDist = 0.5;
          break;
        }
      }
    }
  }

  // Refusal to match on "hypothetical protein" alone:
  // If neither has informative name tokens and neither shares Pfam domains,
  // both domainDist and nameDist are 1.0, so distance is 1.0 (no match).
  return Math.min(domainDist, nameDist);
}

/**
 * Synteny Continuity Score (SCS)
 *
 * Quantifies synteny preservation despite sequence divergence and modular rearrangements.
 * Penalizes block fragmentation into small discontiguous segments while rewarding
 * long unbroken collinear runs and high pairwise sequence similarity.
 */
export function computeSyntenyContinuityScore(
  blocks: SyntenyBlock[],
  numGenesA: number
): number {
  if (numGenesA <= 0 || blocks.length === 0) return 0;

  const totalAlignedLen = blocks.reduce(
    (sum, b) => sum + (b.endIdxA - b.startIdxA + 1),
    0
  );
  if (totalAlignedLen <= 0) return 0;

  const coverage = Math.min(1, totalAlignedLen / numGenesA);

  const weightedSimilarity =
    blocks.reduce((sum, b) => sum + b.score * (b.endIdxA - b.startIdxA + 1), 0) /
    totalAlignedLen;

  // Block contiguity: sum(len_i^2) / (sum len_i)^2
  // 1.0 for a single unbroken block; approaches 1/K for K equal fragments
  const sumLenSq = blocks.reduce((sum, b) => {
    const len = b.endIdxA - b.startIdxA + 1;
    return sum + len * len;
  }, 0);
  const blockContiguity = sumLenSq / (totalAlignedLen * totalAlignedLen);

  // SCS combines coverage, similarity, and contiguity
  return Math.min(1, Math.max(0, coverage * weightedSimilarity * Math.sqrt(blockContiguity)));
}

/**
 * Classifies synteny breakpoints between adjacent synteny blocks.
 * Differentiates inversions, translocations/module swaps, and indel gaps.
 */
export function classifyBreakpoints(blocks: SyntenyBlock[]): SyntenyBreakpoint[] {
  const result: SyntenyBreakpoint[] = [];
  if (blocks.length < 2) return result;

  for (let k = 0; k < blocks.length - 1; k++) {
    const prev = blocks[k];
    const next = blocks[k + 1];
    const idxA = next.startIdxA;
    const idxB = next.startIdxB;

    let type: BreakpointType = 'indel';
    let description = '';

    if (prev.orientation !== next.orientation) {
      type = 'inversion';
      description = `Inversion boundary: Block #${k + 1} (${prev.orientation}) transitions to Block #${k + 2} (${next.orientation})`;
    } else if (prev.orientation === 'reverse' && next.orientation === 'reverse') {
      if (next.startIdxB > prev.startIdxB + 2 || prev.startIdxB > next.endIdxB + 2) {
        type = 'translocation';
        description = `Translocated inverted block: reference coordinates jump from [${prev.startIdxB}..${prev.endIdxB}] to [${next.startIdxB}..${next.endIdxB}]`;
      } else {
        type = 'indel';
        description = `Inverted segment gap of ${Math.max(0, next.startIdxA - prev.endIdxA - 1)} genes in query`;
      }
    } else {
      const gapA = next.startIdxA - prev.endIdxA - 1;
      const stepB = next.startIdxB - prev.endIdxB;

      if (stepB < -1 || stepB > 3) {
        type = 'translocation';
        description = `Module translocation: reference coordinate jumps from gene ${prev.endIdxB} to gene ${next.startIdxB}`;
      } else {
        type = 'indel';
        description = gapA > 0 ? `Insertion/deletion gap of ${gapA} unaligned genes in query` : `Local synteny discontinuity`;
      }
    }

    result.push({
      idxA,
      idxB,
      prevBlockIdx: k,
      nextBlockIdx: k + 1,
      type,
      description,
    });
  }

  return result;
}

// Dynamic Time Warping for gene lists.
//
// DTW is monotonic: its traceback can only move forward through both
// sequences, so it structurally cannot represent an inversion. Every block it
// returns is therefore `orientation: 'forward'`, which is why the exported
// `alignSynteny` below runs it twice -- once against B, once against B
// reversed -- rather than calling this directly.
function alignSyntenyForward(
  genesA: GeneInfo[],
  genesB: GeneInfo[],
  domainMap?: Map<number, string[]> | Record<number, string[]>
): SyntenyAnalysis {
  const n = genesA.length;
  const m = genesB.length;
  
  if (n === 0 || m === 0) {
    return {
      blocks: [],
      breakpoints: [],
      breakpointDetails: [],
      globalScore: 0,
      scsScore: 0,
      dtwDistance: Infinity,
      warpingPath: [],
    };
  }

  // Pre-process genes
  const tokensA = genesA.map(g => preprocessGene(g, domainMap));
  const tokensB = genesB.map(g => preprocessGene(g, domainMap));

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
  
  const scsScore = computeSyntenyContinuityScore(blocks, n);
  const breakpointDetails = classifyBreakpoints(blocks);

  return {
    blocks,
    breakpoints,
    breakpointDetails,
    globalScore: coverageA / n,
    scsScore,
    dtwDistance: dtw[n][m],
    warpingPath: path,
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
export function alignSynteny(
  genesA: GeneInfo[],
  genesB: GeneInfo[],
  domainMap?: Map<number, string[]> | Record<number, string[]>
): SyntenyAnalysis {
  const forward = alignSyntenyForward(genesA, genesB, domainMap);

  const m = genesB.length;
  if (m === 0 || genesA.length === 0) return forward;

  // Second pass against reversed B.
  const reversedB = [...genesB].reverse();
  const reverse = alignSyntenyForward(genesA, reversedB, domainMap);

  // Map reversed indices back to the original coordinate space and mark the
  // orientation. Reversing swaps which end is the start, so the endpoints
  // exchange roles.
  const reverseBlocks: SyntenyBlock[] = reverse.blocks.map(b => ({
    ...b,
    startIdxB: m - 1 - b.endIdxB,
    endIdxB: m - 1 - b.startIdxB,
    orientation: 'reverse' as const,
  }));

  // Also extract local collinear reverse blocks (chains where i in A increases and j in B decreases).
  // This allows detecting inversions anywhere in the genome, even when far off the global DTW diagonal.
  const tokensA = genesA.map(g => preprocessGene(g, domainMap));
  const tokensB = genesB.map(g => preprocessGene(g, domainMap));

  const visited = new Set<string>();
  const localReverseBlocks: SyntenyBlock[] = [];
  for (let i = 0; i < tokensA.length; i++) {
    for (let j = tokensB.length - 1; j >= 0; j--) {
      if (visited.has(`${i},${j}`)) continue;
      const d0 = geneDistanceOptimized(tokensA[i], tokensB[j]);
      if (d0 < 0.8) {
        let len = 1;
        let scoreSum = 1.0 - d0;
        while (i + len < tokensA.length && j - len >= 0) {
          const d = geneDistanceOptimized(tokensA[i + len], tokensB[j - len]);
          if (d < 0.8) {
            scoreSum += 1.0 - d;
            len++;
          } else {
            break;
          }
        }
        if (len >= 2) {
          for (let k = 0; k < len; k++) {
            visited.add(`${i + k},${j - k}`);
          }
          localReverseBlocks.push({
            startIdxA: i,
            endIdxA: i + len - 1,
            startIdxB: j - len + 1,
            endIdxB: j,
            score: scoreSum / len,
            orientation: 'reverse',
          });
        }
      }
    }
  }

  const allReverseCandidates = [...reverseBlocks, ...localReverseBlocks];

  // A single-gene "block" carries no order information, so it cannot evidence
  // an inversion; it would match equally well either way round.
  const meaningfulReverse = allReverseCandidates.filter(b => b.endIdxA > b.startIdxA);
  meaningfulReverse.sort(
    (a, b) => b.score - a.score || (b.endIdxA - b.startIdxA) - (a.endIdxA - a.startIdxA)
  );

  const overlapsInA = (x: SyntenyBlock, y: SyntenyBlock): boolean =>
    x.startIdxA <= y.endIdxA && y.startIdxA <= x.endIdxA;

  let merged: SyntenyBlock[] = [...forward.blocks];
  for (const candidate of meaningfulReverse) {
    const conflicts = merged.filter(b => overlapsInA(b, candidate));
    if (conflicts.length === 0) {
      merged.push(candidate);
      continue;
    }

    const candidateLen = candidate.endIdxA - candidate.startIdxA + 1;
    const candidateMass = candidate.score * candidateLen;

    // A candidate cannot split an enclosing block unless candidate is strictly higher quality
    const enclosingConflict = conflicts.find(
      c => c.startIdxA < candidate.startIdxA && candidate.endIdxA < c.endIdxA
    );
    if (enclosingConflict && candidate.score <= enclosingConflict.score) {
      continue;
    }

    let forwardMassInInterval = 0;
    let canDisplace = true;

    for (const c of conflicts) {
      const overlapStart = Math.max(c.startIdxA, candidate.startIdxA);
      const overlapEnd = Math.min(c.endIdxA, candidate.endIdxA);
      const overlapLen = overlapEnd - overlapStart + 1;
      forwardMassInInterval += c.score * overlapLen;

      // If c is longer than candidate and has strictly higher score, candidate cannot displace it
      const cLen = c.endIdxA - c.startIdxA + 1;
      if (cLen > candidateLen && c.score > candidate.score) {
        canDisplace = false;
        break;
      }
    }

    if (!canDisplace) continue;
    if (candidateMass <= forwardMassInInterval) continue;

    // Apply trimming and displacement to conflicts
    const nextMerged: SyntenyBlock[] = [];
    for (const b of merged) {
      if (!overlapsInA(b, candidate)) {
        nextMerged.push(b);
        continue;
      }

      // If b is completely inside candidate, it is displaced
      if (candidate.startIdxA <= b.startIdxA && b.endIdxA <= candidate.endIdxA) {
        continue;
      }

      // If b starts before candidate, retain prefix
      if (b.startIdxA < candidate.startIdxA) {
        const trimmedEndA = candidate.startIdxA - 1;
        const lenA = trimmedEndA - b.startIdxA + 1;
        if (lenA >= 1) {
          const trimmed: SyntenyBlock = { ...b, endIdxA: trimmedEndA };
          if (b.orientation === 'forward') {
            trimmed.endIdxB = b.startIdxB + lenA - 1;
          } else {
            trimmed.startIdxB = b.endIdxB - (lenA - 1);
          }
          nextMerged.push(trimmed);
        }
      }

      // If b ends after candidate, retain suffix
      if (b.endIdxA > candidate.endIdxA) {
        const trimmedStartA = candidate.endIdxA + 1;
        const lenA = b.endIdxA - trimmedStartA + 1;
        if (lenA >= 1) {
          const trimmed: SyntenyBlock = { ...b, startIdxA: trimmedStartA };
          if (b.orientation === 'forward') {
            trimmed.startIdxB = b.endIdxB - (lenA - 1);
          } else {
            trimmed.endIdxB = b.startIdxB + lenA - 1;
          }
          nextMerged.push(trimmed);
        }
      }
    }

    nextMerged.push(candidate);
    merged = nextMerged;
  }

  merged.sort((a, b) => a.startIdxA - b.startIdxA);

  const coverageA = merged.reduce((sum, b) => sum + (b.endIdxA - b.startIdxA + 1), 0);

  const scsScore = computeSyntenyContinuityScore(merged, genesA.length);
  const breakpointDetails = classifyBreakpoints(merged);

  return {
    blocks: merged,
    breakpoints: merged.slice(1).map(b => b.startIdxA),
    breakpointDetails,
    globalScore: Math.min(1, coverageA / genesA.length),
    scsScore,
    // The forward pass's DTW cost remains the comparable global figure; the
    // reverse pass is a search for local rearrangements, not a rival alignment.
    dtwDistance: forward.dtwDistance,
    warpingPath: forward.warpingPath,
  };
}
