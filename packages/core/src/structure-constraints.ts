import type { GeneInfo, AminoAcid } from './types';
import { translateSequence, reverseComplement } from './codons';

// Lightweight structural fragility heuristics for capsid/tail proteins.
// Intent: provide fast, no-dependency scoring to highlight fragile regions and
// risky mutations, not to replace detailed structural models.

export interface ResidueConstraint {
  position: number;
  aa: AminoAcid;
  fragility: number; // 0 (robust) .. 1 (fragile)
  warnings: string[];
}

export interface ProteinConstraint {
  geneId: number;
  name: string;
  locusTag: string | null;
  role: 'capsid' | 'tail' | 'structural' | 'other';
  avgFragility: number;
  residues: ResidueConstraint[];
  hotspots: ResidueConstraint[];
}

export interface StructuralConstraintReport {
  proteins: ProteinConstraint[];
}

const HYDROPHOBICITY: Record<AminoAcid, number> = {
  A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5, Q: -3.5, E: -3.5, G: -0.4,
  H: -3.2, I: 4.5, L: 3.8, K: -3.9, M: 1.9, F: 2.8, P: -1.6, S: -0.8,
  T: -0.7, W: -0.9, Y: -1.3, V: 4.2, '*': -5, X: -1,
};

const VOLUME: Record<AminoAcid, number> = {
  A: 88.6, R: 173.4, N: 114.1, D: 111.1, C: 108.5, Q: 143.8, E: 138.4, G: 60.1,
  H: 153.2, I: 166.7, L: 166.7, K: 168.6, M: 162.9, F: 189.9, P: 112.7, S: 89.0,
  T: 116.1, W: 227.8, Y: 193.6, V: 140.0, '*': 0, X: 120.0,
};

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

function classifyRole(gene: GeneInfo): ProteinConstraint['role'] {
  const label = `${gene.product ?? ''} ${gene.name ?? ''}`.toLowerCase();
  if (label.includes('capsid') || label.includes('coat')) return 'capsid';
  if (label.includes('tail')) return 'tail';
  if (label.includes('portal') || label.includes('baseplate')) return 'structural';
  return 'other';
}

function computeResidueFragility(sequence: string): ResidueConstraint[] {
  const residues: ResidueConstraint[] = [];
  const minHydro = Math.min(...Object.values(HYDROPHOBICITY));
  const maxHydro = Math.max(...Object.values(HYDROPHOBICITY));
  const minVol = Math.min(...Object.values(VOLUME));
  const maxVol = Math.max(...Object.values(VOLUME));

  for (let i = 0; i < sequence.length; i++) {
    const aa = sequence[i] as AminoAcid;
    const hydro = HYDROPHOBICITY[aa] ?? -1;
    const vol = VOLUME[aa] ?? 120;
    const hydrophobicityScore = normalize(hydro, minHydro, maxHydro); // higher = hydrophobic
    const volumeScore = normalize(vol, minVol, maxVol);

    // Penalize gly/proline for structural kinks, boost charged/hydrophilic as more flexible
    const isGly = aa === 'G';
    const isPro = aa === 'P';
    const flexibilityBonus = (isGly ? 0.25 : 0) + (isPro ? 0.2 : 0);

    // Fragility: higher when hydrophobic (likely buried) and bulky; reduce if flexible
    const fragility = Math.min(1, Math.max(0, 0.55 * hydrophobicityScore + 0.35 * volumeScore - flexibilityBonus));

    const warnings: string[] = [];
    if (fragility > 0.7) warnings.push('fragile');
    if (isPro) warnings.push('proline kink');
    if (isGly) warnings.push('glycine flex');

    residues.push({
      position: i,
      aa,
      fragility,
      warnings,
    });
  }

  return residues;
}

export function analyzeStructuralConstraints(
  genomeSequence: string,
  genes: GeneInfo[]
): StructuralConstraintReport {
  const proteins: ProteinConstraint[] = [];

  for (const gene of genes) {
    const role = classifyRole(gene);
    if (role === 'other') continue; // focus on structural genes
    const start = Math.max(0, gene.startPos);
    const end = Math.min(genomeSequence.length, gene.endPos);
    if (end <= start) continue;

    const rawGeneSeq = genomeSequence.slice(start, end);
    const geneSeq = gene.strand && gene.strand.startsWith('-') ? reverseComplement(rawGeneSeq) : rawGeneSeq;
    const aaSeq = translateSequence(geneSeq, 0);
    if (!aaSeq.length) continue;

    const residues = computeResidueFragility(aaSeq);
    const avgFragility = residues.reduce((sum, r) => sum + r.fragility, 0) / residues.length;
    const hotspots = [...residues]
      .sort((a, b) => b.fragility - a.fragility)
      .slice(0, 5);

    proteins.push({
      geneId: gene.id,
      name: gene.name ?? gene.product ?? 'Unnamed protein',
      locusTag: gene.locusTag,
      role,
      avgFragility,
      residues,
      hotspots,
    });
  }

  return { proteins };
}

export function predictMutationEffect(
  original: AminoAcid,
  mutated: AminoAcid,
  localFragility: number
): {
  deltaStability: number;
  contactPenalty: number;
  volumeChange: number;
  allowed: boolean;
} {
  const hydroDelta = Math.abs((HYDROPHOBICITY[mutated] ?? 0) - (HYDROPHOBICITY[original] ?? 0));
  const volDelta = Math.abs((VOLUME[mutated] ?? 0) - (VOLUME[original] ?? 0)) / 100;
  const contactPenalty = Math.min(1, hydroDelta / 9);
  const volumeChange = Math.min(1, volDelta);
  const deltaStability = Math.min(1, 0.45 * contactPenalty + 0.35 * volumeChange + 0.2 * localFragility);
  return {
    deltaStability,
    contactPenalty,
    volumeChange,
    allowed: deltaStability < 0.6,
  };
}