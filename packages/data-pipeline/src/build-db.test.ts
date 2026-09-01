import { describe, test, expect } from 'bun:test';
import {
  findTrnaPool,
  calculateIntrinsicCai,
  calculateTai,
  detectAuxiliaryMetabolicGenes,
} from './build-db';

describe('findTrnaPool', () => {
  test('matches E. coli host strings', () => {
    const pool = findTrnaPool('Escherichia coli C');
    expect(pool).toBeArray();
    expect(pool?.length).toBeGreaterThan(0);
    expect(pool?.[0]).toHaveProperty('codon');
  });

  test('returns undefined for unknown hosts', () => {
    expect(findTrnaPool('Bacillus subtilis')).toBeUndefined();
  });

  test('is case-insensitive', () => {
    expect(findTrnaPool('escherichia coli')).toBeDefined();
    expect(findTrnaPool('ESCHERICHIA COLI')).toBeDefined();
  });
});

describe('calculateIntrinsicCai', () => {
  test('returns 1 for a gene matching the phage-wide codon usage exactly', () => {
    const phageCounts = { ATG: 10, AAA: 5, AAG: 5 };
    const geneCounts = { ATG: 2, AAA: 1, AAG: 1 };
    const cai = calculateIntrinsicCai(geneCounts, phageCounts);
    expect(cai).toBeCloseTo(1);
  });

  test('returns a value below 1 when a gene avoids preferred codons', () => {
    const phageCounts = { ATG: 10, AAA: 8, AAG: 2 };
    const geneCounts = { ATG: 2, AAA: 1, AAG: 1 };
    const cai = calculateIntrinsicCai(geneCounts, phageCounts);
    expect(cai).toBeLessThan(1);
    expect(cai).toBeGreaterThan(0);
  });

  test('does not produce NaN when a gene codon is absent from phage counts', () => {
    const phageCounts = { ATG: 10, TTC: 5 };
    const geneCounts = { ATG: 2, TTT: 1, TTC: 1 };
    const cai = calculateIntrinsicCai(geneCounts, phageCounts);
    expect(Number.isFinite(cai)).toBe(true);
  });

  test('returns 0 for an empty gene', () => {
    const phageCounts = { ATG: 10 };
    expect(calculateIntrinsicCai({}, phageCounts)).toBe(0);
  });
});

describe('detectAuxiliaryMetabolicGenes', () => {
  test('maps known AMG markers to KEGG orthologs', () => {
    const hits = detectAuxiliaryMetabolicGenes([
      { id: 1, name: 'psbA', locusTag: 'gp1', product: 'photosystem II D1 protein', type: 'CDS' },
      { id: 2, name: 'nrdB', locusTag: 'gp2', product: 'ribonucleotide reductase beta subunit', type: 'CDS' },
    ]);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.keggOrtholog).toBe('K02703');
    expect(hits[1]?.keggOrtholog).toBe('K00526');
  });

  test('does not classify generic genes or non-CDS features', () => {
    const hits = detectAuxiliaryMetabolicGenes([
      { id: 1, name: 'capsid', locusTag: null, product: 'major capsid protein', type: 'CDS' },
      { id: 2, name: 'psbA', locusTag: null, product: null, type: 'gene' },
    ]);
    expect(hits).toEqual([]);
  });
});

describe('calculateTai', () => {
  test('returns 1 for a gene using only the most abundant tRNA codon', () => {
    const pool = [{ anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 }];
    const geneCounts = { ATG: 5 };
    const tai = calculateTai(geneCounts, pool);
    expect(tai).toBeCloseTo(1);
  });

  test('returns a value below 1 when the gene uses a less abundant codon', () => {
    const pool = [
      { anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 },
      { anticodon: 'GUA', aminoAcid: 'Tyr', codon: 'TAT', copyNumber: 2 },
    ];
    const geneCounts = { ATG: 1, TAT: 1 };
    const tai = calculateTai(geneCounts, pool);
    expect(tai).toBeLessThan(1);
    expect(tai).toBeGreaterThan(0);
  });

  test('does not produce NaN for codons absent from the tRNA pool', () => {
    const pool = [{ anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 }];
    const geneCounts = { ATG: 1, AAA: 1 };
    const tai = calculateTai(geneCounts, pool);
    expect(Number.isFinite(tai)).toBe(true);
  });

  test('returns 0 for an empty gene', () => {
    const pool = [{ anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 }];
    expect(calculateTai({}, pool)).toBe(0);
  });

  test('ignores stop codons instead of penalizing the score', () => {
    const pool = [{ anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 }];
    const withStops = calculateTai({ ATG: 1, TAA: 1, TAG: 1, TGA: 1 }, pool);
    const withoutStops = calculateTai({ ATG: 1 }, pool);
    expect(withStops).toBeCloseTo(withoutStops);
  });
});
