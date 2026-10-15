import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord } from './analysis-result';
import { serializeCommandTape } from './command-session';
import { WorkflowResultCollector, parseWorkflowResults, workflowResultIndex, workflowAnalysisAt, WORKFLOW_RESULTS_LIMITS } from './workflow-results';

async function fixture() {
  const record = await createAnalysisRecord({ method: { id: 'literal-count', version: '1', implementation: 'test input length' },
    inputs: [{ id: 'sequence', accession: null, source: 'local', description: 'Literal test input', data: 'ACGT' }],
    parameters: {}, references: [], seed: null,
    fields: { length: { label: 'Input length', kind: 'sequence-score', units: 'count', value: 4,
      coverage: { available: 4, total: 4, unit: 'bases' }, limitations: ['Length only.'] } } });
  const expected = { method: record.method, cacheKey: record.cacheKey, resultId: record.resultId };
  const tapeJson = serializeCommandTape({ format: 'phage-explorer-commands', version: 1, name: 'Two identical analyses then navigation', context: null,
    commands: [{ actionId: 'analysis.count', parameters: {}, expected }, { actionId: 'analysis.count', parameters: {}, expected },
      { actionId: 'nav.goto', parameters: {}, expected: { sequenceSha256: '0'.repeat(64), view: { position: 0 } } }] });
  return { record, tapeJson };
}
describe('complete workflow results', () => {
  it('retains one immutable record per identity and every ordered execution across repetitions', async () => {
    const { record, tapeJson } = await fixture(), collector = new WorkflowResultCollector();
    collector.add(record); collector.add(structuredClone(record));
    const text = await collector.finish(tapeJson, 2), archive = await parseWorkflowResults(text);
    assert.equal(archive.records.length, 1); assert.equal(archive.tapeJson, tapeJson);
    assert.deepEqual(workflowResultIndex(tapeJson, 2).map(e => [e.execution, e.iteration, e.step, e.analysis?.resultId ?? null]),
      [[1,1,1,record.resultId],[2,1,2,record.resultId],[3,1,3,null],[4,2,1,record.resultId],[5,2,2,record.resultId],[6,2,3,null]]);
    assert.equal(serializeAnalysisRecord(workflowAnalysisAt(archive, 5)), serializeAnalysisRecord(record));
    assert.throws(() => workflowAnalysisAt(archive, 6), /navigation/);
    for (const value of [0, 7, NaN, 1.5]) assert.throws(() => workflowAnalysisAt(archive, value));
    (record.fields.length as { value: number }).value = 999;
    assert.equal((await parseWorkflowResults(await collector.finish(tapeJson, 2))).records[0].fields.length.value, 4);
  });
  it('rejects missing, duplicate and unreferenced records rather than exporting a partial run', async () => {
    const { record, tapeJson } = await fixture(), c = new WorkflowResultCollector();
    await assert.rejects(c.finish(tapeJson, 1), /missing/); c.add(record);
    const value = JSON.parse(await c.finish(tapeJson, 1));
    for (const records of [[], [record, record]]) await assert.rejects(parseWorkflowResults(JSON.stringify({ ...value, records })), /missing.*extra/);
    value.records[0].resultId = '1'.repeat(64);
    await assert.rejects(parseWorkflowResults(JSON.stringify(value)));
  });
  it('verifies numerical record hashes and binds method, settings and evidence to the tape', async () => {
    const { record, tapeJson } = await fixture(), c = new WorkflowResultCollector(); c.add(record);
    const value = JSON.parse(await c.finish(tapeJson, 1));
    value.records[0].fields.length.value = 5;
    await assert.rejects(parseWorkflowResults(JSON.stringify(value)), /checksum|integrity|differ|match/i);
    const changed = await createAnalysisRecord({ ...record, inputs: record.inputs, fields: value.records[0].fields });
    value.records[0] = changed;
    await assert.rejects(parseWorkflowResults(JSON.stringify(value)), /recorded analysis/);
  });
  it('checks first-execution order and rejects conflicting evidence with the same identity', async () => {
    const { record, tapeJson } = await fixture(), c = new WorkflowResultCollector(); c.add(record);
    const collision = structuredClone(record); collision.inputs[0].description = 'changed';
    assert.throws(() => c.add(collision), /Conflicting/);
    const second = await createAnalysisRecord({ ...record, inputs: record.inputs, parameters: { second: true } });
    const tape = JSON.parse(tapeJson); tape.commands[1].expected = { method: second.method, cacheKey: second.cacheKey, resultId: second.resultId };
    const reversed = new WorkflowResultCollector(); reversed.add(second); reversed.add(record);
    await assert.rejects(reversed.finish(JSON.stringify(tape), 1), /first-execution order/);
  });
  it('allows a complete navigation-only run without inventing an analysis', async () => {
    const { tapeJson } = await fixture(), tape = JSON.parse(tapeJson); tape.commands = [tape.commands[2]];
    const c = new WorkflowResultCollector(), archive = await parseWorkflowResults(await c.finish(JSON.stringify(tape), 1));
    assert.deepEqual(archive.records, []); assert.throws(() => workflowAnalysisAt(archive, 1), /navigation/);
  });
  it('rejects unsupported schemas, output contracts, repetition and byte limits', async () => {
    const { record, tapeJson } = await fixture(), c = new WorkflowResultCollector(); c.add(record);
    const value = JSON.parse(await c.finish(tapeJson, 1));
    for (const change of [{ version: 2 }, { format: 'other' }, { verified: true }, { repetitions: 11 }, { repetitions: 0 }, { repetitions: NaN }]) {
      await assert.rejects(parseWorkflowResults(JSON.stringify({ ...value, ...change })));
    }
    const tape = JSON.parse(tapeJson); tape.commands[1].expected = { arbitrary: 5 };
    await assert.rejects(c.finish(JSON.stringify(tape), 1), /canonical/);
    tape.commands = []; assert.throws(() => workflowResultIndex(JSON.stringify(tape), 1));
    await assert.rejects(parseWorkflowResults(' '.repeat(WORKFLOW_RESULTS_LIMITS.bytes + 1)), /32 MiB/);
    await assert.rejects(parseWorkflowResults('é'.repeat(WORKFLOW_RESULTS_LIMITS.bytes / 2 + 1)), /32 MiB/);
  });
  it('honors cancellation before parsing and during final integrity checks', async () => {
    const { record, tapeJson } = await fixture(), c = new WorkflowResultCollector(); c.add(record);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(c.finish(tapeJson, 1, controller.signal), { name: 'AbortError' });
    await assert.rejects(parseWorkflowResults('bad', controller.signal), { name: 'AbortError' });
    const active = new AbortController(); const pending = c.finish(tapeJson, 1, active.signal); active.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });
});
