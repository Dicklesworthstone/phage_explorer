/**
 * tail-fiber-structure.ts
 *
 * Roadmap #3: Structural Epitope Clash Map (Tail Fiber Host Range Analyzer)
 *
 * Combines structural biophysics and sequence entropy to model phage tail fiber
 * receptor-binding domains (RBDs):
 * 1. Per-position Shannon entropy H(i) across homologs to locate conserved anchors vs hypervariable tips.
 * 2. Modular domain boundary detection (N-terminal anchor, shaft repeats, distal RBD).
 * 3. Structural stability (Delta-Delta-G alanine scanning), surface exposure (SASA), and electrostatics.
 * 4. Bacterial surface receptor clash & affinity scoring (LamB, OmpC, TonB/FhuA, BtuB, LPS).
 * 5. In-silico point mutation simulator and modular chimera swap recommendations.
 */

import type { PhageFull, GeneInfo } from '../types';

export type TailFiberDomainType = 'n_anchor' | 'shaft' | 'distal_rbd';

export interface FiberDomain {
  type: TailFiberDomainType;
  name: string;
  startResidue: number; // 1-indexed
  endResidue: number;   // 1-indexed
  length: number;
  meanEntropy: number;
  meanSasa: number;
  meanDdg: number;
  structuralClass: string;
  description: string;
}

export interface ResidueEpitopeMetric {
  position: number; // 1-indexed amino acid
  aminoAcid: string;
  entropy: number; // Shannon entropy H(i) in bits [0 .. 4.32]
  sasa: number; // Solvent accessible surface area [0 .. 100%]
  ddgAlaScan: number; // kcal/mol (>2.0 structurally critical/intolerant, 0..1.5 tolerant, <0 destabilizing WT)
  charge: number; // Formal charge at pH 7.4 (-1, 0, +1)
  hydropathy: number; // Kyte-Doolittle scale (-4.5 .. +4.5)
  domain: TailFiberDomainType;
  isHypervariableEpitope: boolean; // Hotspot for diversifying selection (arms race)
  isEssentialAnchor: boolean; // Structurally constrained residue
  clashRisk: 'low' | 'moderate' | 'high' | 'critical';
}

export interface BacterialReceptorTarget {
  id: string;
  name: string;
  category: 'porin' | 'transporter' | 'polysaccharide' | 'appendage';
  chargeProfile: 'predominantly_negative' | 'zwitterionic' | 'amphipathic_polar' | 'hydrophobic_groove';
  primaryHost: string;
  keyResiduesOrEpitopes: string[];
  stericTolerance: number; // 0..1 scale
}

export interface ReceptorBindingScore {
  receptorId: string;
  receptorName: string;
  category: string;
  affinityScore: number; // 0..100
  electrostaticFit: number; // -1..+1
  stericClashScore: number; // 0 (no clash) .. 100 (severe collision)
  compatibilityRank: number;
  interactionEvidence: string[];
}

export interface MutationSimulationResult {
  position: number;
  wildType: string;
  mutant: string;
  ddgDelta: number; // Stability shift (kcal/mol)
  clashPenalty: number; // 0..100
  affinityDeltas: Record<string, number>; // receptorId -> delta %
  predictedHostImpact: string;
}

export interface ChimeraEngineeringSuggestion {
  donorPhage: string;
  donorProtein: string;
  junctionResidue: number;
  rbdRange: [number, number];
  targetReceptor: string;
  predictedHost: string;
  feasibilityScore: number; // 0..100
  rationale: string;
}

export interface TailFiberStructuralAnalysis {
  /** This model has no measured structure, homolog alignment or calibrated affinity. */
  source: 'demonstration';
  assumptions: string;
  phageId: number;
  phageName: string;
  geneId: number;
  geneName: string;
  locusTag: string;
  product: string;
  sequenceLength: number;
  domains: FiberDomain[];
  residues: ResidueEpitopeMetric[];
  meanEntropy: number;
  hypervariableHotspots: number[];
  receptorScores: ReceptorBindingScore[];
  predictedHosts: {
    hostName: string;
    confidence: number;
    primaryReceptors: string[];
  }[];
  chimeraSuggestions: ChimeraEngineeringSuggestion[];
  summary: string;
}

/** Descriptors calculated directly from an explicitly supplied protein sequence. */
export interface TailFiberSequenceAnalysis {
  phageId: number;
  geneId: number;
  geneName: string;
  sequence: string;
  residues: Array<{ position: number; aminoAcid: string; hydropathy: number | null }>;
  meanHydropathy: number | null;
  method: string;
}

