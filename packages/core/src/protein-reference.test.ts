import { describe, expect, test } from 'bun:test';
import snapshot from '../../../data/protein-references/lambda-lamb-v1.json';
import { parseProteinReferenceBundle, proteinReferenceContentHash, type ProteinReferenceBundle } from './protein-reference';

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
