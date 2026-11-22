import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { importLocalGenomes, type GeneInfo } from '@phage-explorer/core';
import {
  prepareSelectedCds, selectedCdsExport, selectedCdsLocation, SelectedCdsSession,
  type SelectedCdsSource,
} from './SelectedCdsSession';

function source(sequence = 'ATGAAATAA', geneOptions: Partial<GeneInfo> = {}): SelectedCdsSource {
  const gene: GeneInfo = { id: 7, name: 'Capsid', locusTag: 'gp7', startPos: 0, endPos: sequence.length,
    strand: '+', product: 'Fixture protein', type: 'CDS', ...geneOptions };
  return { owner: {}, sequence, phage: {
    id: 42, slug: 'same', name: 'Private fixture', accession: 'SAME', family: null, host: null,
    genomeLength: sequence.length, gcContent: null, morphology: null, lifecycle: null,
    description: null, baltimoreGroup: null, genomeType: null, pdbIds: [], genes: [gene], codonUsage: null, hasModel: false,
  } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const dnaOf = (fasta: string) => fasta.split('\n').slice(1).join('');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

describe('exact selected CDS content and local exports', () => {
  it('extracts forward and reverse joined CDS without intervening genomic bases', async () => {
    // The omitted interval is six C bases. Hand translations: ATG AAA GGG TTT
    // gives M K G F; its reverse complement AAA CCC TTT CAT gives K P F H.
    const forward = source('ATGAAACCCCCCGGGTTT', { qualifiers: {
      _location: 'join(1..6,13..18)',
      _segments: [{ start: 0, end: 6, strand: '+' }, { start: 12, end: 18, strand: '+' }],
    } });
    const first = await prepareSelectedCds(forward, forward.phage.genes[0]);
    assert.equal(first.cds, 'ATGAAAGGGTTT'); assert.equal(first.protein, 'MKGF');
    assert.equal(selectedCdsLocation(first), '1..6(+), 13..18(+)');
    const reverse = source(forward.sequence, { strand: '-', qualifiers: {
      _location: 'complement(join(1..6,13..18))',
      _segments: [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }],
    } });
    const second = await prepareSelectedCds(reverse, reverse.phage.genes[0]);
    assert.equal(second.cds, 'AAACCCTTTCAT'); assert.equal(second.protein, 'KPFH');
    assert.equal(selectedCdsLocation(second), '13..18(-), 1..6(-)');
    assert.equal(dnaOf(selectedCdsExport(first, 'cds')!.content), 'ATGAAAGGGTTT');
    assert.equal(dnaOf(selectedCdsExport(second, 'protein')!.content), 'KPFH');
  });

  it('preserves circular-origin order and measures codon_start across short segments', async () => {
    // Genome = AAA TAA CCC ATG; the origin-spanning CDS is ATG AAA TAA.
    const circular = source('AAATAACCCATG', { qualifiers: {
      _segments: [{ start: 9, end: 12, strand: '+' }, { start: 0, end: 6, strand: '+' }],
    } });
    const joined = await prepareSelectedCds(circular, circular.phage.genes[0]);
    assert.equal(joined.cds, 'ATGAAATAA'); assert.equal(joined.protein, 'MK*');
    assert.equal(selectedCdsLocation(joined), '10..12(+), 1..6(+)');
    const offset = source('ACCCTATGAAATAA', { qualifiers: {
      codon_start: 3,
      _segments: [{ start: 0, end: 1, strand: '+' }, { start: 4, end: 14, strand: '+' }],
    } });
    const shifted = await prepareSelectedCds(offset, offset.phage.genes[0]);
    assert.equal(shifted.cds, 'ATGAAATAA'); assert.equal(shifted.protein, 'MK*');
    assert.deepEqual(shifted.segments, [{ start: 5, end: 14, strand: '+' }]);
    const reverse = source('TTATTTCATG', { strand: '-', qualifiers: { codon_start: 2 } });
    const reverseShifted = await prepareSelectedCds(reverse, reverse.phage.genes[0]);
    assert.equal(reverseShifted.cds, 'ATGAAATAA'); assert.equal(reverseShifted.protein, 'MK*');
    assert.deepEqual(reverseShifted.segments, [{ start: 0, end: 9, strand: '-' }]);
  });

  it('uses declared genetic codes and initiation instead of a global reading frame', async () => {
    // NCBI table controls: 4 UGA=W, 15 UAG=Q, 25 UGA=G; table 11 initiates GTG as M.
    for (const [table, dna, expected] of [[1, 'GTGGTGTAA', 'VV*'], [11, 'GTGGTGTAA', 'MV*'],
      [4, 'TTATGATAA', 'MW*'], [15, 'ATGTAGTAA', 'MQ*'], [25, 'GTGTGATAA', 'MG*']] as const) {
      const input = source(dna, { qualifiers: { transl_table: table } });
      const result = await prepareSelectedCds(input, input.phage.genes[0]);
      assert.equal(result.geneticCode, table); assert.equal(result.protein, expected);
      assert.match(selectedCdsExport(result, 'protein')!.content, new RegExp(`transl_table=${table}`));
    }
    const partialStart = source('AGTGGTGTAA', { qualifiers: { codon_start: 2, transl_table: 11 } });
    const result = await prepareSelectedCds(partialStart, partialStart.phage.genes[0]);
    assert.equal(result.cds, 'GTGGTGTAA'); assert.equal(result.protein, 'VV*');
  });

  it('keeps exact DNA for unsupported translation, pseudogenes, exceptions and inconsistent deposited protein', async () => {
    const controls: Array<[Record<string, unknown>, RegExp]> = [
      [{ transl_table: 2 }, /Unsupported translation table/],
      [{ pseudo: '' }, /Unsupported \/pseudo/],
      [{ exception: 'RNA editing' }, /Unsupported \/exception/],
      [{ transl_except: '(pos:4..6,aa:Sec)' }, /Unsupported \/transl_except/],
      [{ ribosomal_slippage: '' }, /Unsupported \/ribosomal_slippage/],
      [{ translation: 'WRONG' }, /Deposited reference translation differs/],
    ];
    for (const [qualifiers, reason] of controls) {
      const input = source('ATGAAATAA', { qualifiers });
      const result = await prepareSelectedCds(input, input.phage.genes[0]);
      assert.equal(result.cds, 'ATGAAATAA'); assert.equal(result.protein, null);
      assert.deepEqual(result.gene.qualifiers, qualifiers);
      assert.deepEqual(result.extractionReasons, []);
      assert.match(result.translationReasons.join(' '), reason);
      assert.equal(dnaOf(selectedCdsExport(result, 'cds')!.content), 'ATGAAATAA');
      assert.equal(selectedCdsExport(result, 'protein'), null);
    }
  });

  it('reports incomplete codons, unresolved bases and internal stops without manufacturing protein exports', async () => {
    for (const [dna, reason] of [['ATGAAAT', /complete terminal codons/], ['ATGNNNTAA', /unresolved bases/],
      ['ATGTAAGGG', /internal stop/]] as const) {
      const input = source(dna), result = await prepareSelectedCds(input, input.phage.genes[0]);
      assert.equal(result.cds, dna); assert.equal(result.protein, null);
      assert.match(result.translationReasons.join(' '), reason);
      assert.equal(selectedCdsExport(result, 'protein'), null);
      assert.equal(dnaOf(selectedCdsExport(result, 'cds')!.content), dna);
    }
  });

  it('never replaces an unsupported joined location with its bounding span', async () => {
    const invalid: Partial<GeneInfo>[] = [
      { qualifiers: { _location: 'join(1..3,7..9)' } },
      { qualifiers: { _segments: 'join(1..3,7..9)' } },
      { qualifiers: { _segments: [{ start: 0, end: 3, strand: '+' }, { start: 6, end: 90, strand: '+' }] } },
      { qualifiers: { _segments: [{ start: 0, end: 6, strand: '+' }, { start: 3, end: 9, strand: '+' }] } },
      { qualifiers: { _segments: [{ start: 0, end: 3, strand: '+' }, { start: 6, end: 9, strand: '-' }] } },
      { qualifiers: { codon_start: 4 } }, { type: 'tRNA' },
    ];
    for (const gene of invalid) {
      const input = source('ATGAAATAA', gene), result = await prepareSelectedCds(input, input.phage.genes[0]);
      assert.equal(result.cds, null); assert.equal(result.protein, null);
      assert(result.extractionReasons.length > 0); assert.deepEqual(result.segments, []);
      assert.equal(selectedCdsExport(result, 'cds'), null);
    }
  });

  it('exports imported private annotations, exact content and independent fingerprints', async () => {
    const imported = await importLocalGenomes({ name: 'private.gb', text:
      'LOCUS       PRIVATE 18 bp DNA circular\nACCESSION   PRIVATE\nFEATURES             Location/Qualifiers\n'
      + '     CDS             complement(join(1..6,13..18))\n                     /locus_tag="private-gene"\n'
      + '                     /transl_table=11\nORIGIN\n        1 atgaaaccccccgggttt\n//\n' });
    const genome = imported.genomes[0];
    const input: SelectedCdsSource = { owner: {}, phage: genome.phage, sequence: genome.sequence };
    const result = await prepareSelectedCds(input, input.phage.genes[0]);
    assert.equal(result.source.kind, 'local'); assert.equal(result.source.localContentId, genome.phage.localGenome!.contentId);
    assert.equal(result.source.genomeSha256, digest('ATGAAACCCCCCGGGTTT'));
    assert.equal(result.cdsSha256, digest('AAACCCTTTCAT')); assert.equal(result.proteinSha256, digest('KPFH'));
    const fasta = selectedCdsExport(result, 'cds')!;
    assert.match(fasta.filename, /^PRIVATE-private-gene-[a-f0-9]{12}\.fna$/);
    assert.match(fasta.content, /source=local/); assert.match(fasta.content, /transl_table=11/);
    assert(fasta.content.includes(result.source.genomeSha256));
    const record = JSON.parse(selectedCdsExport(result, 'json')!.content);
    assert.equal(record.gene.qualifiers._location, 'complement(join(1..6,13..18))');
    assert.equal(record.cds, dnaOf(fasta.content)); assert.equal(record.protein, 'KPFH');
    assert.deepEqual(record.segments, [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }]);
    assert.equal(record.resultId, result.resultId);
    input.phage.localGenome!.sequenceSha256 = '0'.repeat(64);
    await assert.rejects(prepareSelectedCds(input, input.phage.genes[0]), /fingerprint/);
  });

  it('binds labels and annotations before hashing; labels cannot inject FASTA records', async () => {
    const input = source('ATGAAATAA', { locusTag: 'private\n>injected', qualifiers: { transl_table: 11 } });
    const pending = prepareSelectedCds(input, input.phage.genes[0]);
    input.phage.accession = 'REPLACED'; input.phage.genes[0].locusTag = 'other';
    input.phage.genes[0].qualifiers!.transl_table = 4;
    const result = await pending, payload = selectedCdsExport(result, 'cds')!;
    assert.equal(result.source.accession, 'SAME'); assert.equal(result.gene.locusTag, 'private\n>injected');
    assert.equal(result.gene.qualifiers!.transl_table, 11);
    assert.equal(payload.content.split('\n').filter(line => line.startsWith('>')).length, 1);
    assert.match(payload.content, /private%0A%3Einjected/);
    assert.equal(dnaOf(payload.content), 'ATGAAATAA');
  });

  it('gives different exact genome/annotation inputs different export identities, even with identical visible IDs', async () => {
    const a = source(), b = source('ATGGGGTAA'), c = source('ATGAAATAA', { qualifiers: { transl_table: 11 } });
    const ra = await prepareSelectedCds(a, a.phage.genes[0]);
    const ra2 = await prepareSelectedCds(a, a.phage.genes[0]);
    const rb = await prepareSelectedCds(b, b.phage.genes[0]);
    const rc = await prepareSelectedCds(c, c.phage.genes[0]);
    assert.equal(ra.resultId, ra2.resultId); assert.notEqual(ra.resultId, rb.resultId); assert.notEqual(ra.resultId, rc.resultId);
    assert.notEqual(selectedCdsExport(ra, 'cds')!.filename, selectedCdsExport(rb, 'cds')!.filename);
    assert.notEqual(selectedCdsExport(ra, 'cds')!.filename, selectedCdsExport(rc, 'cds')!.filename);
  });
});