export function analyzeTailFiberSequence(
  phage: PhageFull,
  gene: GeneInfo | null | undefined,
  sequence: string | null | undefined
): TailFiberSequenceAnalysis | null {
  if (!gene || !sequence) return null;
  const protein = sequence.toUpperCase().replace(/\*$/, '');
  if (!protein || !/^[ACDEFGHIKLMNPQRSTVWYXBZJUO]+$/.test(protein)) return null;
  const residues = Array.from(protein, (aminoAcid, index) => ({
    position: index + 1,
    aminoAcid,
    hydropathy: KYTE_DOOLITTLE[aminoAcid] ?? null,
  }));
  // Unknown residues are missing observations, not neutral hydropathy.
  const known = residues.filter((r): r is typeof r & { hydropathy: number } => r.hydropathy !== null);
  return {
    phageId: phage.id,
    geneId: gene.id,
    geneName: gene.name ?? gene.locusTag ?? `gene_${gene.id}`,
    sequence: protein,
    residues,
    meanHydropathy: known.length === residues.length
      ? known.reduce((sum, r) => sum + r.hydropathy, 0) / known.length : null,
    method: 'Kyte–Doolittle residue hydropathy from the supplied protein sequence; no structural or host-range inference.',
  };
}

// Kyte-Doolittle hydropathy scale
export const KYTE_DOOLITTLE: Record<string, number> = {
  I: 4.5, V: 4.2, L: 3.8, F: 2.8, C: 2.5, M: 1.9, A: 1.8,
  G: -0.4, T: -0.7, S: -0.8, W: -0.9, Y: -1.3, P: -1.6,
  H: -3.2, E: -3.5, Q: -3.5, D: -3.5, N: -3.5, K: -3.9, R: -4.5,
};

// Formal charge at physiological pH (7.4)
export const RESIDUE_CHARGES: Record<string, number> = {
  R: 1.0, K: 1.0, H: 0.1,
  D: -1.0, E: -1.0,
  A: 0, C: 0, F: 0, G: 0, I: 0, L: 0, M: 0, N: 0, P: 0, Q: 0, S: 0, T: 0, V: 0, W: 0, Y: 0,
};

// Baseline alanine-scanning Delta-Delta-G free energy perturbation (kcal/mol)
export const ALANINE_SCAN_BASELINE_DDG: Record<string, number> = {
  W: 4.2, F: 3.8, Y: 3.2, L: 3.5, I: 3.4, V: 2.8, M: 2.6,
  R: 3.0, K: 2.2, H: 1.8, D: 2.0, E: 1.9, Q: 1.5, N: 1.4,
  P: 3.5, C: 2.5, T: 1.2, S: 0.9, G: 0.0, A: 0.0,
};

// Canonical bacterial surface receptors
export const BACTERIAL_SURFACE_RECEPTORS: BacterialReceptorTarget[] = [
  {
    id: 'lamb',
    name: 'LamB (maltoporin)',
    category: 'porin',
    chargeProfile: 'amphipathic_polar',
    primaryHost: 'Escherichia coli',
    keyResiduesOrEpitopes: ['Loop L6', 'Loop L9', 'Aromatic vestibule (Y118, W358)'],
    stericTolerance: 0.65,
  },
  {
    id: 'ompc',
    name: 'OmpC (outer membrane porin C)',
    category: 'porin',
    chargeProfile: 'predominantly_negative',
    primaryHost: 'Escherichia coli',
    keyResiduesOrEpitopes: ['Extracellular loop L4', 'Loop L5', 'Acidic pocket (D192, E201)'],
    stericTolerance: 0.55,
  },
  {
    id: 'tonb_fhua',
    name: 'FhuA / TonB-dependent receptor',
    category: 'transporter',
    chargeProfile: 'amphipathic_polar',
    primaryHost: 'Escherichia coli',
    keyResiduesOrEpitopes: ['Gating loop 4', 'Cork domain apex', 'Ferric-hydroxamate groove'],
    stericTolerance: 0.50,
  },
  {
    id: 'btub',
    name: 'BtuB (vitamin B12 transporter)',
    category: 'transporter',
    chargeProfile: 'amphipathic_polar',
    primaryHost: 'Escherichia coli',
    keyResiduesOrEpitopes: ['Extracellular loops 2 & 3', 'Cobalamin vestibule'],
    stericTolerance: 0.60,
  },
  {
    id: 'lps_core',
    name: 'LPS Core / O-Antigen',
    category: 'polysaccharide',
    chargeProfile: 'predominantly_negative',
    primaryHost: 'Salmonella / E. coli / Pseudomonas',
    keyResiduesOrEpitopes: ['Heptose phosphate core', 'O-antigen repeat units', 'KDO sugar'],
    stericTolerance: 0.85,
  },
  {
    id: 'type_iv_pilus',
    name: 'Type IV Pilus (PilA)',
    category: 'appendage',
    chargeProfile: 'hydrophobic_groove',
    primaryHost: 'Pseudomonas aeruginosa',
    keyResiduesOrEpitopes: ['PilA helical groove', 'C-terminal receptor loop'],
    stericTolerance: 0.45,
  },
];

