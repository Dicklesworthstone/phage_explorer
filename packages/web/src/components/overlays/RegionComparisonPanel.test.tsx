import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRegionComparisonExperiment } from '../../../../comparison/src/region-comparison-experiment';
import { RegionComparisonResults } from './RegionComparisonPanel';

const inputA = { name: 'annotated.gb', text: 'LOCUS       REGION_A 12 bp DNA linear\nACCESSION   REGION_A\nFEATURES             Location/Qualifiers\n     CDS             1..9\n                     /gene="source-cds"\n                     /product="source product"\nORIGIN\n        1 tttacgtaaccc\n//\n' };
const inputB = { name: 'reverse.fasta', text: '>REGION_B\nGGGTTACGTAAA\n' };
describe('source region result presentation', () => {
  it('uses accepted original sources, explicit reverse strand and mapped source coordinates', async () => {
    const experiment = await createRegionComparisonExperiment(inputA, inputB, {
      regionA: { start: 3, end: 9, strand: '+' }, regionB: { start: 3, end: 9, strand: '-' },
    });
    const html = renderToStaticMarkup(<RegionComparisonResults value={{ experiment, verified: true }} />);
    assert.match(html, /Verified saved region comparison/);
    assert.match(html, /independent of the current explorer selection/);
    assert.match(html, /REGION_A/); assert.match(html, /REGION_B/);
    assert.match(html, /annotated\.gb/); assert.match(html, /reverse\.fasta/);
    assert.match(html, /source bases 4–9/); assert.match(html, /reverse complement \(−\)/);
    assert.match(html, /Source region alignment coordinates/);
    assert.match(html, /<td>match<\/td><td>4–9<\/td><td>4–9<\/td><td>1–6<\/td><td>1–6<\/td>/);
    assert.match(html, /source-cds/); assert.match(html, /partly outside the region/);
    assert.match(html, /Export aligned region FASTA/);
    assert.doesNotMatch(html, /Inspect locus|Jump to|current genome/);
  });
});
