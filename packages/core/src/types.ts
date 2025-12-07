// Nucleotide types
export type Nucleotide = 'A' | 'C' | 'G' | 'T' | 'N';

// Amino acid types - all 20 standard amino acids plus stop codon and unknown
export type AminoAcid =
  | 'A' | 'R' | 'N' | 'D' | 'C' | 'E' | 'Q' | 'G' | 'H' | 'I'
  | 'L' | 'K' | 'M' | 'F' | 'P' | 'S' | 'T' | 'W' | 'Y' | 'V'
  | '*' | 'X'; // Stop codon and Unknown

// Amino acid properties for grouping/coloring
export type AminoAcidProperty =
  | 'hydrophobic'
  | 'polar'
  | 'acidic'
  | 'basic'
  | 'special'
  | 'stop';

// Amino acid metadata
export interface AminoAcidInfo {
  letter: AminoAcid;
  threeCode: string;
  name: string;
  property: AminoAcidProperty;
}

// View modes
export type ViewMode = 'dna' | 'aa';

// Reading frame
export type ReadingFrame = 0 | 1 | 2;

// Grid cell for rendering
export interface GridCell {
  char: string;
  position: number; // absolute position in sequence
  diff?: 'same' | 'different' | 'gap';
}

// Grid row for rendering
export interface GridRow {
  rowIndex: number;
  cells: GridCell[];
}

// Phage summary for list display
export interface PhageSummary {
  id: number;
  slug: string | null;
  name: string;
  accession: string;
  family: string | null;
  host: string | null;
  genomeLength: number | null;
  gcContent: number | null;
  morphology: string | null;
  lifecycle: string | null;
}

// Gene info
export interface GeneInfo {
  id: number;
  name: string | null;
  locusTag: string | null;
  startPos: number;
  endPos: number;
  strand: string | null;
  product: string | null;
  type: string | null;
}

// Codon usage data
export interface CodonUsageData {
  aaCounts: Record<string, number>;
  codonCounts: Record<string, number>;
}

// Full phage data
export interface PhageFull extends PhageSummary {
  description: string | null;
  baltimoreGroup: string | null;
  genomeType: string | null;
  pdbIds: string[];
  genes: GeneInfo[];
  codonUsage: CodonUsageData | null;
  hasModel: boolean;
}

// Virtual window for sequence fetching
export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  overscan: number;
}

// Viewport configuration
export interface ViewportConfig {
  cols: number;
  rows: number;
  hudHeight: number;
  footerHeight: number;
  sidebarWidth: number;
  geneMapHeight: number;
  model3DHeight: number;
}
