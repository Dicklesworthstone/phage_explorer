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

const root = resolve(import.meta.dir, '../../../../..');
const require = createRequire(import.meta.url);
const catalog = new BunSqliteRepository(resolve(root, 'phage.db'), { readonly: true });
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
    expect(html).not.toContain('kcal/mol'); expect(html).not.toContain('Kd');
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
