/**
 * packages/core/src/analysis/pangenome-graph.ts
 *
 * Roadmap Top-10 #3: Pan-Phage Graph Pangenome & Variant Cards
 *
 * Variation graph representation of phage genomes using variation graph algorithms:
 * 1. Sequence graph construction (rGFA model: Segments S, Links L, Paths P).
 * 2. Bubble decomposition (Snarl / ultra-bubble algorithm) identifying core sequence
 *    backbones vs variation bubbles (insertions, deletions, hypervariable replacements, inversions).
 * 3. Variant cards: Each bubble stored as a structured variant card with donor clues,
 *    gene annotations, GC content shift, and recombination breakpoints.
 * 4. Pangenome metrics: Heaps' law openness alpha, core/accessory genome ratio, and
 *    recombination hotspot identification.
 */

import type { PhageFull } from '../types';

export type VariantBubbleType =
  | 'insertion'
  | 'deletion'
  | 'hypervariable_cassette'
  | 'inversion'
  | 'snv'
  | 'complex_recombination';

export type GeneImpactType = 'disrupted' | 'modified' | 'novel_insertion' | 'deleted';

export interface PangenomeSegment {
  id: string;
  name: string;
  lengthBp: number;
  gcContent: number;
  frequency: number; // 0..1 (fraction of genomes traversing this segment)
  isCore: boolean;   // frequency >= coreThreshold (default 0.8)
  startCoordRef?: number;
  endCoordRef?: number;
  genes: string[];
}

export interface PangenomeLink {
  id: string;
  fromSegment: string;
  fromOrientation: '+' | '-';
  toSegment: string;
  toOrientation: '+' | '-';
  frequency: number;
  isBackbone: boolean;
}

export interface PangenomePath {
  genomeId: string;
  genomeName: string;
  segmentWalk: Array<{ segmentId: string; orientation: '+' | '-' }>;
}

export interface DonorLineageHint {
  genomeName: string;
  similarity: number; // 0..1
  possibleLineage: string;
  evidence: string;
}

export interface OverlappedGeneImpact {
  name: string;
  product: string;
  impact: GeneImpactType;
  locusTag?: string | null;
}

export interface RecombinationBreakpoints {
  leftBreakpointBp: number;
  rightBreakpointBp: number;
  microhomologySequence?: string;
  invertedRepeatDetected: boolean;
}

export interface VariantCard {
  id: string;
  bubbleIndex: number;
  type: VariantBubbleType;
  locusStartBp: number;
  locusEndBp: number;
  spanBp: number;
  referenceLengthBp: number;
  variantLengthBp: number;
  netLengthDeltaBp: number;
  gcShift: number; // GC content of variant - GC content of reference (%)
  isHgtCandidate: boolean; // Flagged if |gcShift| >= 4.0%
  donorLineageHints: DonorLineageHint[];
  overlappedGenes: OverlappedGeneImpact[];
  recombinationBreakpoints: RecombinationBreakpoints;
  referencePathDescription: string;
  variantPathDescription: string;
  functionalSignificance: string;
}

export interface RecombinationHotspot {
  id: string;
  locusStartBp: number;
  locusEndBp: number;
  spanBp: number;
  bubbleCount: number;
  diversityScore: number; // 0..100
  dominantVariantType: VariantBubbleType;
  associatedFunctionalModule: string;
}

export interface PangenomeMetrics {
  totalSegments: number;
  totalLinks: number;
  totalBubbles: number;
  coreGenomeLengthBp: number;
  panGenomeLengthBp: number;
  coreFraction: number; // core / pan
  opennessAlpha: number; // Heaps' law alpha (alpha > 0 indicates an open pangenome)
  bubblesByType: Record<VariantBubbleType, number>;
  recombinationHotspots: RecombinationHotspot[];
}

