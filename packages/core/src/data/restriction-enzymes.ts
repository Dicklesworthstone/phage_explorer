/**
 * Restriction Enzyme Database
 *
 * Common restriction enzymes used in molecular biology.
 * Includes recognition sites and cut offsets.
 * Site format: 5'-...-3'
 * Cut offset: index after which cut occurs on forward strand.
 *
 * Based on NEB/neb.com
 */

export interface RestrictionEnzyme {
  name: string;
  site: string;
  cutOffset: number; // 0-based index after which cut occurs
  overhang: '5' | '3' | 'blunt';
}

export const RESTRICTION_ENZYMES: RestrictionEnzyme[] = [
  // 6-cutters (Common)
  { name: 'EcoRI', site: 'GAATTC', cutOffset: 1, overhang: '5' },
  { name: 'BamHI', site: 'GGATCC', cutOffset: 1, overhang: '5' },
  { name: 'HindIII', site: 'AAGCTT', cutOffset: 1, overhang: '5' },
  { name: 'NotI', site: 'GCGGCCGC', cutOffset: 2, overhang: '5' }, // 8-cutter
  { name: 'XbaI', site: 'TCTAGA', cutOffset: 1, overhang: '5' },
  { name: 'PstI', site: 'CTGCAG', cutOffset: 5, overhang: '3' },
  { name: 'SalI', site: 'GTCGAC', cutOffset: 1, overhang: '5' },
  { name: 'SacI', site: 'GAGCTC', cutOffset: 5, overhang: '3' },
  { name: 'KpnI', site: 'GGTACC', cutOffset: 5, overhang: '3' },
  { name: 'SmaI', site: 'CCCGGG', cutOffset: 3, overhang: 'blunt' },
  { name: 'ClaI', site: 'ATCGAT', cutOffset: 2, overhang: '5' },
  { name: 'EcoRV', site: 'GATATC', cutOffset: 3, overhang: 'blunt' },
  
  // 4-cutters (Frequent)
  { name: 'AluI', site: 'AGCT', cutOffset: 2, overhang: 'blunt' },
  { name: 'HaeIII', site: 'GGCC', cutOffset: 2, overhang: 'blunt' },
  { name: 'MboI', site: 'GATC', cutOffset: 0, overhang: '5' },
  { name: 'MspI', site: 'CCGG', cutOffset: 1, overhang: '5' },
  
  // 5-cutters
  { name: 'AvaII', site: 'GGWCC', cutOffset: 1, overhang: '5' }, // W = A or T
];

// Helper to expand IUPAC ambiguity codes in sites
// R=A/G, Y=C/T, M=A/C, K=G/T, S=G/C, W=A/T, H=A/C/T, B=G/C/T, V=G/A/C, D=G/A/T, N=A/C/G/T
export function expandSiteRegex(site: string): RegExp {
  const map: Record<string, string> = {
    A: 'A', C: 'C', G: 'G', T: 'T',
    R: '[AG]', Y: '[CT]', M: '[AC]', K: '[GT]', S: '[GC]', W: '[AT]',
    H: '[ACT]', B: '[GCT]', V: '[GAC]', D: '[GAT]', N: '.'
  };
  
  const regexStr = site.toUpperCase().split('').map(c => map[c] || c).join('');
  return new RegExp(regexStr, 'g');
}
