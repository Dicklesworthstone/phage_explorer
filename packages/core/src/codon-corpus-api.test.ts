/** Exercise the real public barrel consumed by the browser, not a mocked export list. */
import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { createCodonReferenceCorpus, exportCodonCorpusReference, parseCodonReference,
  scoreCodonReferenceSequence } from './index';

it('feeds generated counts into the public CAI consumer', async () => {
  const corpus = await createCodonReferenceCorpus({ name: 'reference.gb', text: `LOCUS       R 18 bp DNA linear
ACCESSION   R
FEATURES             Location/Qualifiers
     CDS             1..18
                     /transl_table=11
ORIGIN
        1 atgaaaaaaaaaaagtaa
//
` }, {
    name: 'Count control', organism: 'Synthetic', citation: 'Hand-counted fixture', version: '1', geneticCode: 11,
  });
  const reference = parseCodonReference(exportCodonCorpusReference(corpus));
  assert.equal(reference.counts.AAA, 3);
  assert.equal(reference.counts.AAG, 1);
  assert(Math.abs(scoreCodonReferenceSequence('ATGAAAAAGTAA', reference, 0).cai! - Math.sqrt(1 / 3)) < 1e-12);
});
