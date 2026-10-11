import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { createAlignedPhylogenyExperiment, type NeighborJoiningTree } from './aligned-phylogeny';
import { rootAlignedPhylogenyExperiment, replayRootedPhylogenyExperiment, resolveOutgroupRooting, type OutgroupRooting } from './phylogeny-rooting';

const fasta = '>A\nAAAAAAAA\n>B\nAAAAAAAA\n>C\nCCCCAAAA\n>D\nCCCCAAAA';
const decision = (): OutgroupRooting => ({ outgroup: ['A', 'B'], fractionFromOutgroup: 0.25,
  evidence: 'Synthetic root hypothesis chosen without dates; quarter-edge placement is a test assumption.', dateIndependent: true });
async function fixture(sequence = fasta, distance: 'p-distance' | 'jc69' = 'p-distance') {
  const experiment = await createAlignedPhylogenyExperiment({ name: 'Synthetic rooting oracle', kind: 'demo',
    reference: 'Hand-derived quartet with zero within-group and 0.5 between-group distances.', fasta: sequence },
  { distance, bootstrap: 0, seed: 0 });
  return { experiment, content: serializeAnalysisRecord(experiment.record) };
}
// Independent all-pairs shortest-path oracle, rather than mirroring the rooter's tree traversal.
function paths(tree: NeighborJoiningTree): number[][] {
  const d = tree.nodes.map((_, i) => tree.nodes.map((__, j) => i === j ? 0 : Infinity));
  for (const e of tree.edges) d[e.a][e.b] = d[e.b][e.a] = e.length;
  for (let k = 0; k < d.length; k++) for (let i = 0; i < d.length; i++) for (let j = 0; j < d.length; j++) d[i][j] = Math.min(d[i][j], d[i][k] + d[k][j]);
  return d;
}

describe('explicit outgroup root geometry', () => {
  test('roots a specified multi-taxon split at the hand-derived quarter edge', async () => {
    const { content, experiment } = await fixture();
    const rooted = await rootAlignedPhylogenyExperiment(content, decision());
    assert.equal(rooted.result.newick, "(('A':0,'B':0):0.125,('C':0,'D':0):0.375);");
    assert.equal(rooted.result.originalEdge.length, 0.5);
    assert.deepEqual(rooted.result.distancePreservation, { pairs: 6, maxAbsoluteDifference: 0 });
    assert.deepEqual(paths(rooted.result.tree).slice(0, 4).map(row => row.slice(0, 4)), [[0,0,.5,.5],[0,0,.5,.5],[.5,.5,0,0],[.5,.5,0,0]]);
    assert.equal(rooted.result.sourceResultId, experiment.record.resultId);
    assert.deepEqual(rooted.unrooted, experiment);
    assert.equal(serializeAnalysisRecord(experiment.record), content);
  });
  test('fraction is measured from the outgroup side regardless of edge orientation', async () => {
    const { content } = await fixture();
    const rooted = await rootAlignedPhylogenyExperiment(content, { ...decision(), outgroup: ['C', 'D'] });
    assert.equal(rooted.result.newick, "(('C':0,'D':0):0.125,('A':0,'B':0):0.375);");
  });
  test('supports a single outgroup while retaining all original tips and distances', async () => {
    const { content } = await fixture('>A\nAAAA\n>B\nAAAT\n>C\nCCAA');
    const rooted = await rootAlignedPhylogenyExperiment(content, { ...decision(), outgroup: ['B'] });
    const distances = paths(rooted.result.tree);
    assert.deepEqual(distances[rooted.result.tree.serializationRoot].slice(0, 3), [.1875, .0625, .6875]);
    assert.equal(distances[1][2], .75);
    assert.equal(rooted.result.tree.nodes.filter(node => node.label !== null).length, 3);
  });
  test('changing placement changes root paths and identity, not taxon-to-taxon paths', async () => {
    const { content } = await fixture();
    const a = await rootAlignedPhylogenyExperiment(content, decision());
    const b = await rootAlignedPhylogenyExperiment(content, { ...decision(), fractionFromOutgroup: .75 });
    assert.notEqual(a.record.resultId, b.record.resultId);
    assert.equal(a.result.sourceResultId, b.result.sourceResultId);
    assert.deepEqual(paths(a.result.tree).slice(0,4).map(row=>row.slice(0,4)), paths(b.result.tree).slice(0,4).map(row=>row.slice(0,4)));
    assert.notDeepEqual(paths(a.result.tree).at(-1), paths(b.result.tree).at(-1));
  });
  test('outgroup ordering is canonical and does not invent a second hypothesis', async () => {
    const { content } = await fixture();
    assert.deepEqual(await rootAlignedPhylogenyExperiment(content, decision()),
      await rootAlignedPhylogenyExperiment(content, { ...decision(), outgroup: ['B', 'A'] }));
  });
  test('rejects groups that are not separated by one edge rather than rearranging the tree', async () => {
    const { content } = await fixture();
    await assert.rejects(rootAlignedPhylogenyExperiment(content, { ...decision(), outgroup: ['A', 'C'] }), /one tree edge/);
  });
  test('refuses unknown labels and fewer than two ingroup taxa', async () => {
    const { content } = await fixture();
    await assert.rejects(rootAlignedPhylogenyExperiment(content, { ...decision(), outgroup: ['missing'] }), /original alignment/);
    await assert.rejects(rootAlignedPhylogenyExperiment(content, { ...decision(), outgroup: ['A', 'B', 'C'] }), /two ingroup/);
  });
  test('zero-length attachment cannot be used to assert a root placement', async () => {
    const { content } = await fixture();
    await assert.rejects(rootAlignedPhylogenyExperiment(content, { ...decision(), outgroup: ['A'] }), /zero length/);
  });
  test('negative JC69 limbs cannot be silently clipped into a usable rooted tree', async () => {
    const { content, experiment } = await fixture('>A\nAAAAAAAA\n>B\nAAAAAAAC\n>C\nAAAAAACC', 'jc69');
    assert.ok(experiment.result.tree.edges.some(edge => edge.length < 0));
    await assert.rejects(rootAlignedPhylogenyExperiment(content, { ...decision(), outgroup: ['A'] }), /Negative NJ limbs/);
    assert.equal(serializeAnalysisRecord(experiment.record), content);
  });
  test('rejects branch fractions whose multiplication loses the chosen placement', async () => {
    const { content } = await fixture();
    await assert.rejects(rootAlignedPhylogenyExperiment(content, { ...decision(), fractionFromOutgroup: Number.MIN_VALUE }), /numeric precision/);
  });
});

