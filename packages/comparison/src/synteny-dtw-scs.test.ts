import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import {
  alignSynteny,
  computeSyntenyContinuityScore,
  classifyBreakpoints,
  type SyntenyBlock,
} from './synteny';

function makeGene(id: number, product: string): GeneInfo {
  return {
    id,
    name: product,
    locusTag: `gene_${id}`,
    startPos: (id - 1) * 1000,
    endPos: id * 1000,
    strand: '+',
    product,
    type: 'CDS',
  };
}

describe('Roadmap #49: Functional Synteny Elastic Alignment DTW & SCS (phage_explorer-dafk5)', () => {
  it('computes Synteny Continuity Score (SCS) = 1.0 for unbroken identical synteny', () => {
    const genesA = [
      makeGene(1, 'terminase large subunit'),
      makeGene(2, 'portal protein'),
      makeGene(3, 'capsid protein'),
      makeGene(4, 'major tail protein'),
      makeGene(5, 'tail fiber protein'),
    ];
    const result = alignSynteny(genesA, genesA);

    expect(result.scsScore).toBeGreaterThan(0.95);
    expect(result.scsScore).toBeLessThanOrEqual(1.0);
    expect(result.globalScore).toBe(1.0);
    expect(result.dtwDistance).toBe(0);
    expect(result.warpingPath.length).toBeGreaterThanOrEqual(5);
  });

  it('penalizes block fragmentation: fragmented blocks have strictly lower SCS than contiguous blocks', () => {
    // Single contiguous 10-gene block
    const contiguousBlock: SyntenyBlock[] = [
      { startIdxA: 0, endIdxA: 9, startIdxB: 0, endIdxB: 9, score: 1.0, orientation: 'forward' },
    ];
    const contiguousSCS = computeSyntenyContinuityScore(contiguousBlock, 10);

    // 5 fragmented 2-gene blocks covering the exact same 10 genes
    const fragmentedBlocks: SyntenyBlock[] = [
      { startIdxA: 0, endIdxA: 1, startIdxB: 0, endIdxB: 1, score: 1.0, orientation: 'forward' },
      { startIdxA: 2, endIdxA: 3, startIdxB: 2, endIdxB: 3, score: 1.0, orientation: 'forward' },
      { startIdxA: 4, endIdxA: 5, startIdxB: 4, endIdxB: 5, score: 1.0, orientation: 'forward' },
      { startIdxA: 6, endIdxA: 7, startIdxB: 6, endIdxB: 7, score: 1.0, orientation: 'forward' },
      { startIdxA: 8, endIdxA: 9, startIdxB: 8, endIdxB: 9, score: 1.0, orientation: 'forward' },
    ];
    const fragmentedSCS = computeSyntenyContinuityScore(fragmentedBlocks, 10);

    expect(contiguousSCS).toBe(1.0);
    expect(fragmentedSCS).toBeLessThan(contiguousSCS);
    expect(fragmentedSCS).toBeCloseTo(Math.sqrt(0.2), 3); // 5 * 4 / 100 = 0.2
  });

  it('detects and classifies inversion breakpoints between inverted and forward modules', () => {
    // Genome A: [head1, head2, tail1, tail2, lysis1, lysis2]
    // Genome B: [head1, head2, tail2, tail1, lysis1, lysis2] (tail inverted)
    const genesA = [
      makeGene(1, 'capsid head subunit alpha'),
      makeGene(2, 'capsid head subunit beta'),
      makeGene(3, 'tape measure tail protein'),
      makeGene(4, 'distal tail fiber protein'),
      makeGene(5, 'holin lysis protein'),
      makeGene(6, 'endolysin cell wall hydrolase'),
    ];
    const genesB = [
      makeGene(101, 'capsid head subunit alpha'),
      makeGene(102, 'capsid head subunit beta'),
      makeGene(104, 'distal tail fiber protein'),
      makeGene(103, 'tape measure tail protein'),
      makeGene(105, 'holin lysis protein'),
      makeGene(106, 'endolysin cell wall hydrolase'),
    ];

    const result = alignSynteny(genesA, genesB);
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);

    const hasInversion = result.blocks.some(b => b.orientation === 'reverse');
    expect(hasInversion).toBe(true);

    const inversionBps = result.breakpointDetails.filter(b => b.type === 'inversion');
    expect(inversionBps.length).toBeGreaterThanOrEqual(1);
    expect(inversionBps[0].description).toContain('Inversion boundary');
  });

  it('detects and classifies module translocation breakpoints when gene order jumps', () => {
    const blocks: SyntenyBlock[] = [
      { startIdxA: 0, endIdxA: 4, startIdxB: 0, endIdxB: 4, score: 0.9, orientation: 'forward' },
      { startIdxA: 5, endIdxA: 9, startIdxB: 20, endIdxB: 24, score: 0.85, orientation: 'forward' },
    ];
    const breakpoints = classifyBreakpoints(blocks);

    expect(breakpoints.length).toBe(1);
    expect(breakpoints[0].type).toBe('translocation');
    expect(breakpoints[0].description).toContain('Module translocation');
    expect(breakpoints[0].description).toContain('4');
    expect(breakpoints[0].description).toContain('20');
  });

  it('returns empty SCS and empty breakpoint details for empty gene sets', () => {
    const result = alignSynteny([], []);
    expect(result.scsScore).toBe(0);
    expect(result.globalScore).toBe(0);
    expect(result.blocks).toEqual([]);
    expect(result.breakpointDetails).toEqual([]);
    expect(result.warpingPath).toEqual([]);
  });

  it('exposes warpingPath tracing dynamic programming coordinates', () => {
    const genesA = [makeGene(1, 'terminase'), makeGene(2, 'portal')];
    const genesB = [makeGene(10, 'terminase'), makeGene(20, 'portal')];

    const result = alignSynteny(genesA, genesB);
    expect(result.warpingPath.length).toBeGreaterThan(0);
    expect(result.warpingPath[0]).toEqual([0, 0]);
    expect(result.warpingPath[result.warpingPath.length - 1]).toEqual([1, 1]);
  });
});
