import { describe, it, expect } from 'bun:test';
import { alignSynteny, type SyntenyBlock } from '../src/synteny';
import type { GeneInfo } from '@phage-explorer/core';

const gene = (name: string): GeneInfo => ({
  id: 0,
  name,
  locusTag: name,
  startPos: 0,
  endPos: 100,
  strand: '+',
  product: name,
  type: 'CDS',
});

describe('Synteny Aligner', () => {
  it('identifies perfect synteny', () => {
    const genesA = [gene('A'), gene('B'), gene('C')];
    const genesB = [gene('A'), gene('B'), gene('C')];
    
    const result = alignSynteny(genesA, genesB);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].startIdxA).toBe(0);
    expect(result.blocks[0].endIdxA).toBe(2);
    expect(result.globalScore).toBe(1);
  });

  it('handles gaps/mismatches', () => {
    const genesA = [gene('A'), gene('B'), gene('C')];
    const genesB = [gene('A'), gene('X'), gene('C')];
    
    const result = alignSynteny(genesA, genesB);
    // Should break into two blocks: A-A and C-C
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);
    // Or one block with low score? Logic splits on mismatch.
    // geneDistance('B', 'X') = 1.0. isMatch = false.
    // So blocks should be [A] and [C].
    expect(result.blocks[0].score).toBe(1);
    expect(result.blocks[1].score).toBe(1);
  });

  it('prevents false positive matching of short numeric names (gp3 vs gp34)', () => {
    const genesA = [gene('gp3')];
    const genesB = [gene('gp34')];
    
    const result = alignSynteny(genesA, genesB);
    
    // Prior to fix, this would match with score 0.8 (dist 0.2)
    // Now it should have no blocks (dist 1.0)
    expect(result.blocks.length).toBe(0);
  });

  it('matches genes by token intersection (terminase)', () => {
    const genesA = [gene('terminase large subunit')];
    const genesB = [gene('terminase')];
    
    const result = alignSynteny(genesA, genesB);
    
    // Should match (dist 0.5 < 0.8)
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].score).toBe(0.5);
  });
});
