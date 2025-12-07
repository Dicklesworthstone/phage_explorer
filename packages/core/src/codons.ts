import type { AminoAcid, AminoAcidInfo, AminoAcidProperty } from './types';

// Standard DNA codon table (Translation Table 1 / Bacterial Nuclear Code)
export const CODON_TABLE: Record<string, AminoAcid> = {
  // Phenylalanine (F)
  'TTT': 'F', 'TTC': 'F',
  // Leucine (L)
  'TTA': 'L', 'TTG': 'L', 'CTT': 'L', 'CTC': 'L', 'CTA': 'L', 'CTG': 'L',
  // Isoleucine (I)
  'ATT': 'I', 'ATC': 'I', 'ATA': 'I',
  // Methionine (M) - Start codon
  'ATG': 'M',
  // Valine (V)
  'GTT': 'V', 'GTC': 'V', 'GTA': 'V', 'GTG': 'V',
  // Serine (S)
  'TCT': 'S', 'TCC': 'S', 'TCA': 'S', 'TCG': 'S', 'AGT': 'S', 'AGC': 'S',
  // Proline (P)
  'CCT': 'P', 'CCC': 'P', 'CCA': 'P', 'CCG': 'P',
  // Threonine (T)
  'ACT': 'T', 'ACC': 'T', 'ACA': 'T', 'ACG': 'T',
  // Alanine (A)
  'GCT': 'A', 'GCC': 'A', 'GCA': 'A', 'GCG': 'A',
  // Tyrosine (Y)
  'TAT': 'Y', 'TAC': 'Y',
  // Stop codons (*)
  'TAA': '*', 'TAG': '*', 'TGA': '*',
  // Histidine (H)
  'CAT': 'H', 'CAC': 'H',
  // Glutamine (Q)
  'CAA': 'Q', 'CAG': 'Q',
  // Asparagine (N)
  'AAT': 'N', 'AAC': 'N',
  // Lysine (K)
  'AAA': 'K', 'AAG': 'K',
  // Aspartic acid (D)
  'GAT': 'D', 'GAC': 'D',
  // Glutamic acid (E)
  'GAA': 'E', 'GAG': 'E',
  // Cysteine (C)
  'TGT': 'C', 'TGC': 'C',
  // Tryptophan (W)
  'TGG': 'W',
  // Arginine (R)
  'CGT': 'R', 'CGC': 'R', 'CGA': 'R', 'CGG': 'R', 'AGA': 'R', 'AGG': 'R',
  // Glycine (G)
  'GGT': 'G', 'GGC': 'G', 'GGA': 'G', 'GGG': 'G',
};

// Amino acid metadata
export const AMINO_ACIDS: Record<AminoAcid, AminoAcidInfo> = {
  'A': { letter: 'A', threeCode: 'Ala', name: 'Alanine', property: 'hydrophobic' },
  'R': { letter: 'R', threeCode: 'Arg', name: 'Arginine', property: 'basic' },
  'N': { letter: 'N', threeCode: 'Asn', name: 'Asparagine', property: 'polar' },
  'D': { letter: 'D', threeCode: 'Asp', name: 'Aspartic acid', property: 'acidic' },
  'C': { letter: 'C', threeCode: 'Cys', name: 'Cysteine', property: 'special' },
  'E': { letter: 'E', threeCode: 'Glu', name: 'Glutamic acid', property: 'acidic' },
  'Q': { letter: 'Q', threeCode: 'Gln', name: 'Glutamine', property: 'polar' },
  'G': { letter: 'G', threeCode: 'Gly', name: 'Glycine', property: 'special' },
  'H': { letter: 'H', threeCode: 'His', name: 'Histidine', property: 'basic' },
  'I': { letter: 'I', threeCode: 'Ile', name: 'Isoleucine', property: 'hydrophobic' },
  'L': { letter: 'L', threeCode: 'Leu', name: 'Leucine', property: 'hydrophobic' },
  'K': { letter: 'K', threeCode: 'Lys', name: 'Lysine', property: 'basic' },
  'M': { letter: 'M', threeCode: 'Met', name: 'Methionine', property: 'hydrophobic' },
  'F': { letter: 'F', threeCode: 'Phe', name: 'Phenylalanine', property: 'hydrophobic' },
  'P': { letter: 'P', threeCode: 'Pro', name: 'Proline', property: 'special' },
  'S': { letter: 'S', threeCode: 'Ser', name: 'Serine', property: 'polar' },
  'T': { letter: 'T', threeCode: 'Thr', name: 'Threonine', property: 'polar' },
  'W': { letter: 'W', threeCode: 'Trp', name: 'Tryptophan', property: 'hydrophobic' },
  'Y': { letter: 'Y', threeCode: 'Tyr', name: 'Tyrosine', property: 'polar' },
  'V': { letter: 'V', threeCode: 'Val', name: 'Valine', property: 'hydrophobic' },
  '*': { letter: '*', threeCode: 'Stop', name: 'Stop codon', property: 'stop' },
  'X': { letter: 'X', threeCode: '???', name: 'Unknown', property: 'special' },
};

