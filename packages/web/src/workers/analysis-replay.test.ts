import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '@phage-explorer/core';
import { createWorkerAnalysisRecord, parseRepeatReplay, compareRepeatReplay, parseGCSkewReplay, compareGCSkewReplay } from './analysis-evidence';
import type { RepeatResult } from './types';

const sequence = 'ACGTACGTNNNNACGTACGT';
const result: RepeatResult = {
  type: 'repeats', engine: 'js',
  repeats: [{ type: 'direct', position1: 0, position2: 12, sequence: 'ACGTACGT', length: 8 }],
  search: { step: 2, minLength: 8, maxGap: 5000, minArmLength: 5, palindromeMaxGap: 30,
    detailedScan: true, maxResults: 500, maxPairedResults: 200, maxPerDetail: 100 },
};
const fixture = () => createWorkerAnalysisRecord(result, sequence, { minLength: 8, maxGap: 5000 },
  { accession: null, source: 'local' }, 'shared');

/** Rehash changes so contract checks cannot pass only because a checksum failed first. */
async function changed(edit: (record: AnalysisRecord) => void): Promise<AnalysisRecord> {
  const record = await fixture();
  edit(record);
  return createAnalysisRecord(record);
}
const restore = (record: AnalysisRecord) => parseRepeatReplay(serializeAnalysisRecord(record));

describe('accelerated viewer GC-skew replay', () => {
  const fixture = () => createWorkerAnalysisRecord({ type: 'gc-skew', engine: 'wasm-simd', skew: [0, -1, 1, 1 / 3], cumulative: [1, 1, 0, 0],
    originPosition: 4, terminusPosition: 0 }, 'GGCCNATGGCC', { windowSize: 4, stepSize: 2 }, { accession: 'PRIVATE', source: 'local' }, 'shared');
  it('retains the old method and exact explicit spacing without installing stored output', async () => {
    const record = await fixture(), parsed = await parseGCSkewReplay(serializeAnalysisRecord(record));
    assert.equal(parsed.sequence, 'GGCCNATGGCC'); assert.deepEqual(parsed.options, { windowSize: 4, stepSize: 2 });
    assert.deepEqual(parsed.record, record);
    assert.equal(compareGCSkewReplay(record, await fixture()).exactRecord, true);
  });
  it('reports backend/transport metadata changes separately from equal biological input and numeric evidence', async () => {
    const record = await fixture(), changed = structuredClone(record);
    changed.method.implementation = 'js'; changed.parameters.route = 'string'; changed.inputs[0].accession = 'RENAMED';
    const fresh = await createAnalysisRecord(changed);
    assert.deepEqual(compareGCSkewReplay(record, fresh), { matches: true, differences: [], implementationMatches: false, exactRecord: false });
    assert.equal((await parseGCSkewReplay(serializeAnalysisRecord(fresh))).record.resultId, fresh.resultId);
  });
  it('refuses inconsistent parameters and forged interpretation even after their checksums are recalculated', async () => {
    for (const edit of [
      (record: AnalysisRecord) => { record.parameters.stepSize = 1; },
      (record: AnalysisRecord) => { record.parameters.circular = true; },
      (record: AnalysisRecord) => { record.parameters.requestedOptions = { windowSize: 4, stepSize: null }; },
      (record: AnalysisRecord) => { record.fields.originPosition.label = 'Measured origin'; },
      (record: AnalysisRecord) => { record.fields.skew.limitations = ['Experimentally validated']; },
      (record: AnalysisRecord) => { record.references[0].version = 'different'; },
      (record: AnalysisRecord) => { record.inputs[0].source = 'demo'; },
      (record: AnalysisRecord) => { record.fields.cumulative.value = []; },
      (record: AnalysisRecord) => { record.method.version = '2'; },
    ]) {
      const record = await fixture(); edit(record);
      await assert.rejects(parseGCSkewReplay(serializeAnalysisRecord(await createAnalysisRecord(record))));
    }
  });
  it('detects numeric forgery even with a valid envelope and checksum', async () => {
    const record = await fixture(), changed = structuredClone(record); changed.fields.skew.value = [0, -1, 0, 0];
    const forged = await createAnalysisRecord(changed);
    const parsed = await parseGCSkewReplay(serializeAnalysisRecord(forged));
    assert.deepEqual(compareGCSkewReplay(parsed.record, record).differences, ['GC-skew values, coverage or evidence']);
  });
  it('restores implicit legacy spacing and unavailable output without manufacturing measurements', async () => {
    for (const sequence of ['GC', 'NNNNNNNN', 'AAAAAAAA']) {
      const record = await createWorkerAnalysisRecord({ type: 'gc-skew', engine: 'js', skew: [], cumulative: [], originPosition: 0, terminusPosition: 0 },
        sequence, {}, { accession: null, source: 'catalog' }, 'string');
      const parsed = await parseGCSkewReplay(serializeAnalysisRecord(record));
      assert.deepEqual(parsed.options, { windowSize: 1000, stepSize: 250 });
      assert.equal(parsed.record.fields.originPosition.kind, 'unavailable');
    }
  });
});

