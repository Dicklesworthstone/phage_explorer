import { describe, expect, it } from 'bun:test';
import type { PhageFull } from '@phage-explorer/core';
import {
  analyzeHostInteractions,
  CANONICAL_HOST_TARGETS,
} from '@phage-explorer/core';
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
        startPos: 1000,
        endPos: 3500,
        strand: '+',
        product: 'long tail fiber distal subunit receptor binding adhesin',
        type: 'CDS',
      },
      {
        id: 38,
        name: 'gp38',
        locusTag: 'T4_038',
        startPos: 3600,
        endPos: 4200,
        strand: '+',
        product: 'tail fiber adhesin receptor recognition protein',
        type: 'CDS',
      },
      {
        id: 50,
        name: 'AsiA',
        locusTag: 'T4_050',
        startPos: 15000,
        endPos: 15300,
        strand: '-',
        product: 'anti-sigma factor 70 transcription inhibitor',
        type: 'CDS',
      },
      {
        id: 60,
        name: 'MazG',
        locusTag: 'T4_060',
        startPos: 22000,
        endPos: 22800,
        strand: '+',
        product: 'pyrophosphohydrolase abortive infection evasion',
        type: 'CDS',
      },
    ],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Host-Phage Protein Interaction & Effector Docking Map (Web Integration)', () => {
  it('registers ActionIds.OverlayHostInteractions in keyboard action registry with Alt+I', () => {
    const action = ActionRegistry[ActionIds.OverlayHostInteractions];
    expect(action).toBeDefined();
    expect(action.title).toBe('Host interactions');
    expect(action.category).toBe('Analysis');
    expect(action.overlayId).toBe('hostInteractions');
    expect(action.overlayAction).toBe('toggle');
    expect(action.provenance).toBe('heuristic');

    const shortcut = Array.isArray(action.defaultShortcut)
      ? action.defaultShortcut[0]
      : action.defaultShortcut;
    if ('key' in shortcut) {
      expect(shortcut.key).toBe('i');
      expect(shortcut.modifiers?.alt).toBe(true);
    } else {
      expect.unreachable();
    }
  });

  it('runs multi-evidence interaction analysis and constructs bipartite network', () => {
    const phage = createMockPhage();
    const result = analyzeHostInteractions(phage);

    expect(result.totalInteractions).toBeGreaterThan(0);
    expect(result.bipartiteNodes.length).toBeGreaterThan(0);
    expect(result.bipartiteEdges.length).toBe(result.totalInteractions);

    // Verify receptor binding interactions (gp37/gp38 with OmpC/OmpF)
    const receptorLinks = result.interactions.filter((i) => i.functionalRole === 'receptor-binding');
    expect(receptorLinks.length).toBeGreaterThan(0);
    expect(receptorLinks.some((l) => l.hostProteinId === 'OmpC' || l.hostProteinId === 'OmpF')).toBe(true);

    // Verify transcription takeover (AsiA with RpoD_sigma70)
    const transcriptionLinks = result.interactions.filter((i) => i.functionalRole === 'transcription-takeover');
    expect(transcriptionLinks.length).toBeGreaterThan(0);
    expect(transcriptionLinks.some((l) => l.hostProteinId === 'RpoD_sigma70')).toBe(true);

    // Verify evidence levels
    expect(result.interactionsByEvidence.high + result.interactionsByEvidence.medium).toBeGreaterThan(0);
  });

  it('evaluates docking interfaces with buried surface area, deltaG, and Kd', () => {
    const phage = createMockPhage();
    const result = analyzeHostInteractions(phage);

    for (const inter of result.interactions) {
      expect(inter.dockingFootprint.buriedSurfaceAreaA2).toBeGreaterThanOrEqual(800);
      expect(inter.dockingFootprint.estimatedDeltaG_kcal_mol).toBeLessThan(0); // Spontaneous binding
      expect(inter.dockingFootprint.estimatedKd_nM).toBeGreaterThan(0);
      expect(inter.dockingFootprint.phageResidueWindow).toBeDefined();
      expect(inter.dockingFootprint.hostResidueWindow).toBeDefined();
    }
  });

  it('generates in-silico effector mutations with predicted affinity gains', () => {
    const phage = createMockPhage();
    const result = analyzeHostInteractions(phage);

    expect(result.inSilicoEngineeringCandidates.length).toBeGreaterThanOrEqual(2);
    for (const cand of result.inSilicoEngineeringCandidates) {
      expect(cand.deltaDeltaG).toBeLessThan(0); // Favorable affinity shift
      expect(cand.engineeredDeltaG).toBeLessThan(cand.baselineDeltaG);
      expect(cand.predictedFoldAffinityChange).toBeGreaterThan(1.0);
      expect(cand.structuralRationale.length).toBeGreaterThan(10);
    }
  });

  it('supports host organism filtering', () => {
    const phage = createMockPhage();

    const ecoliResult = analyzeHostInteractions(phage, CANONICAL_HOST_TARGETS, {
      hostOrganism: 'Escherichia coli',
    });
    expect(ecoliResult.totalInteractions).toBeGreaterThan(0);
    for (const inter of ecoliResult.interactions) {
      expect(inter.hostOrganism).toContain('Escherichia coli');
    }

    const pseudoResult = analyzeHostInteractions(phage, CANONICAL_HOST_TARGETS, {
      hostOrganism: 'Pseudomonas aeruginosa',
    });
    for (const inter of pseudoResult.interactions) {
      expect(inter.hostOrganism).toContain('Pseudomonas aeruginosa');
    }
  });

  it('handles phages without genes gracefully', () => {
    const emptyPhage = createMockPhage({ genes: [] });
    const result = analyzeHostInteractions(emptyPhage);

    expect(result.totalInteractions).toBe(0);
    expect(result.bipartiteNodes.length).toBe(0);
    expect(result.bipartiteEdges.length).toBe(0);
    expect(result.summary).toContain('Identified 0 candidate effector interactions');
  });
});
