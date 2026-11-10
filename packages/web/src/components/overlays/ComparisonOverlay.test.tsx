import React from 'react';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeSequenceDiff } from '@phage-explorer/comparison';
import { ComparisonDiffView } from './ComparisonOverlay';

describe('comparison diff result rendering', () => {
  it('renders real budget exhaustion as unavailable, never identical', () => {
    const sequenceA = 'A'.repeat(3000), sequenceB = 'C'.repeat(3001);
    const diff = computeSequenceDiff(sequenceA, sequenceB);
    const html = renderToStaticMarkup(<ComparisonDiffView diff={diff} sequenceA={sequenceA} sequenceB={sequenceB} />);
    expect(html).toContain('Exact sequence diff unavailable'); expect(html).toContain('budget');
    expect(html).not.toContain('comparison-identical'); expect(html).not.toContain('Sequences appear identical');
  });

  it('claims symbol equality only after complete zero-edit alignment and discloses ambiguity', () => {
    const sequenceA = 'ACNT', sequenceB = 'acnt';
    const html = renderToStaticMarkup(<ComparisonDiffView diff={computeSequenceDiff(sequenceA, sequenceB)} sequenceA={sequenceA} sequenceB={sequenceB} />);
    expect(html).toContain('comparison-identical'); expect(html).toContain('identical symbols');
    expect(html).toContain('1 columns contain ambiguous bases');
  });

  it('renders exact aligned indels and their coordinates for equal-length shifted inputs', () => {
    const sequenceA = 'ACGT', sequenceB = 'CGTA';
    const html = renderToStaticMarkup(<ComparisonDiffView diff={computeSequenceDiff(sequenceA, sequenceB)} sequenceA={sequenceA} sequenceB={sequenceB} />);
    expect(html).not.toContain('comparison-identical'); expect(html).toContain('Aligned sequence edit coordinates');
    expect(html).toContain('deletion'); expect(html).toContain('insertion'); expect(html).toContain('60.00');
    expect(html).toContain('between bases 4 and 5');
  });
});
