import { describe, expect, test } from 'bun:test';
import { importLocalGenomes } from '@phage-explorer/core';
import { reconstructCdsReference } from '../../core/src/analysis/cds-consequences';
import { parseGenBank, type NCBISequenceResult } from './ncbi-fetcher';

const indent = ' '.repeat(21);
function feature(location: string, qualifiers: string[] = [], type = 'CDS'): string {
  const [first, ...continuation] = location.split('\n');
  return [
    '     ' + type.padEnd(16) + first,
    ...continuation.map(line => indent + line),
    ...qualifiers.flatMap(value => value.split('\n').map(line => indent + line)),
  ].join('\n');
}
function fixture(sequence: string, features: string, molecule = 'DNA', topology = 'linear'): string {
  return [
    'LOCUS       TEST ' + sequence.length + ' bp ' + molecule + ' ' + topology + ' PHG 12-NOV-2026',
    'DEFINITION  Parser fixture, complete genome.',
    '            Annotation continuation.',
    'ACCESSION   TEST SECONDARY',
    'VERSION     TEST.2',
    '  ORGANISM  Escherichia phage parser',
    'FEATURES             Location/Qualifiers',
    features,
    'ORIGIN',
    '        1 ' + sequence.toLowerCase(),
    '//',
    '',
  ].join('\n');
}
/** Adapt the parser output to the same exact transcript contract consumed by the
 * catalog protein producer. Expected proteins below are hand-specified, not computed
 * with a second copy of the parser or translation implementation.
 */
function reference(record: NCBISequenceResult, index = 0) {
  const cds = record.features.filter(item => item.type === 'CDS')[index];
  return reconstructCdsReference({
    id: index + 1, name: cds.gene ?? null, locusTag: cds.locusTag ?? null,
    startPos: cds.start, endPos: cds.end, strand: cds.strand, product: cds.product ?? null, type: cds.type,
    qualifiers: { ...cds.qualifiers, _location: cds.location, _segments: cds.segments },
  }, record.sequence);
}

