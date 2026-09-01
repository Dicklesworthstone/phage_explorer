/**
 * Context content mapping
 *
 * Defines beginner-friendly context data for overlays, gene products,
 * and analysis types. These mappings feed the context help panel and
 * InfoButtons so users see the right glossary terms and learning
 * modules when exploring the app.
 */

import type { GlossaryId } from './glossary/terms';
import type { ModuleId } from './types';

interface ContextHelpEntry {
  heading: string;
  summary: string;
  glossary: GlossaryId[];
  modules?: ModuleId[];
  tips?: string[];
}

interface ContextContentMapping {
  overlays: Record<string, ContextHelpEntry>;
  geneProducts: Record<string, ContextHelpEntry>;
  analyses: Record<string, ContextHelpEntry>;
}

const normalizeKey = (key: string): string => key.toLowerCase();

const overlayContext: Record<string, ContextHelpEntry> = {
  gcskew: {
    heading: 'GC Skew',
    summary: 'GC skew highlights replication origin/terminus by tracking G vs C imbalance along the genome.',
    glossary: ['gc-skew', 'gc-content', 'replication-origin'],
    modules: ['dna-basics', 'genomics-basics'],
    tips: [
      'Look for zero-crossings in cumulative skew; they often mark origin and terminus.',
      'Sharp slope changes can hint at large genomic inversions or packaged fragments.',
    ],
  },
  complexity: {
    heading: 'Sequence Complexity',
    summary: 'Entropy-style view showing how repetitive or information-dense a window of DNA is.',
    glossary: ['sequence-complexity', 'shannon-entropy', 'k-mer', 'dna-sequence', 'gc-content'],
    modules: ['genomics-basics'],
    tips: [
      'Low complexity windows often align with repeats or homopolymers that can trip assemblers.',
      'Combine with repeats overlay to distinguish biological repeats from low-information noise.',
    ],
  },
  bendability: {
    heading: 'DNA Bendability',
    summary: 'Predicts how easily DNA segments bend or wrap, influencing packaging and protein binding.',
    glossary: ['double-helix', 'supercoiling', 'sugar-phosphate-backbone'],
    modules: ['dna-basics'],
    tips: [
      'High bendability near packaging signals can aid genome stuffing into capsids.',
      'Stiff regions often coincide with structural motifs or protein-binding sites.',
    ],
  },
  promoter: {
    heading: 'Promoter / RBS',
    summary: 'Highlights promoter motifs and ribosome binding sites that control transcription and translation start points.',
    glossary: ['promoter', 'ribosome-binding-site', 'gene'],
    modules: ['central-dogma', 'genomics-basics'],
    tips: [
      'Promoter strength and spacing to RBS influence expression levels of downstream genes.',
      'Clustered promoters can signal temporal regulation (early vs late genes).',
    ],
  },
  repeats: {
    heading: 'Repeats & Palindromes',
    summary: 'Detects direct and inverted repeats that can form hairpins or recombination hotspots.',
    glossary: ['dna-sequence', 'supercoiling', 'gene'],
    modules: ['dna-basics'],
    tips: [
      'Inverted repeats can create hairpins affecting transcription termination.',
      'Direct repeats may indicate mobile elements or packaging signal echoes.',
    ],
  },
  kmeranomaly: {
    heading: 'K-mer Anomaly',
    summary: 'Flags windows whose k-mer composition diverges from the genome background.',
    glossary: ['k-mer', 'gc-content', 'horizontal-gene-transfer'],
    modules: ['genomics-basics'],
    tips: [
      'Spikes can indicate horizontally transferred islands or host-derived segments.',
      'Use alongside HGT overlay to corroborate donor/recipient hypotheses.',
    ],
  },
  hgt: {
    heading: 'Horizontal Gene Transfer',
    summary: 'Infers donor lineages by comparing sequence signatures against reference sketches.',
    glossary: ['horizontal-gene-transfer', 'phage-genome', 'gene'],
    modules: ['genomics-basics'],
    tips: [
      'Candidate donor calls near tail-fiber genes often explain host-range shifts.',
      'Cross-check with k-mer anomaly and synteny breaks for stronger evidence.',
    ],
  },
  tropism: {
    heading: 'Tail Fiber Tropism',
    summary: 'Connects tail fiber sequences to predicted host receptors and confidence levels.',
    glossary: ['tail-fiber', 'phage-genome', 'lysogeny'],
    modules: ['phage-lifecycle'],
    tips: [
      'High-confidence receptor predictions help explain host specificity changes.',
      'Pair with gene map to spot neighboring chaperones or baseplate proteins.',
    ],
  },
  structureconstraint: {
    heading: 'Structural Constraints',
    summary: 'Assesses coding sequences for structural red flags (frameshifts, impossible motifs).',
    glossary: ['cds', 'reading-frame', 'gene'],
    modules: ['genetic-code'],
    tips: [
      'Persistent constraint warnings may indicate mis-annotated start/stop codons.',
      'Inspect overlapping ORFs carefully; phages frequently stack genes.',
    ],
  },
  anomaly: {
    heading: 'Anomaly Detection',
    summary: 'Composite anomaly score combining GC skew, complexity, and k-mer divergence.',
    glossary: ['gc-content', 'sequence-complexity', 'k-mer'],
    modules: ['genomics-basics'],
    tips: [
      'Use anomalies as starting points; confirm with targeted overlays (HGT, repeats).',
      'Clusters of anomalies near structural genes may hint at assembly artifacts.',
    ],
  },
  dotplot: {
    heading: 'Dot Plot',
    summary: 'Self-comparison matrix to reveal repeats, inversions, and rearrangements.',
    glossary: ['dot-plot', 'synteny', 'dna-sequence', 'gene'],
    modules: ['genomics-basics'],
    tips: [
      'Diagonal lines reflect conserved order; off-diagonals highlight duplications or inversions.',
      'Zoom into dense blocks to trace tandem repeat lengths.',
    ],
  },
  nonbdna: {
    heading: 'Non-B DNA',
    summary: 'Highlights motifs prone to alternative DNA structures (Z-DNA, triplex, cruciform).',
    glossary: ['double-helix', 'supercoiling', 'dna-sequence'],
    modules: ['dna-basics'],
    tips: [
      'These motifs can stall polymerases; watch for co-location with regulatory regions.',
      'Packaging stress can favor non-B conformations in tightly packed genomes.',
    ],
  },
  stability: {
    heading: 'Virion Stability',
    summary: 'Estimates capsid/tail stability factors based on sequence-derived features.',
    glossary: ['capsid', 'phage-genome', 'dna-sequence'],
    modules: ['phage-lifecycle'],
    tips: [
      'Pairs with bendability to understand packaging stress and capsid integrity.',
      'Stability dips near termini can signal special packaging mechanisms.',
    ],
  },
  pressure: {
    heading: 'Packaging Pressure',
    summary: 'Models physical stress during genome packaging into the capsid.',
    glossary: ['capsid', 'phage-genome', 'gc-content'],
    modules: ['phage-lifecycle'],
    tips: [
      'GC-rich stretches increase stiffness; watch for alignment with pressure peaks.',
      'Packaging motors may pause near strong peaks—look for nearby repeats.',
    ],
  },
  synteny: {
    heading: 'Synteny',
    summary: 'Shows conservation of gene order relative to reference genomes.',
    glossary: ['synteny', 'gene', 'phage-genome'],
    modules: ['genomics-basics'],
    tips: [
      'Breaks in synteny often accompany HGT events or recombination.',
      'Shared synteny blocks across hosts can indicate broad host range.',
    ],
  },
  gel: {
    heading: 'Gel (In-Silico)',
    summary: 'Simulates gel-style banding patterns from genome segments, useful for quick visual comparisons.',
    glossary: ['dna-sequence', 'phage-genome', 'gene'],
    modules: ['genomics-basics'],
    tips: [
      'Use it as a “fingerprint”: similar band patterns often reflect similar genome architectures.',
      'Large band shifts can signal big insertions/deletions compared to related phages.',
    ],
  },
  cgr: {
    heading: 'Chaos Game Representation (CGR)',
    summary: 'Maps k-mer composition into a 2D image-like fingerprint to reveal compositional structure.',
    glossary: ['k-mer', 'dna-sequence', 'sequence-complexity'],
    modules: ['genomics-basics'],
    tips: [
      'Look for texture changes between regions—those often correspond to modular genome segments.',
      'Compare CGR against HGT/K-mer anomaly overlays to triangulate unusual islands.',
    ],
  },
  hilbert: {
    heading: 'Hilbert Curve',
    summary: 'Projects the genome onto a space-filling curve so nearby pixels represent nearby bases.',
    glossary: ['dna-sequence', 'gc-content', 'phage-genome'],
    modules: ['genomics-basics'],
    tips: [
      'Large blocks of similar color suggest long, compositionally consistent regions.',
      'Sharp boundaries can indicate domain swaps, repeats, or horizontally transferred islands.',
    ],
  },
  phaseportrait: {
    heading: 'Codon Phase Portrait',
    summary: 'Visualizes codon-usage structure as a trajectory through a reduced state space.',
    glossary: ['codon', 'codon-bias', 'genetic-code'],
    modules: ['genetic-code', 'genomics-basics'],
    tips: [
      'Smooth trajectories often mean consistent coding style; sharp turns can flag unusual regions.',
      'Compare against GC skew / anomaly overlays to see whether shifts align with composition changes.',
    ],
  },
  biasdecomposition: {
    heading: 'Codon Bias Decomposition',
    summary: 'Breaks codon usage into interpretable components so you can spot style shifts across the genome.',
    glossary: ['codon-bias', 'codon-usage-bias', 'codon'],
    modules: ['genetic-code', 'genomics-basics'],
    tips: [
      'Local spikes can suggest recently acquired genes or different expression regimes.',
      'Use together with gene annotations: structural vs replication genes often show different bias.',
    ],
  },
  crispr: {
    heading: 'CRISPR Spacers',
    summary: 'Surfaces candidate CRISPR spacer matches to the phage genome as a clue to host exposure history.',
    glossary: ['dna-sequence', 'phage-genome', 'gene'],
    modules: ['phage-lifecycle', 'genomics-basics'],
    tips: [
      'Clusters of hits may reflect past infections in specific bacterial lineages.',
      'Treat hits as hypotheses: validate with flanking context and gene neighborhood.',
    ],
  },
  comparison: {
    heading: 'Genome Comparison',
    summary: 'Compares two phages across sequence, composition, codon usage, gene content, and diffs.',
    glossary: ['synteny', 'dot-plot', 'gene'],
    modules: ['genomics-basics'],
    tips: [
      'Start with the Summary tab, then drill into Genes or Diff to explain why scores differ.',
      'Large gene-content differences often concentrate around host-range or replication modules.',
    ],
  },
  defensearmsrace: {
    heading: 'Defense Arms Race',
    summary: 'Anti-defense genes help phages evade bacterial immune systems such as CRISPR-Cas, restriction-modification, and abortive infection.',
    glossary: ['phage-genome', 'gene', 'dna-sequence'],
    modules: ['phage-lifecycle', 'genomics-basics'],
    tips: [
      'Anti-CRISPR genes often cluster near structural modules that face host surveillance.',
      'Anti-restriction proteins are common in phages that infect hosts with active RM systems.',
    ],
  },
};

