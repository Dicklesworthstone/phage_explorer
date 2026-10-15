import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzePhylodynamics, type PhylodynamicsResult } from '@phage-explorer/core';
import { DEFAULT_THEME } from '../../theme/themes';
import { PhylodynamicsStats } from './PhylodynamicsOverlay';

const colors = DEFAULT_THEME.colors;
function analyze(sequences: string[]): PhylodynamicsResult {
  return analyzePhylodynamics(sequences.map((sequence, i) => ({
    id: String(i), sequence, date: 2020 + i,
  })), {
    runClock: false, runSkyline: false,
    codingAlignment: { source: 'Hand-aligned regression codons', geneticCode: 1 },
  });
}
const render = (result: PhylodynamicsResult) => renderToStaticMarkup(
  <PhylodynamicsStats result={result} colors={colors} />,
);
function selection(result: PhylodynamicsResult) {
  if (result.selection === null) throw new Error('The coding fixture must produce selection evidence.');
  return result.selection;
}
function reason(value: string | undefined): string {
  if (!value) throw new Error('The unavailable fixture must explain its missing evidence.');
  return value;
}

describe('PhylodynamicsOverlay production stats', () => {
  it('renders an actual unavailable selection without inferring neutrality or crashing', () => {
    const result = analyze(['ATGATGATGATG', 'ATGATGATGATA']);
    expect(result.selection).not.toBeNull();
    expect(result.selection?.treeDnDs).toBeNull();
    const html = render(result);
    expect(html).toContain(`dN/dS: <strong style="color:${colors.textDim}">N/A</strong>`);
    expect(html).toContain(reason(selection(result).treeDnDsUnavailableReason));
    expect(html).not.toContain('1.000');
    expect(html).not.toContain('Infinity');
  });

  it('renders a finite core estimate with three decimals and the existing low-ratio color', () => {
    const result = analyze(['GCTGCTGCT', 'GCCGCTGCT']);
    expect(result.selection?.treeDnDs).toBe(0);
    const html = render(result);
    expect(html).toContain(`dN/dS: <strong style="color:${colors.primary}">0.000</strong>`);
    expect(html).not.toContain('no observed synonymous substitutions');
  });

  it('preserves existing high and neutral colors for available finite presentation values', () => {
    const result = analyze(['GCTGCTGCT', 'GCCGCTGCT']);
    for (const [ratio, color, text] of [[1.23456, colors.error, '1.235'], [1, colors.text, '1.000']] as const) {
      const html = render({ ...result, selection: { ...selection(result), treeDnDs: ratio } });
      expect(html).toContain(`dN/dS: <strong style="color:${color}">${text}</strong>`);
    }
  });

  it('keeps an absent selection and its actual alignment requirement unavailable', () => {
    const result = analyzePhylodynamics([
      { id: 'A', sequence: 'GCTGCTGCT', date: 2020 },
      { id: 'B', sequence: 'GCCGCTGCT', date: 2021 },
    ], { runClock: false, runSkyline: false });
    expect(result.selection).toBeNull();
    expect(render(result)).toContain(reason(result.selectionUnavailableReason));
    expect(render(result)).toContain('N/A');
  });

  it('does not present nonfinite cached ratios as scientific estimates', () => {
    const result = analyze(['GCTGCTGCT', 'GCCGCTGCT']);
    for (const treeDnDs of [Infinity, NaN]) {
      const html = render({ ...result, selection: { ...selection(result), treeDnDs } });
      expect(html).toContain(`dN/dS: <strong style="color:${colors.textDim}">N/A</strong>`);
      expect(html).not.toContain('Infinity');
      expect(html).not.toContain('NaN');
    }
  });
});
