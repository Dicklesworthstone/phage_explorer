import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createCdsConsequenceExperiment, exportCdsConsequenceFasta, exportCdsConsequenceTable, parseCdsGeneIds } from './cds-consequences';

// Two reference CDS: direct ATG AAA TAA -> MK*, reverse complement of
// TTA TTC CAT -> ATG GAA TAA -> ME*. The first query is synonymous in CDS 1
// (AAA -> AAG) and has an amino-acid change in reverse CDS 2 (GAA -> AAA).
const reference = 'ATGAAATAATTATTCCAT';
const annotation = { name: 'genes.gb', text: `LOCUS       REF 18 bp DNA linear
ACCESSION   REF
FEATURES             Location/Qualifiers
     CDS             1..9
                     /gene="direct"
     CDS             complement(10..18)
                     /gene="reverse"
ORIGIN
        1 ${reference}
//
` };
async function fixture(source: 'local' | 'demo' = 'local') {
  return createCdsConsequenceExperiment({ name: 'export oracle', source, sequences: [
    { id: 'ref', description: '', sequence: reference },
    { id: 'good', description: '', sequence: 'ATGAAGTAATTATTTCAT' },
    { id: 'unknown', description: '', sequence: 'ATGNNNTAATTATTCCAT' },
  ] }, annotation, { referenceId: 'ref', terminalGaps: 'missing' });
}
function fasta(content: string) {
  return content.trim().split(/\n(?=>)/).map(block => {
    const [header, ...bases] = block.split('\n'); return { header, sequence: bases.join('') };
  });
}

describe('CDS consequence reports from actual GenBank projection', () => {
  it('exports exact forward/reverse transcripts and conceptual proteins, not full genome slices', async () => {
    const experiment = await fixture();
    const dna = fasta(exportCdsConsequenceFasta(experiment, 'cds'));
    assert.deepEqual(dna.map(row => row.sequence), ['ATGAAATAA', 'ATGGAATAA', 'ATGAAGTAA', 'ATGAAATAA', 'ATGGAATAA']);
    const proteins = fasta(exportCdsConsequenceFasta(experiment, 'protein'));
    assert.deepEqual(proteins.map(row => row.sequence), ['MK*', 'ME*', 'MK*', 'MK*', 'ME*']);
    assert.match(proteins[2].header, /effects=synonymous/);
    assert.match(proteins[3].header, /effects=amino-acid-change/);
    assert.equal(new Set(proteins.map(row => row.header.split(' ')[0])).size, 5);
    assert(proteins.every(row => row.header.includes(experiment.record.resultId)));
  });
  it('retains missingness and coordinate semantics in a complete fixed-column TSV report', async () => {
    const experiment = await fixture();
    const [header, ...data] = exportCdsConsequenceTable(experiment).trimEnd().split('\n').map(line => line.split('\t'));
    assert.equal(data.length, 4);
    assert(data.every(row => row.length === header.length));
    const rows = data.map(values => Object.fromEntries(header.map((key, index) => [key, values[index]])));
    assert.equal(rows[0].effects, 'synonymous');
    assert.equal(rows[0].first_protein_difference_0based, '');
    assert.equal(rows[1].status, 'unavailable');
    assert.match(rows[1].reasons, /unresolved/);
    assert.equal(rows[1].ambiguous_query_bases, '3');
    assert.equal(rows[2].reference_segments_0based_half_open, '9:18:-');
    assert.equal(rows[2].first_protein_difference_0based, '1');
  });
  it('never emits a fictitious sequence for a complete CDS deletion', async () => {
    const experiment = await createCdsConsequenceExperiment({ name: 'deletion', source: 'local', sequences: [
      { id: 'ref', description: '', sequence: reference },
      { id: 'deleted', description: '', sequence: '---------TTATTCCAT' },
    ] }, annotation, { referenceId: 'ref', terminalGaps: 'alleles' });
    assert.equal(experiment.consequences[0].effects[0], 'cds-deleted');
    assert.equal(fasta(exportCdsConsequenceFasta(experiment, 'cds')).length, 3);
    assert.match(exportCdsConsequenceTable(experiment), /cds-deleted/);
  });
  it('does not export invalid reference translations, and carries synthetic provenance', async () => {
    const experiment = await fixture('demo');
    assert(fasta(exportCdsConsequenceFasta(experiment, 'protein')).every(row => row.header.includes('source=demo')));
    const invalid = await createCdsConsequenceExperiment({ name: 'unsupported', source: 'local', sequences: [
      { id: 'ref', description: '', sequence: reference }, { id: 'q', description: '', sequence: reference },
    ] }, { ...annotation, text: annotation.text.replaceAll('/gene=', '/transl_table=4\n                     /gene=') },
    { referenceId: 'ref', terminalGaps: 'missing' });
    assert.throws(() => exportCdsConsequenceFasta(invalid, 'protein'), /No supported/);
    assert.match(exportCdsConsequenceTable(invalid), /Unsupported translation table/);
  });
  it('escapes external labels without record injection and leaves the original experiment untouched', async () => {
    const experiment = await fixture();
    experiment.genes[0].name = '=formula\tnew\n>injected\\line';
    experiment.genes[0].product = '@command';
    const before = JSON.stringify(experiment);
    const dna = exportCdsConsequenceFasta(experiment, 'cds');
    assert.equal(fasta(dna).length, 5);
    assert.match(dna, /gene=%3Dformula%09new%0A%3Einjected%5Cline/);
    const tsv = exportCdsConsequenceTable(experiment);
    assert.equal(tsv.trimEnd().split('\n').length, 5);
    assert.match(tsv, /'=formula\\u0009new\\u000a>injected\\\\line/);
    assert.match(tsv, /'@command/);
    assert.equal(JSON.stringify(experiment), before);
  });
  it('keeps export line widths bounded and rejects invalid selection syntax', async () => {
    assert.equal(parseCdsGeneIds(' '), null);
    assert.deepEqual(parseCdsGeneIds('3, 1,2'), [1, 2, 3]);
    for (const bad of ['0', '-1', '1.0', '1e2', '1,', ',1', '1,1', 'NaN', '9007199254740992']) {
      assert.throws(() => parseCdsGeneIds(bad));
    }
    const experiment = await fixture();
    experiment.genes[0].cds = 'ACG'.repeat(100);
    assert(exportCdsConsequenceFasta(experiment, 'cds').split('\n').filter(line => !line.startsWith('>')).every(line => line.length <= 80));
  });
});