describe('selected CDS source ownership', () => {
  it('retires late same-ID source work and exports only the current accepted genome', async () => {
    const a = source(), b = source('ATGGGGTAA'), gate = deferred<void>();
    const session = new SelectedCdsSession(async (input, gene) => {
      const result = prepareSelectedCds(input, gene);
      if (input === a) await gate.promise;
      return result;
    });
    const old = session.select(a, a.phage.genes[0]);
    const current = session.select(b, b.phage.genes[0]);
    assert.equal(await old, false); assert.equal(await current, true);
    assert.equal(session.export('cds', a, a.phage.genes[0]), null);
    assert.equal(dnaOf(session.export('cds', b, b.phage.genes[0])!.content), 'ATGGGGTAA');
    const accepted = session.getSnapshot().result;
    gate.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(session.getSnapshot().result, accepted);
  });

  it('retires replaced annotations with the same gene ID without losing current output to a late failure', async () => {
    const input = source('ATGAAATAA'), first = input.phage.genes[0], gate = deferred<void>();
    const session = new SelectedCdsSession(async (selectedSource, gene) => {
      if (gene === first) { await gate.promise; throw new Error('Old gene failed'); }
      return prepareSelectedCds(selectedSource, gene);
    });
    const old = session.select(input, first);
    const replacement = { ...first, name: 'New gene', startPos: 3 };
    input.phage.genes = [replacement];
    assert.equal(await session.select(input, replacement), true); assert.equal(await old, false);
    assert.equal(session.export('cds', input, first), null);
    assert.equal(dnaOf(session.export('cds', input, replacement)!.content), 'AAATAA');
    gate.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(session.getSnapshot().result!.gene.name, 'New gene'); assert.equal(session.getSnapshot().error, null);
  });

  it('clears already accepted exports immediately while replacing work, and settles cancelled stalled work', async () => {
    const a = source(), b = source('ATGGGGTAA');
    const session = new SelectedCdsSession((input, gene) => input === b ? new Promise(() => {}) : prepareSelectedCds(input, gene));
    await session.select(a, a.phage.genes[0]);
    const stalled = session.select(b, b.phage.genes[0]);
    assert.equal(session.getSnapshot().result, null); assert.equal(session.export('json', a, a.phage.genes[0]), null);
    session.clear(); assert.equal(await stalled, false);
    assert.equal(session.getSnapshot().loading, false); assert.equal(session.getSnapshot().result, null);
  });

  it('reports preparation failures and supports retry without retaining a stale result', async () => {
    const input = source(); let fails = true;
    const session = new SelectedCdsSession((selectedSource, gene) => {
      if (fails) throw new Error('Digest unavailable');
      return prepareSelectedCds(selectedSource, gene);
    });
    assert.equal(await session.select(input, input.phage.genes[0]), false);
    assert.equal(session.getSnapshot().error, 'Digest unavailable'); assert.equal(session.getSnapshot().loading, false);
    fails = false; assert.equal(await session.select(input, input.phage.genes[0]), true);
    assert.equal(session.getSnapshot().error, null);
    await assert.rejects(prepareSelectedCds(input, { ...input.phage.genes[0] }), /does not belong/);
  });
});
