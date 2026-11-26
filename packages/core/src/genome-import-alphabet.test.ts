import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { importLocalGenomes } from './genome-import';

describe('genome import preserves DNA source symbols before normalization', () => {
  it('rejects non-ASCII case-expanding or ambiguity-lookalike characters in FASTA and saved inputs', async () => {
    for (const sequence of ['ACßGT', 'ACſGT', 'ACKGT']) {
      const input = { name: 'invalid.fa', text: '>PRIVATE\n' + sequence + '\n' };
      await assert.rejects(importLocalGenomes(input), /expected IUPAC DNA/);
      const bundle = { name: 'saved.json', text: JSON.stringify({
        format: 'phage-explorer-local-genomes', version: 1, inputs: [input],
      }) };
      await assert.rejects(importLocalGenomes(bundle), /expected IUPAC DNA/);
    }
  });

  it('accepts ordinary lower-case ASCII IUPAC DNA without changing base count or original source', async () => {
    const input = { name: 'lowercase.fa', text: '>PRIVATE\n acgt \nrysw km bdhvn\n' };
    const expected = 'ACGTRYSWKMBDHVN';
    const imported = (await importLocalGenomes(input)).genomes[0];
    assert.equal(imported.sequence, expected);
    assert.equal(imported.phage.genomeLength, expected.length);
    assert.equal(imported.phage.localGenome!.sequenceSha256, createHash('sha256').update(expected).digest('hex'));
    assert.deepEqual(imported.original, input);
  });
});

