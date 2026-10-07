import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createCodonReferenceCorpus, exportCodonCorpusReference, type CodonCorpusOptions } from './codon-reference-corpus';
import { createReferenceCodonExperiment, replayReferenceCodonExperiment, resolveCodonReferenceInput, referenceGenomeFromPhage } from './codon-reference';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { importLocalGenomes } from '../genome-import';

const metadata: CodonCorpusOptions = { name: 'Source-bound counts', organism: 'Synthetic fixture', geneticCode: 1,
  citation: 'Hand-counted CDS; no expression claim', version: 'test-1' };
const gb = (id: string, sequence: string) => ({ name: `${id}.gb`, text:
  `LOCUS       ${id} ${sequence.length} bp DNA linear\nACCESSION   ${id}\nFEATURES             Location/Qualifiers\n     CDS             1..${sequence.length}\nORIGIN\n        1 ${sequence}\n//\n` });
async function query() { return (await importLocalGenomes(gb('QUERY', 'ATGAAAAAGTAA'))).genomes[0]; }
async function corpus() { return createCodonReferenceCorpus(gb('SOURCE', 'ATGAAAAAAAAAAAGTAA'), metadata); }

describe('source-recomputed reference CAI', () => {
  it('recounts source, embeds the original corpus and freshly reproduces the hand-derived CAI', async () => {
    const source = await corpus(), q = await query(), referenceText = serializeAnalysisRecord(source.record);
    assert.equal(source.reference.counts.AAA, 3); assert.equal(source.reference.counts.AAG, 1);
    const scored = await createReferenceCodonExperiment(referenceGenomeFromPhage(q.phage), q.sequence, referenceText);
    assert.equal(scored.record.method.version, '2');
    // Query contains one AAA and one AAG: geometric mean of 1 and 1/3.
    assert(Math.abs(scored.analysis.summary.cai! - Math.sqrt(1 / 3)) < 1e-12);
    assert.equal(scored.record.inputs.find(i => i.id === 'reference')!.data, referenceText);
    assert(scored.record.references.some(r => r.id === 'genbank-codon-reference' && r.version === source.record.resultId));
    assert.deepEqual((await replayReferenceCodonExperiment(serializeAnalysisRecord(scored.record))).record, scored.record);
    assert.deepEqual((await resolveCodonReferenceInput(referenceText)).corpus, source);
  });
  it('rejects a rehashed fake corpus rather than admitting its displayed counts into a query score', async () => {
    const source = await corpus(), q = await query();
    const { format: _f, version: _v, resultId: _r, cacheKey: _k, ...values } = structuredClone(source.record);
    (values.fields.reference.value as { counts: Record<string, number> }).counts.AAG = 3;
    const forged = serializeAnalysisRecord(await createAnalysisRecord(values));
    await assert.rejects(createReferenceCodonExperiment(referenceGenomeFromPhage(q.phage), q.sequence, forged), /Recomputed corpus/);
    await assert.rejects(resolveCodonReferenceInput(forged), /Recomputed corpus/);
  });
  it('rejects rehashed query results when embedded source selection or numerical outputs change', async () => {
    const source = await corpus(), q = await query();
    const scored = await createReferenceCodonExperiment(referenceGenomeFromPhage(q.phage), q.sequence, serializeAnalysisRecord(source.record));
    for (const mutation of ['score', 'source', 'method']) {
      const { format: _f, version: _v, resultId: _r, cacheKey: _k, ...values } = structuredClone(scored.record);
      if (mutation === 'score') values.fields.pooledCai.value = 1;
      if (mutation === 'source') {
        const { format: _cf, version: _cv, resultId: _cr, cacheKey: _ck, ...original } = structuredClone(source.record);
        original.parameters.geneIds = [999];
        values.inputs.find(i => i.id === 'reference')!.data = serializeAnalysisRecord(await createAnalysisRecord(original));
      }
      if (mutation === 'method') values.method.version = '1';
      const forged = serializeAnalysisRecord(await createAnalysisRecord(values));
      await assert.rejects(replayReferenceCodonExperiment(forged), /Recomputed|missing/);
    }
  });
  it('keeps count-only input as its existing method and treats exported derivation IDs as attribution, not source replay', async () => {
    const source = await corpus(), q = await query(), text = exportCodonCorpusReference(source);
    const resolved = await resolveCodonReferenceInput(text);
    assert.equal(resolved.corpus, undefined);
    assert(resolved.reference.source.version.endsWith(source.record.resultId));
    const scored = await createReferenceCodonExperiment(referenceGenomeFromPhage(q.phage), q.sequence, text);
    assert.equal(scored.record.method.version, '1');
    assert(Math.abs(scored.analysis.summary.cai! - Math.sqrt(1 / 3)) < 1e-12);
    assert.deepEqual((await replayReferenceCodonExperiment(serializeAnalysisRecord(scored.record))).record, scored.record);
  });
  it('snapshots query annotations and parameters before asynchronous source verification', async () => {
    const source = await corpus(), q = await query(), genome = referenceGenomeFromPhage(q.phage), options = { geneIds: [1] };
    const pending = createReferenceCodonExperiment(genome, q.sequence, serializeAnalysisRecord(source.record), options);
    genome.genes[0].qualifiers = { pseudo: '' }; options.geneIds.push(999);
    const scored = await pending;
    assert(Math.abs(scored.analysis.summary.cai! - Math.sqrt(1 / 3)) < 1e-12);
    assert.deepEqual(scored.record.parameters.geneIds, [1]);
  });
});
