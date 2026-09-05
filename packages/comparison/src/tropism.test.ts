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

  test('retains the structural illustration only after explicit opt-in', () => {
    const phage = makePhage([
      makeGene('gp37 long tail fiber', 0, 3000),
    ]);

    const result = analyzeTailFiberTropism(phage);

    expect(result.structuralAnalysis).toBeNull();
    expect(result.sequenceAnalysis).toBeNull();
    const demo = analyzeTailFiberTropism(phage, '', [], { demonstration: true });
    expect(demo.structuralAnalysis?.source).toBe('demonstration');
    expect(demo.structuralAnalysis?.domains.length).toBe(3);
    expect(demo.structuralAnalysis?.receptorScores.length).toBeGreaterThan(0);
    expect(demo.structuralAnalysis?.residues.length).toBeGreaterThan(0);
    expect(demo.structuralAnalysis?.chimeraSuggestions.length).toBeGreaterThan(0);
  });

  test.each(['+', '-'])('uses the actual %s CDS even when predictions were precomputed', strand => {
    const gene = { ...makeGene('tail fiber', 3, 15, 'fiber'), strand };
    const phage = makePhage([gene]);
    // Independently encoded MKR* on either strand, surrounded by non-CDS bases.
    const genome = strand === '+' ? 'GGGATGAAAAGATAACCC' : 'GGGTTATCTTTTCATCCC';
    const predictions = [{ geneId: gene.id, locusTag: gene.locusTag, receptor: 'LamB', confidence: 0.7 }];
    const result = analyzeTailFiberTropism(phage, genome, predictions);
    expect(result.source).toBe('precomputed');
    expect(result.hits[0].gene.name).toBe('fiber');
    expect(result.sequenceAnalysis?.sequence).toBe('MKR');
    expect(result.sequenceAnalysis?.residues.map(r => r.hydropathy)).toEqual([1.9, -3.9, -4.5]);
    expect(result.structuralAnalysis).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/ddgAlaScan|affinityScore|chimeraSuggestions/);
  });

  test.each([
    { startPos: -1, endPos: 8, strand: '+' },
    { startPos: 0, endPos: 12, strand: '+' },
    { startPos: 0, endPos: 8, strand: '+' },
    { startPos: 0, endPos: 9, strand: null },
  ])('does not invent a protein for an incomplete or invalid CDS %p', coordinates => {
    const gene = { ...makeGene('tail fiber', 0, 9), ...coordinates };
    const result = analyzeTailFiberTropism(makePhage([gene]), 'ATGAAAAGA');
    expect(result.hits).toHaveLength(1);
    expect(result.sequenceAnalysis).toBeNull();
    expect(result.structuralAnalysis).toBeNull();
  });

  test('prefers deposited translation for joined or recoded CDS instead of synthesizing a replacement', () => {
    const gene = { ...makeGene('tail fiber', 0, 9), qualifiers: {
      translation: 'M U K', transl_table: '4', transl_except: '(pos:4..6,aa:Sec)', _segments: '[{"start":0,"end":3}]',
    } };
    const phage = makePhage([gene]);
    const result = analyzeTailFiberTropism(phage, 'ATGAAAAGA');
    expect(result.sequenceSource).toBe('deposited_translation');
    expect(result.sequenceAnalysis?.sequence).toBe('MUK');
    expect(result.sequenceAnalysis?.residues[1].hydropathy).toBeNull();
    expect(result.structuralAnalysis).toBeNull();
  });

  test.each([
    { transl_table: '4' }, { transl_except: '(pos:4..6,aa:Sec)' }, { _segments: '[{"start":0,"end":3}]' },
  ])('preserves receptor cues without inventing translation for unsupported qualifiers %p', qualifiers => {
    const gene = { ...makeGene('tail fiber', 0, 9), qualifiers };
    const result = analyzeTailFiberTropism(makePhage([gene]), 'ATGAAAAGA');
    expect(result.hits).toHaveLength(1);
    expect(result.sequenceAnalysis).toBeNull();
  });

  test('applies codon_start after orienting the CDS', () => {
    const gene = { ...makeGene('tail fiber', 0, 10), qualifiers: { codon_start: '2', transl_table: '11' } };
    expect(analyzeTailFiberTropism(makePhage([gene]), 'CATGAAAAGA').sequenceAnalysis?.sequence).toBe('MKR');
  });

  test('matches the exact predicted CDS before an earlier gene feature sharing its locus tag', () => {
    const cds = { ...makeGene('tail fiber', 0, 9), qualifiers: { translation: 'MKW' } };
    const feature = { ...cds, id: cds.id + 1, type: 'gene', qualifiers: { gene: 'fiber' } };
    const phage = makePhage([feature, cds]);
    const result = analyzeTailFiberTropism(phage, 'ATGAAAAGA', [{ geneId: cds.id, locusTag: cds.locusTag, receptor: 'LamB', confidence: 0.7 }]);
    expect(result.hits[0].gene.id).toBe(cds.id);
    expect(result.sequenceSource).toBe('deposited_translation');
    expect(result.sequenceAnalysis?.sequence).toBe('MKW');
  });
});
