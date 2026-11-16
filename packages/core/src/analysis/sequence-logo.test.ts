import { describe, expect, it } from 'bun:test';
import { buildGeneStartAlignment, computeSequenceLogo } from './sequence-logo';
import { importLocalGenomes } from '../genome-import';
import type { GeneInfo } from '../types';

function repeat<T>(value: T, count: number): T[] {
  return Array.from({ length: count }, () => value);
}

describe('Sequence logo', () => {
  it('computeSequenceLogo > returns empty for empty alignment', () => {
    expect(computeSequenceLogo([])).toEqual([]);
  });

  it('computeSequenceLogo (DNA) > identical sequences produce a tall single-letter stack', () => {
    const alignment = repeat('ACGT', 100);
    const logo = computeSequenceLogo(alignment, 'dna');

    expect(logo).toHaveLength(4);
    for (const col of logo) {
      expect(col.totalBits).toBeGreaterThan(1.9);
      expect(col.totalBits).toBeLessThanOrEqual(2);
      expect(col.letters).toHaveLength(1);
      expect(col.letters[0]?.height).toBeCloseTo(col.totalBits, 6);
    }
  });

  it('computeSequenceLogo (DNA) > ignores gaps/ambiguous chars and still computes from valid letters', () => {
    const alignment = ['ACGT', 'ACGT', 'NNNN', '----'];
    const logo = computeSequenceLogo(alignment, 'dna');

    expect(logo).toHaveLength(4);
    // Column 1 has only A from two sequences; N and - should be ignored.
    expect(logo[0]?.letters.map((l) => l.char)).toEqual(['A']);
    // With 2 samples, error correction is large (~1.08 bits). Info = 2 - 0 - 1.08 = 0.92.
    expect(logo[0]?.totalBits).toBeGreaterThan(0.9);
    // Column 4 has only T from two sequences; also ignores N/-.
    expect(logo[3]?.letters.map((l) => l.char)).toEqual(['T']);
  });

  it('computeSequenceLogo (DNA) > sorts letters ascending by height for stacking', () => {
    const alignment = [
      ...repeat('A', 75),
      ...repeat('C', 25),
    ];
    const logo = computeSequenceLogo(alignment, 'dna');

    expect(logo).toHaveLength(1);
    expect(logo[0]?.letters.map((l) => l.char)).toEqual(['C', 'A']);
    expect(logo[0]?.letters[0]?.height).toBeLessThan(logo[0]?.letters[1]?.height ?? 0);
    expect(logo[0]?.letters[0]?.height + (logo[0]?.letters[1]?.height ?? 0)).toBeCloseTo(logo[0]?.totalBits ?? 0, 6);
  });

  it('computeSequenceLogo (protein) > identical sequences approach max information', () => {
    const alignment = repeat('A', 100);
    const logo = computeSequenceLogo(alignment, 'protein');

    expect(logo).toHaveLength(1);
    expect(logo[0]?.totalBits).toBeGreaterThan(4);
    expect(logo[0]?.totalBits).toBeLessThanOrEqual(Math.log2(20));
    expect(logo[0]?.letters).toEqual([{ char: 'A', height: logo[0]?.totalBits ?? 0 }]);
  });
});

const cds = (id: number, startPos: number, endPos: number, overrides: Partial<GeneInfo> = {}): GeneInfo => ({
  id, startPos, endPos, strand: '+', name: `gene-${id}`, locusTag: null, product: null, type: 'CDS', ...overrides,
});
const genbank = (sequence: string, locations: string[], topology = 'circular') => ({ name: 'logo.gb',
  text: `LOCUS       LOGO ${sequence.length} bp DNA ${topology}\nFEATURES             Location/Qualifiers\n` +
    locations.map(location => `     CDS             ${location}\n`).join('') +
    `ORIGIN\n        1 ${sequence.toLowerCase()}\n//\n`,
});

