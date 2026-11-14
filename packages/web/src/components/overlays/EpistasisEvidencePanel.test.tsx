import React from 'react';
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEpistasisAssayTemplate, createEpistasisAssayExperiment } from '../../../../core/src/analysis/epistasis-evidence';
import { EpistasisEvidenceResults, epistasisOptionsFromDraft } from './EpistasisEvidencePanel';

describe('accepted measured epistasis result surface', () => {
  it('renders supplied identities literally and keeps missing controls unavailable', async () => {
    const dataset = createEpistasisAssayTemplate();
    dataset.name = '<img src=x onerror=alert(1)>';
    dataset.protein.id = '<b>private protein</b>';
    dataset.source.kind = 'local';
    dataset.observations.push({ variant: 'A1V:D3E', replicateId: 'only-double', value: 23 });
    const { result, record } = await createEpistasisAssayExperiment(dataset, { bootstrapSamples: 0, seed: 1 });
    const markup = renderToStaticMarkup(<EpistasisEvidenceResults dataset={dataset} result={result} record={record}
      view="pairs" selected="A1V:D3E" />);
    assert(markup.includes('&lt;img src=x onerror=alert(1)&gt;')); assert(!markup.includes('<img'));
    assert(markup.includes('&lt;b&gt;private protein&lt;/b&gt;')); assert(!markup.includes('<b>private'));
    assert(markup.includes('1 estimated / 2 measured double-mutant contrasts'));
    assert(markup.includes('Missing genotype groups: D3E'));
    assert(markup.includes('unavailable assay contrast')); assert(markup.includes('Unavailable'));
    assert(markup.includes('data-result-id="' + record.resultId + '"'));
  });

  it('shows every observation across pages and explicitly reports excluded paired blocks', async () => {
    const dataset = createEpistasisAssayTemplate(); dataset.assay.replicateDesign = 'paired';
    dataset.observations.push(...Array.from({ length: 31 }, (_, i) => ({ variant: 'WT', replicateId: 'unmatched-' + i, value: 99 })));
    const { result, record } = await createEpistasisAssayExperiment(dataset, { bootstrapSamples: 0, seed: 1 });
    const first = renderToStaticMarkup(<EpistasisEvidenceResults dataset={dataset} result={result} record={record} view="observations" />);
    const last = renderToStaticMarkup(<EpistasisEvidenceResults dataset={dataset} result={result} record={record} view="observations" page={1} />);
    assert.equal((first.match(/data-testid="epistasis-observation"/g) ?? []).length, 50);
    assert.equal((last.match(/data-testid="epistasis-observation"/g) ?? []).length, 5);
    const pair = renderToStaticMarkup(<EpistasisEvidenceResults dataset={dataset} result={result} record={record}
      view="pairs" selected="A1V:C2S" />);
    assert(pair.includes('31 excluded incomplete blocks'));
    assert(pair.includes('6 complete paired blocks'));
    assert(pair.includes('unmatched-30'));
    assert(pair.includes('do not contribute to this paired contrast'));
    assert.equal(result.pairs[0].contrast, 3);
  });

  it('keeps draft analysis settings strict and does not turn an empty field into zero', () => {
    assert.deepEqual(epistasisOptionsFromDraft('0', '0'), { bootstrapSamples: 0, seed: 0 });
    assert.deepEqual(epistasisOptionsFromDraft('2000', '4294967295'), { bootstrapSamples: 2000, seed: 4294967295 });
    for (const [samples, seed] of [['', '1'], ['200', ''], [' 200', '1'], ['1e3', '1'], ['199', '1'],
      ['2001', '1'], ['200', '-1'], ['200', '4294967296'], ['200', '0.5']]) {
      assert.throws(() => epistasisOptionsFromDraft(samples, seed));
    }
  });
});