describe('root choice and reproducible evidence', () => {
  test('requires every choice explicitly, without a biological-root or midpoint default', () => {
    for (const invalid of [null, {}, { ...decision(), extra: true }, { ...decision(), evidence: '' }, { ...decision(), evidence: 'α'.repeat(1001) },
      { ...decision(), dateIndependent: false }, { ...decision(), dateIndependent: 'true' }, { ...decision(), fractionFromOutgroup: undefined }]) {
      assert.throws(() => resolveOutgroupRooting(invalid as OutgroupRooting));
    }
  });
  test('rejects invalid fractions, duplicate and sparse taxa lists', () => {
    for (const fractionFromOutgroup of [0, 1, -1, NaN, Infinity, '0.5']) assert.throws(() => resolveOutgroupRooting({ ...decision(), fractionFromOutgroup } as OutgroupRooting));
    for (const outgroup of [[], ['A','A'], ['<bad>'], new Array(2), Array.from({length:63},(_,i)=>`T${i}`)]) {
      assert.throws(() => resolveOutgroupRooting({ ...decision(), outgroup }));
    }
  });
  test('snapshots choices before asynchronous original-record verification', async () => {
    const { content } = await fixture(); const choice = decision();
    const pending = rootAlignedPhylogenyExperiment(content, choice);
    choice.outgroup[0] = 'C'; choice.evidence = 'edited later'; choice.fractionFromOutgroup = .9;
    const result = await pending;
    assert.deepEqual(result.result.rooting, decision());
  });
  test('replay recomputes both original NJ inference and the derived root record', async () => {
    const { content } = await fixture(); const rooted = await rootAlignedPhylogenyExperiment(content, decision());
    const saved = serializeAnalysisRecord(rooted.record);
    assert.deepEqual(await replayRootedPhylogenyExperiment(saved), rooted);
    assert.equal(rooted.record.inputs[0].source, 'demo'); assert.equal(rooted.record.seed, 0);
    assert.equal(rooted.record.fields.rooting.kind, 'sequence-score');
    assert.equal((rooted.record.inputs[0].data as {fasta:string}).fasta, fasta);
    assert.ok(rooted.result.warnings.some(warning=>warning.includes('no root-placement support')));
  });
  test('changed rooting evidence changes identity even when the geometric placement agrees', async () => {
    const { content } = await fixture(); const a = await rootAlignedPhylogenyExperiment(content, decision());
    const b = await rootAlignedPhylogenyExperiment(content, { ...decision(), evidence: 'Different user justification, same fractional choice.' });
    assert.equal(a.result.newick, b.result.newick); assert.notEqual(a.record.cacheKey, b.record.cacheKey);
  });
  test('rehashed invented original output is rejected before it can be rooted', async () => {
    const { experiment } = await fixture();
    const record = structuredClone(experiment.record); record.fields.phylogeny.value = { invented: true };
    const forged = await createAnalysisRecord(record);
    await assert.rejects(rootAlignedPhylogenyExperiment(serializeAnalysisRecord(forged), decision()), /Recomputed phylogeny/);
  });
  test('a self-consistent forged rooted Newick fails fresh replay, not just hash checking', async () => {
    const { content } = await fixture(); const rooted = await rootAlignedPhylogenyExperiment(content, decision());
    const record = structuredClone(rooted.record); (record.fields.rooting.value as {newick:string}).newick = '(invented);';
    const saved = serializeAnalysisRecord(await createAnalysisRecord(record));
    await parseAnalysisRecord(saved); // Positive control: hashes are internally consistent.
    await assert.rejects(replayRootedPhylogenyExperiment(saved), /Recomputed rooted phylogeny/);
  });
  test('missing original options and a wrong method version are not replayable', async () => {
    const { content } = await fixture(); const rooted = await rootAlignedPhylogenyExperiment(content, decision());
    const record = structuredClone(rooted.record); record.parameters.phylogeny = { distance: 'p-distance' };
    await assert.rejects(replayRootedPhylogenyExperiment(serializeAnalysisRecord(await createAnalysisRecord(record))), /every original/);
    const wrong = structuredClone(rooted.record); wrong.method.version = '99';
    await assert.rejects(replayRootedPhylogenyExperiment(serializeAnalysisRecord(await createAnalysisRecord(wrong))), /incompatible/);
  });
  test('pre-abort and abort during hashing refuse partial derived evidence', async () => {
    const { content } = await fixture(); const before = new AbortController(); before.abort();
    await assert.rejects(rootAlignedPhylogenyExperiment(content, decision(), before.signal), { name: 'AbortError' });
    const during = new AbortController(); const pending = rootAlignedPhylogenyExperiment(content, decision(), during.signal); during.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });
});
