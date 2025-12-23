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

  it('does not merge islands across gaps of invalid data', () => {
    // Host (AT) + Island1 (GC) + Gap (N) + Island2 (GC) + Host (AT)
    // Ensures mean GC is low so islands stand out
    const host = 'AT'.repeat(1000); // 2000 bp, 0% GC
    const highGC = 'GC'.repeat(250); // 500 bp, 100% GC
    const gap = 'N'.repeat(2000); // 2000 bp
    
    const genome = host + highGC + gap + highGC + host;
    
    // Window 500, step 250.
    // Host windows: GC ~0. Islands: GC ~100.
    const result = analyzeHGTProvenance(genome, [], {}, { window: 500, step: 250, zThreshold: 1.0, minValidRatio: 0.9 });
    
    expect(result.islands.length).toBeGreaterThanOrEqual(2);
    
    // First island should be around the first highGC block (starts after 2000)
    // Host ends at 2000. Island1 2000-2500.
    const i1 = result.islands.find(i => i.start >= 1500 && i.end <= 3000);
    const i2 = result.islands.find(i => i.start >= 4000); // Gap ends at 2500+2000=4500? No. 2000+500+2000 = 4500.
    
    expect(i1).toBeDefined();
    expect(i2).toBeDefined();
    
    // Ensure they are not merged (end of first < start of second)
    if (i1 && i2) {
        expect(i1.end).toBeLessThan(i2.start);
    }
  });
});