// Get amino acids by property
export function getAminoAcidsByProperty(property: AminoAcidProperty): AminoAcidInfo[] {
  return Object.values(AMINO_ACIDS).filter(aa => aa.property === property);
}

// Translate a single codon to amino acid
export function translateCodon(codon: string): AminoAcid {
  const upperCodon = codon.toUpperCase();
  return CODON_TABLE[upperCodon] ?? 'X'; // Use 'X' for unknown codons
}

// Translate a DNA sequence to amino acids at a given reading frame
export function translateSequence(seq: string, frame: 0 | 1 | 2 = 0): string {
  const result: string[] = [];
  const upperSeq = seq.toUpperCase();

  for (let i = frame; i + 3 <= upperSeq.length; i += 3) {
    const codon = upperSeq.substring(i, i + 3);
    const aa = CODON_TABLE[codon];
    result.push(aa ?? 'X'); // X for unknown codons (containing N, etc.)
  }

  return result.join('');
}

// Slice nucleotides from a sequence
export function sliceNucleotides(seq: string, offset: number, length: number): string {
  return seq.substring(offset, offset + length);
}

// Slice amino acids (given pre-translated AA sequence)
export function sliceAminoAcids(aaSeq: string, offset: number, length: number): string {
  return aaSeq.substring(offset, offset + length);
}

// Get reverse complement of a DNA sequence
export function reverseComplement(seq: string): string {
  const complement: Record<string, string> = {
    // Standard
    'A': 'T', 'T': 'A', 'G': 'C', 'C': 'G',
    'a': 't', 't': 'a', 'g': 'c', 'c': 'g',
    // Ambiguity codes (IUPAC)
    'N': 'N', 'n': 'n',
    'R': 'Y', 'r': 'y', // Purine (A/G) -> Pyrimidine (T/C)
    'Y': 'R', 'y': 'r', // Pyrimidine (T/C) -> Purine (A/G)
    'S': 'S', 's': 's', // Strong (G/C) -> Strong (C/G)
    'W': 'W', 'w': 'w', // Weak (A/T) -> Weak (T/A)
    'K': 'M', 'k': 'm', // Keto (G/T) -> Amino (A/C)
    'M': 'K', 'm': 'k', // Amino (A/C) -> Keto (T/G)
    'B': 'V', 'b': 'v', // Not A (C/G/T) -> Not T (G/C/A)
    'D': 'H', 'd': 'h', // Not C (A/G/T) -> Not G (T/C/A)
    'H': 'D', 'h': 'd', // Not G (A/C/T) -> Not C (T/G/A)
    'V': 'B', 'v': 'b', // Not T (A/C/G) -> Not A (T/G/C)
  };

  return seq
    .split('')
    .reverse()
    .map(c => complement[c] ?? c) // Keep unknown chars as-is
    .join('');
}

// Calculate GC content percentage
export function calculateGCContent(seq: string): number {
  const upperSeq = seq.toUpperCase();
  let gc = 0;
  let total = 0;

  for (const char of upperSeq) {
    if (char === 'G' || char === 'C') {
      gc++;
      total++;
    } else if (char === 'A' || char === 'T') {
      total++;
    }
  }

  return total > 0 ? (gc / total) * 100 : 0;
}

// Count codon usage in a sequence
export function countCodonUsage(seq: string, frame: 0 | 1 | 2 = 0): Record<string, number> {
  const counts: Record<string, number> = {};
  const upperSeq = seq.toUpperCase();

  for (let i = frame; i + 3 <= upperSeq.length; i += 3) {
    const codon = upperSeq.substring(i, i + 3);
    counts[codon] = (counts[codon] ?? 0) + 1;
  }

  return counts;
}

// Count amino acid usage
export function countAminoAcidUsage(aaSeq: string): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const aa of aaSeq) {
    counts[aa] = (counts[aa] ?? 0) + 1;
  }

  return counts;
}
