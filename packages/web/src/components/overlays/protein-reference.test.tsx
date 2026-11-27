import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import { loadProteinReferenceInputs, type PhageFull, type ProteinReferenceRepository } from '@phage-explorer/core';
import snapshot from '../../../../../data/protein-references/lambda-lamb-v1.json';
import { SqlJsRepository } from '../../db/SqlJsRepository';
import { ProteinReferenceCoverage } from './HostInteractionOverlay';
import { ProteinEvidencePanel, ProteinEvidenceResults, ProteinAlignmentResults, ProteinCoordinateResults } from './ProteinEvidencePanel';
import { createProteinStructureExperiment, createProteinAlignmentExperiment, createProteinCoordinateExperiment } from '../../../../core/src/analysis/tail-fiber-structure';
import { parseProteinAlignmentFasta, prepareProteinCoordinateInput } from '../../../../core/src/protein-reference';

const root = resolve(import.meta.dir, '../../../../..');
const require = createRequire(import.meta.url);
const catalog = new BunSqliteRepository(resolve(root, 'packages/web/public/phage.db'), { readonly: true });
afterAll(() => catalog.close());
const getPhage = async () => {
  const phage = await catalog.getPhageById(1);
  if (!phage) throw new Error('Actual Lambda catalog record is required.');
  return phage;
};
function withPhage(phage: PhageFull, consume: () => void = () => {}): ProteinReferenceRepository {
  return { getPhageById: async () => phage,
    getSequenceWindow: (id, start, end) => { consume(); return catalog.getSequenceWindow(id, start, end); } };
}

describe('Actual catalog → repository → source input service → production React coverage', () => {
  test('native SQLite selects the unique real CDS instead of its duplicate gene feature', async () => {
    const inputs = await loadProteinReferenceInputs(catalog, 1, snapshot);
    expect(inputs.status).toBe('ready');
    if (inputs.status !== 'ready') throw new Error(inputs.reason);
    expect(inputs.gene.id).toBe(42);
    expect(inputs.gene.type).toBe('CDS');
    expect(inputs.protein.sequence.length).toBe(1132);
    const html = renderToStaticMarkup(<ProteinReferenceCoverage inputs={inputs} />);
    expect(html).toContain('Source-backed protein inputs available');
    expect(html).toContain('P03749'); expect(html).toContain('Q3YUU9');
    expect(html).toContain('Shigella sonnei'); expect(html).toContain('420 observed residues');
    expect(html).toContain('422 observed residues'); expect(html).toContain('713–1132');
    expect(html).toContain('Experimental receptor: Shigella sonnei 3070');
    expect(html).toContain('EL4, EL6, EL9');
    expect(html).toContain('CC-BY-4.0'); expect(html).toContain('Export reference inputs');
    expect(html).not.toContain('kcal/mol');
    expect(html).toContain('Unavailable from this deposited evidence:</strong> ΔG, Kd');
    expect(html).not.toMatch(/\bKd\s*[=:~]/i);
  });

  test('real browser SQL.js repository consumes the shipped public database without model/network stand-ins', async () => {
    const wasmBinary = await readFile(require.resolve('sql.js/dist/sql-wasm.wasm'));
    const SQL = await initSqlJs({ wasmBinary });
    const db = new SQL.Database(await readFile(resolve(root, 'packages/web/public/phage.db')));
    try {
      const repository = new SqlJsRepository(db);
      const inputs = await loadProteinReferenceInputs(repository, 1, snapshot);
      expect(inputs.status).toBe('ready');
      if (inputs.status !== 'ready') throw new Error(inputs.reason);
      expect(inputs.gene.id).toBe(42);
      expect(inputs.protein.sequenceSha256).toBe(snapshot.proteins[0].sequenceSha256);
    } finally { db.close(); }
  });

  test('relabeling names and locus tags cannot change source sequence evidence', async () => {
    const phage = await getPhage();
    const renamed = { ...phage, genes: phage.genes.map(gene => ({ ...gene, name: 'renamed', locusTag: 'different-label' })) };
    const inputs = await loadProteinReferenceInputs(withPhage(renamed), 1, snapshot);
    expect(inputs.status).toBe('ready');
  });

  test('a supported-accession record with private import identity never consumes sequence or starts network work', async () => {
    const phage = await getPhage();
    let sequenceReads = 0, networkCalls = 0;
    const blockFetch: typeof fetch = Object.assign(async () => {
      networkCalls++; throw new Error('Private input must not start network I/O.');
    }, { preconnect: fetch.preconnect });
    const network = spyOn(globalThis, 'fetch').mockImplementation(blockFetch);
    try {
      const inputs = await loadProteinReferenceInputs(withPhage({ ...phage, localGenome: {
        contentId: 'private-reference-lookalike', sequenceSha256: 'a'.repeat(64), format: 'genbank', topology: 'linear',
      } }, () => sequenceReads++), 1, snapshot);
      expect(inputs.status).toBe('unavailable');
      expect(sequenceReads).toBe(0); expect(networkCalls).toBe(0);
    } finally { network.mockRestore(); }
  });

  test('an uncovered real T4 genome exposes absence without inventing a vector or structure', async () => {
    const phage = await catalog.getPhageById(2);
    if (!phage) throw new Error('Actual T4 record is required.');
    let reads = 0;
    const inputs = await loadProteinReferenceInputs(withPhage(phage, () => reads++), phage.id, snapshot);
    expect(inputs.status).toBe('unavailable'); expect(reads).toBe(0);
    expect(renderToStaticMarkup(<ProteinReferenceCoverage inputs={inputs} />)).toContain('No versioned protein reference');
    expect('embeddings' in inputs).toBe(false);
  });

  for (const [name, change] of [
    ['missing CDS', (phage: PhageFull) => { phage.genes = phage.genes.filter(gene => gene.id !== 42); }],
    ['duplicate CDS', (phage: PhageFull) => { phage.genes.push({ ...phage.genes.find(gene => gene.id === 42)!, id: 100000 }); }],
    ['partial translation', (phage: PhageFull) => { phage.genes.find(gene => gene.id === 42)!.qualifiers!.translation = 'MGK'; }],
    ['wrong strand', (phage: PhageFull) => { phage.genes.find(gene => gene.id === 42)!.strand = '-'; }],
    ['wrong coordinates', (phage: PhageFull) => { phage.genes.find(gene => gene.id === 42)!.endPos -= 3; }],
    ['partial deposited location', (phage: PhageFull) => { phage.genes.find(gene => gene.id === 42)!.qualifiers!._location = '<15505..18903'; }],
    ['recoding exception', (phage: PhageFull) => { phage.genes.find(gene => gene.id === 42)!.qualifiers!.transl_except = '(pos:1..3,aa:Sec)'; }],
  ] as const) {
    test(`withholds ${name} rather than silently replacing missing inputs`, async () => {
      const phage = structuredClone(await getPhage()); change(phage);
      expect((await loadProteinReferenceInputs(withPhage(phage), 1, snapshot)).status).toBe('unavailable');
    });
  }

  test('actual genome corruption cannot be hidden behind a correct deposited translation', async () => {
    const phage = await getPhage();
    const inputs = await loadProteinReferenceInputs({ getPhageById: async () => phage,
      getSequenceWindow: async (id, start, end) => {
        const sequence = await catalog.getSequenceWindow(id, start, end);
        return sequence.slice(0, 15504) + 'TAA' + sequence.slice(15507);
      } }, 1, snapshot);
    expect(inputs.status).toBe('unavailable');
  });

  test('a truncated repository genome is unavailable even when its J CDS remains intact', async () => {
    const phage = await getPhage();
    const inputs = await loadProteinReferenceInputs({ getPhageById: async () => phage,
      getSequenceWindow: async (id, start, end) => (await catalog.getSequenceWindow(id, start, end)).slice(0, -1),
    }, 1, snapshot);
    expect(inputs.status).toBe('unavailable');
    if (inputs.status === 'unavailable') expect(inputs.reason).toContain('coverage is incomplete');
  });
});


