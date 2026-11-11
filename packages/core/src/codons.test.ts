/**
 * Tests for Codons Module
 *
 * Tests codon translation, reverse complement, GC content calculation,
 * and usage counting functions.
 */

import { describe, test, expect } from 'bun:test';
import {
  CODON_TABLE,
  AMINO_ACIDS,
  getAminoAcidsByProperty,
  getGeneticCode,
  isSupportedGeneticCode,
  translateCodon,
  translateSequence,
  sliceNucleotides,
  sliceAminoAcids,
  reverseComplement,
  calculateGCContent,
  countCodonUsage,
  countAminoAcidUsage,
} from './codons';

describe('CODON_TABLE', () => {
  test('has 64 entries', () => {
    expect(Object.keys(CODON_TABLE).length).toBe(64);
  });

  test('contains start codon ATG -> M', () => {
    expect(CODON_TABLE.ATG).toBe('M');
  });

  test('contains stop codons', () => {
    expect(CODON_TABLE.TAA).toBe('*');
    expect(CODON_TABLE.TAG).toBe('*');
    expect(CODON_TABLE.TGA).toBe('*');
  });

  test('maps all codons to single-letter amino acids', () => {
    for (const [codon, aa] of Object.entries(CODON_TABLE)) {
      expect(codon).toHaveLength(3);
      expect(aa).toHaveLength(1);
    }
  });
});