const geneProductContext: Record<string, ContextHelpEntry> = {
  capsid: {
    heading: 'Capsid Proteins',
    summary: 'Structural shell proteins that protect the genome and define virion geometry.',
    glossary: ['capsid', 'phage-genome', 'dna-sequence'],
    modules: ['phage-lifecycle'],
    tips: [
      'Look for neighboring scaffold and portal genes in the gene map.',
      'Capsid mutations can impact packaging limits and stability.',
    ],
  },
  'tail-fiber': {
    heading: 'Tail Fibers',
    summary: 'Host-recognition structures that bind receptors and drive host specificity.',
    glossary: ['tail-fiber', 'phage-genome', 'lysogeny'],
    modules: ['phage-lifecycle'],
    tips: [
      'Sequence changes here often shift tropism; compare against receptor predictions.',
      'Adjacent chaperones or baseplate proteins can modulate folding and host range.',
    ],
  },
  holin: {
    heading: 'Holin',
    summary: 'Membrane pore proteins that time host lysis by opening the inner membrane.',
    glossary: ['lytic-cycle', 'holin', 'endolysin'],
    modules: ['phage-lifecycle'],
    tips: [
      'Holin and endolysin are usually co-located; check spacing for timing control.',
      'Mutations altering transmembrane domains can delay or accelerate lysis.',
    ],
  },
  endolysin: {
    heading: 'Endolysin',
    summary: 'Cell wall hydrolases that break peptidoglycan during lysis.',
    glossary: ['lytic-cycle', 'endolysin', 'gene'],
    modules: ['phage-lifecycle'],
    tips: [
      'Look for catalytic domain + cell-wall-binding domain architecture.',
      'Host-range tweaks sometimes come from swapping binding domains.',
    ],
  },
  lysogeny: {
    heading: 'Lysogeny Regulators',
    summary: 'Genes governing integration, maintenance, and induction of lysogenic state.',
    glossary: ['lysogeny', 'phage-genome', 'gene'],
    modules: ['phage-lifecycle'],
    tips: [
      'Integrase/repressor modules often sit near att sites; check for attP motifs.',
      'Stress-response promoters can hint at induction triggers.',
    ],
  },
};

