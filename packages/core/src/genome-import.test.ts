import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { exportCatalogGenomeSnapshot, exportLocalGenomeBundle, getGeneMapSegments, importLocalGenomes, parseLocalFeatureLocation, type CatalogGenomeSnapshot } from './genome-import';
import type { PhageFull } from './types';

const genbank = `LOCUS       LOCAL1                    24 bp    DNA     circular
DEFINITION  Private α genome.
ACCESSION   LOCAL1
VERSION     LOCAL1.1
FEATURES             Location/Qualifiers
     source          1..24
                     /organism="Private phage"
     CDS             complement(join(1..6,
                     19..24))
                     /gene="reverse_join"
                     /product="tail fiber
                     protein"
                     /translation="MK
                     LP"
                     /pseudo
     CDS             7..18
                     /locus_tag="forward"
                     /product="forward CDS"
     misc_feature    REMOTE.1:1..9
                     /note="Unsupported remote interval"
ORIGIN
        1 atgaaacccgggtttaaaccctag
//
`;

describe('private genome import', () => {
  test('multiple FASTA records preserve bases, ambiguity, metadata, exact input and independent SHA', async () => {
    const input = { name: 'private.fa', text: '>same α [topology=circular]\r\nacgtRYSWKMBDHVN\r\n>second\r\nGGCC\r\n' };
    const { genomes } = await importLocalGenomes(input);
    expect(genomes).toHaveLength(2);
    expect(genomes[0].sequence).toBe('ACGTRYSWKMBDHVN');
    expect(genomes[0].phage.gcContent).toBe(50);
    expect(genomes[0].phage.localGenome?.topology).toBe('circular');
    expect(genomes[0].original).toEqual(input);
    expect(genomes[0].phage.localGenome?.sequenceSha256).toBe(createHash('sha256').update('ACGTRYSWKMBDHVN').digest('hex'));
    expect(genomes[0].warnings.join(' ')).toContain('11 ambiguous');
    expect(genomes[1].phage.gcContent).toBe(100);
    expect(genomes[1].phage.localGenome?.topology).toBe('unknown');
    expect(genomes.every(genome => genome.phage.id < 0)).toBe(true);
  });

  test('INSDC reverse-join examples agree and preserve transcript order', () => {
    const expected = [{ start: 4917, end: 5163, strand: '-' as const }, { start: 2690, end: 4571, strand: '-' as const }];
    expect(parseLocalFeatureLocation('complement(join(2691..4571,4918..5163))', 6000)).toEqual(expected);
    expect(parseLocalFeatureLocation('join(complement(4918..5163),complement(2691..4571))', 6000)).toEqual(expected);
    expect(parseLocalFeatureLocation('join(19..24,1..6)', 24)).toEqual([{ start: 18, end: 24, strand: '+' }, { start: 0, end: 6, strand: '+' }]);
  });

  test('GenBank retains complement/join coordinates, multiline qualifiers and unsupported original annotations', async () => {
    const { genomes } = await importLocalGenomes({ name: 'record.gb', text: genbank });
    const genome = genomes[0];
    expect(genome.sequence).toBe('ATGAAACCCGGGTTTAAACCCTAG');
    expect(genome.phage.genes).toHaveLength(2);
    const [reverse, forward] = genome.phage.genes;
    expect(reverse).toMatchObject({ startPos: 0, endPos: 24, strand: '-', product: 'tail fiber protein' });
    expect(reverse.qualifiers?._segments).toEqual([{ start: 18, end: 24, strand: '-' }, { start: 0, end: 6, strand: '-' }]);
    expect(reverse.qualifiers?.translation).toBe('MKLP');
    expect(reverse.qualifiers?.pseudo).toBe('');
    expect(forward).toMatchObject({ startPos: 6, endPos: 18, strand: '+', locusTag: 'forward' });
    expect(genome.warnings.join(' ')).toContain('REMOTE.1:1..9');
    expect(genome.original.text).toBe(genbank);
  });

  test('stable IDs survive whitespace transport and round-trip original files with selected view', async () => {
    const input = { name: 'record.gb', text: genbank };
    const first = await importLocalGenomes(input);
    const windows = await importLocalGenomes({ ...input, text: genbank.replace(/\n/g, '\r\n') });
    expect(windows.genomes[0].phage.id).toBe(first.genomes[0].phage.id);
    const contentId = first.genomes[0].phage.localGenome!.contentId;
    const view = { contentId, viewMode: 'dual' as const, readingFrame: -2 as const, scrollPosition: 9 };
    const reimported = await importLocalGenomes({ name: 'bundle.json', text: exportLocalGenomeBundle(first.genomes, view) });
    expect(reimported).toEqual({ ...first, view });
    const changed = await importLocalGenomes({ ...input, text: genbank.replace('atgaaaccc', 'ctgaaaccc') });
    expect(changed.genomes[0].phage.id).not.toBe(first.genomes[0].phage.id);
  });

  test('multiple GenBank records and identical duplicates keep deterministic record identities', async () => {
    const second = genbank.replaceAll('LOCAL1', 'LOCAL2');
    const result = await importLocalGenomes({ name: 'multi.gb', text: genbank + second + genbank });
    expect(result.genomes).toHaveLength(2);
    const restored = await importLocalGenomes({ name: 'bundle.json', text: exportLocalGenomeBundle(result.genomes) });
    expect(restored).toEqual(result);
  });

  for (const [name, input] of [
    ['empty', ''], ['no header', 'ACTG'], ['empty record', '>x\n'], ['RNA', '>x\nACGU'],
    ['gaps', '>x\nACT-G'], ['digits', '>x\nACT123G'], ['protein', '>x\nMELF'],
    ['missing terminator', genbank.replace('//\n', '')], ['length mismatch', genbank.replace('24 bp', '25 bp')],
    ['RNA GenBank molecule', genbank.replace('DNA     circular', 'RNA     circular')],
    ['too many records', Array.from({ length: 101 }, (_, i) => `>r${i}\nACGT`).join('\n')],
    ['too many bases', `>large\n${'A'.repeat(5_000_001)}`],
    ['nested bundle', JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, inputs: [{ name: 'nested', text: '{}' }] })],
  ]) test(`rejects ${name} without returning partial records`, async () => {
    await expect(importLocalGenomes({ name, text: input })).rejects.toThrow();
  });

  test('unknown-only DNA never invents a GC measurement; display metadata stays literal', async () => {
    const result = await importLocalGenomes({ name: '<img onerror=alert(1)>.fa', text: '><script>alert(1)</script>\nNNN' });
    expect(result.genomes[0].phage.name).toBe('<script>alert(1)</script>');
    expect(result.genomes[0].phage.gcContent).toBeNull();
    expect(result.genomes[0].phage.genes).toEqual([]);
  });

  test('uncertain, remote, reversed, out-of-bounds and between-base locations never become CDS intervals', () => {
    for (const location of ['<1..10', 'R1.1:1..10', '10..1', '0..10', '1..25', '10^11', 'order(1..3,5..9)', 'join(1..2)', 'join(1..2,3..4))']) {
      expect(() => parseLocalFeatureLocation(location, 24)).toThrow();
    }
  });

  test('bounds deeply nested and excessively segmented annotations before creating intervals', () => {
    expect(() => parseLocalFeatureLocation(`join(${Array(1001).fill('1..3').join(',')})`, 24)).toThrow('1,000');
    expect(() => parseLocalFeatureLocation(`${'complement('.repeat(18)}1..3${')'.repeat(18)}`, 24)).toThrow('16');
  });

  test('rejects a bundle view that points outside its original input', async () => {
    const { genomes } = await importLocalGenomes({ name: 'x.fa', text: '>x\nACGT' });
    const view = { contentId: genomes[0].phage.localGenome!.contentId, viewMode: 'dna' as const, readingFrame: 0 as const, scrollPosition: 4 };
    await expect(importLocalGenomes({ name: 'bad.json', text: exportLocalGenomeBundle(genomes, view) })).rejects.toThrow('position');
  });
});