/**
 * Identify whether a gene represents a tail fiber or receptor-binding protein
 */
export function isTailFiberCandidate(gene: GeneInfo): boolean {
  const combined = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
  if (/\b(tail\s*fiber|tail\s*fibre|tailspike|tail\s*spike|receptor[- ]binding|rbp|gp37|gp38|gp12|gpj|fibritin|baseplate\s*wedge)\b/i.test(combined)) {
    return true;
  }
  if (gene.domains) {
    const pfam = gene.domains.join(' ');
    if (/PF03906|PF06605|PF07484|PF09404|PF10531|PF13885/i.test(pfam)) {
      return true;
    }
  }
  return false;
}

/**
 * Calculate per-position Shannon entropy H(i) = -Sum p(a) * log2(p(a))
 */
export function calculatePositionEntropy(column: string[]): number {
  const validChars = column.filter((c) => c !== '-' && c !== 'X' && c !== '*' && c !== ' ' && c !== '');
  if (validChars.length <= 1) return 0.0;

  const counts: Record<string, number> = {};
  for (const c of validChars) {
    counts[c] = (counts[c] ?? 0) + 1;
  }

  let entropy = 0.0;
  const total = validChars.length;
  for (const count of Object.values(counts)) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return Math.round(entropy * 1000) / 1000;
}

/**
 * Generate empirical/simulated homolog alignment columns for target fiber sequence
 * anchored by tail fiber structural domain rules (conserved N-terminal anchor,
 * repetitive shaft, hypervariable distal tip).
 */
export function generateFiberHomologColumns(sequence: string): string[][] {
  const n = sequence.length;
  const columns: string[][] = [];

  for (let i = 0; i < n; i++) {
    const wt = sequence[i].toUpperCase();
    const relPos = (i + 1) / Math.max(1, n);

    // Structural constraint model:
    // N-anchor (relPos < 0.25): highly conserved (low variability)
    // Shaft (0.25 <= relPos < 0.65): moderate variability, coiled-coil periodicity
    // Distal RBD (relPos >= 0.65): high diversification rate under immune / host receptor arms race
    let mutationProb = 0.05;
    if (relPos >= 0.65) {
      mutationProb = 0.55 + 0.35 * Math.sin(i * 0.7); // High entropy peaks in loops
    } else if (relPos >= 0.25) {
      mutationProb = 0.20 + 0.15 * (i % 7 === 0 || i % 7 === 3 ? 0.05 : 0.30); // heptad repeat pattern
    }

    const col: string[] = [wt];
    const candidateAAs = ['A', 'S', 'T', 'N', 'D', 'E', 'K', 'R', 'Q', 'V', 'L', 'I', 'F', 'Y'];

    // Sample 12 homologous sequences
    for (let s = 0; s < 12; s++) {
      const rand = ((i * 37 + s * 19 + wt.charCodeAt(0)) % 100) / 100;
      if (rand < mutationProb) {
        const altIdx = (i * 7 + s * 13 + rand * 100) % candidateAAs.length;
        col.push(candidateAAs[Math.floor(altIdx)]);
      } else {
        col.push(wt);
      }
    }
    columns.push(col);
  }

  return columns;
}

/**
 * Smooth an array using a moving average window
 */
function smoothArray(arr: number[], windowSize: number): number[] {
  const result: number[] = [];
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
      sum += arr[j];
      count++;
    }
    result.push(sum / count);
  }
  return result;
}

/**
 * Detect domain boundaries: N-terminal anchor, shaft, distal RBD
 */
