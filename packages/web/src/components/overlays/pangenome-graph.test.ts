import { describe, expect, it } from 'bun:test';
import type { PhageFull } from '@phage-explorer/core';
import { constructPangenomeGraph } from '@phage-explorer/core';
import { ActionIds, ActionRegistry } from '../../keyboard';

function createMockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 101,
    slug: 'enterobacteria-phage-t4',
    name: 'Enterobacteria phage T4',
    accession: 'NC_000866',
    family: 'Myoviridae',
    host: 'Escherichia coli',
    genomeLength: 168903,
    gcContent: 35.3,
    morphology: 'myovirus',
    lifecycle: 'lytic',
    description: null,
    baltimoreGroup: 'I',
    genomeType: 'dsDNA',
    pdbIds: ['1YFP', '2XGF'],
    genes: [
      {
        id: 37,
        name: 'gp37',
        locusTag: 'T4_037',
        startPos: 135000,
        endPos: 138500,
        strand: '+',
        product: 'long tail fiber distal subunit receptor binding adhesin',
        type: 'CDS',
      },
      {
        id: 38,
        name: 'gp38',
        locusTag: 'T4_038',
        startPos: 138600,
        endPos: 139200,
        strand: '+',
        product: 'tail fiber adhesin receptor recognition protein',
        type: 'CDS',
      },
    ],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Pangenome illustration API and action registry (not browser proof)', () => {
  it('registers ActionIds.OverlayPangenomeGraph in keyboard action registry with Shift+P', () => {
    const action = ActionRegistry[ActionIds.OverlayPangenomeGraph];
    expect(action).toBeDefined();
    expect(action.title).toBe('Pangenome graph');
    expect(action.category).toBe('Education');
    expect(action.overlayId).toBe('pangenomeGraph');
    expect(action.overlayAction).toBe('toggle');
    expect(action.provenance).toBe('demo');

    const shortcut = Array.isArray(action.defaultShortcut)
      ? action.defaultShortcut[0]
      : action.defaultShortcut;
    if ('key' in shortcut) {
      expect(shortcut.key.toUpperCase()).toBe('P');
      expect(shortcut.modifiers?.shift).toBe(true);
    } else {
      expect.unreachable();
    }
  });

  it('runs variation graph pangenome construction for comparative visualization', () => {
    const phage = createMockPhage();
    const result = constructPangenomeGraph(phage, [], { demonstration: true });

    expect(result.includedGenomesCount).toBeGreaterThanOrEqual(4);
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.variantCards.length).toBeGreaterThan(0);

    // Verify core backbone and variant bubble topology
    const coreSegments = result.segments.filter((s) => s.isCore);
    expect(coreSegments.length).toBeGreaterThan(0);
    expect(coreSegments.every((s) => s.frequency === 1.0)).toBe(true);

    const variantSegments = result.segments.filter((s) => !s.isCore);
    expect(variantSegments.length).toBeGreaterThan(0);
  });

  it('provides structured variant cards with net length delta, GC shift, and breakpoints', () => {
    const phage = createMockPhage();
    const result = constructPangenomeGraph(phage, [], { demonstration: true });

    for (const card of result.variantCards) {
      expect(card.id).toMatch(/^var-bubble-\d+$/);
      expect(card.bubbleIndex).toBeGreaterThan(0);
      expect(card.locusStartBp).toBeLessThan(card.locusEndBp);
      expect(card.spanBp).toBe(card.locusEndBp - card.locusStartBp);
      expect(typeof card.netLengthDeltaBp).toBe('number');
      expect(typeof card.gcShift).toBe('number');
      expect(card.functionalSignificance.length).toBeGreaterThan(5);
      expect(card.recombinationBreakpoints.leftBreakpointBp).toBe(card.locusStartBp);
      expect(card.recombinationBreakpoints.rightBreakpointBp).toBe(card.locusEndBp);
    }
  });

  it('identifies HGT candidates based on |ΔGC| >= 4.0%', () => {
    const phage = createMockPhage();
    const result = constructPangenomeGraph(phage, [], { demonstration: true });

    const hgtCards = result.variantCards.filter((c) => c.isHgtCandidate);
    expect(hgtCards.length).toBeGreaterThan(0);
    for (const card of hgtCards) {
      expect(Math.abs(card.gcShift)).toBeGreaterThanOrEqual(4.0);
      expect(card.donorLineageHints.length).toBeGreaterThan(0);
    }
  });

  it('computes Heaps law openness alpha and recombination hotspots', () => {
    const phage = createMockPhage();
    const result = constructPangenomeGraph(phage, [], { demonstration: true });
    const { metrics } = result;

    expect(metrics.coreFraction).toBeGreaterThan(0);
    expect(metrics.coreFraction).toBeLessThan(1);
    expect(metrics.opennessAlpha).toBeGreaterThan(0);
    expect(metrics.recombinationHotspots.length).toBeGreaterThan(0);

    for (const hotspot of metrics.recombinationHotspots) {
      expect(hotspot.id).toBeDefined();
      expect(hotspot.diversityScore).toBeGreaterThanOrEqual(50);
      expect(hotspot.associatedFunctionalModule.length).toBeGreaterThan(5);
    }
  });

  it('handles phages without annotated genes gracefully', () => {
    const emptyPhage = createMockPhage({ genes: [] });
    const result = constructPangenomeGraph(emptyPhage, [], { demonstration: true });

    expect(result.includedGenomesCount).toBeGreaterThanOrEqual(4);
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.variantCards.length).toBeGreaterThan(0);
  });
});
