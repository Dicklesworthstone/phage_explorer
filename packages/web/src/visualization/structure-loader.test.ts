import { describe, expect, it } from 'bun:test';
import { parsePDB, parseMMCIF } from './structure-loader';

describe('structure loader parsers', () => {
  it('parses basic PDB atom records', () => {
    const pdb = [
      'ATOM      1  N   ALA A   1      11.104  13.207   7.219  1.00  0.00           N',
      'ATOM      2  CA  ALA A   1      12.560  13.369   7.478  1.00  0.00           C',
      'HETATM    3  O   HOH B   2      15.000  10.000   5.000  1.00  0.00           O',
    ].join('\n');

    const atoms = parsePDB(pdb);
    expect(atoms.length).toBe(3);
    expect(atoms[0].element).toBe('N');
    expect(atoms[2].element).toBe('O');
  });

  it('parses minimal mmCIF atom_site loop', () => {
    const cif = `
data_test
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
ATOM 1 C 1.0 2.0 3.0
ATOM 2 O 4.0 5.0 6.0
#`;

    const atoms = parseMMCIF(cif);
    expect(atoms.length).toBe(2);
    expect(atoms[0]).toMatchObject({ x: 1, y: 2, z: 3, element: 'C' });
    expect(atoms[1].element).toBe('O');
  });
});

