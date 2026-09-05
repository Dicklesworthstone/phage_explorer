import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { exportLocalGenomeBundle, importLocalGenomes, parseLocalFeatureLocation } from './genome-import';

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
