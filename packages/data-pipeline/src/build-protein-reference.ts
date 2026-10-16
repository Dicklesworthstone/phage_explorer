/** Rebuild the small, immutable Lambda J / Shigella LamB input snapshot. No private-genome network requests. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseProteinReferenceBundle, proteinReferenceContentHash, proteinReferenceSha256,
  type ProteinReferenceBundle, type ReferenceChain, type ReferenceProtein,
} from '@phage-explorer/core';

const USER_AGENT = 'phage_explorer-agent (+https://github.com/Dicklesworthstone/phage_explorer)';
export const REFERENCE_SOURCES = [
  { id: 'uniprot-j', file: 'lambda-j.json', uri: 'https://rest.uniprot.org/uniprotkb/P03749.json',
    sha256: 'ae7e545bc5b3ef76c7c5c3972d47f6b7ae181a202f27bc26579236da5304203a', version: 'entry120/sequence1', license: 'CC-BY-4.0', retrievedAt: '2026-10-16T03:06:25.564882Z' },
  { id: 'uniprot-lamb', file: 'shigella-lamb.json', uri: 'https://rest.uniprot.org/uniprotkb/Q3YUU9.json',
    sha256: '9b37867dbe2db5975244fc638db2ecc48fe2e57c9c2567513e48355cd725f43b', version: 'entry105/sequence1', license: 'CC-BY-4.0', retrievedAt: '2026-10-16T03:06:25.973824Z' },
  { id: 'uniprot-homolog', file: 'lambda-j-homolog.json', uri: 'https://rest.uniprot.org/uniprotkb/P0DXX7.json',
    sha256: '12e97dda26c0e4d95d6fa5b7ae6f0faf8c1e50dcd5408956fbc273c735e469a0', version: 'entry4/sequence1', license: 'CC-BY-4.0', retrievedAt: '2026-10-16T03:11:03.070509Z' },
  { id: 'rcsb-host-entity', file: '8XCJ-entity-1.json', uri: 'https://data.rcsb.org/rest/v1/core/polymer_entity/8XCJ/1',
    sha256: '56881049a705d7b7b0507ae8eeb0216049f937726a83439f81623bfbf232bd01', version: '8XCJ1.3/entity1', license: 'CC0-1.0', retrievedAt: '2026-10-16T03:06:26.188857Z' },
  { id: 'rcsb-j-entity', file: '8XCJ-entity-2.json', uri: 'https://data.rcsb.org/rest/v1/core/polymer_entity/8XCJ/2',
    sha256: '14f9213de104bbcd6b7a1cf29cc6b5f56dd69e733e0b6bb912c15d570530f21f', version: '8XCJ1.3/entity2', license: 'CC0-1.0', retrievedAt: '2026-10-16T03:06:26.314083Z' },
  { id: 'rcsb-entry', file: '8XCJ-entry.json', uri: 'https://data.rcsb.org/rest/v1/core/entry/8XCJ',
    sha256: '3241b7a206e9866bc0fec87cdfead5f51ddc1602c3c0d7394e565d6fa5155a3e', version: '8XCJ1.3', license: 'CC0-1.0', retrievedAt: '2026-10-16T03:06:26.413599Z' },
  { id: 'rcsb-assembly', file: '8XCJ-assembly-1.json', uri: 'https://data.rcsb.org/rest/v1/core/assembly/8XCJ/1',
    sha256: 'fb7bda288c79991332bd75a3596182a7ab9984687d8c33de2e59df744087308a', version: '8XCJ1.3/assembly1', license: 'CC0-1.0', retrievedAt: '2026-10-16T03:20:50.912195Z' },
  { id: 'rcsb-coordinates', file: '8XCJ.cif', uri: 'https://files.rcsb.org/download/8XCJ.cif',
    sha256: '0b2023f19d4f17899c5bf41d9b7d7f22604e1c8c48b6ecac3ff856c0b8fcdbd7', version: '8XCJ1.3', license: 'CC0-1.0', retrievedAt: '2026-10-16T03:07:19.305213Z' },
  { id: 'ge-wang-2024', file: 'ge-wang-2024.xml', uri: 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11101478/fullTextXML',
    sha256: '400f71bb14688349240982174c3d8b5cbdc23e722571a460914753222a8ef4e0', version: 'published2024-05-17/PMC11101478', license: 'CC-BY-4.0', retrievedAt: '2026-10-16T03:45:45.268466Z' },
] as const;

const AA3: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
};

/** This source profile accepts complete single-line atom rows only, and refuses ambiguous alternatives. */
export function referenceCAlpha(cif: string, labelAsymId: string): { authAsymId: string; atoms: ReferenceChain['coordinates'] } {
  const lines = cif.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === '_atom_site.group_PDB');
  if (start < 1 || lines[start - 1].trim() !== 'loop_') throw new Error('Expected an atom_site loop.');
  const headers: string[] = [];
  let at = start;
  while (lines[at]?.trim().startsWith('_atom_site.')) headers.push(lines[at++].trim());
  const column = (name: string) => {
    const index = headers.indexOf(`_atom_site.${name}`);
    if (index < 0) throw new Error(`Missing atom column ${name}.`);
    return index;
  };
  const fields = Object.fromEntries(['group_PDB', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id',
    'label_asym_id', 'label_seq_id', 'auth_asym_id', 'auth_seq_id', 'pdbx_PDB_ins_code',
    'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'pdbx_PDB_model_num'].map(name => [name, column(name)]));
  const atoms: ReferenceChain['coordinates'] = [];
  const authors = new Set<string>();
  const observed = new Set<number>();
  for (; at < lines.length && !lines[at].trim().startsWith('#'); at++) {
    if (!lines[at].trim()) continue;
    const row = lines[at].trim().split(/\s+/);
    if (row.length !== headers.length) throw new Error('Unsupported wrapped or quoted atom row.');
    const field = (name: string) => row[fields[name]];
    if (field('label_asym_id') !== labelAsymId || field('label_atom_id') !== 'CA') continue;
    if (field('group_PDB') !== 'ATOM' || field('type_symbol') !== 'C' || field('pdbx_PDB_model_num') !== '1' ||
        field('label_alt_id') !== '.' || Number(field('occupancy')) !== 1) throw new Error('Ambiguous reference alpha carbon.');
    const labelSeqId = Number(field('label_seq_id'));
    const authSeqId = Number(field('auth_seq_id'));
    const aminoAcid = AA3[field('label_comp_id')];
    const [x, y, z] = ['Cartn_x', 'Cartn_y', 'Cartn_z'].map(name => Number(field(name)));
    if (!Number.isSafeInteger(labelSeqId) || labelSeqId < 1 || !Number.isSafeInteger(authSeqId) || !aminoAcid ||
        observed.has(labelSeqId) || ![x, y, z].every(Number.isFinite)) throw new Error('Invalid reference residue.');
    observed.add(labelSeqId);
    authors.add(field('auth_asym_id'));
    atoms.push({ labelSeqId, authSeqId, insertionCode: ['?', '.'].includes(field('pdbx_PDB_ins_code')) ? '' : field('pdbx_PDB_ins_code'), aminoAcid, x, y, z });
  }
  if (authors.size !== 1 || atoms.length === 0) throw new Error('Missing or ambiguous chain identity.');
  return { authAsymId: [...authors][0], atoms };
}

/** A bounded two-sequence MSA, with explicit match2/mismatch-1/gap-2 scores and deterministic diagonal-first traceback. */
export function alignReferenceProteins(a: string, b: string): [string, string] {
  if (!/^[ACDEFGHIKLMNPQRSTVWY]+$/.test(a) || !/^[ACDEFGHIKLMNPQRSTVWY]+$/.test(b) ||
      a.length > 2000 || b.length > 2000) throw new Error('Alignment needs two unambiguous proteins of at most2000 residues.');
  const stride = b.length + 1;
  const scores = new Int32Array((a.length + 1) * stride);
  for (let i = 1; i <= a.length; i++) scores[i * stride] = -2 * i;
  for (let j = 1; j <= b.length; j++) scores[j] = -2 * j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    scores[i * stride + j] = Math.max(scores[(i - 1) * stride + j - 1] + (a[i - 1] === b[j - 1] ? 2 : -1),
      scores[(i - 1) * stride + j] - 2, scores[i * stride + j - 1] - 2);
  }
  const left: string[] = [], right: string[] = [];
  let i = a.length, j = b.length;
  while (i || j) {
    const score = scores[i * stride + j];
    if (i && j && score === scores[(i - 1) * stride + j - 1] + (a[i - 1] === b[j - 1] ? 2 : -1)) {
      left.push(a[--i]); right.push(b[--j]);
    } else if (i && score === scores[(i - 1) * stride + j] - 2) {
      left.push(a[--i]); right.push('-');
    } else if (j && score === scores[i * stride + j - 1] - 2) {
      left.push('-'); right.push(b[--j]);
    } else throw new Error('Invalid alignment traceback.');
  }
  return [left.reverse().join(''), right.reverse().join('')];
}

