import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '@phage-explorer/core';
import { createWorkerAnalysisRecord, parseRepeatReplay, compareRepeatReplay } from './analysis-evidence';
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