describe('catalog genome session snapshots', () => {
  const sequence = 'ATGAAACCCGGGTTTTAA';
  const source = (): PhageFull => ({
    id: 17, slug: 'catalog-alpha', name: 'Catalog α', accession: 'CAT.1', family: 'Example family',
    host: 'Example host', genomeLength: sequence.length, gcContent: 50, morphology: 'tailed', lifecycle: 'lytic',
    description: 'Catalog description', baltimoreGroup: 'I', genomeType: 'dsDNA',
    pdbIds: ['1ABC'], hasModel: true, codonUsage: { aaCounts: { M: 1 }, codonCounts: { ATG: 1 } },
    genes: [
      { id: 92, name: 'joined', locusTag: 'CAT_92', startPos: 0, endPos: 18, strand: '-', product: 'Joined product',
        type: 'CDS', domains: ['example-domain'], qualifiers: {
          codon_start: '2', transl_table: '11', _location: 'complement(join(1..6,13..18))',
          _segments: [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }],
        } },
      { id: 41, name: null, locusTag: null, startPos: 6, endPos: 12, strand: '+', product: null,
        type: 'misc_feature', qualifiers: { note: 'literal source annotation' } },
    ],
  });

  test('preserves bases, ordered transcript segments, catalog metadata and independently hashed identity', async () => {
    const catalog = source();
    const before = structuredClone(catalog);
    const version = 'a'.repeat(64);
    const input = await exportCatalogGenomeSnapshot(catalog, sequence, { contentVersion: version });
    const result = await importLocalGenomes(input);
    const genome = result.genomes[0];
    expect(genome.sequence).toBe(sequence);
    expect(genome.original).toEqual(input);
    expect(genome.phage.genes).toEqual([...catalog.genes].sort((a, b) => a.id - b.id));
    expect(getGeneMapSegments(genome.phage.genes[1])).toEqual([
      { start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' },
    ]);
    expect(catalog).toEqual(before);
    expect(genome.phage).toMatchObject({
      family: catalog.family, host: catalog.host, description: catalog.description,
      pdbIds: [], hasModel: false, codonUsage: null,
      localGenome: {
        format: 'catalog-snapshot', topology: 'unknown',
        sequenceSha256: createHash('sha256').update(sequence).digest('hex'),
      },
    });
    expect(JSON.parse(input.text).provenance).toEqual({ phageId: 17, slug: 'catalog-alpha', contentVersion: version });
    expect(genome.warnings.join(' ')).toContain('not the original GenBank');
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
        : value;
    // The source snapshot is already canonical; no production hashing helper is reused.
    const ordered = canonical(JSON.parse(input.text));
    expect(genome.phage.localGenome!.contentId).toBe(createHash('sha256').update(JSON.stringify(ordered)).digest('hex'));
  });

  test('mixed bundles restore exact source snapshots and selection without catalog access', async () => {
    const catalog = await importLocalGenomes(await exportCatalogGenomeSnapshot(source(), sequence));
    const privateInput = await importLocalGenomes({ name: 'private.fa', text: '>private\nGCGC\n' });
    const genomes = [...catalog.genomes, ...privateInput.genomes];
    const view = { contentId: genomes[0].phage.localGenome!.contentId, viewMode: 'dual' as const,
      readingFrame: -2 as const, scrollPosition: 8 };
    const restored = await importLocalGenomes({ name: 'mixed.json', text: exportLocalGenomeBundle(genomes, view) });
    expect(restored).toEqual({ genomes, view });
  });

  test('identity ignores transport order and filename but binds bases, annotation and dataset version', async () => {
    const input = await exportCatalogGenomeSnapshot(source(), sequence, { contentVersion: 'a'.repeat(64) });
    const initial = (await importLocalGenomes(input)).genomes[0].phage.localGenome!.contentId;
    const reordered = JSON.parse(input.text) as CatalogGenomeSnapshot;
    reordered.genome.genes.reverse();
    const rootOrder = { genome: reordered.genome, provenance: reordered.provenance, version: reordered.version, format: reordered.format };
    expect((await importLocalGenomes({ name: 'renamed.json', text: JSON.stringify(rootOrder) })).genomes[0].phage.localGenome!.contentId).toBe(initial);
    for (const mutate of [
      (value: CatalogGenomeSnapshot) => { value.genome.sequence = 'CTGAAACCCGGGTTTTAA'; },
      (value: CatalogGenomeSnapshot) => { value.genome.genes[0].product = 'changed product'; },
      (value: CatalogGenomeSnapshot) => { value.provenance.contentVersion = 'b'.repeat(64); },
    ]) {
      const changed = JSON.parse(input.text) as CatalogGenomeSnapshot;
      mutate(changed);
      expect((await importLocalGenomes({ name: input.name, text: JSON.stringify(changed) })).genomes[0].phage.localGenome!.contentId).not.toBe(initial);
    }
  });

  test('legacy split annotations remain exact in the source and are never presented as a complete CDS', async () => {
    const catalog = source();
    catalog.genes = [catalog.genes[0]];
    catalog.genes[0].endPos = 6;
    catalog.genes[0].qualifiers!._segments = JSON.stringify([{ start: 0, end: 6 }, { start: 12, end: 18 }]);
    const input = await exportCatalogGenomeSnapshot(catalog, sequence);
    const { genomes } = await importLocalGenomes(input);
    expect(genomes[0].phage.genes).toEqual([]);
    expect(JSON.parse(genomes[0].original.text).genome.genes).toEqual(catalog.genes);
    expect(genomes[0].warnings.join(' ')).toContain('Catalog gene 92');
    expect((await importLocalGenomes({ name: 'copy.json', text: exportLocalGenomeBundle(genomes) })).genomes).toEqual(genomes);
  });

  test('rejects inconsistent snapshots atomically and cannot recapture a local genome', async () => {
    await expect(exportCatalogGenomeSnapshot(source(), sequence.slice(1))).rejects.toThrow('complete');
    const input = await exportCatalogGenomeSnapshot(source(), sequence);
    for (const mutate of [
      (value: CatalogGenomeSnapshot) => { value.genome.genes.push(value.genome.genes[0]); },
      (value: CatalogGenomeSnapshot) => { value.genome.genes[0].endPos = 100; },
      (value: CatalogGenomeSnapshot) => { value.provenance.phageId = -1; },
      (value: CatalogGenomeSnapshot) => { value.provenance.contentVersion = 'not-a-hash'; },
      (value: CatalogGenomeSnapshot) => { value.genome.sequence = sequence.toLowerCase(); },
      (value: CatalogGenomeSnapshot) => { value.genome.sequence = sequence.replace('T', 'U'); },
    ]) {
      const changed = JSON.parse(input.text) as CatalogGenomeSnapshot;
      mutate(changed);
      await expect(importLocalGenomes({ name: 'invalid.json', text: JSON.stringify(changed) })).rejects.toThrow();
    }
    const version = { ...JSON.parse(input.text), version: 2 };
    await expect(importLocalGenomes({ name: 'version.json', text: JSON.stringify(version) })).rejects.toThrow();
    const unknown = { ...JSON.parse(input.text), references: ['never accepted'] };
    await expect(importLocalGenomes({ name: 'unknown.json', text: JSON.stringify(unknown) })).rejects.toThrow();
    const { genomes } = await importLocalGenomes(input);
    await expect(exportCatalogGenomeSnapshot(genomes[0].phage, sequence)).rejects.toThrow('catalog genome');
  });
});
