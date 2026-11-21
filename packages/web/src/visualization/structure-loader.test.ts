import { describe, expect, it, spyOn } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { reverseComplement, type GeneInfo } from '@phage-explorer/core';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import lambdaReference from '../../../../data/protein-references/lambda-lamb-v1.json';
import { buildStructureResidueMappings, structureResidueKey } from './structure-sequence';
import { parsePDB, parseMMCIF, getStructureWorkerPool, loadStructure, type AtomRecord } from './structure-loader';
import type { WorkerOutput } from './structure.worker';
import * as structureCache from '../db/structure-cache';

describe('structure loader parsers', () => {
  it('parses basic PDB atom records', () => {
    const pdb = [
      'ATOM      1  N   ALA A   1      11.104  13.207   7.219  1.00  0.00           N',
      'ATOM      2  CA  ALA A   1      12.560  13.369   7.478  1.00  0.00           C',
      'HETATM    3  O   HOH B   2      15.000  10.000   5.000  1.00  0.00           O',
    ].join('\n');

    const atoms = parsePDB(pdb);
    expect(atoms.length).toBe(3);
    expect(atoms[0]).toMatchObject({ element: 'N', chainId: 'A', resSeq: 1, atomName: 'N' });
    expect(atoms[2].element).toBe('O');
    expect(atoms[2].chainId).toBe('B');
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
    expect(atoms[0]).toMatchObject({ x: 1, y: 2, z: 3, element: 'C', atomName: 'C' });
    expect(atoms[1].element).toBe('O');
  });
});

const PROTEIN = 'MACDEFGHIK';
// Independently specified standard-code codons, including the terminal stop.
const CDS = 'ATGGCTTGTGATGAATTTGGTCATATTAAATAA';
const RESIDUES = ['MET', 'ALA', 'CYS', 'ASP', 'GLU', 'PHE', 'GLY', 'HIS', 'ILE', 'LYS'];
const atomsFor = (residues = RESIDUES): AtomRecord[] => residues.map((resName, i) => ({
  x: i * 4, y: 0, z: 0, atomName: 'CA', element: 'C', chainId: 'A', resName, resSeq: 501 + i, insertionCode: '',
}));
const geneFor = (startPos = 0, qualifiers: GeneInfo['qualifiers'] = {}): GeneInfo => ({
  id: 7, name: 'observed', locusTag: 'exact-cds', type: 'CDS', product: 'observed protein',
  startPos, endPos: startPos + CDS.length, strand: '+', qualifiers: { translation: PROTEIN, ...qualifiers },
});
const pdbLine = (atom: AtomRecord, index: number) => 'ATOM  ' + String(index + 1).padStart(5) + ' ' + atom.atomName.padStart(4) + ' ' +
  atom.resName.padStart(3) + ' ' + atom.chainId + String(atom.resSeq).padStart(4) + (atom.insertionCode || ' ') + '   ' +
  [atom.x, atom.y, atom.z].map(value => value.toFixed(3).padStart(8)).join('') + '  1.00  0.00          ' + atom.element.padStart(2);