export function detectFiberDomainBoundaries(
  sequenceLength: number,
  smoothedEntropy: number[],
  _hydropathy: number[]
): FiberDomain[] {
  const len = Math.max(sequenceLength, smoothedEntropy.length);
  if (len < 15) {
    return [
      {
        type: 'distal_rbd',
        name: 'Receptor-Binding Domain',
        startResidue: 1,
        endResidue: len,
        length: len,
        meanEntropy: 1.5,
        meanSasa: 50,
        meanDdg: 1.5,
        structuralClass: 'Globular / Beta-sheet',
        description: 'Short peptide tail fiber fragment',
      },
    ];
  }

  // Anchor boundary: typically 15-28% of sequence where entropy stays low
  let anchorEnd = Math.floor(len * 0.22);
  // Find local gradient peak near 15%-30%
  let maxGrad = 0;
  for (let i = Math.floor(len * 0.15); i < Math.floor(len * 0.32); i++) {
    const grad = Math.abs(smoothedEntropy[i] - smoothedEntropy[Math.max(0, i - 10)]);
    if (grad > maxGrad) {
      maxGrad = grad;
      anchorEnd = i;
    }
  }

  // Shaft boundary: typically 55-75% of sequence where entropy transitions to high hypervariable peak
  let shaftEnd = Math.floor(len * 0.65);
  maxGrad = 0;
  for (let i = Math.floor(len * 0.55); i < Math.floor(len * 0.78); i++) {
    const grad = smoothedEntropy[i] - (smoothedEntropy[Math.max(0, i - 15)] ?? 0);
    if (grad > maxGrad) {
      maxGrad = grad;
      shaftEnd = i;
    }
  }

  if (anchorEnd < 5) anchorEnd = Math.max(5, Math.floor(len * 0.2));
  if (shaftEnd <= anchorEnd + 10) shaftEnd = anchorEnd + Math.max(10, Math.floor((len - anchorEnd) / 2));
  if (shaftEnd >= len - 5) shaftEnd = Math.max(anchorEnd + 5, len - 10);

  const anchorSlice = smoothedEntropy.slice(0, anchorEnd);
  const shaftSlice = smoothedEntropy.slice(anchorEnd, shaftEnd);
  const rbdSlice = smoothedEntropy.slice(shaftEnd, len);

  const mean = (a: number[]) => (a.length > 0 ? a.reduce((s, v) => s + v, 0) / a.length : 0);

  return [
    {
      type: 'n_anchor',
      name: 'N-Terminal Anchor',
      startResidue: 1,
      endResidue: anchorEnd,
      length: anchorEnd,
      meanEntropy: Math.round(mean(anchorSlice) * 100) / 100,
      meanSasa: 22.4,
      meanDdg: 3.4,
      structuralClass: 'Conserved Baseplate / Collar Wedge',
      description: 'Attaches tail fiber securely to the virion baseplate complex; strictly conserved against mutations.',
    },
    {
      type: 'shaft',
      name: 'Central Shaft & Fibritin Repeats',
      startResidue: anchorEnd + 1,
      endResidue: shaftEnd,
      length: shaftEnd - anchorEnd,
      meanEntropy: Math.round(mean(shaftSlice) * 100) / 100,
      meanSasa: 41.5,
      meanDdg: 2.1,
      structuralClass: 'Fibrous Coiled-Coil / Heptad Repeats',
      description: 'Extended rigid mechanical arm projecting the receptor-binding domain away from the capsid shell.',
    },
    {
      type: 'distal_rbd',
      name: 'Distal Receptor-Binding Domain (RBD)',
      startResidue: shaftEnd + 1,
      endResidue: len,
      length: len - shaftEnd,
      meanEntropy: Math.round(mean(rbdSlice) * 100) / 100,
      meanSasa: 68.2,
      meanDdg: 1.2,
      structuralClass: 'Beta-Sandwich / Hypervariable Loops',
      description: 'The molecular key conferring bacterial host specificity; subject to intense diversifying selection.',
    },
  ];
}

/**
 * Calculate per-residue biophysical and structural metrics
 */
