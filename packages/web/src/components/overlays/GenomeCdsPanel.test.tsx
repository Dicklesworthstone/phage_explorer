import React from 'react';
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createGenomeCdsExperiment } from '../../../../core/src/genome-cds-export';
import { GenomeCdsResults } from './GenomeCdsPanel';

function genbank(count = 2) {
  return { name: '<img src=x onerror=alert(1)>.gb', text: 'LOCUS       PRIVATE 9 bp DNA linear\nACCESSION   PRIVATE\nFEATURES             Location/Qualifiers\n'
    + Array.from({ length: count }, (_, index) => '     CDS             1..9\n                     /locus_tag="gene' + (index + 1) + '"\n'
      + (index % 2 ? '                     /pseudo\n' : '')).join('') + 'ORIGIN\n        1 atgaaataa\n//\n' };
}

describe('accepted CDS export presentation', () => {
  it('renders exact source identity, availability and reasons while labels stay literal', async () => {
    const experiment = await createGenomeCdsExperiment(genbank());
    const markup = renderToStaticMarkup(<GenomeCdsResults value={{ experiment, verified: false }} />);
    assert.match(markup, /2 DNA available \/ 0 unavailable/);
    assert.match(markup, /1 proteins available \/ 1 unavailable/);
    assert.match(markup, /Unsupported \/pseudo qualifier/);
    assert.ok(markup.includes(experiment.result.source.contentId));
    assert.ok(markup.includes(experiment.result.source.sequenceSha256));
    assert.ok(markup.includes('data-result-id="' + experiment.record.resultId + '"'));
    assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;.gb')); assert.ok(!markup.includes('<img'));
    assert.match(markup, /Export CDS analysis JSON/); assert.match(markup, /Export CDS table TSV/);
    assert.match(markup, /Export CDS DNA FASTA/); assert.match(markup, /Export protein FASTA/);
  });

  it('bounds row rendering while every mapped row remains reachable and empty FASTA remains disabled', async () => {
    const experiment = await createGenomeCdsExperiment(genbank(27));
    const first = renderToStaticMarkup(<GenomeCdsResults value={{ experiment, verified: true }} />);
    const last = renderToStaticMarkup(<GenomeCdsResults value={{ experiment, verified: true }} page={1} />);
    assert.equal((first.match(/data-testid="genome-cds-row"/g) ?? []).length, 25);
    assert.equal((last.match(/data-testid="genome-cds-row"/g) ?? []).length, 2);
    assert.match(last, /data-gene-id="27"/); assert.match(last, /Verified saved CDS export/);
    const unannotated = await createGenomeCdsExperiment({ name: 'dna.fa', text: '>dna\nATGAAATAA' });
    const empty = renderToStaticMarkup(<GenomeCdsResults value={{ experiment: unannotated, verified: false }} />);
    assert.match(empty, /No mapped CDS annotations/);
    assert.match(empty, /disabled=""[^>]*>Export CDS DNA FASTA/);
    assert.match(empty, /disabled=""[^>]*>Export protein FASTA/);
  });
});