describe('repeat experiment replay', () => {
  it('round-trips exact inputs and explicit settings from the real record writer', async () => {
    const record = await fixture();
    const replay = await restore(record);
    assert.equal(replay.sequence, sequence);
    assert.deepEqual(replay.options, { minLength: 8, maxGap: 5000 });
    assert.deepEqual(replay.record, record);
  });

  it('supports records that used the documented default options', async () => {
    const record = await createWorkerAnalysisRecord(result, sequence, {}, { accession: null, source: 'local' }, 'string');
    assert.deepEqual((await restore(record)).options, { minLength: 8, maxGap: 5000 });
  });

  it('rejects edited inputs and outputs before returning any settings', async () => {
    const input = await fixture();
    input.inputs[0].data = 'ACGT';
    await assert.rejects(restore(input), /input checksum mismatch/);
    const output = await fixture();
    output.fields.repeats.value = [];
    await assert.rejects(restore(output), /result checksum mismatch/);
  });

  it('refuses another method and unsupported method versions even with valid checksums', async () => {
    await assert.rejects(restore(await changed(record => { record.method.id = 'sequence-gc-skew'; })), /method\/version/);
    await assert.rejects(restore(await changed(record => { record.method.version = '999'; })), /method\/version/);
  });

  it('refuses changed reference versions and unsupported stochastic seeds', async () => {
    await assert.rejects(restore(await changed(record => { record.references[0].version = 'other'; })), /reference versions/);
    await assert.rejects(restore(await changed(record => { record.seed = 42; })), /seed/);
  });

  it('requires one exact, identified non-demo sequence input', async () => {
    for (const edit of [
      (record: AnalysisRecord) => { record.inputs[0].source = 'demo'; },
      (record: AnalysisRecord) => { record.inputs[0].source = 'external'; },
      (record: AnalysisRecord) => { record.inputs[0].id = 'not-sequence'; },
      (record: AnalysisRecord) => { record.inputs[0].data = { sequence }; },
      (record: AnalysisRecord) => { record.inputs[0].data = ''; },
      (record: AnalysisRecord) => { record.inputs.push({ ...record.inputs[0], id: 'second' }); },
    ]) await assert.rejects(restore(await changed(edit)), /one exact, non-demo/);
  });

  it('rejects unknown or contradictory requested options rather than silently discarding them', async () => {
    for (const edit of [
      (record: AnalysisRecord) => { record.parameters.requestedOptions = { minLength: 12, maxGap: 5000 }; },
      (record: AnalysisRecord) => { record.parameters.requestedOptions = { minLength: 8, maxGap: 5000, windowSize: 10 }; },
      (record: AnalysisRecord) => { record.parameters.requestedOptions = { minLength: null }; },
      (record: AnalysisRecord) => { record.parameters.circular = true; },
      (record: AnalysisRecord) => { record.parameters.route = ['shared']; },
    ]) await assert.rejects(restore(await changed(edit)), /inconsistent or contain unsupported/);
  });

  it('enforces finite integer replay bounds even on otherwise valid records', async () => {
    for (const [minLength, maxGap] of [[3, 5000], [257, 5000], [8.5, 5000], [8, -1], [8, 100001]]) {
      const record = await changed(record => {
        record.parameters = { route: 'shared', minLength, maxGap, requestedOptions: { minLength, maxGap } };
      });
      await assert.rejects(restore(record), /supported replay bounds|unsupported options/);
    }
  });

  it('requires both matches and search evidence with sequence-score semantics', async () => {
    for (const edit of [
      (record: AnalysisRecord) => { delete record.fields.search; },
      (record: AnalysisRecord) => { record.fields.repeats.value = 'not an array'; },
      (record: AnalysisRecord) => { record.fields.search.value = []; },
      (record: AnalysisRecord) => { record.fields.extra = record.fields.search; },
    ]) await assert.rejects(restore(await changed(edit)), /matches or search evidence/);
  });

  it('enforces the portable-record size limit before JSON parsing', async () => {
    await assert.rejects(parseRepeatReplay(' '.repeat(10 * 1024 * 1024 + 1)), /10 MiB/);
  });

  it('recognizes a freshly created identical result, including full record identity', async () => {
    assert.deepEqual(compareRepeatReplay(await fixture(), await fixture()), {
      matches: true, differences: [], implementationMatches: true, exactRecord: true,
    });
  });

  it('distinguishes matching evidence from backend, transport and display identity changes', async () => {
    const other = await changed(record => {
      record.method.implementation = 'JS pair scan; wasm-simd detailed kernels';
      record.parameters.route = 'string';
      record.inputs[0].accession = 'renamed-local-input';
    });
    assert.deepEqual(compareRepeatReplay(await fixture(), other), {
      matches: true, differences: [], implementationMatches: false, exactRecord: false,
    });
  });

  it('detects recomputed differences even when both records have valid checksums', async () => {
    const original = await fixture();
    for (const [edit, difference] of [
      [(record: AnalysisRecord) => { record.inputs[0].data = sequence + 'A'; }, 'exact sequence input'],
      [(record: AnalysisRecord) => { record.parameters.maxGap = 100; }, 'search parameters/seed'],
      [(record: AnalysisRecord) => { record.seed = 1; }, 'search parameters/seed'],
      [(record: AnalysisRecord) => { record.method.version = '3'; }, 'method/version'],
      [(record: AnalysisRecord) => { record.references[0].version = 'changed'; }, 'reference versions'],
      [(record: AnalysisRecord) => { record.fields.repeats.value = []; }, 'repeat results, search limits or evidence fields'],
    ] as const) {
      const comparison = compareRepeatReplay(original, await changed(edit));
      assert.equal(comparison.matches, false);
      assert.equal(comparison.exactRecord, false);
      assert.ok(comparison.differences.includes(difference));
    }
  });

  it('compares interpretation and coverage, not just the displayed repeat values', async () => {
    const original = await fixture();
    for (const edit of [
      (record: AnalysisRecord) => { record.fields.repeats.coverage.available = 0; },
      (record: AnalysisRecord) => { record.fields.repeats.limitations = ['A different interpretation.']; },
      (record: AnalysisRecord) => { record.fields.search.value = { ...result.search, maxPerDetail: 1 }; },
    ]) assert.equal(compareRepeatReplay(original, await changed(edit)).matches, false);
  });
});
