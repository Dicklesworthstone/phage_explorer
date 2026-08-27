import { describe, expect, it } from 'bun:test';
import {
  buildNcbiNucleotideUrl,
  buildPhageCitation,
  buildRcsbPdbUrl,
  formatCitationAccessDate,
} from './research-record';

describe('primary-source URLs', () => {
  it('builds version-preserving NCBI Nucleotide links', () => {
    expect(buildNcbiNucleotideUrl(' NC_000866.4 ')).toBe(
      'https://www.ncbi.nlm.nih.gov/nuccore/NC_000866.4'
    );
  });

  it('normalizes RCSB PDB identifiers', () => {
    expect(buildRcsbPdbUrl(' 5vf3 ')).toBe('https://www.rcsb.org/structure/5VF3');
  });
});

describe('buildPhageCitation', () => {
  it('includes the primary accession, scoped structures, exact explorer state, and access date', () => {
    expect(
      buildPhageCitation({
        name: 'Enterobacteria phage T4',
        accession: 'NC_000866.4',
        pdbIds: ['5vf3', '5VF3', ' 7ABC '],
        explorerUrl: 'https://phage-explorer.org/?phage=t4&view=dna&pos=120',
        accessedAt: new Date('2026-08-27T12:00:00.000Z'),
      })
    ).toBe(
      'Enterobacteria phage T4. NCBI Nucleotide accession NC_000866.4. Associated phage-level RCSB PDB records: 5VF3, 7ABC. Phage Explorer, https://phage-explorer.org/?phage=t4&view=dna&pos=120 (accessed 2026-08-27).'
    );
  });

  it('does not imply that phage-level structures belong to a selected gene', () => {
    const citation = buildPhageCitation({
      name: 'gp23 in Enterobacteria phage T4',
      accession: 'NC_000866.4',
      pdbIds: ['5VF3'],
      explorerUrl: 'https://phage-explorer.org/?phage=t4&gene=gp23',
      accessedAt: new Date('2026-08-27T12:00:00.000Z'),
    });

    expect(citation).toContain('Associated phage-level RCSB PDB records: 5VF3.');
    expect(citation).not.toContain('gp23 RCSB PDB');
  });

  it('remains useful when no structure record is available', () => {
    expect(
      buildPhageCitation({
        name: 'Example phage',
        accession: 'ABC123',
        explorerUrl: '',
        accessedAt: new Date('2025-01-02T00:00:00.000Z'),
      })
    ).toBe(
      'Example phage. NCBI Nucleotide accession ABC123. Phage Explorer (accessed 2025-01-02).'
    );
  });
});

describe('formatCitationAccessDate', () => {
  it('uses a locale-independent ISO calendar date', () => {
    expect(formatCitationAccessDate(new Date('2024-02-29T23:59:59.000Z'))).toBe('2024-02-29');
  });

  it('handles invalid dates explicitly', () => {
    expect(formatCitationAccessDate(new Date(Number.NaN))).toBe('unknown date');
  });
});
