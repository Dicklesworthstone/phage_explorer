import React from 'react';
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import { createInactivationTemplate, createInactivationRecord, exportInactivationTsv, type InactivationInput } from '../../../../core/src/analysis/virion-stability';
import type { AcceptedGrowth } from '../../workers/PlaqueGrowthSession';
import { VirionInactivationResults } from './VirionInactivationPanel';

async function accepted(input = createInactivationTemplate()): Promise<AcceptedGrowth<InactivationInput>> {
  const inputText = JSON.stringify(input), record = await createInactivationRecord(inputText);
  return { input, inputText, record, json: serializeAnalysisRecord(record), tsv: exportInactivationTsv(record), verifiedReplay: false };
}
const save = () => {};

describe('accepted measured inactivation results', () => {
  it('renders literal preparation/source identities and separates unapplied drafts from accepted evidence', async () => {
    const input = createInactivationTemplate();
    input.title = '<img src=x onerror=alert(1)>';
    input.preparation.phageId = '<b>private phage</b>';
    const result = await accepted(input);
    const markup = renderToStaticMarkup(<VirionInactivationResults accepted={result} dirty save={save} />);
    assert(markup.includes('&lt;img src=x onerror=alert(1)&gt;')); assert(!markup.includes('<img'));
    assert(markup.includes('&lt;b&gt;private phage&lt;/b&gt;')); assert(!markup.includes('<b>private'));
    assert(markup.includes('SYNTHETIC — NOT EMPIRICAL EVIDENCE'));
    assert(markup.includes('Draft edits are not applied')); assert(markup.includes('Fresh fit'));
    assert(markup.includes('Conditional half-life (minutes)</th><td>10</td>'));
    assert(markup.includes('not a calibrated confidence interval'));
    assert(markup.includes('data-result-id="' + result.record.resultId + '"'));
  });
  it('keeps all-zero and earliest-only support unbounded without inventing a finite rate or chart', async () => {
    const input = createInactivationTemplate(); input.provenance.kind = 'user-supplied';
    input.csv = 'time_min,plaque_count,dilution_fraction,volume_ml\n0,0,1,1\n10,0,1,1\n';
    let result = await accepted(input);
    let markup = renderToStaticMarkup(<VirionInactivationResults accepted={result} save={save} />);
    assert(markup.includes('unidentifiable')); assert(markup.includes('+∞)'));
    assert(markup.includes('Exponential decay rate (per minute)</th><td>Unavailable</td>'));
    assert(!markup.includes('NaN')); assert(!markup.includes('Infinity'));
    input.csv = 'time_min,plaque_count,dilution_fraction,volume_ml\n0,120,1,1\n10,0,1,1\n';
    result = await accepted(input); result.verifiedReplay = true;
    markup = renderToStaticMarkup(<VirionInactivationResults accepted={result} save={save} />);
    assert(markup.includes('unbounded-rate')); assert(markup.includes('limiting-mle'));
    assert(markup.includes('A finite-rate curve is unavailable')); assert(!markup.includes('<polyline'));
    assert(markup.includes('Saved numerical evidence verified by fresh replay'));
    assert(markup.includes('USER-SUPPLIED — SOURCE NOT INDEPENDENTLY VERIFIED'));
  });
  it('renders every observed plate across pages and handles a single-time design without dividing by zero', async () => {
    const input = createInactivationTemplate();
    input.csv = 'time_min,plaque_count,dilution_fraction,volume_ml\n'
      + Array.from({ length: 53 }, (_, i) => '7,' + (i % 3) + ',0.01,0.1').join('\n') + '\n';
    const result = await accepted(input);
    const first = renderToStaticMarkup(<VirionInactivationResults accepted={result} save={save} />);
    const last = renderToStaticMarkup(<VirionInactivationResults accepted={result} page={1} save={save} />);
    assert.equal((first.match(/data-testid="inactivation-plate"/g) ?? []).length, 50);
    assert.equal((last.match(/data-testid="inactivation-plate"/g) ?? []).length, 3);
    assert(first.includes('common-time-concentration')); assert(first.includes('unidentifiable'));
    assert(!first.includes('NaN')); assert(!first.includes('Infinity'));
    assert(last.includes('51')); assert(last.includes('53'));
    assert.equal(result.tsv.split('\n').filter(line => line && !line.startsWith('#')).length, 54);
  });
});
