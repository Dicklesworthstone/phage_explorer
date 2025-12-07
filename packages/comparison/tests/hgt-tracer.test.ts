import { describe, it, expect } from 'bun:test';
import { analyzeHGTProvenance } from '../src/hgt-tracer';
import type { GeneInfo } from '@phage-explorer/core';

const makeGene = (start: number, end: number, name: string, product: string): GeneInfo => ({
  id: start,
  name,
  locusTag: name,
  startPos: start,
  endPos: end,
  strand: '+',
  product,
  type: 'CDS',
});

describe('HGT tracer', () => {
  it('detects a high-GC island and infers donor similarity', () => {
    // Genome: mostly AT with a terminal GC-rich island (window size 2000, step 1000)
    const host = 'AT'.repeat(3000); // 6000 bp, low GC
    const island = 'GC'.repeat(1000); // 2000 bp, high GC
    const genome = host + island;

    // Gene inside the island with hallmark keyword
    const genes: GeneInfo[] = [
      makeGene(6200, 6400, 'int', 'integrase'),
    ];

    const references = {
      donorA: island, // identical to island for Jaccard 1.0
      donorB: host,   // low similarity
    };

    const result = analyzeHGTProvenance(genome, genes, references, { window: 500, step: 250, zThreshold: 1.5 });

    expect(result.islands.length).toBeGreaterThanOrEqual(1);
    const topStamp = result.stamps[0];
    expect(topStamp.donor?.taxon).toBe('donorA');
    expect(topStamp.donor?.similarity ?? 0).toBeGreaterThan(0.9);
    expect(topStamp.amelioration).toBe('recent');
  });

  it('propagates hallmark genes into passport stamps', () => {
    const genome = 'AT'.repeat(3000) + 'GC'.repeat(1000); // same structure as first test
    const genes: GeneInfo[] = [makeGene(7000, 7200, 'tpase', 'transposase')];

    const result = analyzeHGTProvenance(genome, genes, { donorX: 'GC'.repeat(1000) }, { window: 400, step: 200, zThreshold: 1 });
    const stamp = result.stamps[0]!;
    expect(stamp.hallmarks.length).toBeGreaterThan(0);
    expect(stamp.hallmarks.join(' ')).toContain('transposase');
  });
});