const cifHeaders = ['group_PDB', 'type_symbol', 'label_atom_id', 'auth_comp_id', 'label_asym_id', 'auth_asym_id',
  'label_seq_id', 'auth_seq_id', 'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'pdbx_PDB_model_num'];
function cifFixture(withSecondChain = false): string {
  const rows = RESIDUES.filter((_, i) => i !== 6).map((residue, i) => {
    const label = i < 6 ? i + 1 : i + 2;
    return `ATOM C 'CA' ${residue} X 'author' ${label} ${i === 3 ? 503 : 501 + i} ${i === 3 ? 'A' : '?'} ${i * 4} 0\n0 1`;
  });
  return ['data_test', 'loop_', '_other.id', 'unrelated', '#', 'loop_', ...cifHeaders.map(name => '_atom_site.' + name),
    ...rows, ...(withSecondChain ? rows.map(row => row.replace(" X 'author' ", " Y 'author' ")) : []),
    'ATOM C CA TYR X author 1 501 ? 999 0 0 2', '#'].join('\n');
}

describe('exact structural residue to genomic CDS mapping', () => {
  it('maps retained real 8XCJ Lambda J coordinates to the curated Lambda genome and leaves the host chain unmapped', async () => {
    const repository = new BunSqliteRepository(fileURLToPath(new URL('../../public/phage.db', import.meta.url)), { readonly: true });
    try {
      const entry = (await repository.listPhages()).find(phage => phage.accession === 'NC_001416.1')!;
      const phage = (await repository.getPhageById(entry.id))!;
      const genome = await repository.getSequenceWindow(phage.id, 0, phage.genomeLength!);
      const oneLetter = 'ARNDCQEGHILKMFPSTWYV';
      const names = ['ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
        'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL'];
      const atoms: AtomRecord[] = lambdaReference.chains.flatMap(chain => chain.coordinates.map(coordinate => ({
        x: coordinate.x, y: coordinate.y, z: coordinate.z, atomName: 'CA', element: 'C',
        chainId: chain.authAsymId, labelChainId: chain.labelAsymId, labelSeqId: coordinate.labelSeqId,
        resSeq: coordinate.authSeqId, insertionCode: coordinate.insertionCode,
        resName: names[oneLetter.indexOf(coordinate.aminoAcid)],
      })));
      const mapped = buildStructureResidueMappings(atoms, phage.genes, genome);
      const gene = phage.genes.find(gene => gene.type === 'CDS' && gene.name === 'J')!;
      expect(mapped.size).toBe(420);
      // Independent reference: J CDS starts at 15504; observed J residues span 713–1132.
      expect(mapped.get(structureResidueKey(atoms[0]))).toMatchObject({ geneId: gene.id, proteinPosition: 713, genomePos: 17640 });
      expect(mapped.get(structureResidueKey(atoms[419]))).toMatchObject({ geneId: gene.id, proteinPosition: 1132, genomePos: 18897 });
      expect(mapped.has(structureResidueKey(atoms[420]))).toBe(false);
    } finally { await repository.close(); }
  });

  it('selects the real sequence instead of an unrelated equal-length gene', () => {
    const wrongCds = 'ATG' + 'GCT'.repeat(9) + 'TAA';
    const genome = wrongCds + 'CCC' + CDS;
    const wrong = { ...geneFor(), id: 1, product: 'misleading equal length', qualifiers: { translation: 'MAAAAAAAAA' } };
    const right = geneFor(wrongCds.length + 3);
    const atoms = atomsFor();
    const mapped = buildStructureResidueMappings(atoms, [wrong, right, { ...right, id: 8, type: 'gene' }], genome);
    expect(mapped.size).toBe(10);
    expect(mapped.get(structureResidueKey(atoms[0]))).toMatchObject({ geneId: 7, proteinPosition: 1, genomePos: 36 });
    expect(mapped.get(structureResidueKey(atoms[9]))).toMatchObject({ geneId: 7, proteinPosition: 10, genomePos: 63,
      genomeSegments: [{ start: 63, end: 66, strand: '+' }] });
    expect(buildStructureResidueMappings(atoms, [{ ...right, name: 'renamed', product: 'different description' }], genome)
      .get(structureResidueKey(atoms[9]))?.genomePos).toBe(63);
    expect(buildStructureResidueMappings(atoms, [right], 'A'.repeat(genome.length)).size).toBe(0);
  });

  it('preserves PDB insertion identities and refuses coordinate gaps without polymer indices', () => {
    const source = atomsFor();
    source[3] = { ...source[3], resSeq: source[2].resSeq, insertionCode: 'A' };
    // Glycine is unobserved; arbitrary author residue labels are deliberately not polymer offsets.
    const atoms = parsePDB(source.map(pdbLine).join('\n'));
    const mapped = buildStructureResidueMappings(atoms, [geneFor()], CDS);
    expect(mapped.size).toBe(10);
    expect(structureResidueKey(atoms[2])).not.toBe(structureResidueKey(atoms[3]));
    expect(mapped.get(structureResidueKey(atoms[3]))?.genomePos).toBe(9);
    expect(mapped.get(structureResidueKey(atoms[7]))).toMatchObject({ proteinPosition: 8, genomePos: 21 });
    expect(buildStructureResidueMappings(atoms.filter((_, i) => i !== 6), [geneFor()], CDS).size).toBe(0);
  });

  it('uses mmCIF polymer labels, quoted fields and wrapped rows while keeping only the first model', () => {
    const atoms = parseMMCIF(cifFixture());
    expect(atoms).toHaveLength(9);
    expect(atoms[3]).toMatchObject({ chainId: 'author', labelChainId: 'X', resSeq: 503, insertionCode: 'A', labelSeqId: 4 });
    expect(atoms[6].labelSeqId).toBe(8);
    const mapped = buildStructureResidueMappings(atoms, [geneFor()], CDS);
    expect(mapped.get(structureResidueKey(atoms[6]))).toMatchObject({ method: 'polymer-sequence-offset', proteinPosition: 8, genomePos: 21 });
    const secondChain = atoms.map(atom => ({ ...atom, labelChainId: 'Y' }));
    const both = buildStructureResidueMappings([...atoms, ...secondChain], [geneFor()], CDS);
    expect(both.size).toBe(18);
    expect(both.get(structureResidueKey(secondChain[3]))?.proteinPosition).toBe(4);
  });

  it('keeps model ensembles separate and does not collapse alternate residue identities', () => {
    const pdb = ['MODEL        1', ...atomsFor().map(pdbLine), 'ENDMDL', 'MODEL        2',
      ...atomsFor(['TYR', ...RESIDUES.slice(1)]).map(pdbLine), 'ENDMDL'].join('\n');
    const atoms = parsePDB(pdb);
    expect(atoms).toHaveLength(10);
    expect(buildStructureResidueMappings(atoms, [geneFor()], CDS).size).toBe(10);
    expect(buildStructureResidueMappings([...atoms, { ...atoms[0], resName: 'TYR' }], [geneFor()], CDS).size).toBe(0);
    expect(buildStructureResidueMappings([...atoms, { ...atoms[0], x: 0.5 }], [geneFor()], CDS).size).toBe(10);
  });

  it('refuses duplicate CDS matches and requires polymer indices to place missing residues', () => {
    const atoms = atomsFor();
    expect(buildStructureResidueMappings(atoms, [geneFor(), { ...geneFor(), id: 8 }], CDS).size).toBe(0);
    const doubledA = CDS.slice(0, 6) + 'GCT' + CDS.slice(6);
    const gene = { ...geneFor(), endPos: doubledA.length, qualifiers: { translation: 'MAACDEFGHIK' } };
    const mapped = buildStructureResidueMappings(atoms, [gene], doubledA);
    expect(mapped.size).toBe(0); // Either A could be the unobserved residue; no arbitrary gap alignment.
    const labeled = atoms.map((atom, i) => ({ ...atom, labelSeqId: i === 0 ? 1 : i + 2, labelChainId: 'X' }));
    expect(buildStructureResidueMappings(labeled, [gene], doubledA).get(structureResidueKey(labeled[1]))?.genomePos).toBe(6);
  });

  it('maps joined reverse CDS, codon_start and a codon split across segments', () => {
    const genome = reverseComplement(CDS.slice(2)) + 'CCCC' + reverseComplement('AAT');
    const gene: GeneInfo = { ...geneFor(), startPos: 0, endPos: genome.length, strand: '-', qualifiers: {
      codon_start: '2', translation: PROTEIN,
      _segments: [{ start: 35, end: 38, strand: '-' }, { start: 0, end: 31, strand: '-' }],
    } };
    const atoms = atomsFor(), mapped = buildStructureResidueMappings(atoms, [gene], genome);
    expect(mapped.size).toBe(10);
    expect(mapped.get(structureResidueKey(atoms[0]))).toMatchObject({ genomePos: 36,
      genomeSegments: [{ start: 35, end: 37, strand: '-' }, { start: 30, end: 31, strand: '-' }] });
    expect(mapped.get(structureResidueKey(atoms[9]))).toMatchObject({ genomePos: 5,
      genomeSegments: [{ start: 3, end: 6, strand: '-' }] });
  });

  it('withholds partial, recoded, inconsistent and short evidence instead of manufacturing a gene match', () => {
    for (const qualifiers of [{ _location: '<1..33' }, { partial: true }, { pseudo: '' }, { transl_except: 'Sec' },
      { translation: 'MISMATCH' }, { transl_table: 99 }, { codon_start: 4 }]) {
      expect(buildStructureResidueMappings(atomsFor(), [geneFor(0, qualifiers)], CDS).size).toBe(0);
    }
    expect(buildStructureResidueMappings(atomsFor(), [geneFor()], CDS.slice(0, -1)).size).toBe(0);
    expect(buildStructureResidueMappings(atomsFor().slice(0, 7), [geneFor()], CDS).size).toBe(0);
    expect(buildStructureResidueMappings(atomsFor(['UNK', ...RESIDUES.slice(1)]), [geneFor()], CDS).size).toBe(0);
  });

  it('transports the exact shared parser identities through the actual production structure worker', async () => {
    const worker = new Worker(new URL('./structure.worker.ts', import.meta.url).href, { type: 'module' });
    try {
      const result = await new Promise<WorkerOutput>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Structure worker timed out.')), 10_000);
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        worker.onmessage = event => {
          if (event.data.type === 'error') { clearTimeout(timer); reject(new Error(event.data.error)); }
          if (event.data.type === 'success') { clearTimeout(timer); resolve(event.data.data); }
        };
        worker.postMessage({ text: cifFixture(true), format: 'mmcif', options: { includeBonds: false, includeFunctionalGroups: false } });
      });
      const { atoms } = result;
      expect(atoms).toEqual(parseMMCIF(cifFixture(true)));
      expect(result.chains).toEqual(['X', 'Y']);
      expect(result.backboneTraces.map(trace => trace.length)).toEqual([9, 9]);
      const mapped = buildStructureResidueMappings(atoms, [geneFor()], CDS);
      expect(mapped.size).toBe(18);
      expect(mapped.get(structureResidueKey(atoms[3]))?.genomePos).toBe(9);
      expect(mapped.get(structureResidueKey(atoms[6]))?.genomePos).toBe(21);
    } finally { worker.terminate(); }
  }, 15_000);
});