export function calculateResidueEpitopeMetrics(
  sequence: string,
  domains: FiberDomain[],
  entropies: number[]
): ResidueEpitopeMetric[] {
  const residues: ResidueEpitopeMetric[] = [];
  const n = sequence.length;

  for (let i = 0; i < n; i++) {
    const pos = i + 1;
    const aa = sequence[i].toUpperCase();
    const entropy = entropies[i] ?? 0;
    const kd = KYTE_DOOLITTLE[aa] ?? 0;
    const charge = RESIDUE_CHARGES[aa] ?? 0;
    const baseDdg = ALANINE_SCAN_BASELINE_DDG[aa] ?? 1.5;

    // Determine domain
    let domainType: TailFiberDomainType = 'shaft';
    for (const d of domains) {
      if (pos >= d.startResidue && pos <= d.endResidue) {
        domainType = d.type;
        break;
      }
    }

    // Surface exposure (SASA) proxy: hydrophilic residues and RBD loop positions have higher SASA
    let sasa = Math.max(5, Math.min(95, 50 - kd * 8 + (domainType === 'distal_rbd' ? 25 : domainType === 'n_anchor' ? -20 : 0)));
    // Modulation with entropy (flexible variable regions are typically surface loops)
    sasa = Math.round(Math.max(5, Math.min(98, sasa + entropy * 8)));

    // Structural stability (Delta-Delta-G Ala scan)
    // Buried core residues have high Delta-Delta-G; surface residues have lower Delta-Delta-G
    let ddg = baseDdg * (1 - sasa / 120);
    if (domainType === 'n_anchor') ddg += 1.0;
    if (aa === 'P' || aa === 'G') {
      // Proline / Glycine in structured regions have high conformational penalty
      ddg = Math.max(ddg, 2.5);
    }
    ddg = Math.round(ddg * 10) / 10;

    const isHypervariableEpitope = domainType === 'distal_rbd' && entropy > 2.2 && sasa > 50;
    const isEssentialAnchor = domainType === 'n_anchor' && entropy < 1.0 && ddg > 2.5;

    let clashRisk: ResidueEpitopeMetric['clashRisk'] = 'low';
    if (ddg > 3.0) {
      clashRisk = 'critical'; // Intolerant core packing
    } else if (ddg > 2.0) {
      clashRisk = 'high';
    } else if (sasa < 25) {
      clashRisk = 'moderate';
    }

    residues.push({
      position: pos,
      aminoAcid: aa,
      entropy,
      sasa,
      ddgAlaScan: ddg,
      charge,
      hydropathy: kd,
      domain: domainType,
      isHypervariableEpitope,
      isEssentialAnchor,
      clashRisk,
    });
  }

  return residues;
}

/**
 * Score structural compatibility against canonical bacterial surface receptors
 */
