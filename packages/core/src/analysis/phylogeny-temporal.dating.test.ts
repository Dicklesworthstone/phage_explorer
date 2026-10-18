import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAlignedPhylogenyExperiment } from './aligned-phylogeny';
import { rootAlignedPhylogenyExperiment } from './phylogeny-rooting';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { createRootedDatingExperiment, createRootedTemporalExperiment, replayRootedDatingExperiment,
  replayRootedTemporalExperiment, ROOTED_DATING_METHOD, type RootedTemporalMetadata } from './phylogeny-temporal';
import { createDatedTreeRecord, exportDatedNewick, fitDatedTree, type DatingOptions } from './strict-clock';

// Analytic four-taxon oracle: disjoint private changes in a 100-column alignment.
// The JC-corrected distances give the A/D split; the closed-form limb lengths
// below are independent of the production path traversal and clock solver.
const jc = (changes: number) => -.75 * Math.log(1 - 4 * changes / 300);
const a = (jc(5) + (jc(3) + jc(4) - jc(6) - jc(7)) / 2) / 2;
const b = (jc(5) + (jc(3) + jc(6) - jc(4) - jc(7)) / 2) / 2;
const c = jc(5) - b;
const internal = (jc(3) + jc(6) - jc(5)) / 2 - b;
const paths = [a / 4, a * .75 + internal + b, a * .75 + internal + c, a * .75 + jc(5) - a];
const rate = .005, origin = 2000;
const dates = paths.map(path => origin + path / rate);
const fasta = '\uFEFF' + ['A', 'B', 'C', 'D'].map((id, i) =>
  `>${id} synthetic private substitutions\r\n${'A'.repeat(i * 5)}${'G'.repeat(i + 1)}${'A'.repeat(99 - i * 6)}\r\n`).join('');
const sampleTable = '\uFEFFsampleId,collectionDate,dateSource,accession,permutationGroup\r\n'
  + [3, 1, 0, 2].map(i => `${'ABCD'[i]},${dates[i]},analytical fixture,synthetic-${i},${i < 2 ? 'one' : 'two'}\r\n`).join('');
async function temporal(options: { table?: string; excluded?: string[]; treeKind?: 'demo' | 'local'; dateKind?: 'demo' | 'local' } = {}) {
  const original = await createAlignedPhylogenyExperiment({ name: 'Synthetic clock quartet', kind: options.treeKind ?? 'demo',
    reference: 'Analytical synthetic fixture, not biological evidence', fasta }, { distance: 'jc69', bootstrap: 20, seed: 42 });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(original.record), {
    outgroup: ['A'], fractionFromOutgroup: .25, evidence: 'Fixed synthetic root; not chosen using dates', dateIndependent: true });
  const metadata: RootedTemporalMetadata = { name: 'Analytic dated quartet', kind: options.dateKind ?? 'demo',
    description: 'Dates from independent quartet formulas at 0.005 substitutions/site/year', reference: null,
    license: 'CC0 synthetic fixture', sampleTable: options.table ?? sampleTable, dateIndependent: true };
  return createRootedTemporalExperiment(serializeAnalysisRecord(rooted.record), metadata,
    { permutations: 24, seed: 0, excludedSamples: options.excluded ?? [] });
}
async function rehash(record: AnalysisRecord) {
  return createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _sha, ...input }) => input) });
}
const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