describe('Exact annotated gene-start logo windows', () => {
  it('orients forward and reverse genomic flanks at the same explicit initiation codon', () => {
    const forward = buildGeneStartAlignment('A'.repeat(20) + 'ATG' + 'C'.repeat(37), [cds(1, 20, 50)], 'linear');
    expect(forward.windows).toHaveLength(1);
    expect(forward.windows[0]).toEqual({ geneId: 1, name: 'gene-1', anchor: 20, strand: '+', geneticCode: 1,
      startCodon: 'ATG', sequence: 'A'.repeat(20) + 'ATG' + 'C'.repeat(7), wrapped: false });
    // Genome positions 30..59 contain TTTTTTTCATGGGGGGGGGGGGGGGGGGGG:
    // reading leftward from base 39 gives ATG, with twenty complementary C upstream.
    const reverse = buildGeneStartAlignment('A'.repeat(30) + 'T'.repeat(7) + 'CAT' + 'G'.repeat(20),
      [cds(2, 10, 40, { strand: '-' })], 'linear');
    expect(reverse.windows[0]).toEqual({ geneId: 2, name: 'gene-2', anchor: 39, strand: '-', geneticCode: 1,
      startCodon: 'ATG', sequence: 'C'.repeat(20) + 'ATG' + 'A'.repeat(7), wrapped: false });
  });

  it('keeps forward and reverse origin-crossing join order from actual GenBank records', async () => {
    const forwardSequence = 'GGGTT' + 'C'.repeat(30) + 'A'.repeat(20) + 'ATGCC';
    const forward = (await importLocalGenomes(genbank(forwardSequence, ['join(56..60,1..16)']))).genomes[0];
    const first = buildGeneStartAlignment(forward.sequence, forward.phage.genes, forward.phage.localGenome!.topology);
    expect(first.windows[0].anchor).toBe(55);
    expect(first.windows[0].sequence).toBe('A'.repeat(20) + 'ATGCCGGGTT');
    expect(first.windows[0].wrapped).toBe(true);
    expect(first.excluded).toEqual([]);
    for (const topology of ['unknown', 'linear'] as const) {
      const unwrapped = buildGeneStartAlignment(forward.sequence, forward.phage.genes, topology);
      expect(unwrapped.windows).toEqual([]);
      expect(unwrapped.excluded[0].reason).toBe('genome-edge');
    }

    const reverseSequence = 'GGCAT' + 'T'.repeat(20) + 'C'.repeat(30) + 'AACCC';
    const reverse = (await importLocalGenomes(genbank(reverseSequence, ['complement(join(45..60,1..5))']))).genomes[0];
    const second = buildGeneStartAlignment(reverse.sequence, reverse.phage.genes, 'circular');
    expect(second.windows[0].anchor).toBe(4);
    expect(second.windows[0].strand).toBe('-');
    expect(second.windows[0].sequence).toBe('A'.repeat(20) + 'ATGCCGGGTT');
    expect(second.windows[0].wrapped).toBe(true);
  });

  it('handles initiation split across a circular origin but never splices an intron into genomic context', async () => {
    const sequence = 'TG' + 'C'.repeat(37) + 'A'.repeat(20) + 'A';
    const circular = (await importLocalGenomes(genbank(sequence, ['join(60,1..15)']))).genomes[0];
    const window = buildGeneStartAlignment(sequence, circular.phage.genes, 'circular');
    expect(window.windows[0].sequence).toBe('A'.repeat(20) + 'ATG' + 'C'.repeat(7));
    const split = cds(2, 20, 50, { qualifiers: { _segments: [{ start: 20, end: 21, strand: '+' }, { start: 40, end: 50, strand: '+' }] } });
    const spliced = buildGeneStartAlignment('C'.repeat(20) + 'A' + 'C'.repeat(19) + 'TG' + 'C'.repeat(18), [split]);
    expect(spliced.windows).toEqual([]);
    expect(spliced.excluded[0].reason).toBe('split-initiator');
  });

  it('does not collapse distinct starts sharing a locus tag or count a duplicate genomic start twice', () => {
    const sequence = 'C'.repeat(20) + 'ATG' + 'C'.repeat(37) + 'A'.repeat(20) + 'ATG' + 'C'.repeat(37);
    const result = buildGeneStartAlignment(sequence, [
      cds(1, 20, 50, { locusTag: 'same' }), cds(2, 80, 110, { locusTag: 'same' }), cds(3, 20, 55),
      cds(4, 30, 40, { type: 'gene' }),
    ]);
    expect(result.totalCds).toBe(3);
    expect(result.windows.map(row => row.anchor)).toEqual([20, 80]);
    expect(result.windows.map(row => row.sequence.slice(0, 20))).toEqual(['C'.repeat(20), 'A'.repeat(20)]);
    expect(result.excluded).toEqual([{ geneId: 3, name: 'gene-3', reason: 'duplicate-start' }]);
  });

  it('keeps complete initiation separate from partial, ambiguous and unsupported annotations', () => {
    const sequence = 'C'.repeat(20) + 'ATG' + 'C'.repeat(37);
    for (const [qualifiers, reason] of [
      [{ codon_start: 2 }, 'partial-start'], [{ codon_start: 3 }, 'partial-start'], [{ codon_start: 'unknown' }, 'partial-start'],
      [{ pseudo: '' }, 'unsupported-annotation'], [{ exception: 'RNA editing' }, 'unsupported-annotation'],
      [{ partial: true }, 'unsupported-annotation'], [{ transl_table: 2 }, 'unsupported-code'],
      [{ _location: '<21..50' }, 'invalid-location'], [{ _location: '22..50' }, 'invalid-location'],
      [{ _segments: null }, 'invalid-location'],
      [{ _segments: [{ start: 20, end: 30, strand: '+' }, { start: 25, end: 50, strand: '+' }] }, 'invalid-location'],
      [{ _segments: [{ start: 20, end: 30, strand: '+' }, { start: 40, end: 50, strand: '-' }] }, 'invalid-location'],
    ] as const) {
      const result = buildGeneStartAlignment(sequence, [cds(1, 20, 50, { qualifiers })]);
      expect(result.windows).toEqual([]);
      expect(result.excluded[0].reason).toBe(reason);
    }
    expect(buildGeneStartAlignment('C'.repeat(20) + 'ANG' + 'C'.repeat(37), [cds(1, 20, 50)]).excluded[0].reason).toBe('unresolved-start');
    expect(buildGeneStartAlignment(sequence, [cds(1, 20, 22)]).excluded[0].reason).toBe('unresolved-start');
    expect(buildGeneStartAlignment(sequence, [cds(1, 20, 61)]).excluded[0].reason).toBe('invalid-location');
    expect(buildGeneStartAlignment('ATG', [cds(1, 0, 3)], 'circular').excluded[0].reason).toBe('genome-edge');
  });

  it('uses the explicitly annotated genetic code without guessing a bacterial default', () => {
    const sequence = 'C'.repeat(20) + 'GTG' + 'C'.repeat(37);
    expect(buildGeneStartAlignment(sequence, [cds(1, 20, 50)]).excluded[0].reason).toBe('unsupported-initiator');
    const bacterial = buildGeneStartAlignment(sequence, [cds(1, 20, 50, { qualifiers: { transl_table: '11' } })]);
    expect(bacterial.windows[0].startCodon).toBe('GTG');
    expect(bacterial.windows[0].geneticCode).toBe(11);
    expect(buildGeneStartAlignment(sequence, [cds(1, 20, 50, { qualifiers: { transl_table: 15 } })]).excluded[0].reason).toBe('unsupported-initiator');
  });

  it('retains unresolved flanking bases at their original coordinates', () => {
    const sequence = 'NNRY' + 'A'.repeat(16) + 'ATG' + 'C'.repeat(37);
    const result = buildGeneStartAlignment(sequence.toLowerCase(), [cds(1, 20, 50)]);
    expect(result.windows[0].sequence).toBe('NNRY' + 'A'.repeat(16) + 'ATG' + 'C'.repeat(7));
    expect(result.totalCds).toBe(result.windows.length + result.excluded.length);
    expect(() => buildGeneStartAlignment('---ATG', [cds(1, 3, 6)])).toThrow('original genomic positions');
    expect(buildGeneStartAlignment('', []).windows).toEqual([]);
  });
});