export function scoreReceptorBinding(
  residues: ResidueEpitopeMetric[],
  _domains: FiberDomain[]
): ReceptorBindingScore[] {
  const rbdResidues = residues.filter((r) => r.domain === 'distal_rbd');
  const rbdRes = rbdResidues.length > 0 ? rbdResidues : residues;

  // Compute RBD electrostatic sum & hydrophobic ratio
  let netRbdCharge = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let aromaticCount = 0;
  let hydrophobicCount = 0;

  for (const r of rbdRes) {
    netRbdCharge += r.charge;
    if (r.charge > 0) positiveCount++;
    if (r.charge < 0) negativeCount++;
    if (['F', 'W', 'Y'].includes(r.aminoAcid)) aromaticCount++;
    if (r.hydropathy > 1.0) hydrophobicCount++;
  }

  const scores: ReceptorBindingScore[] = [];

  for (const receptor of BACTERIAL_SURFACE_RECEPTORS) {
    let affinity = 50;
    let electrostaticFit = 0.0;
    let stericClash = 20;
    const evidence: string[] = [];

    switch (receptor.id) {
      case 'lamb': {
        // LamB favors aromatic loops (Trp, Tyr) fitting into the maltoporin greasy slide
        const aromaticDensity = aromaticCount / Math.max(1, rbdRes.length);
        if (aromaticDensity > 0.07) {
          affinity += 30;
          evidence.push(`Enriched aromatic residues (${aromaticCount} Y/W/F) compatible with maltoporin vestibule`);
        } else {
          affinity -= 10;
        }
        electrostaticFit = Math.min(1.0, Math.max(-1.0, 0.4 + netRbdCharge * 0.05));
        stericClash = 15;
        break;
      }
      case 'ompc': {
        // OmpC outer vestibule has negative aspartate/glutamate clusters; favors basic RBD loops (Arg/Lys)
        if (positiveCount > negativeCount) {
          affinity += 28;
          electrostaticFit = Math.min(1.0, 0.5 + netRbdCharge * 0.1);
          evidence.push(`Cationic tip (${positiveCount} basic vs ${negativeCount} acidic) balances anionic OmpC loop L4/L5`);
        } else {
          affinity -= 15;
          electrostaticFit = -0.5;
          stericClash += 25;
          evidence.push('Electrostatic repulsion against negative OmpC outer surface');
        }
        break;
      }
      case 'tonb_fhua': {
        // FhuA iron transporter cork domain
        if (aromaticCount >= 3 && positiveCount >= 2) {
          affinity += 22;
          electrostaticFit = 0.5;
          evidence.push('Amphipathic loop configuration compatible with FhuA gating apex');
        }
        stericClash = 22;
        break;
      }
      case 'btub': {
        if (hydrophobicCount > 10) {
          affinity += 18;
          electrostaticFit = 0.3;
          evidence.push('Hydrophobic core contacts align with cobalamin transporter cleft');
        }
        stericClash = 20;
        break;
      }
      case 'lps_core': {
        // LPS phosphate core is heavily negatively charged; basic residues (Arg, Lys) are essential for attachment
        const basicRatio = positiveCount / Math.max(1, rbdRes.length);
        if (basicRatio > 0.08) {
          affinity += 35;
          electrostaticFit = 0.9;
          evidence.push(`High basic residue density (${basicRatio.toFixed(2)}) binds negatively charged LPS phosphate core`);
        } else {
          affinity -= 12;
          electrostaticFit = -0.3;
          evidence.push('Low basic charge reduces initial ionic adsorption to LPS core');
        }
        stericClash = 10; // High steric flexibility in polysaccharide chain
        break;
      }
      case 'type_iv_pilus': {
        // Pili require hydrophobic interactions with PilA grooves
        const hydroRatio = hydrophobicCount / Math.max(1, rbdRes.length);
        if (hydroRatio > 0.3) {
          affinity += 25;
          electrostaticFit = 0.2;
          evidence.push(`Hydrophobic patch density (${hydroRatio.toFixed(2)}) docks into PilA subunit groove`);
        }
        stericClash = 30;
        break;
      }
    }

    affinity = Math.max(10, Math.min(98, affinity));
    scores.push({
      receptorId: receptor.id,
      receptorName: receptor.name,
      category: receptor.category,
      affinityScore: affinity,
      electrostaticFit: Math.round(electrostaticFit * 100) / 100,
      stericClashScore: stericClash,
      compatibilityRank: 0,
      interactionEvidence: evidence,
    });
  }

  // Sort descending by affinityScore
  scores.sort((a, b) => b.affinityScore - a.affinityScore);
  scores.forEach((s, idx) => {
    s.compatibilityRank = idx + 1;
  });

  return scores;
}

/**
 * Predict bacterial host genera from RBD and receptor scores
 */
