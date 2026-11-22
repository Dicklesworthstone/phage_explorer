import React from 'react';
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { importLocalGenomes } from '@phage-explorer/core';
import { prepareSelectedCds, selectedCdsExport } from '../hooks/SelectedCdsSession';
import { SelectedCdsDetails } from './SelectedCdsInspector';

async function result(sequence = 'ATGTGATAA', qualifiers = '                     /transl_table=4\n', location = `1..${sequence.length}`) {
  const imported = await importLocalGenomes({ name: 'private.gb', text:
    `LOCUS       PRIVATE ${sequence.length} bp DNA linear\nACCESSION   PRIVATE\nFEATURES             Location/Qualifiers\n`
    + `     CDS             ${location}\n                     /locus_tag="private-gene"\n${qualifiers}`
    + `ORIGIN\n        1 ${sequence.toLowerCase()}\n//\n` });
  const genome = imported.genomes[0];
  return prepareSelectedCds({ owner: {}, sequence: genome.sequence, phage: genome.phage }, genome.phage.genes[0]);
}
const noop = () => {};

describe('selected CDS inspector evidence and export controls', () => {
  it('shows the actual source, genetic code, transcript and terminal stop convention', async () => {
    const accepted = await result();
    const html = renderToStaticMarkup(<SelectedCdsDetails result={accepted} onExport={noop} />);
    assert(html.includes('Private local genome')); assert(html.includes('Translation table</dt><dd>4 (annotation)'));
    assert(html.includes('ATGTGATAA')); assert(html.includes('MW*'));
    assert(html.includes('terminal * marks a stop')); assert(html.includes('1..9(+)'));
    assert(html.includes('1-based inclusive')); assert(html.includes('data-result-id="' + accepted.resultId + '"'));
    assert(!html.includes('disabled=""'));
  });

  it('retains DNA actions and identifies the real translation refusal', async () => {
    const accepted = await result('ATGAAATAA', '                     /transl_table=2\n                     /pseudo\n');
    const html = renderToStaticMarkup(<SelectedCdsDetails result={accepted} onExport={noop} />);
    assert(html.includes('Translation table</dt><dd>2 (annotation)'));
    assert(html.includes('Unsupported translation table.')); assert(html.includes('Unsupported /pseudo qualifier.'));
    assert(html.includes('exact annotated DNA remains available')); assert(html.includes('ATGAAATAA'));
    assert.match(html, /<button type="button">Export CDS FASTA<\/button>/);
    assert.match(html, /<button type="button" disabled="">Export protein FASTA<\/button>/);
    assert(!html.includes('aria-label="Translated protein"'));
  });

  it('makes partial coding frame and unresolved bases visible independently of location readability', async () => {
    const accepted = await result('ATGNNAAT', '');
    const html = renderToStaticMarkup(<SelectedCdsDetails result={accepted} onExport={noop} />);
    assert(html.includes('Incomplete: 2 trailing base(s)')); assert(html.includes('unresolved bases'));
    assert(html.includes('ATGNNAAT')); assert(html.includes('complete terminal codons'));
    assert.match(html, /<button type="button">Export CDS FASTA<\/button>/);
    assert.match(html, /<button type="button" disabled="">Copy protein FASTA<\/button>/);
  });

  it('renders annotated labels literally and bounds the preview without truncating exports', async () => {
    const accepted = await result('ATG'.repeat(300), '');
    accepted.source.name = '<img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(<SelectedCdsDetails result={accepted} onExport={noop} />);
    assert(html.includes('&lt;img src=x onerror=alert(1)&gt;')); assert(!html.includes('<img'));
    assert(html.includes('first 600 shown; copy and export include the complete sequence'));
    const cdsPreview = html.match(/aria-label="Annotated CDS DNA[^>]+>(.*?)<\/pre>/s)![1];
    assert.equal(cdsPreview.replace(/\n/g, '').length, 600);
    const exported = selectedCdsExport(accepted, 'cds')!.content.split('\n').slice(1).join('');
    assert.equal(exported, 'ATG'.repeat(300));
  });
});