describe('production protein evidence presentation', () => {
  test('requires the verified mapped CDS instead of applying a reference to another selected gene', async () => {
    const inputs = await loadProteinReferenceInputs(catalog, 1, snapshot);
    if (inputs.status !== 'ready') throw new Error(inputs.reason);
    const html = renderToStaticMarkup(<ProteinEvidencePanel repository={catalog} phage={await getPhage()}
      selectedGeneId={41} inputs={inputs} onSelectGene={() => {}} />);
    expect(html).toContain('Selected gene: 41');
    expect(html).toContain('Select mapped protein CDS');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Analyze mapped protein CDS/);
    expect(html).not.toContain('Protein evidence results');
  });
  test('exposes real full-length coverage, source identity and unexamined interchain geometry', async () => {
    const experiment = await createProteinStructureExperiment(snapshot, { contactScope: 'chain' });
    const html = renderToStaticMarkup(<ProteinEvidenceResults experiment={experiment}
      origin={{ kind: 'reference-file', name: 'standalone.json' }} verified={false} />);
    expect(html).toContain('P03749: reference-derived residue evidence');
    expect(html).toContain('1132 complete protein residues');
    expect(html).toContain('1096 / 1132');
    expect(html).toContain('420 / 1132');
    expect(html).toContain('958');
    expect(html).toContain('not compared');
    expect(html).toContain('no current genome or selected CDS was verified');
    expect(html).toContain('Export protein experiment JSON');
    expect(html).toContain('Export residue TSV'); expect(html).toContain('Export contact TSV');
  });
  test('retains standalone source labels and genuine missing geometry for alignment-only analysis', async () => {
    const experiment = await createProteinStructureExperiment(snapshot, { chainLabelAsymId: null });
    const html = renderToStaticMarkup(<ProteinEvidenceResults experiment={experiment}
      origin={{ kind: 'saved-experiment', name: 'restored.json' }} verified={true} />);
    expect(html).toContain('Standalone saved experiment: restored.json');
    expect(html).toContain('Fresh replay verified');
    expect(html).toContain('No chain selected: geometry is unavailable');
    expect(html).toContain('unavailable');
    expect(html).not.toContain('Verified against the loaded genome');
  });
});