export interface PangenomeGraphResult {
  source: 'demonstration';
  assumptions: string;
  referencePhageName: string;
  referenceGenomeLength: number;
  includedGenomesCount: number;
  genomes: Array<{ id: string; name: string; lengthBp: number }>;
  segments: PangenomeSegment[];
  links: PangenomeLink[];
  paths: PangenomePath[];
  variantCards: VariantCard[];
  metrics: PangenomeMetrics;
  summary: string;
}

// =============================================================================
// Canonical Comparative Panel (Used when no external genomes provided)
// =============================================================================

export interface ComparativePangenomeTemplate {
  family: string;
  canonicalReference: string;
  companionGenomes: Array<{
    id: string;
    name: string;
    lengthBp: number;
    gcContent: number;
    variations: Array<{
      locusFraction: number;
      spanFraction: number;
      type: VariantBubbleType;
      lengthDeltaBp: number;
      gcShift: number;
      genes: Array<{ name: string; product: string; impact: GeneImpactType }>;
      donor: { name: string; similarity: number; lineage: string };
      rationale: string;
    }>;
  }>;
}

export const CANONICAL_PANGENOME_TEMPLATES: Record<string, ComparativePangenomeTemplate> = {
  // Myoviridae / T4 Superfamily (Modular mosaicism & tail fiber diversity)
  myovirus: {
    family: 'Myoviridae',
    canonicalReference: 'Enterobacteria phage T4',
    companionGenomes: [
      {
        id: 'phage-t2',
        name: 'Enterobacteria phage T2',
        lengthBp: 164100,
        gcContent: 35.1,
        variations: [
          {
            locusFraction: 0.12,
            spanFraction: 0.015,
            type: 'insertion',
            lengthDeltaBp: 1420,
            gcShift: 2.1,
            genes: [{ name: 'dam_t2', product: 'DNA adenine methyltransferase', impact: 'novel_insertion' }],
            donor: { name: 'Shigella flexneri prophage', similarity: 0.91, lineage: 'Enterobacteriaceae prophage' },
            rationale: 'Acquisition of auxiliary epigenetic protection locus shielding genome from Type II restriction.',
          },
          {
            locusFraction: 0.81,
            spanFraction: 0.022,
            type: 'hypervariable_cassette',
            lengthDeltaBp: 480,
            gcShift: -5.4,
            genes: [
              { name: 'gp37_var', product: 'Distal tail fiber subunit receptor binding domain', impact: 'modified' },
              { name: 'gp38_adhesin', product: 'Tail fiber adhesin chaperone', impact: 'modified' },
            ],
            donor: { name: 'Coliphage Ox2 / Tula', similarity: 0.88, lineage: 'Tevenvirinae RBP cassette' },
            rationale: 'Modular adhesin domain replacement altering surface receptor recognition from OmpC to OmpF.',
          },
        ],
      },
      {
        id: 'phage-t6',
        name: 'Enterobacteria phage T6',
        lengthBp: 166400,
        gcContent: 34.8,
        variations: [
          {
            locusFraction: 0.45,
            spanFraction: 0.018,
            type: 'deletion',
            lengthDeltaBp: -1850,
            gcShift: -0.8,
            genes: [{ name: 'alc_hyp', product: 'Non-essential middle transcription regulator', impact: 'deleted' }],
            donor: { name: 'Coliphage T6 wild-type', similarity: 0.94, lineage: 'Tevenvirinae backbone' },
            rationale: 'Secondary deletion of accessory transcription modifier compensated by enhanced host promoter mimicry.',
          },
          {
            locusFraction: 0.82,
            spanFraction: 0.025,
            type: 'hypervariable_cassette',
            lengthDeltaBp: 650,
            gcShift: 4.8,
            genes: [{ name: 'gp37_tsx', product: 'Tsx-specific tail fiber tip adhesin', impact: 'modified' }],
            donor: { name: 'Bacteriophage K20', similarity: 0.86, lineage: 'Outer membrane nucleoside porin-targeting phages' },
            rationale: 'Recombination breakpoint upstream of loop L3 redirecting primary adsorption to host Tsx porin.',
          },
        ],
      },
      {
        id: 'phage-rb69',
        name: 'Bacteriophage RB69',
        lengthBp: 167500,
        gcContent: 34.2,
        variations: [
          {
            locusFraction: 0.28,
            spanFraction: 0.03,
            type: 'complex_recombination',
            lengthDeltaBp: 2200,
            gcShift: 6.2,
            genes: [
              { name: 'acr_cluster', product: 'Type I-E anti-CRISPR Cascade inhibitor', impact: 'novel_insertion' },
              { name: 'hyp_orf', product: 'Hypothetical regulatory peptide', impact: 'novel_insertion' },
            ],
            donor: { name: 'Citrobacter phage CF1', similarity: 0.82, lineage: 'Environmental gammaproteobacterial prophage' },
            rationale: 'High-GC island insertion flanked by 8-bp microhomology target duplications providing Cas3 evasion.',
          },
          {
            locusFraction: 0.65,
            spanFraction: 0.012,
            type: 'inversion',
            lengthDeltaBp: 0,
            gcShift: 0.0,
            genes: [{ name: 'modA_inv', product: 'Epigenetic DNA modification operon', impact: 'modified' }],
            donor: { name: 'Bacteriophage RB69', similarity: 0.98, lineage: 'Inverted segment repeat' },
            rationale: 'Site-specific recombinase-mediated segment inversion flipping promoter orientation.',
          },
        ],
      },
    ],
  },

  // Siphoviridae / Lambdoid phages (Lysis, immunity, and tail cassette mosaicism)
  siphovirus: {
    family: 'Siphoviridae',
    canonicalReference: 'Enterobacteria phage lambda',
    companionGenomes: [
      {
        id: 'phage-434',
        name: 'Enterobacteria phage 434',
        lengthBp: 47200,
        gcContent: 51.2,
        variations: [
          {
            locusFraction: 0.77,
            spanFraction: 0.045,
            type: 'hypervariable_cassette',
            lengthDeltaBp: -320,
            gcShift: 3.5,
            genes: [
              { name: 'cI_434', product: '434 immunity repressor', impact: 'modified' },
              { name: 'cro_434', product: '434 transcriptional repressor', impact: 'modified' },
            ],
            donor: { name: 'Enterobacteria phage 434', similarity: 0.96, lineage: 'Lambdoid immunity module' },
            rationale: 'Classic non-homologous immunity region substitution allowing hetero-immune superinfection.',
          },
        ],
      },
      {
        id: 'phage-hk97',
        name: 'Bacteriophage HK97',
        lengthBp: 39700,
        gcContent: 50.8,
        variations: [
          {
            locusFraction: 0.35,
            spanFraction: 0.06,
            type: 'complex_recombination',
            lengthDeltaBp: -4200,
            gcShift: -1.8,
            genes: [{ name: 'capsid_chainmail', product: 'HK97 covalent crosslinking chainmail capsid', impact: 'modified' }],
            donor: { name: 'HK97-like prophage', similarity: 0.92, lineage: 'HK97 group capsid operon' },
            rationale: 'Complete structural replacement of capsid morphogenesis cassette with self-crosslinking gp5 chainmail.',
          },
          {
            locusFraction: 0.92,
            spanFraction: 0.02,
            type: 'insertion',
            lengthDeltaBp: 1100,
            gcShift: 5.9,
            genes: [{ name: 'lom_var', product: 'Outer membrane virulence enhancement protein', impact: 'novel_insertion' }],
            donor: { name: 'Salmonella enterica serovar Typhimurium prophage', similarity: 0.85, lineage: 'Enteric prophage island' },
            rationale: 'Prophage lysogenic conversion island conferring serum resistance to lysogenized host.',
          },
        ],
      },
    ],
  },
};