describe('complete alignment-to-strict-clock experiment', () => {
  it('recovers the independently specified rate, root date and chronological branch durations', async () => {
    const parent = await temporal();
    const result = await createRootedDatingExperiment(serializeAnalysisRecord(parent.record));
    assert.equal(result.dating.status, 'fitted');
    close(result.dating.rate, rate); close(result.dating.rootDate!, origin);
    assert.equal(result.dating.certificate.converged, true);
    assert.ok(result.dating.sumSquaredResiduals < 1e-20);
    const tips = result.dating.nodes.filter(node => node.isTip);
    assert.equal(tips.length, 4);
    tips.forEach(tip => close(tip.date, dates['ABCD'.indexOf(tip.label!)]));
    for (const node of result.dating.nodes) {
      assert.ok(node.duration >= 0); close(node.fittedLength, node.sourceLength);
    }
    assert.deepEqual(result.record, parent.record); assert.deepEqual(result.result, parent.result);
    assert.equal(result.dating.clockValidated, false); assert.equal(result.dating.uncertainty, 'not-estimated');
    assert.match(exportDatedNewick(result.dating), /branch_units=years/);
  });
  it('replays both independent analyses and retains exact FASTA/table bytes inside a single file', async () => {
    const parent = await temporal(), content = serializeAnalysisRecord(parent.record);
    const result = await createRootedDatingExperiment(content);
    const replay = await replayRootedDatingExperiment('\uFEFF' + serializeAnalysisRecord(result.datingRecord));
    assert.deepEqual(replay, result);
    assert.equal(replay.datingRecord.method.id, ROOTED_DATING_METHOD.id);
    assert.deepEqual(replay.datingRecord.inputs[1].data, JSON.parse(content));
    assert.equal(replay.rootedSource.metadata.sampleTable, sampleTable);
    const root = JSON.parse(replay.rootedSource.content) as AnalysisRecord;
    assert.equal((root.inputs[0].data as { fasta: string }).fasta, fasta);
    assert.equal(replay.record.seed, 0); assert.equal(replay.datingRecord.seed, null);
  });
  it('matches the existing clock solver and portable standalone fit without changing their method', async () => {
    const parent = await temporal(), dating = fitDatedTree(parent.dataset);
    const standalone = await createDatedTreeRecord(parent.dataset, dating);
    const linked = await createRootedDatingExperiment(serializeAnalysisRecord(parent.record));
    assert.deepEqual(linked.dating, dating);
    assert.deepEqual(linked.datingRecord.fields.dating, standalone.fields.dating);
    assert.equal((linked.datingRecord.fields.lineage.value as { fitResultId: string }).fitResultId, standalone.resultId);
    assert.deepEqual(await replayRootedTemporalExperiment(serializeAnalysisRecord(parent.record)), parent);
  });
  it('fits interval-dated tips within their bounds without using midpoints or diagnostic exclusions to prune', async () => {
    const interval = Math.floor(dates[3]);
    const table = sampleTable.replace(String(dates[3]), String(interval));
    const parent = await temporal({ table, excluded: ['A'] });
    assert.equal(parent.result.regression, null);
    const result = await createRootedDatingExperiment(serializeAnalysisRecord(parent.record));
    assert.equal(result.dating.status, 'fitted');
    assert.equal(result.dating.exactTips, 3); assert.equal(result.dating.intervalTips, 1);
    const tip = result.dating.nodes.find(node => node.label === 'D')!;
    assert.deepEqual(tip.dateRange, { lower: interval, upper: interval + 1 });
    close(tip.date, dates[3]); assert.ok(Math.abs(tip.date - (interval + .5)) > .01);
    assert.equal(result.dating.nodes.filter(node => node.isTip).length, 4);
    assert.deepEqual(result.result.options.excludedSamples, ['A']);
  });
  it('retains supplied-rate provenance and distinguishes it from estimation', async () => {
    const parent = await temporal(), options: Partial<DatingOptions> = { rateMode: 'fixed', fixedRate: rate, rateSource: 'Explicit synthetic rate' };
    const result = await createRootedDatingExperiment(serializeAnalysisRecord(parent.record), options);
    close(result.dating.rate, rate); close(result.dating.rootDate!, origin);
    assert.equal(result.datingRecord.parameters.rateSource, 'Explicit synthetic rate');
    assert.deepEqual(await replayRootedDatingExperiment(serializeAnalysisRecord(result.datingRecord)), result);
  });
  it('keeps synthetic evidence synthetic when either source is a demo', async () => {
    for (const [treeKind, dateKind] of [['demo', 'local'], ['local', 'demo'], ['local', 'local']] as const) {
      // The local/local case tests the provenance branch, not an empirical dataset.
      const parent = await temporal({ treeKind, dateKind });
      const result = await createRootedDatingExperiment(serializeAnalysisRecord(parent.record));
      assert.equal(result.datingRecord.fields.dating.kind, treeKind === 'demo' || dateKind === 'demo' ? 'demo' : 'fitted-estimate');
    }
  });
  it('preserves a rate-boundary certificate without publishing a dated tree', async () => {
    const result = await createRootedDatingExperiment(serializeAnalysisRecord((await temporal()).record), { maximumRate: rate / 2 });
    assert.equal(result.dating.status, 'rate-boundary'); assert.equal(result.dating.rootDate, null);
    assert.deepEqual(result.dating.nodes, []); assert.equal(result.dating.certificate.converged, true);
    assert.throws(() => exportDatedNewick(result.dating), /Only a certified/);
    assert.deepEqual(await replayRootedDatingExperiment(serializeAnalysisRecord(result.datingRecord)), result);
  });
  it('preserves iteration-limited unresolved output without turning it into a fit', async () => {
    const result = await createRootedDatingExperiment(serializeAnalysisRecord((await temporal()).record), { maximumRate: rate / 2, maxIterations: 1 });
    assert.equal(result.dating.status, 'unresolved'); assert.equal(result.dating.certificate.converged, false);
    assert.equal(result.dating.rootDate, null); assert.deepEqual(result.dating.nodes, []);
    assert.deepEqual(await replayRootedDatingExperiment(serializeAnalysisRecord(result.datingRecord)), result);
  });
  it('refuses missing dates and same-date rate estimation instead of silently pruning or inventing variation', async () => {
    const missing = await temporal({ table: sampleTable.replace(String(dates[3]), '') });
    await assert.rejects(createRootedDatingExperiment(serializeAnalysisRecord(missing.record)), /Every dated-tree tip/);
    const same = await temporal({ table: dates.reduce((table, date) => table.replace(String(date), '2001.0'), sampleTable) });
    await assert.rejects(createRootedDatingExperiment(serializeAnalysisRecord(same.record)), /two different exact tip dates/);
    const fixed = await createRootedDatingExperiment(serializeAnalysisRecord(same.record), { rateMode: 'fixed', fixedRate: rate, rateSource: 'Synthetic assumption' });
    assert.equal(fixed.dating.status, 'fitted'); assert.equal(fixed.dating.nodes.filter(node => node.isTip).length, 4);
  });
  it('rejects rehashed false trees, fitted dates, certificates and lineage', async () => {
    const original = await createRootedDatingExperiment(serializeAnalysisRecord((await temporal()).record));
    for (const mutate of [
      (r: AnalysisRecord) => { (r.inputs[0].data as { tree: { newick: string } }).tree.newick = '(A:1,B:2,C:3,D:4);'; },
      (r: AnalysisRecord) => { (r.fields.dating.value as { rootDate: number }).rootDate = 1990; },
      (r: AnalysisRecord) => { (r.fields.dating.value as { certificate: { iterations: number } }).certificate.iterations = 999; },
      (r: AnalysisRecord) => { (r.fields.lineage.value as { temporalResultId: string }).temporalResultId = '0'.repeat(64); },
    ]) {
      const changed = structuredClone(original.datingRecord); mutate(changed);
      const content = serializeAnalysisRecord(await rehash(changed));
      await parseAnalysisRecord(content);
      await assert.rejects(replayRootedDatingExperiment(content), /differs from saved evidence/);
    }
  });
  it('recomputes the nested parent even when every enclosing checksum is regenerated', async () => {
    const result = await createRootedDatingExperiment(serializeAnalysisRecord((await temporal()).record));
    const modified = structuredClone(result.datingRecord), parent = modified.inputs[1].data as unknown as AnalysisRecord;
    (parent.fields.regression.value as { slope: number }).slope = 12;
    modified.inputs[1].data = JSON.parse(serializeAnalysisRecord(await rehash(parent)));
    const content = serializeAnalysisRecord(await rehash(modified));
    await parseAnalysisRecord(content);
    await assert.rejects(replayRootedDatingExperiment(content), /temporal experiment differs/);
  });
  it('rejects incomplete, extra and substituted method contracts', async () => {
    const parent = await temporal(); const linked = await createRootedDatingExperiment(serializeAnalysisRecord(parent.record));
    for (const mutate of [
      (r: AnalysisRecord) => { r.inputs.pop(); },
      (r: AnalysisRecord) => { delete r.parameters.maxIterations; },
      (r: AnalysisRecord) => { r.parameters.extra = true; },
    ]) {
      const copy = structuredClone(linked.datingRecord); mutate(copy);
      await assert.rejects(replayRootedDatingExperiment(serializeAnalysisRecord(await rehash(copy))), /every explicit clock option/);
    }
    await assert.rejects(createRootedDatingExperiment(parent.rootedSource.content), /method\/version/);
    await assert.rejects(replayRootedDatingExperiment(serializeAnalysisRecord(parent.record)), /method\/version/);
  });
  it('snapshots settings before async replay and cancels at each workflow boundary', async () => {
    const content = serializeAnalysisRecord((await temporal()).record);
    const options: Partial<DatingOptions> = { rateMode: 'fixed', fixedRate: rate, rateSource: 'Original rate' };
    const pending = createRootedDatingExperiment(content, options); options.fixedRate = .1; options.rateSource = 'Changed';
    assert.equal((await pending).dating.options.fixedRate, rate);
    for (const phase of [null, 'Replaying', 'Fitting', 'Binding']) {
      const owner = new AbortController(); if (!phase) owner.abort();
      await assert.rejects(createRootedDatingExperiment(content, {}, owner.signal, message => {
        if (phase && message.startsWith(phase)) owner.abort();
      }), { name: 'AbortError' });
    }
  });
  it('rejects oversized imports and malformed fixed rates before producing results', async () => {
    await assert.rejects(replayRootedDatingExperiment(' '.repeat(10 * 1024 * 1024 + 1)), /10 MiB/);
    await assert.rejects(createRootedDatingExperiment('{}', { rateMode: 'fixed', fixedRate: rate }), /explicit source/);
  });
});