const analysisContext: Record<string, ContextHelpEntry> = {
  comparison: {
    heading: 'Genome Comparison',
    summary: 'Compares a selected phage against references to spot divergence hot spots.',
    glossary: ['synteny', 'gc-content', 'gene'],
    modules: ['genomics-basics'],
    tips: [
      'Focus on synteny breaks and tail-fiber regions when explaining host shifts.',
      'Pair with dot plot to see whether differences are localized or genome-wide.',
    ],
  },
  simulations: {
    heading: 'Simulations',
    summary: 'Interactive models for infection dynamics, ribosome traffic, and packaging.',
    glossary: ['phage-genome', 'lysogeny', 'lytic-cycle'],
    modules: ['phage-lifecycle'],
    tips: [
      'Use simulations to illustrate why timing (lysis vs lysogeny) changes outcomes.',
      'Adjust parameters gradually to connect model behavior with biological intuition.',
    ],
  },
  overlays: {
    heading: 'Analysis Overlays',
    summary: 'Context-aware help index for the major overlays in the TUI and web app.',
    glossary: ['gc-skew', 'sequence-complexity', 'synteny'],
    modules: ['genomics-basics'],
    tips: [
      'Start with GC skew + complexity to build a quick genome mental model.',
      'Add specialized overlays (HGT, tropism) only after establishing baseline signals.',
    ],
  },
};

export const CONTEXT_CONTENT: ContextContentMapping = {
  overlays: overlayContext,
  geneProducts: geneProductContext,
  analyses: analysisContext,
};

export function getOverlayContext(key: string): ContextHelpEntry | undefined {
  const normalized = normalizeKey(key);
  return overlayContext[normalized];
}

export function getGeneProductContext(key: string): ContextHelpEntry | undefined {
  const normalized = normalizeKey(key);
  return geneProductContext[normalized];
}

export function getAnalysisContext(key: string): ContextHelpEntry | undefined {
  const normalized = normalizeKey(key);
  return analysisContext[normalized];
}