describe('catalog GenBank parser', () => {
  test('retains primary accession, complete definition, source qualifiers and all feature types', () => {
    const record = parseGenBank(fixture('ATGAAATAA', [
      feature('1..9', ['/mol_type="genomic DNA"', '/db_xref="taxon:123"'], 'source'),
      feature('4..6', ['/product="mature peptide"'], 'mat_peptide'),
    ].join('\n')));
    expect(record.accession).toBe('TEST');
    expect(record.metadata.version).toBe('TEST.2');
    expect(record.metadata.definition).toBe('Parser fixture, complete genome. Annotation continuation.');
    expect(record.metadata.organism).toBe('Escherichia phage parser');
    expect(record.metadata.molecule).toBe('DNA');
    expect(record.features.map(item => item.type)).toEqual(['source', 'mat_peptide']);
    expect(record.features[0].qualifiers.mol_type).toBe('genomic DNA');
    expect(record.features[1].segments).toEqual([{ start: 3, end: 6, strand: '+' }]);
  });

  test('assembles a wrapped joined CDS without translating the intervening sequence', () => {
    const record = parseGenBank(fixture('ATGAAACCCGGGTAA', feature('join(1..6,\n10..15)', [
      '/gene="capsid"', '/locus_tag="gp1"', '/product="tail fiber\nassembly protein"',
      '/codon_start=1', '/transl_table=11', '/translation="MK\nG"',
    ])));
    const cds = record.features[0];
    expect(cds.location).toBe('join(1..6,10..15)');
    expect(cds.segments).toEqual([{ start: 0, end: 6, strand: '+' }, { start: 9, end: 15, strand: '+' }]);
    expect([cds.start, cds.end, cds.strand]).toEqual([0, 15, '+']);
    expect(cds.product).toBe('tail fiber assembly protein');
    expect(cds.qualifiers.translation).toBe('MKG');
    expect(reference(record)).toMatchObject({ cds: 'ATGAAAGGGTAA', protein: 'MKG*', reasons: [] });
  });

  for (const row of [
    { name: 'outer complement', sequence: 'TTACCCGGGTTTCAT', location: 'complement(join(1..6,10..15))',
      segments: [{ start: 9, end: 15, strand: '-' }, { start: 0, end: 6, strand: '-' }] },
    { name: 'per-segment complements', sequence: 'TTACCCGGGTTTCAT', location: 'join(complement(10..15),complement(1..6))',
      segments: [{ start: 9, end: 15, strand: '-' }, { start: 0, end: 6, strand: '-' }] },
    { name: 'circular plus transcript', sequence: 'GGGTAACCCATGAAA', location: 'join(10..15,1..6)',
      segments: [{ start: 9, end: 15, strand: '+' }, { start: 0, end: 6, strand: '+' }] },
    { name: 'circular minus transcript', sequence: 'TTTCATCCCTTACCC', location: 'complement(join(10..15,1..6))',
      segments: [{ start: 0, end: 6, strand: '-' }, { start: 9, end: 15, strand: '-' }] },
  ]) {
    test('preserves transcript order for ' + row.name, () => {
      const record = parseGenBank(fixture(row.sequence, feature(row.location, ['/translation="MKG"']), 'DNA', 'circular'));
      expect(record.features[0].segments).toEqual(row.segments);
      expect(record.metadata.topology).toBe('circular');
      expect(reference(record)).toMatchObject({ cds: 'ATGAAAGGGTAA', protein: 'MKG*', reasons: [] });
    });
  }

  test('preserves a single reverse-strand segment', () => {
    const record = parseGenBank(fixture('TTATTTCAT', feature('complement(1..9)', ['/translation="MK"'])));
    expect(record.features[0].segments).toEqual([{ start: 0, end: 9, strand: '-' }]);
    expect(reference(record)).toMatchObject({ cds: 'ATGAAATAA', protein: 'MK*', reasons: [] });
  });

  test('applies codon_start across a short first segment without inferring initiation', () => {
    const record = parseGenBank(fixture('CGGGCTTGAAATAA', feature('join(1,5..14)', [
      '/codon_start=3', '/transl_table=11', '/translation="LK"',
    ])));
    expect(record.features[0].segments).toEqual([{ start: 0, end: 1, strand: '+' }, { start: 4, end: 14, strand: '+' }]);
    expect(reference(record)).toMatchObject({
      cds: 'TTGAAATAA', protein: 'LK*', codonStart: 3, geneticCode: 11,
      segments: [{ start: 5, end: 14, strand: '+' }], reasons: [],
    });
  });

  test('preserves reverse joined offsets and an explicitly reassigned TGA codon', () => {
    const record = parseGenBank(fixture('TTACCCCTCATAAG', feature('complement(join(1..3,8..14))', [
      '/codon_start=2', '/transl_table=4', '/translation="LW"',
    ])));
    expect(record.features[0].segments).toEqual([{ start: 7, end: 14, strand: '-' }, { start: 0, end: 3, strand: '-' }]);
    expect(reference(record)).toMatchObject({ cds: 'TTATGATAA', protein: 'LW*', codonStart: 2, geneticCode: 4, reasons: [] });
  });

  for (const row of [
    { code: 15, sequence: 'ATGTAGTAA', protein: 'MQ' },
    { code: 25, sequence: 'ATGTGATAA', protein: 'MG' },
  ]) {
    test('preserves explicit translation table ' + row.code, () => {
      const record = parseGenBank(fixture(row.sequence, feature('1..9', [
        '/transl_table=' + row.code, '/translation="' + row.protein + '"',
      ])));
      expect(record.features[0].qualifiers.transl_table).toBe(String(row.code));
      expect(reference(record)).toMatchObject({ protein: row.protein + '*', geneticCode: row.code, reasons: [] });
    });
  }

  test('retains mixed strands and overlaps for explicit downstream refusal', () => {
    const record = parseGenBank(fixture('ATGAAATAA', [
      feature('join(1..3,complement(7..9))'),
      feature('join(1..6,4..9)'),
    ].join('\n')));
    expect(record.features[0].strand).toBeNull();
    expect(record.features[0].segments).toEqual([{ start: 0, end: 3, strand: '+' }, { start: 6, end: 9, strand: '-' }]);
    expect(record.features[1].segments).toEqual([{ start: 0, end: 6, strand: '+' }, { start: 3, end: 9, strand: '+' }]);
    for (let i = 0; i < 2; i++) {
      expect(reference(record, i).protein).toBeNull();
      expect(reference(record, i).reasons.join(' ')).toContain('mixed, overlapping');
    }
  });

  for (const location of [
    'join(1..3,<7..9)', 'join(1..3,REMOTE.1:7..9)', 'REMOTE:1..3',
    'join(1..3,order(4..6,7..9))', '1^2', '3..2', '0..3', '1..10',
    'join(1..3,)', 'join(1..3,4..6', 'join(1..3,4..6))', 'one-of(1,3)..9',
  ]) {
    test('retains unsupported location without inventing a partial CDS: ' + location, () => {
      const record = parseGenBank(fixture('ATGAAATAA', feature(location, ['/product="retained annotation"'])));
      expect(record.features).toHaveLength(1);
      expect(record.features[0]).toMatchObject({
        location, segments: [], start: 0, end: 0, strand: null, product: 'retained annotation',
      });
      const warnings = JSON.parse(record.metadata.warnings) as string[];
      expect(warnings.some(warning => warning.includes(location) && warning.includes('annotation retained'))).toBe(true);
      expect(reference(record).protein).toBeNull();
      expect(reference(record).reasons.length).toBeGreaterThan(0);
    });
  }

  test('retains repeated qualifiers, full display labels and escaped quotes', () => {
    const record = parseGenBank(fixture('ATGAAATAA', feature('1..9', [
      '/product="tail fiber\nassembly protein"', '/product="alternative label"',
      '/db_xref="GeneID:1"', '/db_xref="RefSeq:2"',
      '/transl_table=11', '/transl_table=4', '/codon_start=1', '/codon_start=2',
      '/translation="MK"', '/translation="M"',
      '/transl_except=(pos:4..6,aa:Sec)', '/transl_except=(pos:7..9,aa:Pyl)',
      '/note="An ""escaped"" label\nand /pseudo is just text"',
    ])));
    expect(record.features[0].qualifiers).toMatchObject({
      product: ['tail fiber assembly protein', 'alternative label'],
      db_xref: ['GeneID:1', 'RefSeq:2'], transl_table: ['11', '4'], codon_start: ['1', '2'],
      translation: ['MK', 'M'], transl_except: ['(pos:4..6,aa:Sec)', '(pos:7..9,aa:Pyl)'],
      note: 'An "escaped" label and /pseudo is just text',
    });
    expect(record.features[0].product).toBe('tail fiber assembly protein');
    expect(record.features[0].qualifiers).not.toHaveProperty('pseudo');
    expect(JSON.parse(record.metadata.warnings).join(' ')).toContain('first value used for the display label');
  });

  test('recognizes a slash as text while a quoted qualifier remains open', () => {
    const record = parseGenBank(fixture('ATGAAATAA', feature('1..9', ['/note="continued\n/pseudo is not a qualifier"'])));
    expect(record.features[0].qualifiers.note).toBe('continued /pseudo is not a qualifier');
    expect(record.features[0].qualifiers).not.toHaveProperty('pseudo');
    expect(reference(record).reasons).toEqual([]);
  });

  for (const [key, value] of [
    ['pseudo', ''], ['pseudogene', 'unknown'], ['exception', 'ribosomal slippage'],
    ['transl_except', '(pos:4..6,aa:Sec)'], ['ribosomal_slippage', ''],
    ['trans_splicing', ''], ['artificial_location', 'heterogeneous population sequenced'],
  ]) {
    test('preserves the final /' + key + ' qualifier so exact translation refuses it', () => {
      const qualifier = '/' + key + (value ? '="' + value + '"' : '');
      const record = parseGenBank(fixture('ATGAAATAA', feature('1..9', [qualifier])));
      expect(record.features[0].qualifiers[key]).toBe(value);
      expect(reference(record).protein).toBeNull();
      expect(reference(record).reasons).toContain('Unsupported /' + key + ' qualifier.');
    });
  }

  test('flushes flags at a feature boundary and accepts a qualifier after a wrapped location', () => {
    const record = parseGenBank(fixture('ATGAAATAA', [
      feature('1..9', ['/pseudo']),
      feature('join(1..3,\n4..9) /transl_table=11', ['/translation="MK"']),
    ].join('\n')));
    expect(record.features[0].qualifiers.pseudo).toBe('');
    expect(record.features[1].location).toBe('join(1..3,4..9)');
    expect(reference(record, 1)).toMatchObject({ protein: 'MK*', geneticCode: 11, reasons: [] });
  });

  test('rejects unfinished or trailing quoted text instead of losing subsequent annotations', () => {
    expect(() => parseGenBank(fixture('ATGAAATAA', feature('1..9', ['/note="unfinished'])))).toThrow('unterminated quoted');
    expect(() => parseGenBank(fixture('ATGAAATAA', feature('1..9', ['/note="x"trailing'])))).toThrow('text after closing quote');
    expect(() => parseGenBank(fixture('ATGAAATAA', [
      feature('1..9', ['/note="unfinished']), feature('1..3', ['/pseudo']),
    ].join('\n')))).toThrow('unterminated quoted');
  });

  test('accepts catalog RNA using INSDC T notation without weakening private DNA import', async () => {
    const text = fixture('ATGAAATAA', feature('1..9', ['/translation="MK"']), 'ss-RNA');
    const record = parseGenBank(text);
    expect(record.sequence).toBe('ATGAAATAA');
    expect(record.metadata.molecule).toBe('RNA');
    expect(record.metadata.moleculeType).toBe('ss-RNA');
    expect(record.metadata.sequenceNormalization).toBeUndefined();
    expect(reference(record)).toMatchObject({ protein: 'MK*', reasons: [] });
    await expect(importLocalGenomes({ name: 'rna.gb', text })).rejects.toThrow('RNA records');
  });

  test('normalizes U only for explicitly declared catalog RNA and records the conversion', () => {
    const record = parseGenBank(fixture('AUGAAAUAA', feature('1..9', ['/translation="MK"']), 'RNA'));
    expect(record.sequence).toBe('ATGAAATAA');
    expect(record.length).toBe(9);
    expect(record.metadata.molecule).toBe('RNA');
    expect(record.metadata.sequenceNormalization).toBe('RNA U-to-T');
    expect(JSON.parse(record.metadata.warnings).join(' ')).toContain('molecule type remains RNA');
    expect(reference(record)).toMatchObject({ protein: 'MK*', reasons: [] });
    for (const molecule of ['DNA', '']) {
      expect(() => parseGenBank(fixture('AUGAAAUAA', feature('1..9'), molecule))).toThrow('declared RNA');
    }
  });

  test('retains ambiguity bases and computes GC over known RNA nucleotides', () => {
    const record = parseGenBank(fixture('ACGUNRY', feature('1..7', [], 'ncRNA'), 'RNA'));
    expect(record.sequence).toBe('ACGTNRY');
    expect(record.gcContent).toBe(50);
    expect(record.features[0].type).toBe('ncRNA');
  });

  test('validates complete ORIGIN content, numbering, record length and single-record input', () => {
    const text = fixture('ATGAAATAA', feature('1..9'));
    expect(parseGenBank(text.replace('        1 atgaaataa', '        1 atg\n        4 aaataa')).sequence).toBe('ATGAAATAA');
    expect(() => parseGenBank(text.replace('9 bp', '10 bp'))).toThrow('LOCUS declares');
    expect(() => parseGenBank(text.replace('        1 atgaaataa', '        1 atg\n        5 aaataa'))).toThrow('out-of-order');
    expect(() => parseGenBank(text.replace('ORIGIN', 'CONTIG'))).toThrow('missing ORIGIN');
    expect(() => parseGenBank(text.replace('//', ''))).toThrow('must end with //');
    expect(() => parseGenBank(text + text)).toThrow('multiple records');
    expect(() => parseGenBank(fixture('ATGZAATAA', feature('1..9')))).toThrow('non-IUPAC');
    expect(() => parseGenBank(fixture('ATG-AATAA', feature('1..9')))).toThrow('malformed');
    expect(parseGenBank('\uFEFF' + text.replaceAll('\n', '\r\n')).sequence).toBe('ATGAAATAA');
  });
});
