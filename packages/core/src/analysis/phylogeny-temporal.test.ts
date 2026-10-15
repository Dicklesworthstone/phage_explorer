import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAlignedPhylogenyExperiment } from './aligned-phylogeny';
import { rootAlignedPhylogenyExperiment, type OutgroupRooting } from './phylogeny-rooting';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { createRootedTemporalExperiment, prepareRootedTemporalDataset, replayRootedTemporalExperiment,
  ROOTED_TEMPORAL_METHOD, type RootedTemporalMetadata } from './phylogeny-temporal';

const source = {
  name: 'Synthetic private-substitution quartet', kind: 'demo' as 'demo' | 'local',
  reference: 'Hand-constructed columns, not experimental phage data.',
  fasta: ['A', 'B', 'C', 'D'].map((id, i) => `>${id}\n${'A'.repeat(i * 5)}${'G'.repeat(i + 1)}${'A'.repeat(100 - i * 5 - i - 1)}\n`).join(''),
};
const decision: OutgroupRooting = { outgroup: ['A'], fractionFromOutgroup: .25,
  evidence: 'Fixed synthetic outgroup placement, independent of fixture dates.', dateIndependent: true };
const metadata: RootedTemporalMetadata = { name: 'Synthetic dated quartet', kind: 'demo', description: 'Synthetic independently ordered sample metadata',
  reference: null, license: 'CC0 synthetic fixture', dateIndependent: true,
  sampleTable: 'sampleId,collectionDate,dateSource,permutationGroup\nD,2003.0,synthetic,two\nB,2001.0,synthetic,one\nA,2000.0,synthetic,one\nC,2002.0,synthetic,two\n' };