describe('explicit genetic codes', () => {
  test('matches all 64 elongation meanings and initiators against NCBI AAs/Starts rows', () => {
    // Literal independent source oracle, in NCBI TCAG order (not the implementation's table layout).
    // https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi, verified 2026-11-11.
    const sourceRows = [
      [1, 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG', '---M------**--*----M---------------M----------------------------'],
      [4, 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG', '--MM------**-------M------------MMMM---------------M------------'],
      [11, 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG', '---M------**--*----M------------MMMM---------------M------------'],
      [15, 'FFLLSSSSYY*QCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG', '----------*---*--------------------M----------------------------'],
      [25, 'FFLLSSSSYY**CCGWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG', '---M------**-----------------------M---------------M------------'],
    ] as const;
    for (const [code, amino, starts] of sourceRows) {
      let index = 0;
      for (const first of 'TCAG') for (const second of 'TCAG') for (const third of 'TCAG') {
        const codon = first + second + third;
        expect(translateCodon(codon, code)).toBe(amino[index]);
        expect(getGeneticCode(code).starts.includes(codon)).toBe(starts[index] === 'M');
        index++;
      }
      expect(index).toBe(64);
      expect(amino.length).toBe(64);
      expect(starts.length).toBe(64);
    }
  });
  test('keeps elongation separate from initiation and honors frames, ambiguity and explicit refusals', () => {
    expect(translateSequence('ttgtgataa', 0, 25)).toBe('LG*');
    expect(translateSequence('AATGTGATAA', 1, 4)).toBe('MW*');
    expect(translateSequence('ATGTAGTAA', 0, 15)).toBe('MQ*');
    expect(translateSequence('ATGNNNTAA', 0, 4)).toBe('MX*');
    expect(translateSequence('ATGTGATAA')).toBe('M**');
    for (const code of [0, 2, 6, 26, 4.5, NaN, Infinity]) {
      expect(isSupportedGeneticCode(code)).toBe(false);
      expect(() => translateSequence('ATGTGA', 0, code)).toThrow('Unsupported genetic code');
    }
  });
});

describe('AMINO_ACIDS', () => {
  test('contains all 20 standard amino acids plus stop and unknown', () => {
    // 20 amino acids + stop (*) + unknown (X) = 22
    expect(Object.keys(AMINO_ACIDS).length).toBe(22);
  });

  test('each entry has required properties', () => {
    for (const [letter, info] of Object.entries(AMINO_ACIDS)) {
      expect(info).toHaveProperty('letter');
      expect(info).toHaveProperty('threeCode');
      expect(info).toHaveProperty('name');
      expect(info).toHaveProperty('property');
      expect(info.letter).toBe(letter as typeof info.letter);
    }
  });

  test('contains expected amino acids', () => {
    expect(AMINO_ACIDS.M.name).toBe('Methionine');
    expect(AMINO_ACIDS.W.name).toBe('Tryptophan');
    expect(AMINO_ACIDS['*'].name).toBe('Stop codon');
  });
});

describe('getAminoAcidsByProperty', () => {
  test('returns hydrophobic amino acids', () => {
    const hydrophobic = getAminoAcidsByProperty('hydrophobic');
    expect(hydrophobic.length).toBeGreaterThan(0);
    expect(hydrophobic.every((aa) => aa.property === 'hydrophobic')).toBe(true);
    // A, I, L, M, F, W, V are hydrophobic
    expect(hydrophobic.some((aa) => aa.letter === 'A')).toBe(true);
    expect(hydrophobic.some((aa) => aa.letter === 'L')).toBe(true);
  });

  test('returns acidic amino acids', () => {
    const acidic = getAminoAcidsByProperty('acidic');
    expect(acidic.length).toBe(2); // D and E
    expect(acidic.some((aa) => aa.letter === 'D')).toBe(true);
    expect(acidic.some((aa) => aa.letter === 'E')).toBe(true);
  });

  test('returns basic amino acids', () => {
    const basic = getAminoAcidsByProperty('basic');
    expect(basic.length).toBe(3); // R, H, K
    expect(basic.some((aa) => aa.letter === 'R')).toBe(true);
    expect(basic.some((aa) => aa.letter === 'K')).toBe(true);
    expect(basic.some((aa) => aa.letter === 'H')).toBe(true);
  });

  test('returns polar amino acids', () => {
    const polar = getAminoAcidsByProperty('polar');
    expect(polar.length).toBeGreaterThan(0);
    expect(polar.every((aa) => aa.property === 'polar')).toBe(true);
  });

  test('returns stop codon', () => {
    const stop = getAminoAcidsByProperty('stop');
    expect(stop.length).toBe(1);
    expect(stop[0].letter).toBe('*');
  });
});

describe('translateCodon', () => {
  test('translates known codons', () => {
    expect(translateCodon('ATG')).toBe('M');
    expect(translateCodon('TTT')).toBe('F');
    expect(translateCodon('TAA')).toBe('*');
  });

  test('handles lowercase', () => {
    expect(translateCodon('atg')).toBe('M');
    expect(translateCodon('Ttt')).toBe('F');
  });

  test('returns X for unknown codons', () => {
    expect(translateCodon('NNN')).toBe('X');
    expect(translateCodon('XXX')).toBe('X');
  });
});

describe('translateSequence', () => {
  test('translates simple sequence', () => {
    // ATG (M) + TTT (F) + TAA (*)
    expect(translateSequence('ATGTTTTAA')).toBe('MF*');
  });

  test('handles incomplete trailing codons', () => {
    // ATG (M) + AT (incomplete, ignored)
    expect(translateSequence('ATGAT')).toBe('M');
  });

  test('supports different reading frames', () => {
    const seq = 'AATGTTTTAA';
    expect(translateSequence(seq, 0)).toBe('NVL'); // AAT=N, GTT=V, TTA=L
    expect(translateSequence(seq, 1)).toBe('MF*'); // ATG, TTT, TAA
  });

  test('handles lowercase', () => {
    expect(translateSequence('atgttttaa')).toBe('MF*');
  });

  test('returns empty string for short sequences', () => {
    expect(translateSequence('AT')).toBe('');
    expect(translateSequence('')).toBe('');
  });

  test('uses X for codons with N', () => {
    expect(translateSequence('ATGNNN')).toBe('MX');
  });
});

describe('sliceNucleotides', () => {
  test('slices nucleotides correctly', () => {
    const seq = 'ATGCATGC';
    expect(sliceNucleotides(seq, 0, 3)).toBe('ATG');
    expect(sliceNucleotides(seq, 3, 3)).toBe('CAT');
  });

  test('handles edge cases', () => {
    const seq = 'ATGC';
    expect(sliceNucleotides(seq, 0, 10)).toBe('ATGC'); // beyond length
    expect(sliceNucleotides(seq, 2, 2)).toBe('GC');
  });
});

describe('sliceAminoAcids', () => {
  test('slices amino acids correctly', () => {
    const aaSeq = 'MFKLDW';
    expect(sliceAminoAcids(aaSeq, 0, 3)).toBe('MFK');
    expect(sliceAminoAcids(aaSeq, 2, 2)).toBe('KL');
  });
});

describe('reverseComplement', () => {
  test('complements and reverses', () => {
    expect(reverseComplement('ATGC')).toBe('GCAT');
    expect(reverseComplement('AAAA')).toBe('TTTT');
    expect(reverseComplement('CCCC')).toBe('GGGG');
  });

  test('handles lowercase', () => {
    expect(reverseComplement('atgc')).toBe('gcat');
    expect(reverseComplement('ATgc')).toBe('gcAT');
  });

  test('handles ambiguity codes', () => {
    // RYSWKM reversed = MKWSYR, then complemented: M→K, K→M, W→W, S→S, Y→R, R→Y
    expect(reverseComplement('RYSWKM')).toBe('KMWSRY');
    // BDHV reversed = VHDB, then complemented: V→B, H→D, D→H, B→V = BDHV (palindromic!)
    expect(reverseComplement('BDHV')).toBe('BDHV');
  });

  test('handles N', () => {
    expect(reverseComplement('ATNG')).toBe('CNAT');
  });

  test('preserves unknown characters', () => {
    expect(reverseComplement('ATX')).toBe('XAT');
  });

  test('empty string returns empty', () => {
    expect(reverseComplement('')).toBe('');
  });

  test('single nucleotide', () => {
    expect(reverseComplement('A')).toBe('T');
    expect(reverseComplement('G')).toBe('C');
  });
});

describe('calculateGCContent', () => {
  test('calculates 100% GC', () => {
    expect(calculateGCContent('GGCC')).toBe(100);
    expect(calculateGCContent('GCGC')).toBe(100);
  });

  test('calculates 0% GC', () => {
    expect(calculateGCContent('AATT')).toBe(0);
    expect(calculateGCContent('TATA')).toBe(0);
  });

  test('calculates 50% GC', () => {
    expect(calculateGCContent('ATGC')).toBe(50);
    expect(calculateGCContent('ACGT')).toBe(50);
  });

  test('handles lowercase', () => {
    expect(calculateGCContent('atgc')).toBe(50);
  });

  test('ignores N and other characters', () => {
    expect(calculateGCContent('ATGCNN')).toBe(50); // Only counts ATGC
  });

  test('returns 0 for empty sequence', () => {
    expect(calculateGCContent('')).toBe(0);
  });

  test('returns 0 for all-N sequence', () => {
    expect(calculateGCContent('NNNN')).toBe(0);
  });
});

describe('countCodonUsage', () => {
  test('counts codons in frame 0', () => {
    const seq = 'ATGATGATG'; // 3x ATG
    const counts = countCodonUsage(seq, 0);
    expect(counts.ATG).toBe(3);
  });

  test('counts different codons', () => {
    const seq = 'ATGTTTTAA'; // ATG, TTT, TAA
    const counts = countCodonUsage(seq, 0);
    expect(counts.ATG).toBe(1);
    expect(counts.TTT).toBe(1);
    expect(counts.TAA).toBe(1);
  });

  test('handles different frames', () => {
    const seq = 'AATGTTTTAA';
    const counts0 = countCodonUsage(seq, 0); // AAT, GTT, TTA
    const counts1 = countCodonUsage(seq, 1); // ATG, TTT, TAA

    expect(counts0.AAT).toBe(1);
    expect(counts1.ATG).toBe(1);
  });

  test('handles lowercase', () => {
    const counts = countCodonUsage('atgatg', 0);
    expect(counts.ATG).toBe(2);
  });

  test('ignores incomplete codons', () => {
    const counts = countCodonUsage('ATGAT', 0); // ATG + incomplete AT
    expect(counts.ATG).toBe(1);
    expect(counts.AT).toBeUndefined();
  });

  test('returns empty object for short sequences', () => {
    const counts = countCodonUsage('AT', 0);
    expect(Object.keys(counts).length).toBe(0);
  });
});

describe('countAminoAcidUsage', () => {
  test('counts amino acids', () => {
    const counts = countAminoAcidUsage('MMFFF');
    expect(counts.M).toBe(2);
    expect(counts.F).toBe(3);
  });

  test('handles all unique', () => {
    const counts = countAminoAcidUsage('MFKLDW');
    expect(Object.keys(counts).length).toBe(6);
    expect(counts.M).toBe(1);
    expect(counts.W).toBe(1);
  });

  test('handles empty string', () => {
    const counts = countAminoAcidUsage('');
    expect(Object.keys(counts).length).toBe(0);
  });

  test('counts stop codons', () => {
    const counts = countAminoAcidUsage('M*F*');
    expect(counts['*']).toBe(2);
  });
});
