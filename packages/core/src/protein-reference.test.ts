import { describe, expect, test } from 'bun:test';
import snapshot from '../../../data/protein-references/lambda-lamb-v1.json';
import { parseProteinReferenceBundle, proteinReferenceContentHash, type ProteinReferenceBundle,
  parseProteinAlignmentFasta, validateProteinAlignmentInput, PROTEIN_ALIGNMENT_LIMITS,
  prepareProteinCoordinateInput, validateProteinCoordinateInput, parseProteinCoordinates, PROTEIN_COORDINATE_LIMITS } from './protein-reference';

async function changed(edit: (bundle: ProteinReferenceBundle) => void): Promise<ProteinReferenceBundle> {
  const bundle = structuredClone(snapshot) as ProteinReferenceBundle;
  edit(bundle);
  const { bundleSha256: _identity, ...payload } = bundle;
  bundle.bundleSha256 = await proteinReferenceContentHash(payload);
  return bundle;
}

describe('Real protein input snapshot validation; not inference calibration', () => {
  test('retains exact primary protein/chain identities, real homolog rows and compatible vectors', async () => {
    const bundle = await parseProteinReferenceBundle(snapshot);
    expect(bundle.proteins.map(protein => protein.accession)).toEqual(['P03749', 'Q3YUU9', 'P0DXX7']);
    expect(bundle.proteins.map(protein => protein.sequence.length)).toEqual([1132, 446, 1192]);
    expect(bundle.proteins[0].sequenceSha256).toBe('08ac2d5fc2e1b7633310d801e26ffd4a0dc06e33b66ce7d0d967193eeb7dfe78');
    expect(bundle.embeddingSpace.weightsSha256).toBe('24c5fa474c48f3b754b86efe752d5f189d2bcd88190fa2270fc92b2ef3034189');
    expect(bundle.embeddingSpace.model).toBe('facebook/esm2_t6_8M_UR50D');
    expect(bundle.embeddingSpace.implementation).toBe('transformers-4.57.1/torch-2.8.0+cpu/cpu');
    expect(bundle.embeddings.map(row => [row.start, row.end, row.vector.length])).toEqual([[713, 1132, 320], [25, 446, 320]]);
    for (const vector of bundle.embeddings) expect(Math.hypot(...vector.vector)).toBeCloseTo(1, 6);
    const phage = bundle.chains[0];
    expect([phage.labelAsymId, phage.authAsymId, phage.start, phage.end, phage.coordinates.length]).toEqual(['D', 'Z', 713, 1132, 420]);
    // Directly checked atom_site row in the independently downloaded 8XCJ mmCIF.
    expect(phage.coordinates[0]).toEqual({ labelSeqId: 1, authSeqId: 713, insertionCode: '', aminoAcid: 'A', x: 244.882, y: 184.152, z: 253.950 });
    expect(bundle.chains[1].coordinates.length).toBe(422);
    expect(bundle.proteins[1].organism).toBe('Shigella sonnei (strain Ss046)');
    expect(bundle.evidence.experimentalHost).toBe('Shigella sonnei 3070');
    expect(bundle.domainInteractions[0].hostLoops).toEqual(['EL4', 'EL6', 'EL9']);
    expect(bundle.alignment.rows[0].alignedSequence.replace(/-/g, '')).toBe(bundle.proteins[0].sequence);
    expect(bundle.alignment.rows[1].alignedSequence.replace(/-/g, '')).toBe(bundle.proteins[2].sequence);
    expect(bundle.sources.every(source => source.license && source.version && source.sha256.length === 64)).toBe(true);
  });

  test('rejects altered snapshot bytes before accepting derived values', async () => {
    await expect(parseProteinReferenceBundle({ ...snapshot, id: 'changed' })).rejects.toThrow('checksum');
  });

  for (const [name, edit] of [
    ['wrong dimensions', (b: ProteinReferenceBundle) => { b.embeddings[0].vector.push(0); }],
    ['incompatible embedding spaces', (b: ProteinReferenceBundle) => { b.embeddings[1].spaceSha256 = '0'.repeat(64); }],
    ['different model revision', (b: ProteinReferenceBundle) => { b.embeddingSpace.revision = '0'.repeat(40); }],
    ['zero vector', (b: ProteinReferenceBundle) => { b.embeddings[0].vector.fill(0); }],
    ['wrong vector residue range', (b: ProteinReferenceBundle) => { b.embeddings[0].start++; }],
    ['unmapped chain offset', (b: ProteinReferenceBundle) => { b.chains[0].start--; }],
    ['missing coordinates', (b: ProteinReferenceBundle) => { b.chains[0].coordinates = []; }],
    ['duplicate observed residues', (b: ProteinReferenceBundle) => { b.chains[0].coordinates.push(b.chains[0].coordinates[0]); }],
    ['wrong observed amino acid', (b: ProteinReferenceBundle) => { b.chains[0].coordinates[0].aminoAcid = 'W'; }],
    ['mixed assemblies', (b: ProteinReferenceBundle) => { b.chains[1].assemblyId = '2'; }],
    ['broken homolog row', (b: ProteinReferenceBundle) => { b.alignment.rows[1].alignedSequence = b.alignment.rows[1].alignedSequence.slice(1); }],
    ['duplicate homolog identity', (b: ProteinReferenceBundle) => { b.alignment.rows[1] = b.alignment.rows[0]; }],
    ['missing source license', (b: ProteinReferenceBundle) => { b.sources[0].license = '' as 'MIT'; }],
    ['missing receptor vector', (b: ProteinReferenceBundle) => { b.embeddings.pop(); }],
    ['unsourced domain interaction', (b: ProteinReferenceBundle) => { b.domainInteractions[0].sourceId = 'unknown'; }],
    ['wrong domain interaction partners', (b: ProteinReferenceBundle) => { b.domainInteractions[0].hostProteinId = 'secphi27-j'; }],
    ['missing experimental provenance', (b: ProteinReferenceBundle) => { b.evidence.experimentalHostSourceId = 'unknown'; }],
  ] as const) {
    test(`withholds ${name} even when the outer content checksum is updated`, async () => {
      await expect(parseProteinReferenceBundle(await changed(edit))).rejects.toThrow('Invalid protein reference');
    });
  }

  test('refuses nonfinite numerical input rather than replacing it with JSON null', async () => {
    const bundle = structuredClone(snapshot);
    bundle.chains[0].coordinates[0].x = NaN;
    await expect(parseProteinReferenceBundle(bundle)).rejects.toThrow('finite');
  });
});

