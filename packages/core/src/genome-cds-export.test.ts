import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createGenomeCdsExperiment, replayGenomeCdsExperiment, exportGenomeCdsFasta, exportGenomeCdsTable,
  GENOME_CDS_LIMITS, type GenomeCdsOptions, type GenomeCdsResult,
} from './genome-cds-export';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from './analysis-result';
import { exportCatalogGenomeSnapshot, importLocalGenomes } from './genome-import';

function genbank(sequence: string, features: Array<{ location: string; qualifiers?: string }>, accession = 'PRIVATE') {
  return { name: 'private.gb', text: `LOCUS       ${accession} ${sequence.length} bp DNA circular\nACCESSION   ${accession}\nFEATURES             Location/Qualifiers\n`
    + features.map(feature => `     CDS             ${feature.location}\n                     /locus_tag="duplicate"\n${feature.qualifiers ?? ''}`).join('')
    + `ORIGIN\n        1 ${sequence.toLowerCase()}\n//\n` };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function readFasta(content: string) {
  return content.trim().split(/^>/m).slice(1).map(part => {
    const [header, ...sequence] = part.split('\n');
    return { id: header.split(' ')[0], header, sequence: sequence.join('') };
  });
}

describe('whole-genome annotated CDS and proteome export', () => {
  it('exports forward, reverse and joined transcripts with independent sequences and unique FASTA identities', async () => {
    // Two copies of ATGAAATAA: one split over a two-base intron, the other on minus strand.
    const source = genbank('ATGAAACCTAA' + 'TTATTTCAT', [
      { location: 'join(1..6,9..11)' }, { location: 'complement(12..20)' },
    ]);
    const experiment = await createGenomeCdsExperiment(source);
    assert.deepEqual(experiment.result.rows.map(row => row.cds), ['ATGAAATAA', 'ATGAAATAA']);
    assert.deepEqual(experiment.result.rows.map(row => row.protein), ['MK*', 'MK*']);
    assert.equal(experiment.result.source.sequenceSha256, hash('ATGAAACCTAATTATTTCAT'));
    assert.deepEqual(experiment.result.rows[0].segments, [{ start: 0, end: 6, strand: '+' }, { start: 8, end: 11, strand: '+' }]);
    assert.deepEqual(experiment.result.rows[1].segments, [{ start: 11, end: 20, strand: '-' }]);
    for (const row of experiment.result.rows) {
      assert.equal(row.cdsSha256, hash('ATGAAATAA'));
      assert.equal(row.proteinSha256, hash('MK*'));
      assert.deepEqual(row.extractionReasons, []); assert.deepEqual(row.translationReasons, []);
    }
    const dna = readFasta(exportGenomeCdsFasta(experiment, 'cds'));
    const proteins = readFasta(exportGenomeCdsFasta(experiment, 'protein'));
    assert.deepEqual(dna.map(row => row.sequence), ['ATGAAATAA', 'ATGAAATAA']);
    assert.deepEqual(proteins.map(row => row.sequence), ['MK*', 'MK*']);
    assert.equal(new Set(proteins.map(row => row.id)).size, 2);
    assert.match(dna[0].header, /exported=2 omitted=0/);
    assert.ok(dna[0].header.includes(`result_id=${experiment.record.resultId}`));
    assert.deepEqual(experiment.record.inputs[0].data, source);
    assert.deepEqual(await replayGenomeCdsExperiment(serializeAnalysisRecord(experiment.record)), experiment);
  });

  it('applies codon_start once across joins and uses explicit initiators and recoded genetic tables', async () => {
    const partial = await createGenomeCdsExperiment(genbank('ACCATGAAATAA', [
      { location: 'join(1..1,4..12)', qualifiers: '                     /codon_start=2\n' },
    ]));
    assert.equal(partial.result.rows[0].cds, 'ATGAAATAA');
    assert.equal(partial.result.rows[0].protein, 'MK*');
    assert.deepEqual(partial.result.rows[0].segments, [{ start: 3, end: 12, strand: '+' }]);
    for (const [table, sequence, protein] of [[11, 'GTGGTGTAA', 'MV*'], [4, 'TTATGATAA', 'MW*'],
      [15, 'ATGTAGTAA', 'MQ*'], [25, 'GTGTGATAA', 'MG*']] as const) {
      const result = await createGenomeCdsExperiment(genbank(sequence, [{ location: '1..9', qualifiers: `                     /transl_table=${table}\n` }]));
      assert.equal(result.result.rows[0].protein, protein);
      assert.equal(result.result.rows[0].geneticCode, table);
    }
  });

  it('keeps every selected mapped row and exact omitted-annotation evidence without fabricating proteins', async () => {
    const source = genbank('ATGAAATAA', [
      { location: '1..9' },
      { location: '1..9', qualifiers: '                     /transl_table=2\n' },
      { location: '1..9', qualifiers: '                     /pseudo\n' },
      { location: '1..9', qualifiers: '                     /transl_except="(pos:4..6,aa:Sec)"\n' },
      { location: '1..9', qualifiers: '                     /translation="WRONG"\n' },
      { location: '1..8' },
      { location: '1..9', qualifiers: '                     /codon_start=4\n' },
      { location: 'REMOTE.1:1..9' },
    ]);
    const experiment = await createGenomeCdsExperiment(source);
    assert.deepEqual(experiment.result.summary, {
      mappedCds: 7, selectedCds: 7, cdsAvailable: 6, proteinsAvailable: 1, cdsUnavailable: 1, proteinsUnavailable: 6,
    });
    assert.equal(experiment.result.rows[1].cds, 'ATGAAATAA');
    assert.match(experiment.result.rows[1].translationReasons.join(' '), /translation table/);
    assert.match(experiment.result.rows[2].translationReasons.join(' '), /pseudo/);
    assert.match(experiment.result.rows[3].translationReasons.join(' '), /transl_except/);
    assert.match(experiment.result.rows[4].translationReasons.join(' '), /translation differs/);
    assert.equal(experiment.result.rows[5].cds, 'ATGAAATA');
    assert.match(experiment.result.rows[5].translationReasons.join(' '), /terminal codons/);
    assert.equal(experiment.result.rows[6].cds, null);
    assert.match(experiment.result.rows[6].extractionReasons.join(' '), /codon_start/);
    assert.ok(experiment.result.rows.slice(1).every(row => row.protein === null && row.translationReasons.length));
    assert.match(experiment.result.importWarnings.join(' '), /REMOTE\.1:1\.\.9/);
    assert.deepEqual(experiment.input, source);
    const fasta = readFasta(exportGenomeCdsFasta(experiment, 'protein'));
    assert.equal(fasta.length, 1); assert.match(fasta[0].header, /exported=1 omitted=6/);
    const table = exportGenomeCdsTable(experiment);
    assert.match(table, /# import_warning=.*REMOTE/);
    assert.equal(table.trim().split('\n').filter(line => !line.startsWith('#')).length, 8);
    assert.deepEqual(await replayGenomeCdsExperiment(serializeAnalysisRecord(experiment.record)), experiment);
  });

  it('retains ambiguous DNA, internal-stop reasons and unannotated FASTA as honest unavailable reports', async () => {
    for (const [sequence, reason] of [['ATGNNNTAA', /unresolved/], ['ATGTAATAA', /internal stop/]] as const) {
      const result = await createGenomeCdsExperiment(genbank(sequence, [{ location: '1..9' }]));
      assert.equal(result.result.rows[0].cds, sequence);
      assert.equal(result.result.rows[0].protein, null);
      assert.match(result.result.rows[0].translationReasons.join(' '), reason);
      assert.throws(() => exportGenomeCdsFasta(result, 'protein'), /No supported protein/);
    }
    const unannotated = await createGenomeCdsExperiment({ name: 'dna.fa', text: '>dna\nATGAAATAA\n' });
    assert.equal(unannotated.result.summary.mappedCds, 0);
    assert.deepEqual(unannotated.result.rows, []);
    assert.throws(() => exportGenomeCdsFasta(unannotated, 'cds'), /No supported CDS DNA/);
    assert.deepEqual(await replayGenomeCdsExperiment(serializeAnalysisRecord(unannotated.record)), unannotated);
  });

  it('neutralizes formula-like TSV labels after spreadsheet unquoting while retaining exact source labels', async () => {
    const source = genbank('ATGAAATAA', [{ location: '1..9',
      qualifiers: '                     /gene="=SUM(1)"\n                     /product="  +1\t@label"\n',
    }]);
    source.text = source.text.replace('/locus_tag="duplicate"', '/locus_tag="@label"');
    const experiment = await createGenomeCdsExperiment(source);
    const lines = exportGenomeCdsTable(experiment).trim().split('\n').filter(line => !line.startsWith('#'));
    const values = lines[1].split('\t').map(value => value ? JSON.parse(value) : null);
    assert.equal(values[2], "'@label");
    assert.equal(values[3], "'=SUM(1)");
    assert.equal(values[4], "'  +1\t@label");
    assert.equal(lines.length, 2);
    assert.equal(experiment.result.rows[0].name, '=SUM(1)');
    assert.equal(experiment.result.rows[0].product, '  +1\t@label');
    assert.deepEqual(experiment.record.inputs[0].data, source);
    assert.equal((await replayGenomeCdsExperiment(serializeAnalysisRecord(experiment.record))).result.rows[0].name, '=SUM(1)');
  });

  it('requires exact record disambiguation, validates IDs and captures inputs before asynchronous work', async () => {
    const source = genbank('ATGAAATAA', [{ location: '1..9' }, { location: '1..9' }]);
    const multi = { ...source, text: source.text + source.text.replace('atgaaa', 'atgccc') };
    const genomes = (await importLocalGenomes(multi)).genomes;
    await assert.rejects(createGenomeCdsExperiment(multi), /exactly one/);
    await assert.rejects(createGenomeCdsExperiment(multi, { record: 'PRIVATE' }), /exactly one/);
    const exact = genomes[1].phage.localGenome!.contentId;
    const options = { record: exact, geneIds: [2, 1] };
    const pending = createGenomeCdsExperiment(multi, options);
    options.geneIds[0] = 999; options.record = 'changed'; multi.text = '>changed\nAAAA';
    const experiment = await pending;
    assert.equal(experiment.result.source.contentId, exact);
    assert.deepEqual(experiment.options.geneIds, [1, 2]);
    assert.equal(experiment.result.rows[0].cds, 'ATGCCCTAA');
    for (const geneIds of [[], [1, 1], [-1], [0], [1.5], [999]]) {
      await assert.rejects(createGenomeCdsExperiment(source, { geneIds }));
    }
    await assert.rejects(createGenomeCdsExperiment(source, { unknown: true } as GenomeCdsOptions), /selection fields/);
  });

  it('exports a captured catalog genome with original numeric CDS IDs and source provenance', async () => {
    const parsed = (await importLocalGenomes(genbank('ATGAAATAA', [{ location: '1..9' }]))).genomes[0];
    const { localGenome: _local, ...phage } = parsed.phage;
    phage.id = 17; phage.slug = 'catalog-fixture'; phage.genes[0].id = 92;
    const source = await exportCatalogGenomeSnapshot(phage, parsed.sequence, { contentVersion: 'a'.repeat(64) });
    const experiment = await createGenomeCdsExperiment(source);
    assert.equal(experiment.result.rows[0].geneId, 92);
    assert.equal(experiment.result.rows[0].protein, 'MK*');
    assert.equal(experiment.result.source.format, 'catalog-snapshot');
    assert.equal(JSON.parse(experiment.input.text).provenance.contentVersion, 'a'.repeat(64));
    assert.deepEqual(await replayGenomeCdsExperiment(serializeAnalysisRecord(experiment.record)), experiment);
  });

  it('recomputes saved sequences and rejects forged results even with otherwise-valid regenerated checksums', async () => {
    const experiment = await createGenomeCdsExperiment(genbank('ATGAAATAA', [{ location: '1..9' }]));
    for (const change of [
      (record: typeof experiment.record) => { (record.fields.cds.value as unknown as GenomeCdsResult).rows[0].protein = 'MADEUP'; },
      (record: typeof experiment.record) => { (record.fields.cds.value as unknown as GenomeCdsResult).rows[0].translationReasons = ['Invented omission']; },
      (record: typeof experiment.record) => { record.inputs[0].accession = 'RELABELLED'; },
      (record: typeof experiment.record) => { record.parameters.record = '0'.repeat(64); },
      (record: typeof experiment.record) => { record.method.implementation = 'different'; },
    ]) {
      const clone = structuredClone(experiment.record); change(clone);
      const { format: _format, version: _version, cacheKey: _cache, resultId: _result, ...options } = clone;
      const forged = await createAnalysisRecord(options);
      const content = serializeAnalysisRecord(forged);
      await parseAnalysisRecord(content); // Envelope checksums alone are deliberately insufficient.
      await assert.rejects(replayGenomeCdsExperiment(content));
    }
  });

  it('bounds source bytes, row counts, extracted work and export expansion; cancellation publishes no partial experiment', async () => {
    await assert.rejects(createGenomeCdsExperiment({ name: 'huge', text: ' '.repeat(GENOME_CDS_LIMITS.inputBytes + 1) }), /10 MiB/);
    const many = genbank('ATGAAATAA', Array.from({ length: GENOME_CDS_LIMITS.rows + 1 }, () => ({ location: '1..9' })));
    await assert.rejects(createGenomeCdsExperiment(many), /12,000 rows/);
    const repeated = genbank('ATG'.repeat(300000), Array.from({ length: 9 }, () => ({ location: '1..900000' })));
    await assert.rejects(createGenomeCdsExperiment(repeated), /8,000,000 extracted/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createGenomeCdsExperiment(genbank('ATG', [{ location: '1..3' }]), {}, controller.signal), { name: 'AbortError' });
    const active = new AbortController();
    const pending = createGenomeCdsExperiment(genbank('ATGAAATAA', Array.from({ length: 80 }, () => ({ location: '1..9' }))), {}, active.signal);
    setTimeout(() => active.abort(), 0);
    await assert.rejects(pending, { name: 'AbortError' });
    const result = await createGenomeCdsExperiment(genbank('ATG', [{ location: '1..3' }]));
    result.result.source.accession = 'α'.repeat(GENOME_CDS_LIMITS.outputBytes / 2);
    assert.throws(() => exportGenomeCdsFasta(result, 'cds'), /10 MiB/);
  });
});