describe('structure download format and cache identity', () => {
  it('prefers indexed mmCIF for bare accessions, respects explicit PDB and never misparses another cached format', async () => {
    const worker = new Worker(new URL('./structure.worker.ts', import.meta.url).href, { type: 'module' });
    const pool = getStructureWorkerPool();
    const acquire = spyOn(pool, 'acquire').mockResolvedValue({ worker, busy: true, lastUsed: Date.now() });
    const pdbBytes = new TextEncoder().encode(atomsFor().map(pdbLine).join('\n')).buffer;
    const cachedPdb = { pdbId: '8XCJ', data: pdbBytes, format: 'pdb' as const, fetchedAt: 0, accessedAt: 0, sizeBytes: pdbBytes.byteLength };
    const readCache = spyOn(structureCache, 'getCachedStructure').mockResolvedValue(cachedPdb);
    const writeCache = spyOn(structureCache, 'cacheStructure').mockResolvedValue(undefined);
    const fetchAsset = spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected structure download'))
      .mockResolvedValueOnce(new Response(cifFixture()))
      .mockResolvedValueOnce(new Response(cifFixture()));
    const options = { includeBonds: false, includeFunctionalGroups: false };
    try {
      const indexed = await loadStructure('8XCJ', undefined, undefined, options);
      expect(fetchAsset).toHaveBeenLastCalledWith('https://files.rcsb.org/download/8XCJ.cif', { signal: undefined });
      expect(indexed.fromCache).toBe(false);
      expect(indexed.atoms[6].labelSeqId).toBe(8);
      expect(writeCache.mock.calls[0][2]).toBe('mmcif');

      const legacy = await loadStructure('8XCJ.pdb', undefined, undefined, options);
      expect(legacy.fromCache).toBe(true);
      expect(legacy.atoms).toEqual(parsePDB(new TextDecoder().decode(pdbBytes)));
      expect(fetchAsset).toHaveBeenCalledTimes(1);

      const cifBytes = new TextEncoder().encode(cifFixture()).buffer;
      readCache.mockResolvedValue({ ...cachedPdb, data: cifBytes, format: 'mmcif', sizeBytes: cifBytes.byteLength });
      const retained = await loadStructure('8XCJ.mmcif', undefined, undefined, options);
      expect(retained.fromCache).toBe(true);
      expect(retained.atoms).toEqual(indexed.atoms);
      expect(fetchAsset).toHaveBeenCalledTimes(1);

      readCache.mockResolvedValue(null);
      const url = 'https://example.test/8XCJ.cif?download=1';
      const external = await loadStructure(url, undefined, undefined, options);
      expect(fetchAsset).toHaveBeenLastCalledWith(url, { signal: undefined });
      expect(external.atoms).toEqual(indexed.atoms);
    } finally {
      acquire.mockRestore(); readCache.mockRestore(); writeCache.mockRestore(); fetchAsset.mockRestore();
      pool.dispose(); worker.terminate();
    }
  }, 20_000);
});

