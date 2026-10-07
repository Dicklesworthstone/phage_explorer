import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { analyzeGCSkew, createGCSkewRecord, exportGCSkewTsv, parseGCSkewRecord, replayGCSkewRecord, resolveGCSkewOptions } from './gc-skew';

describe('portable GC-skew experiments', () => {
  it('counts hand-derived overlapping windows and inclusive prefixes, preserving first ties', () => {
    const result = analyzeGCSkew('GGCCNATGGCC', { windowSize: 4, stepSize: 2 });
    assert.deepEqual(result.windows, [
      { start: 0, end: 4, g: 2, c: 2, resolvedBases: 4, skew: 0, cumulative: 1 },
      { start: 2, end: 6, g: 0, c: 2, resolvedBases: 3, skew: -1, cumulative: 1 },
      { start: 4, end: 8, g: 1, c: 0, resolvedBases: 3, skew: 1, cumulative: 0 },
      { start: 6, end: 10, g: 2, c: 1, resolvedBases: 4, skew: 1 / 3, cumulative: 0 },
    ]);
    assert.equal(result.originPosition, 4); assert.equal(result.terminusPosition, 0);
    assert.equal(result.resolvedBases, 10); assert.equal(result.gcBases, 8);
  });
  it('agrees with direct substring and prefix counts across overlap, disjoint windows and ambiguity', () => {
    const sequences = ['gGcCnryATGNC', 'NNNNAAAATTTT', 'G'.repeat(51) + 'C'.repeat(47), 'ACGTN'.repeat(61)];
    for (const sequence of sequences) for (const windowSize of [1, 2, 4, 13, 1000]) for (const stepSize of [1, 2, 7, 101]) {
      const actual = analyzeGCSkew(sequence, { windowSize, stepSize });
      const rows = [];
      for (let start = 0; start + windowSize <= sequence.length; start += stepSize) {
        const text = sequence.slice(start, start + windowSize).toUpperCase();
        const g = [...text].filter(c => c === 'G').length, c = [...text].filter(c => c === 'C').length;
        const prefix = [...sequence.slice(0, start + 1).toUpperCase()];
        rows.push({ start, end: start + windowSize, g, c, resolvedBases: [...text].filter(c => 'ACGT'.includes(c)).length,
          skew: g + c ? (g - c) / (g + c) : null, cumulative: prefix.filter(c => c === 'G').length - prefix.filter(c => c === 'C').length });
      }
      assert.deepEqual(actual.windows, rows);
    }
  });
  it('distinguishes undefined windows from balanced composition and insufficient candidate evidence', async () => {
    const record = await createGCSkewRecord('NNNNGGCC', { windowSize: 4, stepSize: 4 });
    const rows = record.fields.windows.value as unknown as Array<{ skew: number | null }>;
    assert.equal(rows[0].skew, null); assert.equal(rows[1].skew, 0);
    assert.deepEqual(record.fields.windows.coverage, { available: 1, total: 2, unit: 'records' });
    for (const sequence of ['', 'NNNN', 'GGCC']) {
      const unavailable = await createGCSkewRecord(sequence, { windowSize: 4, stepSize: 4 });
      assert.equal(unavailable.fields.originPosition.kind, 'unavailable');
      assert.equal(unavailable.fields.terminusPosition.value, null);
      assert.equal((await replayGCSkewRecord(serializeAnalysisRecord(unavailable))).resultId, unavailable.resultId);
    }
    assert.match(exportGCSkewTsv(record), /0\t4\t0\t0\t0\t\t0\n/);
  });
  it('round-trips exact input, explicit parameters and all evidence through fresh replay', async () => {
    const record = await createGCSkewRecord('GGccNNATGGCC', { windowSize: 4, stepSize: 2 }, { accession: 'PRIVATE', source: 'local' });
    const text = serializeAnalysisRecord(record), parsed = await parseGCSkewRecord(text);
    assert.equal(parsed.sequence, 'GGccNNATGGCC'); assert.deepEqual(parsed.options, { windowSize: 4, stepSize: 2 });
    assert.deepEqual(await replayGCSkewRecord(text), record);
    const table = exportGCSkewTsv(record);
    assert.ok(table.includes(`result=${record.resultId}; inputSha256=${record.inputs[0].sha256}`));
    assert.ok(table.includes('windowSize=4; stepSize=2; complete linear windows; empty gc_skew cells are unavailable'));
  });
  it('rejects edited but correctly rehashed values, evidence and input conventions', async () => {
    const original = await createGCSkewRecord('GGCCNNGGCC', { windowSize: 4, stepSize: 2 });
    for (const edit of [
      (record: typeof original) => { (record.fields.windows.value as unknown as Array<{ skew: number }>)[0].skew = 1; },
      (record: typeof original) => { record.fields.originPosition.value = 999; },
      (record: typeof original) => { record.fields.windows.limitations = ['All windows establish replication sites.']; },
      (record: typeof original) => { record.inputs[0].data = 'GGGGNNGGCC'; },
      (record: typeof original) => { record.references[0].version = 'different'; },
      (record: typeof original) => { record.parameters.stepSize = 3; },
    ]) {
      const forged = structuredClone(original); edit(forged);
      await assert.rejects(replayGCSkewRecord(serializeAnalysisRecord(await createAnalysisRecord(forged))));
    }
  });
  it('refuses malformed settings, unsupported alphabets and unbounded output before allocating rows', () => {
    assert.deepEqual(resolveGCSkewOptions({ windowSize: 10 }), { windowSize: 10, stepSize: 2 });
    for (const options of [{ windowSize: 0 }, { stepSize: 0 }, { windowSize: 1.5 }, { stepSize: Infinity }, { windowSize: 1000001 }, { extra: true }]) {
      assert.throws(() => resolveGCSkewOptions(options));
    }
    assert.throws(() => analyzeGCSkew('AUCG', { windowSize: 2 }), /IUPAC DNA/);
    assert.throws(() => analyzeGCSkew('A'.repeat(20001), { windowSize: 1, stepSize: 1 }), /20,000/);
  });
});
