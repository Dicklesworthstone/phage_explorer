/**
 * Tests for Tropism Analysis Module
 *
 * Tests tail fiber receptor prediction and tropism analysis.
 */

import { describe, test, expect } from 'bun:test';
import { analyzeTailFiberTropism } from './tropism';
import type { PhageFull, GeneInfo } from '@phage-explorer/core';

let geneId = 0;
const makeGene = (
  product: string,
  start: number,
  end: number,
  name: string | null = null
): GeneInfo => ({
  id: ++geneId,
  name,
  locusTag: `gene_${geneId}`,
  startPos: start,
  endPos: end,
  strand: '+',
  product,
  type: 'CDS',
});

const makePhage = (genes: GeneInfo[]): PhageFull => ({
  id: 1,
  name: 'Test Phage',
  slug: 'test-phage',
  accession: 'TEST001',
  family: 'Myoviridae',
  host: 'Escherichia coli',
  genomeLength: 50000,
  gcContent: 45.5,
  morphology: null,
  lifecycle: null,
  genes,
  description: null,
  baltimoreGroup: null,
  genomeType: null,
  pdbIds: [],
  codonUsage: null,
  hasModel: false,
});

describe('analyzeTailFiberTropism', () => {
  test('returns expected structure for phage without genes', () => {
    const phage = makePhage([]);
    const result = analyzeTailFiberTropism(phage);

    expect(result).toHaveProperty('phageId');
    expect(result).toHaveProperty('phageName');
    expect(result).toHaveProperty('hits');
    expect(result).toHaveProperty('breadth');
    expect(result).toHaveProperty('source');
    expect(result.source).toBe('heuristic');
    expect(result.hits).toEqual([]);
    expect(result.breadth).toBe('unknown');
  });

  test('identifies tail fiber genes by product keywords', () => {
    const phage = makePhage([
      makeGene('tail fiber protein', 0, 1000),
      makeGene('capsid protein', 1000, 2000), // Not a tail fiber
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.hits.length).toBe(1);
    expect(result.hits[0].gene.product).toBe('tail fiber protein');
  });

  test('identifies tailspike genes', () => {
    const phage = makePhage([
      makeGene('tailspike protein', 0, 1500),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.hits.length).toBe(1);
    expect(result.hits[0].gene.product).toBe('tailspike protein');
  });

  test('identifies receptor-binding proteins', () => {
    const phage = makePhage([
      makeGene('receptor-binding protein', 0, 1200),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.hits.length).toBe(1);
  });

  test('identifies LamB receptor from annotation', () => {
    const phage = makePhage([
      makeGene('LamB-specific tail fiber protein', 0, 1000),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.hits.length).toBe(1);
    const receptors = result.hits[0].receptorCandidates.map(c => c.receptor);
    expect(receptors.some(r => r.includes('LamB'))).toBe(true);
  });

  test('identifies flagellum binding from annotation', () => {
    const phage = makePhage([
      makeGene('flagellum-binding tail fiber', 0, 800),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.hits.length).toBe(1);
    const receptors = result.hits[0].receptorCandidates.map(c => c.receptor);
    expect(receptors.some(r => r.includes('Flagell'))).toBe(true);
  });

  test('identifies LPS/O-antigen from annotation', () => {
    const phage = makePhage([
      makeGene('O-antigen depolymerase tailspike', 0, 1500),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.hits.length).toBe(1);
    const receptors = result.hits[0].receptorCandidates.map(c => c.receptor);
    expect(receptors.some(r => r.includes('LPS') || r.includes('O-antigen'))).toBe(true);
  });

  test('returns narrow breadth for single receptor', () => {
    const phage = makePhage([
      makeGene('LamB-specific tail fiber protein', 0, 1000),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.breadth).toBe('narrow');
  });

  test('skips non-fiber genes that are not hypothetical', () => {
    const phage = makePhage([
      makeGene('DNA polymerase', 0, 2000),
      makeGene('capsid protein', 2000, 3000),
      makeGene('portal protein', 3000, 4000),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.hits.length).toBe(0);
    expect(result.breadth).toBe('unknown');
  });

  test('returns correct phageId and phageName', () => {
    const phage = makePhage([]);
    phage.id = 42;
    phage.name = 'Lambda';

    const result = analyzeTailFiberTropism(phage);

    expect(result.phageId).toBe(42);
    expect(result.phageName).toBe('Lambda');
  });

  test('handles precomputed predictions', () => {
    const phage = makePhage([]);
    const precomputed = [
      {
        geneId: 1,
        locusTag: 'gene_1',
        receptor: 'LamB (maltoporin)',
        confidence: 0.9,
        evidence: ['lamb', 'maltoporin'],
        startPos: 0,
        endPos: 1000,
        strand: '+',
        product: 'Tail fiber protein gp37',
        aaLength: 300,
      },
    ];

    const result = analyzeTailFiberTropism(phage, '', precomputed);

    expect(result.source).toBe('precomputed');
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].receptorCandidates[0].receptor).toBe('LamB (maltoporin)');
    expect(result.hits[0].receptorCandidates[0].confidence).toBe(0.9);
  });

  test('multi-receptor breadth for multiple different receptors', () => {
    const phage = makePhage([]);
    const precomputed = [
      {
        geneId: 1,
        locusTag: 'gene_1',
        receptor: 'LamB (maltoporin)',
        confidence: 0.8,
      },
      {
        geneId: 2,
        locusTag: 'gene_2',
        receptor: 'OmpC',
        confidence: 0.7,
      },
    ];

    const result = analyzeTailFiberTropism(phage, '', precomputed);

    expect(result.breadth).toBe('multi-receptor');
  });

  test('receptor candidates have required properties', () => {
    const phage = makePhage([
      makeGene('polysaccharide lyase tailspike', 0, 1500),
    ]);

    const result = analyzeTailFiberTropism(phage);

    if (result.hits.length > 0 && result.hits[0].receptorCandidates.length > 0) {
      const candidate = result.hits[0].receptorCandidates[0];
      expect(candidate).toHaveProperty('receptor');
      expect(candidate).toHaveProperty('confidence');
      expect(candidate).toHaveProperty('evidence');
      expect(typeof candidate.receptor).toBe('string');
      expect(typeof candidate.confidence).toBe('number');
      expect(Array.isArray(candidate.evidence)).toBe(true);
    }
  });

  test('confidence values are between 0 and 1', () => {
    const phage = makePhage([
      makeGene('tail fiber protein', 0, 1000),
      makeGene('receptor binding protein', 1000, 2000),
      makeGene('tailspike depolymerase', 2000, 3500),
    ]);

    const result = analyzeTailFiberTropism(phage);

    for (const hit of result.hits) {
      for (const candidate of hit.receptorCandidates) {
        expect(candidate.confidence).toBeGreaterThanOrEqual(0);
        expect(candidate.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  test('identifies gp37 as tail fiber gene', () => {
    const phage = makePhage([
      makeGene('gp37 long tail fiber', 0, 3000),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.hits.length).toBe(1);
  });

  test('identifies gp38 as tail fiber gene', () => {
    const phage = makePhage([
      makeGene('gp38 adhesin', 0, 500),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.hits.length).toBe(1);
  });

  test('computes structuralAnalysis for tail fiber genes with domains and residue metrics', () => {
    const phage = makePhage([
      makeGene('gp37 long tail fiber', 0, 3000),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.structuralAnalysis).toBeDefined();
    expect(result.structuralAnalysis).not.toBeNull();
    expect(result.structuralAnalysis?.domains.length).toBe(3);
    expect(result.structuralAnalysis?.receptorScores.length).toBeGreaterThan(0);
    expect(result.structuralAnalysis?.residues.length).toBeGreaterThan(0);
    expect(result.structuralAnalysis?.chimeraSuggestions.length).toBeGreaterThan(0);
  });
});

