import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';
import {
  executeCdsConsequencesJob, parseCdsConsequencesCommand,
} from './cds-consequences';

const genbank = (sequence: string) => ({ name: 'reference.gb', text:
`LOCUS       REF ${sequence.length} bp DNA linear
ACCESSION   REF
FEATURES             Location/Qualifiers
     CDS             1..${sequence.length}
                     /locus_tag="gene1"
ORIGIN
        1 ${sequence.toLowerCase()}
//
` });
const alignment = JSON.stringify({
  name: 'CDS fixture', source: 'local',
  sequences: [
    { id: 'ref', description: 'reference', sequence: 'ATGTCTTAA' },
    { id: 'query', description: 'two-base synonymous haplotype', sequence: 'ATGAGTTAA' },
  ],
});

describe('cds-consequences command contracts', () => {
  it('parses explicit analysis settings and protects replay identity', () => {
    assert.deepEqual(parseCdsConsequencesCommand(['analyze', 'alignment.json', '--genbank', 'reference.gb',
      '--reference', 'ref', '--terminal-gaps', 'missing', '--genes', '1,2', '--format', 'table', '--output', '-']), {
      operation: 'analyze', input: 'alignment.json', output: undefined, demo: false, genbank: 'reference.gb',
      referenceId: 'ref', terminalGaps: 'missing', annotationRecord: undefined, geneIds: [1, 2], format: 'table',
    });
    assert.throws(() => parseCdsConsequencesCommand(['replay', 'saved.json', '--reference', 'ref']), /cannot override/i);
    assert.throws(() => parseCdsConsequencesCommand(['analyze', '-', '--genbank', '-', '--reference', 'ref', '--terminal-gaps', 'missing']), /Only one/);
  });

  it('evaluates the complete haplotype and verified replay preserves exact evidence identity', async () => {
    const first = await executeCdsConsequencesJob({
      operation: 'analyze', input: { name: 'alignment.json', text: alignment }, annotation: genbank('ATGTCTTAA'),
      options: { referenceId: 'ref', terminalGaps: 'missing' }, format: 'json',
    });
    const record = await parseAnalysisRecord(first.output);
    assert.equal(record.method.id, 'aligned-cds-consequences');
    const rows = record.fields.consequences.value as any[];
    assert.deepEqual(rows[0].effects, ['synonymous']);
    assert.equal(rows[0].changedColumns, 2);
    const replay = await executeCdsConsequencesJob({
      operation: 'replay', input: { name: 'saved.json', text: first.output.trim() }, format: 'json',
    });
    assert.equal(replay.verified, true);
    assert.equal((await parseAnalysisRecord(replay.output)).resultId, record.resultId);
  });

  it('exports complete table and projected CDS/protein FASTA from the same experiment', async () => {
    const base = { operation: 'analyze' as const, input: { name: 'alignment.json', text: alignment },
      annotation: genbank('ATGTCTTAA'), options: { referenceId: 'ref', terminalGaps: 'missing' as const } };
    const table = await executeCdsConsequencesJob({ ...base, format: 'table' });
    assert.match(table.output, /gene_id\tgene_name/);
    assert.match(table.output, /synonymous/);
    const cds = await executeCdsConsequencesJob({ ...base, format: 'cds-fasta' });
    const protein = await executeCdsConsequencesJob({ ...base, format: 'protein-fasta' });
    assert.match(cds.output, />reference_g1 molecule=cds/);
    assert.match(protein.output, />reference_g1 molecule=protein/);
    assert.match(protein.output, /MS\*/);
  });

  it('carries declared phage genetic codes through terminal analysis, replay and protein export', async () => {
    const annotation = genbank('ATGTAGTAA');
    annotation.text = annotation.text.replace('/locus_tag="gene1"', '/locus_tag="gene1"\n                     /transl_table=15\n                     /translation="MQ"');
    const input = { name: 'recoded.json', text: JSON.stringify({ name: 'recoded haplotype', source: 'local', sequences: [
      { id: 'ref', description: '', sequence: 'ATGTAGTAA' }, { id: 'query', description: '', sequence: 'ATGCAATAA' },
    ] }) };
    const first = await executeCdsConsequencesJob({ operation: 'analyze', input, annotation,
      options: { referenceId: 'ref', terminalGaps: 'missing' }, format: 'json' });
    const record = await parseAnalysisRecord(first.output);
    assert.equal(record.method.version, '2');
    const protein = await executeCdsConsequencesJob({ operation: 'replay', input: { name: 'saved.json', text: first.output }, format: 'protein-fasta' });
    assert.equal(protein.verified, true);
    assert.equal(protein.identity, record.resultId);
    assert.equal(protein.output.split('\n').filter(line => line === 'MQ*').length, 2);
    assert.match(protein.output, /effects=synonymous/);
  });

  it('refuses a nonmatching GenBank source instead of trusting accession equality', async () => {
    await assert.rejects(executeCdsConsequencesJob({
      operation: 'analyze', input: { name: 'alignment.json', text: alignment }, annotation: genbank('ATGAAATAA'),
      options: { referenceId: 'ref', terminalGaps: 'missing' }, format: 'json',
    }), /exactly match/);
  });
});