const options = { permutations: 24, seed: 42 };
async function parent(distance: 'jc69' | 'p-distance' = 'jc69', kind: 'demo' | 'local' = 'demo', fraction = .25) {
  // Power-of-two length gives exact p-distances and avoids unrelated roundoff-negative limbs.
  const fasta = distance === 'p-distance' ? source.fasta.split('\n').map(line => line && !line.startsWith('>') ? line + 'A'.repeat(28) : line).join('\n') : source.fasta;
  const original = await createAlignedPhylogenyExperiment({ ...source, kind, fasta }, { distance, bootstrap: 20, seed: 42 });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(original.record), { ...decision, fractionFromOutgroup: fraction });
  return { original, rooted, content: serializeAnalysisRecord(rooted.record) };
}
async function rehash(record: AnalysisRecord): Promise<AnalysisRecord> {
  return createAnalysisRecord({ method: record.method, inputs: record.inputs.map(({ sha256: _hash, ...input }) => input),
    parameters: record.parameters, seed: record.seed, references: record.references, fields: record.fields });
}
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} differs from ${b}`);

describe('alignment-backed temporal experiment', () => {
  it('joins samples by ID and matches independently calculated quartet path sums, slope and permutation tail', async () => {
    const { original, rooted, content } = await parent();
    const experiment = await createRootedTemporalExperiment(content, metadata, options);
    // For this explicit quartet, NJ joins A/D. Distances depend only on the
    // independently specified counts of disjoint private substitutions.
    const d = (n: number) => -.75 * Math.log(1 - 4 * (n / 100) / 3);
    const a = (d(5) + (d(3) + d(4) - d(6) - d(7)) / 2) / 2;
    const b = (d(5) + ((d(3) + d(6) - d(5)) / 2 - (d(4) + d(7) - d(5)) / 2)) / 2;
    const c = d(5) - b;
    const internal = (d(3) + d(6) - d(5)) / 2 - b;
    const paths = [a / 4, a * .75 + internal + b, a * .75 + internal + c, a * .75 + d(5) - a];
    const tips = new Map(experiment.result.tips.map(row => [row.id, row]));
    ['A', 'B', 'C', 'D'].forEach((id, i) => { close(tips.get(id)!.distance, paths[i]); assert.equal(tips.get(id)!.date, 2000 + i); });
    const mean = paths.reduce((sum, v) => sum + v, 0) / 4;
    const slope = paths.reduce((sum, v, i) => sum + (i - 1.5) * (v - mean), 0) / 5;
    close(experiment.result.regression!.slope, slope);
    assert.deepEqual(experiment.result.randomization, { mode: 'exact', draws: 24, extreme: 1, tailFraction: 1 / 24, groups: 1 });
    assert.equal(experiment.dataset.tree.newick, rooted.result.newick);
    assert.equal(experiment.rootedResultId, rooted.record.resultId);
    assert.equal(experiment.unrootedResultId, original.record.resultId);
    assert.equal(experiment.result.clockCalibrated, false);
    assert.deepEqual(experiment.record.inputs[1].data, JSON.parse(content));
  });
  it('replays every parent stage and preserves exact input bytes and result identity', async () => {
    const { content } = await parent();
    const input = { ...metadata, sampleTable: '\uFEFF' + metadata.sampleTable.replaceAll('\n', '\r\n') };
    const experiment = await createRootedTemporalExperiment(content, input, options);
    const replayed = await replayRootedTemporalExperiment(serializeAnalysisRecord(experiment.record));
    assert.deepEqual(replayed, experiment);
    assert.equal(replayed.rootedSource.metadata.sampleTable, input.sampleTable);
    assert.equal(replayed.record.method.id, ROOTED_TEMPORAL_METHOD.id);
    assert.ok(replayed.record.references.some(reference => reference.id === 'root-to-tip'));
    assert.ok(replayed.record.references.some(reference => reference.id.includes('a040454')));
  });
  it('supports table-only preparation without inventing a fitted result', async () => {
    const prepared = await prepareRootedTemporalDataset((await parent()).content, metadata);
    assert.equal(prepared.dataset.samples.length, 4);
    assert.ok(!('record' in prepared)); assert.ok(!('result' in prepared));
  });
  it('refuses p-distance instead of changing branch units or silently rerunning with JC69', async () => {
    await assert.rejects(createRootedTemporalExperiment((await parent('p-distance')).content, metadata), /requires a JC69/);
  });
  it('refuses an unrooted parent, including one with an arbitrary Newick display root', async () => {
    const { original } = await parent();
    await assert.rejects(createRootedTemporalExperiment(serializeAnalysisRecord(original.record), metadata), /method\/version/);
  });
  it('preserves demo status when either the alignment or dates are synthetic', async () => {
    for (const [treeKind, datesKind] of [['demo', 'local'], ['local', 'demo'], ['local', 'local']] as const) {
      // 'local' exercises a provenance branch with synthetic test data, not a biological validation claim.
      const result = await createRootedTemporalExperiment((await parent('jc69', treeKind)).content, { ...metadata, kind: datesKind }, options);
      const demo = treeKind === 'demo' || datesKind === 'demo';
      assert.equal(result.dataset.source.kind, demo ? 'demo' : 'local');
      assert.equal(result.record.fields.regression.kind, demo ? 'demo' : 'fitted-estimate');
      assert.equal(result.record.inputs[1].source, treeKind);
      assert.equal(result.record.inputs[2].source, datesKind);
    }
  });
  it('preserves missing, uncertain and explicitly excluded dates without replacing them by numeric dates', async () => {
    const input = { ...metadata, sampleTable: 'sampleId,collectionDate,dateSource\nA,2000,year only\nB,,not collected\nC,2002.0,synthetic\n' };
    const result = await createRootedTemporalExperiment((await parent()).content, input, { ...options, excludedSamples: ['C'] });
    const rows = new Map(result.result.tips.map(tip => [tip.id, tip]));
    assert.match(rows.get('A')!.exclusion!, /Uncertain/); assert.equal(rows.get('A')!.date, null);
    assert.match(rows.get('B')!.exclusion!, /Missing collection/); assert.match(rows.get('D')!.exclusion!, /Missing sample/);
    assert.equal(rows.get('C')!.exclusion, 'Explicit user exclusion');
    assert.equal(result.record.fields.regression.kind, 'unavailable');
    assert.equal(result.result.regression, null); assert.equal(result.result.randomization, null);
    assert.deepEqual(await replayRootedTemporalExperiment(serializeAnalysisRecord(result.record)), result);
  });
  it('retains grouped permutations and explicit seed rather than falling back to defaults', async () => {
    const result = await createRootedTemporalExperiment((await parent()).content, metadata,
      { permutations: 19, seed: 0, permutationScheme: 'within-groups', excludedSamples: [] });
    assert.deepEqual(result.result.randomization, { mode: 'exact', draws: 4, extreme: 1, tailFraction: .25, groups: 2 });
    assert.equal(result.record.seed, 0); assert.equal(result.record.parameters.permutationScheme, 'within-groups');
  });
  it('rejects wrong or duplicate sample IDs instead of silently joining by order', async () => {
    const { content } = await parent();
    for (const replacement of ['X,2000.0', 'B,2000.0']) {
      await assert.rejects(prepareRootedTemporalDataset(content, { ...metadata, sampleTable: metadata.sampleTable.replace('A,2000.0', replacement) }), /unique and match/);
    }
  });
  it('changes identity and diagnostics when root placement changes, without changing alignment identity', async () => {
    const a = await createRootedTemporalExperiment((await parent()).content, metadata, options);
    const b = await createRootedTemporalExperiment((await parent('jc69', 'demo', .75)).content, metadata, options);
    assert.equal(a.unrootedResultId, b.unrootedResultId);
    assert.notEqual(a.rootedResultId, b.rootedResultId); assert.notEqual(a.record.resultId, b.record.resultId);
    assert.notEqual(a.result.regression!.slope, b.result.regression!.slope);
  });
  it('rejects independently rehashed false parent branches before fitting dates', async () => {
    const { rooted } = await parent();
    const modified = structuredClone(rooted.record);
    (modified.fields.rooting.value as unknown as { newick: string }).newick = '(A:1,B:2,C:3,D:4);';
    const forged = await rehash(modified);
    await parseAnalysisRecord(serializeAnalysisRecord(forged));
    await assert.rejects(createRootedTemporalExperiment(serializeAnalysisRecord(forged), metadata), /Recomputed rooted phylogeny differs/);
  });
  it('rejects rehashed false derived distances, date metadata and fit outputs', async () => {
    const experiment = await createRootedTemporalExperiment((await parent()).content, metadata, options);
    const cases = [
      (r: AnalysisRecord) => { (r.inputs[0].data as unknown as { tree: { newick: string } }).tree.newick = '(A:1,B:2,C:3,D:4);'; },
      (r: AnalysisRecord) => { (r.inputs[0].data as unknown as { samples: { collectionDate: number }[] }).samples[0].collectionDate = 2500; },
      (r: AnalysisRecord) => { (r.fields.regression.value as unknown as { slope: number }).slope = 123; },
      (r: AnalysisRecord) => { (r.inputs[2].data as unknown as RootedTemporalMetadata).sampleTable = metadata.sampleTable.replace('2003.0', '2004.0'); },
    ];
    for (const change of cases) {
      const copy = structuredClone(experiment.record); change(copy);
      const forged = serializeAnalysisRecord(await rehash(copy));
      await parseAnalysisRecord(forged);
      await assert.rejects(replayRootedTemporalExperiment(forged), /differs from saved evidence/);
    }
  });
  it('refuses incomplete and extra replay contracts even when rehashed', async () => {
    const experiment = await createRootedTemporalExperiment((await parent()).content, metadata, options);
    for (const missing of ['input', 'parameter', 'extra']) {
      const copy = structuredClone(experiment.record);
      if (missing === 'input') copy.inputs.pop();
      else if (missing === 'parameter') delete copy.parameters.seed;
      else copy.parameters.unused = true;
      await assert.rejects(replayRootedTemporalExperiment(serializeAnalysisRecord(await rehash(copy))), /every explicit diagnostic option/);
    }
  });
  it('snapshots metadata and exclusions before replay yields', async () => {
    const { content } = await parent(), input = { ...metadata }, settings = { ...options, excludedSamples: [] as string[] };
    const expected = await createRootedTemporalExperiment(content, input, settings);
    const pending = createRootedTemporalExperiment(content, input, settings);
    input.name = 'changed'; input.sampleTable = ''; settings.excludedSamples.push('A'); settings.seed = 99;
    assert.deepEqual(await pending, expected);
  });
  it('cancels before starting and while awaiting the verified parent', async () => {
    const { content } = await parent();
    for (const before of [true, false]) {
      const owner = new AbortController(); if (before) owner.abort();
      const work = createRootedTemporalExperiment(content, metadata, options, owner.signal);
      owner.abort(); await assert.rejects(work, { name: 'AbortError' });
    }
  });
  it('requires explicit study design and bounded, complete metadata', async () => {
    const { content } = await parent();
    const bad = [ { ...metadata, dateIndependent: false }, { ...metadata, license: '' }, { ...metadata, name: 'x\n' },
      { ...metadata, kind: 'external' }, { ...metadata, extra: true }, { ...metadata, reference: undefined },
      { ...metadata, sampleTable: 'x'.repeat(2 * 1024 * 1024 + 1) } ];
    for (const input of bad) await assert.rejects(prepareRootedTemporalDataset(content, input as unknown as RootedTemporalMetadata));
    await assert.rejects(prepareRootedTemporalDataset('x'.repeat(10 * 1024 * 1024 + 1), metadata), /10 MiB/);
  });
});