export async function buildProteinReference(sourceDir: string, vectorsFile: string): Promise<ProteinReferenceBundle> {
  const raw = new Map<string, string>();
  for (const source of REFERENCE_SOURCES) {
    const bytes = await readFile(resolve(sourceDir, source.file));
    if (bytes.length > 8 * 1024 * 1024 || await proteinReferenceSha256(bytes.toString('utf8')) !== source.sha256) {
      throw new Error(`Pinned source checksum mismatch: ${source.file}. Keep the old snapshot; review a new version explicitly.`);
    }
    raw.set(source.id, bytes.toString('utf8'));
  }
  const proteins: ReferenceProtein[] = [];
  for (const [id, sourceId] of [['lambda-j', 'uniprot-j'], ['shigella-lamb', 'uniprot-lamb'], ['secphi27-j', 'uniprot-homolog']]) {
    const entry = JSON.parse(raw.get(sourceId)!);
    const sequence = entry.sequence.value as string;
    proteins.push({ id, sourceId, accession: entry.primaryAccession, organism: entry.organism.scientificName,
      sequence, sequenceSha256: await proteinReferenceSha256(sequence) });
  }
  const chains: ReferenceChain[] = [];
  const assembly = JSON.parse(raw.get('rcsb-assembly')!);
  const generators = assembly.pdbx_struct_assembly_gen;
  if (generators.length !== 1 || generators[0].oper_expression !== '1' ||
      !['A', 'D'].every(chain => generators[0].asym_id_list.includes(chain))) throw new Error('Unsupported biological assembly.');
  // The pinned CIF's operation1 is identity. The pinned whole-file hash binds that transform and all coordinates.
  for (const [proteinId, entitySource, labelAsymId] of [
    ['lambda-j', 'rcsb-j-entity', 'D'], ['shigella-lamb', 'rcsb-host-entity', 'A'],
  ]) {
    const entity = JSON.parse(raw.get(entitySource)!);
    const protein = proteins.find(row => row.id === proteinId)!;
    const mapping = entity.rcsb_polymer_entity_align.filter((row: { reference_database_accession: string }) =>
      row.reference_database_accession === protein.accession);
    if (mapping.length !== 1 || mapping[0].aligned_regions.length !== 1) throw new Error('Ambiguous chain/reference alignment.');
    const region = mapping[0].aligned_regions[0];
    if (region.entity_beg_seq_id !== 1) throw new Error('Unsupported partial entity alignment.');
    const sequence = entity.entity_poly.pdbx_seq_one_letter_code_can as string;
    if (sequence.length !== region.length) throw new Error('Incomplete entity mapping.');
    const observed = referenceCAlpha(raw.get('rcsb-coordinates')!, labelAsymId);
    chains.push({ proteinId, sourceId: 'rcsb-coordinates', pdbId: '8XCJ', entryVersion: '1.3', assemblyId: '1',
      entityId: entity.rcsb_polymer_entity_container_identifiers.entity_id, labelAsymId, authAsymId: observed.authAsymId,
      start: region.ref_beg_seq_id, end: region.ref_beg_seq_id + region.length - 1, sequence, coordinates: observed.atoms });
  }
  const vectors = JSON.parse(await readFile(vectorsFile, 'utf8'));
  if (vectors.space.model !== 'facebook/esm2_t6_8M_UR50D' || vectors.space.revision !== 'c731040fcd8d73dceaa04b0a8e6329b345b0f5df' ||
      vectors.space.weightsSha256 !== '24c5fa474c48f3b754b86efe752d5f189d2bcd88190fa2270fc92b2ef3034189') throw new Error('Unapproved checkpoint weights.');
  const [left, right] = alignReferenceProteins(proteins[0].sequence, proteins[2].sequence);
  const payload: Omit<ProteinReferenceBundle, 'bundleSha256'> = {
    format: 'phage-explorer-protein-reference', version: 1, id: 'lambda-shigella-lamb-8xcj-v1',
    sources: [...REFERENCE_SOURCES.map(source => ({ id: source.id, uri: source.uri, sha256: source.sha256,
      version: source.version, license: source.license, retrievedAt: source.retrievedAt })),
      { id: 'esm2-weights', uri: `https://huggingface.co/${vectors.space.model}/resolve/${vectors.space.revision}/model.safetensors`,
        sha256: vectors.space.weightsSha256, version: vectors.space.revision, license: 'MIT', retrievedAt: vectors.retrievedAt }], proteins,
    cds: { genomeAccession: 'NC_001416.1', proteinId: 'lambda-j', proteinAccession: 'NP_040600.1',
      locusTag: 'lambdap21', startPos: 15504, endPos: 18903, strand: '+', codonStart: 1, translationTable: 11 },
    embeddingSpace: vectors.space, embeddings: vectors.embeddings, chains,
    alignment: { method: 'needleman-wunsch-linear', match: 2, mismatch: -1, gap: -2,
      rows: [{ proteinId: 'lambda-j', alignedSequence: left }, { proteinId: 'secphi27-j', alignedSequence: right }] },
    domainInteractions: [{ phageProteinId: 'lambda-j', hostProteinId: 'shigella-lamb',
      phageDomain: 'C-terminal receptor-binding domain (Ig-like)', hostDomain: 'LamB extracellular surface',
      phageLoops: ['L1', 'L2', 'L3', 'L4'], hostLoops: ['EL4', 'EL6', 'EL9'], sourceId: 'ge-wang-2024',
      sourceSection: 'Results: Interaction and selectivity between RBD and LamB; Figure 2',
      pdbId: '8XCJ', method: 'published-cryo-em-complex' }],
    evidence: { phageProteinId: 'lambda-j', hostProteinId: 'shigella-lamb', sourceId: 'rcsb-entry',
      publicationDoi: '10.1038/s41467-024-48686-3', method: 'deposited-complex',
      experimentalHost: 'Shigella sonnei 3070', experimentalHostSourceId: 'ge-wang-2024' },
  };
  return parseProteinReferenceBundle({ ...payload, bundleSha256: await proteinReferenceContentHash(payload) });
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const sourceDir = option('--source-dir'), vectors = option('--vectors'), output = option('--output');
  if (!sourceDir || !vectors || !output) throw new Error('Usage: bun build-protein-reference.ts --source-dir DIR --vectors JSON --output NEW_JSON [--download]');
  if (args.includes('--download')) for (const source of REFERENCE_SOURCES) {
    const path = resolve(sourceDir, source.file);
    if (await Bun.file(path).exists()) continue;
    const response = await fetch(source.uri, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Reference download failed: ${source.file} HTTP${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024 || await proteinReferenceSha256(new TextDecoder().decode(bytes)) !== source.sha256) throw new Error(`Unreviewed source version: ${source.file}.`);
    await writeFile(path, bytes, { flag: 'wx' });
  }
  const bundle = await buildProteinReference(sourceDir, vectors);
  await writeFile(output, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ output, bundleSha256: bundle.bundleSha256, proteins: bundle.proteins.length,
    observedResidues: bundle.chains.map(chain => ({ protein: chain.proteinId, count: chain.coordinates.length })) }) + '\n');
}