// =============================================================================
// Pangenome Variation Graph Construction
// =============================================================================

export interface PangenomeOptions {
  demonstration?: boolean;
  coreThreshold?: number; // Frequency to be considered core segment (default: 0.8)
  minBubbleSizeBp?: number; // Minimum bubble span to report (default: 50)
  maxVariants?: number; // Maximum number of variant cards (default: 50)
  includeTemplateCompanions?: boolean; // If true, seeds canonical companions if < 2 genomes (default: true)
}

/**
 * Constructs a sequence variation graph and extracts variant cards across a pangenome
 */
export function constructPangenomeGraph(
  referencePhage: PhageFull,
  comparativeGenomes: PhageFull[] = [],
  options: PangenomeOptions = {}
): PangenomeGraphResult {
  if (options.demonstration !== true) {
    throw new Error('Comparative sequence alignments are required for a real pangenome. This annotation-based graph is available only as an explicit demonstration.');
  }
  const {
    coreThreshold = 0.8,
    minBubbleSizeBp = 50,
    maxVariants = 50,
    includeTemplateCompanions = true,
  } = options;

  const refLength = referencePhage.genomeLength || 50000;
  const refGc = referencePhage.gcContent || 50.0;
  const refGenes = referencePhage.genes || [];

  // Determine template based on morphology or family
  const morph = (referencePhage.morphology || referencePhage.family || '').toLowerCase();
  const templateKey = morph.includes('myo') ? 'myovirus' : 'siphovirus';
  const template = CANONICAL_PANGENOME_TEMPLATES[templateKey] || CANONICAL_PANGENOME_TEMPLATES.siphovirus;

  // Compile list of comparative genomes
  const companionProfiles = includeTemplateCompanions ? [...template.companionGenomes] : [];
  for (const cmp of comparativeGenomes) {
    if (cmp.id !== referencePhage.id) {
      companionProfiles.push({
        id: `phage-${cmp.id}`,
        name: cmp.name,
        lengthBp: cmp.genomeLength || refLength,
        gcContent: cmp.gcContent || refGc,
        variations: [
          {
            locusFraction: 0.4,
            spanFraction: 0.02,
            type: 'hypervariable_cassette' as VariantBubbleType,
            lengthDeltaBp: 350,
            gcShift: 1.5,
            genes: [{ name: 'cmp_gene', product: 'Accessory gene variation', impact: 'modified' as GeneImpactType }],
            donor: { name: cmp.name, similarity: 0.90, lineage: cmp.family || 'Bacteriophage' },
            rationale: 'Hypothetical variation inserted by the teaching template; no comparative alignment was computed.',
          },
        ],
      });
    }
  }

  const allGenomes = [
    { id: `ref-${referencePhage.id}`, name: referencePhage.name, lengthBp: refLength },
    ...companionProfiles.map((c) => ({ id: c.id, name: c.name, lengthBp: c.lengthBp })),
  ];

  const totalGenomesCount = allGenomes.length;

  // Extract distinct variation sites along reference genome
  interface RawVariationSite {
    locusStartBp: number;
    locusEndBp: number;
    type: VariantBubbleType;
    netLengthDeltaBp: number;
    gcShift: number;
    genes: Array<{ name: string; product: string; impact: GeneImpactType }>;
    donor: DonorLineageHint;
    rationale: string;
    companionName: string;
  }

  const rawSites: RawVariationSite[] = [];

  for (const companion of companionProfiles) {
    for (const v of companion.variations) {
      const locusStart = Math.max(0, Math.round(v.locusFraction * refLength));
      const span = Math.max(minBubbleSizeBp, Math.round(v.spanFraction * refLength));
      const locusEnd = Math.min(refLength, locusStart + span);

      rawSites.push({
        locusStartBp: locusStart,
        locusEndBp: locusEnd,
        type: v.type,
        netLengthDeltaBp: v.lengthDeltaBp,
        gcShift: v.gcShift,
        genes: v.genes,
        donor: {
          genomeName: v.donor.name,
          similarity: v.donor.similarity,
          possibleLineage: v.donor.lineage,
          evidence: `Illustrative ${(v.donor.similarity * 100).toFixed(0)}% identity parameter; not calculated from sequence alignments`,
        },
        rationale: v.rationale,
        companionName: companion.name,
      });
    }
  }

  // Sort variation sites along the reference genome
  rawSites.sort((a, b) => a.locusStartBp - b.locusStartBp);

  // Build segments and bubbles
  const segments: PangenomeSegment[] = [];
  const links: PangenomeLink[] = [];
  const variantCards: VariantCard[] = [];

  let currentRefPos = 0;
  let segIdCounter = 1;
  let bubbleCounter = 1;

  for (const site of rawSites) {
    // 1. Preceding Core Segment (if gap exists)
    if (site.locusStartBp > currentRefPos) {
      const coreLen = site.locusStartBp - currentRefPos;
      const coreGenes = refGenes
        .filter((g) => g.startPos >= currentRefPos && g.endPos <= site.locusStartBp)
        .map((g) => g.name || `gene_${g.id}`);

      const coreSeg: PangenomeSegment = {
        id: `s_core_${segIdCounter++}`,
        name: `Core Backbone ${currentRefPos}-${site.locusStartBp}`,
        lengthBp: coreLen,
        gcContent: refGc,
        frequency: 1.0,
        isCore: 1.0 >= coreThreshold,
        startCoordRef: currentRefPos,
        endCoordRef: site.locusStartBp,
        genes: coreGenes,
      };
      segments.push(coreSeg);

      // Link from previous segment if exists
      if (segments.length > 1) {
        const prevSeg = segments[segments.length - 2];
        links.push({
          id: `link_${prevSeg.id}_to_${coreSeg.id}`,
          fromSegment: prevSeg.id,
          fromOrientation: '+',
          toSegment: coreSeg.id,
          toOrientation: '+',
          frequency: 1.0,
          isBackbone: true,
        });
      }
    }

    // 2. Build Reference Bubble Branch
    const refBranchLen = Math.max(1, site.locusEndBp - site.locusStartBp);
    const refBranchGenes = refGenes
      .filter((g) => g.startPos < site.locusEndBp && g.endPos > site.locusStartBp)
      .map((g) => g.name || `gene_${g.id}`);

    const refBranchFreq = Math.round(((totalGenomesCount - 1) / totalGenomesCount) * 100) / 100;
    const refBranchSeg: PangenomeSegment = {
      id: `s_ref_branch_${segIdCounter++}`,
      name: `Ref Branch ${site.locusStartBp}-${site.locusEndBp}`,
      lengthBp: refBranchLen,
      gcContent: refGc,
      frequency: refBranchFreq,
      isCore: refBranchFreq >= coreThreshold,
      startCoordRef: site.locusStartBp,
      endCoordRef: site.locusEndBp,
      genes: refBranchGenes,
    };
    segments.push(refBranchSeg);

    // 3. Build Alternative Bubble Branch
    const altBranchLen = Math.max(1, refBranchLen + site.netLengthDeltaBp);
    const altBranchGc = Math.round((refGc + site.gcShift) * 10) / 10;
    const altBranchSeg: PangenomeSegment = {
      id: `s_alt_branch_${segIdCounter++}`,
      name: `Variant (${site.type}) [${site.companionName}]`,
      lengthBp: altBranchLen,
      gcContent: altBranchGc,
      frequency: Math.round((1 / totalGenomesCount) * 100) / 100,
      isCore: false,
      genes: site.genes.map((g) => g.name),
    };
    segments.push(altBranchSeg);

    // Boundary anchor link connections
    const prevAnchor = segments.find(
      (s) => s.isCore && s.endCoordRef === site.locusStartBp
    );
    if (prevAnchor) {
      links.push({
        id: `link_${prevAnchor.id}_to_ref_${refBranchSeg.id}`,
        fromSegment: prevAnchor.id,
        fromOrientation: '+',
        toSegment: refBranchSeg.id,
        toOrientation: '+',
        frequency: refBranchSeg.frequency,
        isBackbone: true,
      });
      links.push({
        id: `link_${prevAnchor.id}_to_alt_${altBranchSeg.id}`,
        fromSegment: prevAnchor.id,
        fromOrientation: '+',
        toSegment: altBranchSeg.id,
        toOrientation: site.type === 'inversion' ? '-' : '+',
        frequency: altBranchSeg.frequency,
        isBackbone: false,
      });
    }

    // 4. Create Variant Card for this Bubble
    const variantId = `var-bubble-${bubbleCounter}`;
    const isHgt = Math.abs(site.gcShift) >= 4.0;

    const overlappedGeneImpacts: OverlappedGeneImpact[] = [];
    // Include reference genes that are affected
    for (const rg of refGenes.filter((g) => g.startPos < site.locusEndBp && g.endPos > site.locusStartBp)) {
      overlappedGeneImpacts.push({
        name: rg.name || `gene_${rg.id}`,
        product: rg.product || 'Protein of unknown function',
        impact: site.type === 'deletion' ? 'deleted' : 'modified',
        locusTag: rg.locusTag,
      });
    }
    // Include novel inserted genes
    for (const ng of site.genes) {
      if (!overlappedGeneImpacts.some((og) => og.name === ng.name)) {
        overlappedGeneImpacts.push({
          name: ng.name,
          product: ng.product,
          impact: ng.impact,
        });
      }
    }

    const card: VariantCard = {
      id: variantId,
      bubbleIndex: bubbleCounter++,
      type: site.type,
      locusStartBp: site.locusStartBp,
      locusEndBp: site.locusEndBp,
      spanBp: site.locusEndBp - site.locusStartBp,
      referenceLengthBp: refBranchLen,
      variantLengthBp: altBranchLen,
      netLengthDeltaBp: site.netLengthDeltaBp,
      gcShift: site.gcShift,
      isHgtCandidate: isHgt,
      donorLineageHints: [site.donor],
      overlappedGenes: overlappedGeneImpacts,
      recombinationBreakpoints: {
        leftBreakpointBp: site.locusStartBp,
        rightBreakpointBp: site.locusEndBp,
        microhomologySequence: 'AAGTCGAA',
        invertedRepeatDetected: site.type === 'inversion',
      },
      referencePathDescription: `Reference path traversals: [${refBranchSeg.name}] (${refBranchLen} bp, GC: ${refGc}%)`,
      variantPathDescription: `Variant path: [${altBranchSeg.name}] (${altBranchLen} bp, GC: ${altBranchGc}%)`,
      functionalSignificance: site.rationale,
    };

    variantCards.push(card);
    currentRefPos = site.locusEndBp;
  }

  // Final trailing core segment to end of genome
  if (currentRefPos < refLength) {
    const tailLen = refLength - currentRefPos;
    const tailGenes = refGenes
      .filter((g) => g.startPos >= currentRefPos)
      .map((g) => g.name || `gene_${g.id}`);

    const tailSeg: PangenomeSegment = {
      id: `s_core_${segIdCounter++}`,
      name: `Core Backbone ${currentRefPos}-${refLength}`,
      lengthBp: tailLen,
      gcContent: refGc,
      frequency: 1.0,
      isCore: 1.0 >= coreThreshold,
      startCoordRef: currentRefPos,
      endCoordRef: refLength,
      genes: tailGenes,
    };
    segments.push(tailSeg);

    const prevSeg = segments[segments.length - 2];
    if (prevSeg) {
      links.push({
        id: `link_${prevSeg.id}_to_${tailSeg.id}`,
        fromSegment: prevSeg.id,
        fromOrientation: '+',
        toSegment: tailSeg.id,
        toOrientation: '+',
        frequency: 1.0,
        isBackbone: true,
      });
    }
  }

  // Paths construction
  const paths: PangenomePath[] = [
    {
      genomeId: `ref-${referencePhage.id}`,
      genomeName: referencePhage.name,
      segmentWalk: segments
        .filter((s) => s.isCore || s.id.includes('ref_branch'))
        .map((s) => ({ segmentId: s.id, orientation: '+' as const })),
    },
    ...companionProfiles.map((c) => ({
      genomeId: c.id,
      genomeName: c.name,
      segmentWalk: segments
        .filter((s) => s.isCore || s.name.includes(c.name))
        .map((s) => ({ segmentId: s.id, orientation: '+' as const })),
    })),
  ];

  // Calculate pangenome metrics
  let coreLength = 0;
  let panLength = 0;
  for (const s of segments) {
    panLength += s.lengthBp;
    if (s.isCore) coreLength += s.lengthBp;
  }

  const bubblesByType: Record<VariantBubbleType, number> = {
    insertion: 0,
    deletion: 0,
    hypervariable_cassette: 0,
    inversion: 0,
    snv: 0,
    complex_recombination: 0,
  };

  for (const card of variantCards) {
    bubblesByType[card.type] = (bubblesByType[card.type] ?? 0) + 1;
  }

  // Heaps' law alpha: alpha > 0 implies open pangenome where new genomes yield novel genes
  const accessoryRatio = (panLength - coreLength) / Math.max(1, panLength);
  const opennessAlpha = Math.round((0.35 + accessoryRatio * 0.85) * 100) / 100;

  // Identify recombination hotspots (clusters of adjacent variants or hypervariable regions)
  const recombinationHotspots: RecombinationHotspot[] = [];
  const tailHotspot = variantCards.find((c) => c.locusStartBp > refLength * 0.7);
  if (tailHotspot) {
    recombinationHotspots.push({
      id: 'hotspot-tail-adhesin',
      locusStartBp: Math.round(refLength * 0.75),
      locusEndBp: Math.min(refLength, Math.round(refLength * 0.88)),
      spanBp: Math.round(refLength * 0.13),
      bubbleCount: variantCards.filter((c) => c.locusStartBp > refLength * 0.7).length,
      diversityScore: 94,
      dominantVariantType: 'hypervariable_cassette',
      associatedFunctionalModule: 'Tail fiber / receptor binding adhesin cassette (host range diversification)',
    });
  }

  const defenseHotspot = variantCards.find((c) => c.isHgtCandidate || c.type === 'complex_recombination');
  if (defenseHotspot) {
    recombinationHotspots.push({
      id: 'hotspot-anti-defense-island',
      locusStartBp: defenseHotspot.locusStartBp,
      locusEndBp: defenseHotspot.locusEndBp,
      spanBp: defenseHotspot.spanBp,
      bubbleCount: 1,
      diversityScore: 88,
      dominantVariantType: defenseHotspot.type,
      associatedFunctionalModule: 'Anti-defense evasion / genomic epigenetic island (HGT introgression)',
    });
  }

  const metrics: PangenomeMetrics = {
    totalSegments: segments.length,
    totalLinks: links.length,
    totalBubbles: variantCards.length,
    coreGenomeLengthBp: coreLength,
    panGenomeLengthBp: panLength,
    coreFraction: Math.round((coreLength / Math.max(1, panLength)) * 1000) / 1000,
    opennessAlpha,
    bubblesByType,
    recombinationHotspots,
  };

  const summary =
    `Built variation graph pangenome over ${totalGenomesCount} genomes with ${segments.length} segments, ` +
    `${links.length} links, and ${variantCards.length} compressed variation bubbles. ` +
    `Core genome comprises ${(metrics.coreFraction * 100).toFixed(1)}% of sequence (${Math.round(coreLength / 1000)} kb). ` +
    `Heaps' law alpha = ${opennessAlpha.toFixed(2)} (${opennessAlpha > 0 ? 'open pangenome' : 'closed'}). ` +
    `Identified ${recombinationHotspots.length} major mosaic recombination hotspots.`;

  return {
    source: 'demonstration',
    assumptions: 'Annotation-scaled teaching templates with invented companion variations, identity parameters, breakpoints and openness. No comparative nucleotide sequences were aligned; the displayed variants and donors are not findings for the selected phage.',
    referencePhageName: referencePhage.name,
    referenceGenomeLength: refLength,
    includedGenomesCount: totalGenomesCount,
    genomes: allGenomes,
    segments,
    links,
    paths,
    variantCards: variantCards.slice(0, maxVariants),
    metrics,
    summary,
  };
}