export function inferHostRangeFromReceptors(
  receptorScores: ReceptorBindingScore[],
  primaryHost?: string | null
): TailFiberStructuralAnalysis['predictedHosts'] {
  const hostMap: Record<string, { confidence: number; receptors: string[] }> = {};

  for (const s of receptorScores) {
    let host = 'Escherichia coli';
    if (s.receptorId === 'type_iv_pilus') host = 'Pseudomonas aeruginosa';
    if (s.receptorId === 'lps_core' && s.affinityScore > 75) {
      host = 'Salmonella enterica';
    }

    if (!hostMap[host]) {
      hostMap[host] = { confidence: s.affinityScore, receptors: [s.receptorName] };
    } else {
      hostMap[host].confidence = Math.max(hostMap[host].confidence, s.affinityScore);
      hostMap[host].receptors.push(s.receptorName);
    }
  }

  // If primaryHost is known, give it prominent representation
  if (primaryHost && !hostMap[primaryHost]) {
    hostMap[primaryHost] = {
      confidence: 85,
      receptors: ['Primary documented host species'],
    };
  }

  return Object.entries(hostMap)
    .map(([hostName, data]) => ({
      hostName,
      confidence: Math.round(data.confidence),
      primaryReceptors: data.receptors,
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * In-silico point mutation simulator: calculates stability shifts and receptor binding deltas
 */
export function simulateResidueMutation(
  analysis: TailFiberStructuralAnalysis,
  position: number,
  mutantAa: string
): MutationSimulationResult {
  const targetRes = analysis.residues.find((r) => r.position === position);
  const wt = targetRes?.aminoAcid ?? 'A';
  const newAa = mutantAa.toUpperCase();

  const wtDdg = ALANINE_SCAN_BASELINE_DDG[wt] ?? 1.5;
  const newDdg = ALANINE_SCAN_BASELINE_DDG[newAa] ?? 1.5;
  const wtCharge = RESIDUE_CHARGES[wt] ?? 0;
  const newCharge = RESIDUE_CHARGES[newAa] ?? 0;

  // Free energy stability shift
  let ddgDelta = newDdg - wtDdg;
  if (targetRes?.domain === 'n_anchor') {
    ddgDelta *= 1.6; // Anchor mutations are heavily penalized
  }

  // Clash penalty
  let clashPenalty = 0;
  const bulkyAAs = ['W', 'F', 'Y', 'R'];
  if (bulkyAAs.includes(newAa) && (targetRes?.sasa ?? 50) < 30) {
    clashPenalty = 65; // Steric clash inside packed core
  }

  // Affinity shifts
  const affinityDeltas: Record<string, number> = {};
  for (const r of analysis.receptorScores) {
    let delta = 0;
    if (r.receptorId === 'ompc' || r.receptorId === 'lps_core') {
      if (newCharge > wtCharge) delta += 12; // Basic charge enhances affinity to anionic porin/LPS
      if (newCharge < wtCharge) delta -= 14;
    }
    if (r.receptorId === 'lamb') {
      if (['W', 'Y', 'F'].includes(newAa)) delta += 15;
      if (wt !== 'A' && newAa === 'A') delta -= 12;
    }
    affinityDeltas[r.receptorId] = Math.round(delta);
  }

  let predictedHostImpact = `Mutation ${wt}${position}${newAa} in ${targetRes?.domain ?? 'fiber'}`;
  if (clashPenalty > 50) {
    predictedHostImpact += ': High steric clash risk within core; likely destabilizes fiber folding.';
  } else if ((affinityDeltas.ompc ?? 0) > 8) {
    predictedHostImpact += ': Enhances cationic electrostatic affinity toward OmpC porin.';
  } else if ((affinityDeltas.lamb ?? 0) > 8) {
    predictedHostImpact += ': Introduces favorable aromatic stacking into LamB vestibule.';
  } else {
    predictedHostImpact += ': Neutral or conservative substitution with minimal host range shift.';
  }

  return {
    position,
    wildType: wt,
    mutant: newAa,
    ddgDelta: Math.round(ddgDelta * 10) / 10,
    clashPenalty,
    affinityDeltas,
    predictedHostImpact,
  };
}

/**
 * Generate modular chimera engineering suggestions
 */
export function generateChimeraSuggestions(
  domains: FiberDomain[],
  _currentPhage: string
): ChimeraEngineeringSuggestion[] {
  const rbd = domains.find((d) => d.type === 'distal_rbd');
  const junction = rbd ? rbd.startResidue : Math.floor(domains[0]?.length ?? 100 * 0.7);
  const rbdRange: [number, number] = rbd ? [rbd.startResidue, rbd.endResidue] : [junction, junction + 250];

  return [
    {
      donorPhage: 'Enterobacteria phage T2',
      donorProtein: 'gp37 (C-terminal tip)',
      junctionResidue: junction,
      rbdRange,
      targetReceptor: 'OmpF / FadL',
      predictedHost: 'Escherichia coli (OmpC-deficient mutants)',
      feasibilityScore: 88,
      rationale: 'Well-documented modular junction swap in Teven phages; expands host tropism to porin-altered escape mutants.',
    },
    {
      donorPhage: 'Salmonella phage P22',
      donorProtein: 'gp9 tailspike',
      junctionResidue: junction,
      rbdRange,
      targetReceptor: 'Salmonella enterica O-antigen repeat units',
      predictedHost: 'Salmonella enterica serovar Typhimurium',
      feasibilityScore: 76,
      rationale: 'Endorhamnosidase beta-helix domain substitution retargets tail fiber toward surface polysaccharide O-antigens.',
    },
    {
      donorPhage: 'Pseudomonas phage PaP1',
      donorProtein: 'gp18 receptor-binding tip',
      junctionResidue: junction,
      rbdRange,
      targetReceptor: 'Type IV Pilus & O-polysaccharide',
      predictedHost: 'Pseudomonas aeruginosa PAO1',
      feasibilityScore: 68,
      rationale: 'Crossover at coiled-coil shaft boundary enables cross-genus chimera construction for therapeutic cocktail expansion.',
    },
  ];
}

/**
 * Full structural epitope clash map analyzer for tail fiber genes
 */
export function analyzeTailFiberStructure(
  phage: PhageFull,
  targetGene?: GeneInfo | null,
  translatedSequence?: string | null,
  options: { demonstration?: boolean } = {}
): TailFiberStructuralAnalysis | null {
  // Sequence alone cannot supply an alignment, 3D surface or binding energy.
  // Keep the existing teaching model available only after explicit opt-in.
  if (options.demonstration !== true) return null;
  // Find tail fiber gene if not provided
  let gene = targetGene;
  if (!gene) {
    gene = phage.genes.find((g) => isTailFiberCandidate(g)) ?? null;
  }

  if (!gene) {
    return null;
  }

  // Construct representative or provided amino acid sequence
  let seq = translatedSequence ?? '';
  if (!seq || seq.length < 20) {
    // Generate representative amino acid model sequence for phage tail fiber
    const len = Math.max(120, Math.min(800, Math.floor(Math.abs(gene.endPos - gene.startPos) / 3)));
    const mockAa = 'MAEKLLNVLNELDALTAELAQKADAAKGVAASIKTGVGTGGGGVSYAGFTNGTVTFANWAKAGYQYNDWGFV';
    seq = mockAa.repeat(Math.ceil(len / mockAa.length)).slice(0, len);
  }

  const homologColumns = generateFiberHomologColumns(seq);
  const rawEntropies = homologColumns.map((col) => calculatePositionEntropy(col));
  const smoothedEntropies = smoothArray(rawEntropies, 9);

  const kdArray = seq.split('').map((aa) => KYTE_DOOLITTLE[aa.toUpperCase()] ?? 0);
  const domains = detectFiberDomainBoundaries(seq.length, smoothedEntropies, kdArray);
  const residues = calculateResidueEpitopeMetrics(seq, domains, rawEntropies);
  const receptorScores = scoreReceptorBinding(residues, domains);
  const predictedHosts = inferHostRangeFromReceptors(receptorScores, phage.host);
  const chimeraSuggestions = generateChimeraSuggestions(domains, phage.name);

  const hypervariableHotspots = residues
    .filter((r) => r.isHypervariableEpitope)
    .map((r) => r.position);

  const meanEntropy =
    rawEntropies.length > 0
      ? Math.round((rawEntropies.reduce((a, b) => a + b, 0) / rawEntropies.length) * 100) / 100
      : 0;

  const rbd = domains.find((d) => d.type === 'distal_rbd');
  const topReceptor = receptorScores[0]?.receptorName ?? 'Outer surface receptor';

  const summary =
    `Analyzed tail fiber ${gene.name ?? gene.locusTag ?? 'protein'} (${seq.length} aa): ` +
    `identified ${domains.length} structural domains (N-anchor 1-${domains[0]?.endResidue ?? 0}, ` +
    `shaft ${domains[1]?.startResidue ?? 0}-${domains[1]?.endResidue ?? 0}, ` +
    `distal RBD ${rbd?.startResidue ?? 0}-${rbd?.endResidue ?? 0}). ` +
    `Top predicted receptor is ${topReceptor} (${receptorScores[0]?.affinityScore ?? 0}% affinity). ` +
    `Found ${hypervariableHotspots.length} hypervariable epitope hotspot residues in the receptor-binding tip.`;

  return {
    source: 'demonstration',
    assumptions: `Illustration using ${translatedSequence && translatedSequence.length >= 20 ? 'the supplied protein sequence' : 'a repeated MAEKLL… example sequence'} and ${gene.name ?? gene.locusTag ?? 'gene'} annotation. Homologs, domain boundaries, surface areas, energies, affinities and chimera scenarios are synthetic model outputs, not predictions for ${phage.name}.`,
    phageId: phage.id,
    phageName: phage.name,
    geneId: gene.id,
    geneName: gene.name ?? gene.locusTag ?? `gene_${gene.id}`,
    locusTag: gene.locusTag ?? `gene_${gene.id}`,
    product: gene.product ?? 'Tail fiber protein',
    sequenceLength: seq.length,
    domains,
    residues,
    meanEntropy,
    hypervariableHotspots,
    receptorScores,
    predictedHosts,
    chimeraSuggestions,
    summary,
  };
}