describe('Supplied protein alignments without invented complex inputs', () => {
  test('preserves complete rows, local labels, descriptions and declared source metadata', async () => {
    const source = { kind: 'local' as const, description: 'Private laboratory MSA, run 17', reference: 'Alignment notebook 2026-11-11' };
    const input = parseProteinAlignmentFasta('\uFEFF>sample-1 complete target\r\nac x-\r\nG\r\n>sample-2 homolog\r\nAZBCG\r\n', 'proteins.faa', source);
    expect(input.rows).toEqual([
      { id: 'sample-1', description: 'complete target', alignedSequence: 'ACX-G' },
      { id: 'sample-2', description: 'homolog', alignedSequence: 'AZBCG' },
    ]);
    expect(input.source).toEqual(source);
    expect(Object.keys(input).sort()).toEqual(['format', 'name', 'rows', 'source', 'version']);
    expect('cds' in input || 'chains' in input || 'embeddings' in input).toBe(false);
    expect(validateProteinAlignmentInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
    await expect(parseProteinReferenceBundle(input)).rejects.toThrow('Invalid protein reference');
  });

  test.each([
    ['unaligned rows', '>one\nAC\n>two\nA'],
    ['duplicate identifiers', '>same first\nAC\n>same second\nAC'],
    ['all-gap columns', '>one\nA-C\n>two\nA-C'],
    ['gap-only record', '>one\n--\n>two\nAC'],
    ['stop codon', '>one\nA*\n>two\nAC'],
    ['dot gap', '>one\nA.\n>two\nAC'],
    ['missing header', 'AC\n>two\nAC'],
    ['only one record', '>one\nAC'],
    ['empty header', '>\nAC\n>two\nAC'],
  ])('rejects %s instead of modifying evidence', (_name, content) => {
    expect(() => parseProteinAlignmentFasta(content, 'bad.faa')).toThrow();
  });

  test('refuses unsupported source claims and unbounded input before computation', () => {
    const input = parseProteinAlignmentFasta('>one\nAC\n>two\nAC', 'bounded.faa');
    expect(() => validateProteinAlignmentInput({ ...input, chains: [] })).toThrow('unsupported');
    expect(() => validateProteinAlignmentInput({ ...input, source: { ...input.source, kind: 'catalog' } })).toThrow('source');
    expect(() => validateProteinAlignmentInput({ ...input, source: { ...input.source, reference: '' } })).toThrow('reference');
    expect(() => parseProteinAlignmentFasta('>one\n' + 'A'.repeat(PROTEIN_ALIGNMENT_LIMITS.columns + 1), 'too-wide.faa')).toThrow('columns');
    expect(() => parseProteinAlignmentFasta(' '.repeat(PROTEIN_ALIGNMENT_LIMITS.bytes + 1), 'too-large.faa')).toThrow('2 MiB');
    expect(() => parseProteinAlignmentFasta(Array.from({ length: 257 }, (_, i) => '>r' + i + '\nAA').join('\n'), 'too-many.faa')).toThrow('256');
    expect(() => validateProteinAlignmentInput({ ...input, rows: Array.from({ length: 51 }, (_, i) => ({ id: 'r' + i, description: '', alignedSequence: 'A'.repeat(20000) })) })).toThrow('cells');
  });
});


describe('standalone mmCIF input and exact polymer mapping', () => {
  const headers = ['group_PDB', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id', 'label_asym_id',
    'label_seq_id', 'auth_asym_id', 'auth_seq_id', 'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'pdbx_PDB_model_num'];
  const rows = [
    'ATOM C CA . ALA A 1 Z -2 ? 0 0 0 1 1',
    'ATOM C CA . ASP A 3 Z 10 A 3 4 0 1 1',
    'ATOM C CA . GLY A 6 Z 10 B 0 0 12 1 1',
  ];
  const cif = (body = rows) => 'data_private\nloop_\n' + headers.map(name => '_atom_site.' + name).join('\n') + '\n' + body.join('\n') + '\n#\n';
  const input = (content = cif()) => prepareProteinCoordinateInput(content, '>target private sequence\nMKACDEFGH\n', 'private.cif',
    { labelAsymId: 'A', proteinStart: 3 }, { kind: 'local', description: 'Local experimental or model coordinates', reference: null });

  test('maps missing polymer positions without using author numbering or inventing residues', () => {
    const parsed = parseProteinCoordinates(input());
    expect(parsed.chain).toEqual({ proteinId: 'target', labelAsymId: 'A', authAsymId: 'Z', start: 3, coordinates: [
      { labelSeqId: 1, authSeqId: -2, insertionCode: '', aminoAcid: 'A', x: 0, y: 0, z: 0 },
      { labelSeqId: 3, authSeqId: 10, insertionCode: 'A', aminoAcid: 'D', x: 3, y: 4, z: 0 },
      { labelSeqId: 6, authSeqId: 10, insertionCode: 'B', aminoAcid: 'G', x: 0, y: 0, z: 12 },
    ] });
    expect(parsed.selection).toEqual({ dataBlock: 'private', model: 1, alternateLocation: null, minimumLabelSeqId: 1,
      maximumLabelSeqId: 6, omittedAlternateAtoms: 0, zeroOccupancyAtoms: 0 });
    expect(parsed.input.structure.content).toBe(cif());
    expect(parsed.input.protein).toEqual({ id: 'target', description: 'private sequence', sequence: 'MKACDEFGH' });
  });

  test('accepts quoted/wrapped rows, reordered case-insensitive columns, comments and unrelated semicolon text', () => {
    const order = [14, 10, 11, 12, 5, 0, 1, 2, 3, 4, 6, 7, 8, 9, 13];
    const content = 'data_private\n_struct.title\n;A local coordinate file\nwith a multiline title\n;\nloop_\n_note.id\n_note.text\n1 "loop_"\n# comment\nloop_\n' +
      order.map(index => '_ATOM_SITE.' + headers[index].toUpperCase()).join('\n') + '\n' +
      rows.map(row => order.map(index => index === 5 ? "'A'" : row.split(' ')[index]).join('\n')).join('\n') + '\n#\n';
    expect(parseProteinCoordinates(input(content)).chain.coordinates).toEqual(parseProteinCoordinates(input()).chain.coordinates);
  });

  test('selects an explicit model and chain without joining author labels or models', () => {
    const content = cif([...rows, rows[0].replace('ALA A', 'ALA B'), rows[1].replace('3 4 0 1 1', '30 40 0 1 2')]);
    expect(parseProteinCoordinates(input(content)).chain.coordinates).toHaveLength(3);
    const second = input(content); second.structure.model = 2;
    expect(parseProteinCoordinates(second).chain.coordinates).toEqual([
      { labelSeqId: 3, authSeqId: 10, insertionCode: 'A', aminoAcid: 'D', x: 30, y: 40, z: 0 },
    ]);
    second.structure.model = 3;
    expect(() => parseProteinCoordinates(second)).toThrow(/No uniquely identified/);
  });

  test('requires a declared conformer and counts excluded alternate/zero-occupancy atoms', () => {
    const content = cif([rows[0].replace('CA .', 'CA A').replace('0 0 0 1 1', '0 0 0 0.5 1'),
      rows[0].replace('CA .', 'CA B').replace('0 0 0 1 1', '10 0 0 0.5 1'),
      rows[1], rows[2], 'ATOM C CA . CYS A 2 Z 4 ? 1 1 1 0 1']);
    const value = input(content);
    expect(() => parseProteinCoordinates(value)).toThrow(/explicit alternate location/);
    value.structure.alternateLocation = 'A';
    const parsed = parseProteinCoordinates(value);
    expect(parsed.chain.coordinates).toHaveLength(3);
    expect(parsed.chain.coordinates[0].x).toBe(0);
    expect(parsed.selection.omittedAlternateAtoms).toBe(1);
    expect(parsed.selection.zeroOccupancyAtoms).toBe(1);
    value.structure.alternateLocation = 'B';
    expect(parseProteinCoordinates(value).chain.coordinates[0].x).toBe(10);
    value.structure.alternateLocation = 'C';
    expect(() => parseProteinCoordinates(value)).toThrow(/absent/);
  });

  test('refuses contradictory or ambiguous residue mappings and modified residues', () => {
    const invalid = [
      cif([...rows, rows[0]]),
      cif([rows[0], rows[1], rows[2].replace('10 B', '10 A')]),
      cif([rows[0], rows[1].replace(' Z 10', ' Y 10'), rows[2]]),
      cif([rows[0].replace('ALA', 'GLY'), ...rows.slice(1)]),
      cif([rows[0].replace('ATOM C CA', 'HETATM C CA'), ...rows.slice(1)]),
      cif([rows[0].replace('ALA', 'MSE'), ...rows.slice(1)]),
      cif([rows[0].replace(' A 1 ', ' A ? '), ...rows.slice(1)]),
    ];
    for (const content of invalid) expect(() => parseProteinCoordinates(input(content))).toThrow();
    const wrongOffset = input(); wrongOffset.structure.proteinStart = 4;
    expect(() => parseProteinCoordinates(wrongOffset)).toThrow(/does not match/);
  });

  test('does not accept permissive numeric parsing, incomplete loops or a second coordinate frame', () => {
    for (const content of [
      cif([rows[0].replace('0 0 0', '0junk 0 0'), ...rows.slice(1)]),
      cif([rows[0].replace('0 0 0', 'NaN 0 0'), ...rows.slice(1)]),
      cif([rows[0].replace('0 0 0 1 1', '0 0 0 1.1 1'), ...rows.slice(1)]),
      cif([rows[0].replace(' A 1 ', ' A 1.5 '), ...rows.slice(1)]),
      cif([rows[0].slice(0, -2)]),
      cif() + 'data_other\n_entry.id other\n',
      cif().replace('_atom_site.auth_seq_id\n', ''),
      cif() + 'loop_\n_atom_site.group_PDB\nATOM\n',
    ]) expect(() => parseProteinCoordinates(input(content))).toThrow();
  });

  test('bounds raw files and canonical snapshots, and requires one exact protein and explicit mapping', () => {
    expect(() => prepareProteinCoordinateInput(cif(), '>a\nAC\n>b\nAC\n', 'x', { labelAsymId: 'A', proteinStart: 1 })).toThrow(/exactly one/);
    expect(() => prepareProteinCoordinateInput(cif(), '>a\nACX\n', 'x', { labelAsymId: 'A', proteinStart: 1 })).toThrow(/canonical/);
    expect(() => prepareProteinCoordinateInput(cif(), '>a\nAC*\n', 'x', { labelAsymId: 'A', proteinStart: 1 })).toThrow(/canonical/);
    expect(() => prepareProteinCoordinateInput(cif(), '>a\nAC\n', 'x', { labelAsymId: 'A', proteinStart: 0 })).toThrow(/within/);
    expect(() => validateProteinCoordinateInput({ ...input(), embeddings: [] })).toThrow(/unsupported fields/);
    const value = input(); value.structure.content = 'x'.repeat(PROTEIN_COORDINATE_LIMITS.bytes + 1);
    expect(() => parseProteinCoordinates(value)).toThrow(/4 MiB/);
  });

  test('does not weaken the independent deposited-complex validation contract', async () => {
    await expect(parseProteinReferenceBundle(input())).rejects.toThrow();
  });
});