describe('ordinary protein alignment presentation', () => {
  test('offers aligned FASTA without requiring a loaded genome or deposited complex', () => {
    const html = renderToStaticMarkup(<ProteinEvidencePanel phage={null} selectedGeneId={null}
      inputs={{ status: 'unavailable', reason: 'No mapped complex for this genome.' }} onSelectGene={() => {}} />);
    expect(html).toContain('Load aligned protein FASTA');
    expect(html).toContain('Alignment source description');
    expect(html).toContain('Alignment source citation');
    expect(html).toContain('Replay alignment experiment JSON');
    expect(html).toContain('No structure, embedding or known binding partner is required');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Analyze supplied protein alignment/);
  });
  test('renders source-bound counts, missing entropy and complete exports with literal user labels', async () => {
    const input = parseProteinAlignmentFasta('><b>target</b> supplied label\nAX\n>other\nCY', 'private.faa',
      { kind: 'local', description: '<script>literal source</script>', reference: 'Notebook 17' });
    const experiment = await createProteinAlignmentExperiment(input);
    const html = renderToStaticMarkup(<ProteinAlignmentResults experiment={experiment} verified={true} />);
    expect(html).toContain('Fresh replay verified');
    expect(html).toContain('&lt;b&gt;target&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;literal source&lt;/script&gt;');
    expect(html).not.toContain('<script>literal source</script>');
    expect(html).toContain('Notebook 17');
    expect(html).toContain('1.0000');
    expect(html).toContain('unavailable');
    expect(html).toContain('Export alignment experiment JSON');
    expect(html).toContain('Export alignment residue TSV');
    expect(html).toContain('no current genome, accession or CDS mapping has been verified');
    expect(html).not.toContain('Export contact TSV');
  });
});


describe('standalone local mmCIF presentation', () => {
  test('offers explicit file, sequence and mapping controls without a loaded genome or full complex', () => {
    const html = renderToStaticMarkup(<ProteinEvidencePanel phage={null} selectedGeneId={null}
      inputs={{ status: 'unavailable', reason: 'No mapped complex for this genome.' }} onSelectGene={() => {}} />);
    expect(html).toContain('Local mmCIF coordinate workbench');
    for (const control of ['Local mmCIF file', 'Coordinate protein FASTA', 'mmCIF label chain ID',
      'Protein position for polymer label 1', 'mmCIF model number', 'mmCIF alternate location ID',
      'Coordinate source description', 'Coordinate source citation', 'Load prepared coordinate input JSON',
      'Replay local coordinate experiment JSON']) {
      expect(html).toContain('aria-label="' + control + '"');
    }
    expect(html).toContain('No receptor, embedding, publication or homolog alignment is required');
    expect(html).toContain('label_seq_id 1');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Review local mmCIF mapping/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Analyze local mmCIF geometry/);
    expect(html).not.toContain('Local mmCIF geometry results');
  });

  test('renders literal local identities, missing residues, insertion codes and independent geometry exports', async () => {
    const cif = `data_private
loop_
_atom_site.group_PDB
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.auth_asym_id
_atom_site.auth_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.pdbx_PDB_model_num
ATOM C CA . ALA A 1 Z -2 ? 0 0 0 1 1
ATOM C CA . ASP A 3 Z 10 A 3 4 0 1 1
ATOM C CA . GLY A 6 Z 10 B 0 0 12 1 1
#
`;
    const input = prepareProteinCoordinateInput(cif, '><b>private</b> supplied label\nMKACDEFGH', 'local.cif',
      { labelAsymId: 'A', proteinStart: 3 }, { kind: 'local', description: '<script>literal source</script>', reference: 'Notebook 23' });
    const experiment = await createProteinCoordinateExperiment(input, { contactCutoffAngstrom: 5, minSequenceSeparation: 1 });
    const html = renderToStaticMarkup(<ProteinCoordinateResults experiment={experiment} verified={true} />);
    expect(html).toContain('Fresh replay verified.');
    expect(html).toContain('&lt;b&gt;private&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;literal source&lt;/script&gt;');
    expect(html).not.toContain('<script>literal source</script>');
    expect(html).toContain('Notebook 23');
    expect(html).toContain('Label chain A; author chain Z; model 1');
    expect(html).toContain('Polymer label position 1 maps to protein position 3');
    expect(html).toContain('3 / 9');
    expect(html).toContain('3 / 10A');
    expect(html).toContain('6 / 10B');
    expect(html).toContain('5.000');
    expect(html).toContain('unavailable');
    expect(html).toContain('No current genome, accession or genomic CDS mapping is implied');
    expect(html).toContain('Export local coordinate experiment JSON');
    expect(html).toContain('Export prepared coordinate input JSON');
    expect(html).toContain('Export local coordinate residue TSV');
    expect(html).toContain('Export local coordinate contact TSV');
    expect(html).not.toContain('Verified against the loaded genome');
    expect(html).not.toContain('Alignment entropy');
  });
});
