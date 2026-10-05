import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnnotatedAlignmentPangenome, buildAlignmentPangenome, createAlignmentPangenomeRecord,
  parsePangenomeInput, replayAlignmentPangenome, exportPangenomeOriginalFasta } from './alignment-pangenome';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';

export function cdsSource(sequence: string, location = `1..${sequence.length}`, topology = 'linear') {
  return { name: 'ref.gb', text: `LOCUS       REF ${sequence.length} bp DNA ${topology}\nACCESSION   REF\nFEATURES             Location/Qualifiers\n     CDS             ${location}\n                     /locus_tag="coding"\n                     /transl_table=11\nORIGIN\n        1 ${sequence}\n//\n` };
}
function randomDna(n: number): string {
  let seed = 137;
  return Array.from({ length: n }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return 'ACGT'[(seed >>> 0) % 4]; }).join('');
}
const rc = (s: string) => [...s].reverse().map(c => ({ A: 'T', C: 'G', G: 'C', T: 'A' })[c]).join('');

describe('complete annotated pangenome producer and replay', () => {
  it('aligns original genomes, reconstructs coding changes and binds all inputs in one experiment', async () => {
    const reference = 'ATGAAAGCTTAA', query = 'ATGAAGGCCTAA';
    const input = parsePangenomeInput(`>r\n${reference}\n>q\n${query}`, 'Annotated pair');
    const result = await createAnnotatedAlignmentPangenome(input, { referenceId: 'r', alignment: 'wavefront' }, cdsSource(reference));
    assert.equal(result.record.method.version, '5');
    assert.equal(result.graph.variants.length, 2);
    assert.equal(result.cds.genes[0].protein, 'MKA*');
    assert.deepEqual(result.cds.consequences[0].effects, ['synonymous']);
    assert.equal(result.record.inputs.length, 2);
    assert.equal(result.record.fields.codingConsequences.kind, 'sequence-score');
    assert(!result.record.fields.codingConsequences.limitations.some(s => s.includes('does not rerun')));
    assert.deepEqual(await replayAlignmentPangenome(serializeAnalysisRecord(result.record)), result);
  });
  it('normalizes a reverse-rotated 100kb input, applies the reference annotation, and retains original exports', async () => {
    const reference = randomDna(100000);
    const codingReference = reference.slice(0, 45000) + 'ATGAAAGCTTAA' + reference.slice(45012);
    const query = codingReference.slice(0, 45003) + 'GAG' + codingReference.slice(45006);
    const originalQuery = rc(query.slice(127) + query.slice(0, 127));
    const input = parsePangenomeInput(`>r\n${codingReference}\n>q\n${originalQuery}`);
    const result = await createAnnotatedAlignmentPangenome(input, { referenceId: 'r', alignment: 'wavefront', normalization: 'circular', terminalGaps: 'alleles' }, cdsSource(codingReference, '45001..45012', 'circular'));
    assert.equal(result.cds.consequences[0].queryCds, 'ATGGAGGCTTAA');
    assert.equal(result.cds.consequences[0].queryProtein, 'MEA*');
    assert.deepEqual(result.cds.consequences[0].effects, ['amino-acid-change']);
    assert.equal(result.graph.diagnostics.normalization!.sequences.find(s => s.sequenceId === 'q')!.transform.strand, '-');
    const fasta = exportPangenomeOriginalFasta(result.graph).split(/\n(?=>)/);
    const restored = new Map(fasta.map(record => [record.split('\n')[0].slice(1), record.split('\n').slice(1).join('')]));
    assert.equal(restored.get('q'), originalQuery);
    assert.equal(restored.get('r'), codingReference);
    const replay = await replayAlignmentPangenome(serializeAnalysisRecord(result.record));
    assert.deepEqual(replay.cds, result.cds);
    assert.equal(replay.record.resultId, result.record.resultId);
  });
  it('rejects forged consequences, missing annotations and changed method/reference descriptions after valid rehashing', async () => {
    const ref = 'ATGAAATAA', input = parsePangenomeInput(`>r\n${ref}\n>q\nATGAAGTAA`);
    const result = await createAnnotatedAlignmentPangenome(input, { referenceId: 'r' }, cdsSource(ref));
    for (const change of ['consequence', 'method', 'reference', 'selector']) {
      const modified = structuredClone(result.record);
      if (change === 'consequence') (modified.fields.codingConsequences.value as Array<Record<string, unknown>>)[0].effects = ['frameshift'];
      if (change === 'method') modified.method.implementation = 'different method';
      if (change === 'reference') modified.references[0].version = 'different version';
      if (change === 'selector') modified.parameters.geneIds = [2];
      const forged = await createAnalysisRecord(modified);
      await assert.rejects(replayAlignmentPangenome(serializeAnalysisRecord(forged)));
    }
    await assert.rejects(createAnnotatedAlignmentPangenome(input, { referenceId: 'r' }, cdsSource('ATGAAGTAA')), /exactly match/);
  });
  it('preserves previous graph identities and unannotated replay when no annotations are requested', async () => {
    const input = parsePangenomeInput('>r\nACGT\n>q\nACGA');
    for (const alignment of ['provided', 'global', 'wavefront'] as const) {
      const graph = buildAlignmentPangenome(input, { referenceId: 'r', alignment });
      const record = await createAlignmentPangenomeRecord(input, graph);
      assert.equal(record.method.version, alignment === 'wavefront' ? '3' : '2');
      const replay = await replayAlignmentPangenome(serializeAnalysisRecord(record));
      assert.equal(replay.cds, undefined); assert.deepEqual(replay.graph, graph); assert.deepEqual(replay.record, record);
    }
  });
});
