import { describe, expect, test } from 'bun:test';
import { alignReferenceProteins, referenceCAlpha } from './build-protein-reference';

describe('Bounded source protein alignment', () => {
  test('retains gaps at actual deletion positions', () => {
    expect(alignReferenceProteins('ACDE', 'ADE')).toEqual(['ACDE', 'A-DE']);
    expect(alignReferenceProteins('ADE', 'ACDE')).toEqual(['A-DE', 'ACDE']);
    expect(alignReferenceProteins('MACK', 'MACK')).toEqual(['MACK', 'MACK']);
  });
  test('rejects unresolved or oversized source proteins', () => {
    for (const sequence of ['', 'MA-X', 'MAC*', 'A'.repeat(2001)]) {
      expect(() => alignReferenceProteins(sequence, 'MAC')).toThrow();
    }
  });
});

// Small syntax controls only. Real coordinates are checked in the committed input snapshot tests.
const headers = ['group_PDB', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id', 'label_asym_id',
  'label_seq_id', 'auth_asym_id', 'auth_seq_id', 'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z',
  'occupancy', 'pdbx_PDB_model_num'];
const cif = (row: string) => `data_test\nloop_\n${headers.map(name => '_atom_site.' + name).join('\n')}\n${row}\n#\n`;
const atom = 'ATOM C CA . ALA D 1 Z 713 ? 244.882 184.152 253.950 1.0 1';
describe('Explicit observed alpha-carbon source profile', () => {
  test('keeps label and author numbering separate', () => {
    const result = referenceCAlpha(cif(atom), 'D');
    expect(result.authAsymId).toBe('Z');
    expect(result.atoms[0].labelSeqId).toBe(1);
    expect(result.atoms[0].authSeqId).toBe(713);
  });
  test('refuses ambiguous alternatives, partial rows and nonfinite coordinates', () => {
    for (const broken of [atom.replace('CA .', 'CA A'), atom.replace('1.0 1', '0.5 1'),
      atom.replace('244.882', 'NaN'), atom.slice(0, -2), `${atom}\n${atom}`]) {
      expect(() => referenceCAlpha(cif(broken), 'D')).toThrow();
    }
    expect(() => referenceCAlpha(cif(atom), 'missing')).toThrow();
  });
});
