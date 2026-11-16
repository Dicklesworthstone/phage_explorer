import React from 'react';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeBiologicalMetrics } from '@phage-explorer/comparison';
import { ComparisonGcContent } from './ComparisonOverlay';

describe('GC content evidence rendering', () => {
  it('shows unavailable rather than zero GC or zero difference for unresolved records', () => {
    const html = renderToStaticMarkup(<ComparisonGcContent biological={analyzeBiologicalMetrics('NNN', 'NRY')} />);
    expect(html).toContain('Unavailable');
    expect(html).toContain('Δ Unavailable');
    expect(html).toContain('A 0/3; B 0/3');
    expect(html).not.toContain('0.00%');
  });

  it('retains the measured value for one resolved genome without comparing it to missing evidence', () => {
    const html = renderToStaticMarkup(<ComparisonGcContent biological={analyzeBiologicalMetrics('NNN', 'AATT')} />);
    expect(html).toContain('Unavailable / 0.00%');
    expect(html).toContain('Δ Unavailable');
    expect(html).toContain('A 0/3; B 4/4');
  });

  it('shows percentages and a difference when both have resolved bases', () => {
    const html = renderToStaticMarkup(<ComparisonGcContent biological={analyzeBiologicalMetrics('gNc', 'atNN')} />);
    expect(html).toContain('100.00% / 0.00%');
    expect(html).toContain('Δ 100.00%');
    expect(html).toContain('A 2/3; B 2/4');
    expect(html).toContain('Ambiguous bases are excluded from GC%');
    expect(html).not.toContain('Unavailable');
  });
});
