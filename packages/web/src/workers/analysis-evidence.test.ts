import { expect, test } from 'bun:test';
import { parseAnalysisRecord, serializeAnalysisRecord } from '@phage-explorer/core';
import { createWorkerAnalysisRecord } from './analysis-evidence';
import type { AnalysisResult } from './types';

test('every worker result property has an evidence adapter and retains its payload', async () => {
  // These are transport fixtures, not claims that the scientific kernels ran.
  const fixtures: AnalysisResult[] = [
    { type: 'gc-skew', skew: [0, -1], cumulative: [1, 0], originPosition: 1, terminusPosition: 0, engine: 'js' },
    { type: 'complexity', entropy: [1], linguistic: [0.5], lowComplexityRegions: [] },
    { type: 'bendability', values: [0.35], flexibleRegions: [] },
    { type: 'promoters', sites: [] }, { type: 'repeats', repeats: [] },
    { type: 'codon-usage', usage: { ATG: 1 }, rscu: { ATG: 1 } },
    { type: 'kmer-spectrum', kmerSize: 2, spectrum: [{ kmer: 'GC', count: 1, frequency: 1 }], uniqueKmers: 1, totalKmers: 1 },
    { type: 'transcription-flow', values: [0.1], peaks: [] },
  ];
  for (const fixture of fixtures) {
    const record = await createWorkerAnalysisRecord(fixture, 'GCATN', { windowSize: 4 }, { accession: 'PRIVATE', source: 'local' }, 'shared');
    expect(await parseAnalysisRecord(serializeAnalysisRecord(record))).toEqual(record);
    for (const [name, value] of Object.entries(fixture)) if (name !== 'type' && name !== 'engine') expect(record.fields[name].value).toEqual(value);
    expect(record.inputs[0].data).toBe('GCATN');
    for (const field of Object.values(record.fields)) expect(field.coverage).toEqual({ available: field.kind === 'unavailable' ? 0 : 4, total: 5, unit: 'bases' });
    if (fixture.type === 'gc-skew') {
      expect(record.parameters.stepSize).toBe(1);
      expect(record.fields.cumulative.units).toBe('count');
    }
    if (fixture.type === 'codon-usage') expect(record.fields.cai.kind).toBe('unavailable');
    if (fixture.type === 'complexity') expect(record.fields.entropy.units).toBe('fraction');
    if (fixture.type === 'transcription-flow') expect(record.fields.values.kind).toBe('simulation');
  }
});

test('zero GC denominator and insufficient sequence remain unavailable in exported evidence', async () => {
  const empty: AnalysisResult = { type: 'gc-skew', skew: [], cumulative: [], originPosition: 0, terminusPosition: 0, engine: 'js' };
  for (const sequence of ['', 'N', 'ATATAT', 'GC']) {
    const record = await createWorkerAnalysisRecord(empty, sequence, { windowSize: 500 }, { accession: null, source: 'local' }, 'shared');
    for (const field of Object.values(record.fields)) expect(field).toMatchObject({ kind: 'unavailable', units: null, value: null });
  }
  const zero: AnalysisResult = { type: 'gc-skew', skew: [0, 0], cumulative: [0, 0], originPosition: 0, terminusPosition: 0, engine: 'js' };
  const record = await createWorkerAnalysisRecord(zero, 'AT'.repeat(500), { windowSize: 500 }, { accession: 'NO_GC', source: 'local' }, 'shared');
  expect(record.fields.originPosition.kind).toBe('unavailable');
  expect(record.fields.skew.kind === 'unavailable' && record.fields.skew.missingInputs.join()).toContain('denominator is zero');
});
