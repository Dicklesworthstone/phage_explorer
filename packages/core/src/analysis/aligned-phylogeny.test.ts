import { describe, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { parseAlignedDNA, neighborJoining, inferAlignedPhylogeny, resolvePhylogenyOptions,
  createAlignedPhylogenyExperiment, replayAlignedPhylogenyExperiment, PHYLOGENY_LIMITS,
  type NeighborJoiningTree, type PhylogenySource } from './aligned-phylogeny';
const fasta = (records: Record<string, string>): string => Object.entries(records).map(([id, sequence]) => `>${id}\n${sequence}`).join('\n');
const alignment = fasta({ A: 'A'.repeat(80), B: 'A'.repeat(80), C: 'C'.repeat(40) + 'A'.repeat(40), D: 'C'.repeat(40) + 'A'.repeat(40) });
const source: PhylogenySource = { name: 'Synthetic quartet', fasta: alignment, kind: 'demo', reference: 'Hand-constructed independent quartet fixture, not collected phage sequences.' };
const near = (a: number, b: number, tolerance = 1e-12) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function pathDistance(tree: NeighborJoiningTree, a: string, b: string): number {
  const start = tree.nodes.find(node => node.label === a)!.id, target = tree.nodes.find(node => node.label === b)!.id;
  const stack = [{ id: start, parent: -1, length: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.id === target) return current.length;
    for (const edge of tree.edges) {
      const next = edge.a === current.id ? edge.b : edge.b === current.id ? edge.a : -1;
      if (next >= 0 && next !== current.parent) stack.push({ id: next, parent: current.id, length: current.length + edge.length });
    }
  }
  throw new Error('Disconnected tree');
}

describe('aligned DNA import and independent counts', () => {
  test('normalizes wrapped DNA and sorts identifiers, preserving gaps and missing values', () => {
    assert.deepEqual(parseAlignedDNA('\ufeff>C note\r\nAC\r\ngt\r\n>A\r\nAC-N\r\n>B\r\nAC?t'),
      [{ id: 'A', sequence: 'AC-N' }, { id: 'B', sequence: 'AC?T' }, { id: 'C', sequence: 'ACGT' }]);
  });
  for (const [label, value] of Object.entries({ duplicate: '>A\nAC\n>A\nAC\n>C\nAC', unequal: '>A\nAC\n>B\nACT\n>C\nAC', empty: '>A\n>B\n>C', unheaded: 'ACGT\n>A\nACGT', tooFew: '>A\nAC\n>B\nAC', identifier: '>A;injected\nAC\n>B\nAC\n>C\nAC', alphabet: '>A\nAU\n>B\nAC\n>C\nAC' })) {
    test(`rejects ${label} input`, () => assert.throws(() => parseAlignedDNA(value)));
  }
  test('keeps one complete-deletion mask, never pairwise opportunistic denominators', () => {
    const result = inferAlignedPhylogeny(fasta({ A: 'ACGTN-', B: 'ATGTAA', C: 'ACNTAA' }));
    assert.equal(result.usedSites, 3); assert.equal(result.variableSites, 1);
    assert.deepEqual(result.excludedColumns, [2, 4, 5]);
    assert.deepEqual(result.distances, [[0, 1 / 3, 0], [1 / 3, 0, 1 / 3], [0, 1 / 3, 0]]);
  });
  test('rejects all-missing columns rather than returning zero distances', () => assert.throws(() => inferAlignedPhylogeny(fasta({ A: 'NN', B: 'AC', C: 'GT' })), /No complete/));
  test('JC69 agrees with the analytical transform of one difference in ten sites', () => {
    const result = inferAlignedPhylogeny(fasta({ A: 'AAAAAAAAAA', B: 'CAAAAAAAAA', C: 'GAAAAAAAAA' }), { distance: 'jc69' });
    near(result.distances[0][1], -0.75 * Math.log(1 - 4 * 0.1 / 3));
  });
  test('saturated JC69 fails while p-distance remains an observed fraction', () => {
    const saturated = fasta({ A: 'AAAA', B: 'CCCA', C: 'TTTA' });
    assert.throws(() => inferAlignedPhylogeny(saturated, { distance: 'jc69' }), /undefined/);
    assert.equal(inferAlignedPhylogeny(saturated).distances[0][1], 0.75);
  });
  test('bounds UTF-8 input, taxon count, sites and total bootstrap work', () => {
    assert.throws(() => parseAlignedDNA('x'.repeat(PHYLOGENY_LIMITS.bytes + 1)), /limit/);
    assert.throws(() => parseAlignedDNA(Array.from({ length: 65 }, (_, i) => `>t${i}\nA`).join('\n')), /taxa/);
    assert.throws(() => parseAlignedDNA(`>A\n${'A'.repeat(100001)}`), /sites/);
    const costly = fasta(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`t${i}`, 'A'.repeat(20000)])));
    assert.throws(() => inferAlignedPhylogeny(costly, { bootstrap: 200 }), /budget/);
  });
});

describe('neighbor joining independent topology and branch oracles', () => {
  test('reconstructs a known nonclock additive quartet, not a UPGMA tree', () => {
    // A--1--u--2--v--4--C; B--3--u; D--6--v. Unequal tip depths.
    const ids = ['A', 'B', 'C', 'D'], matrix = [[0, 4, 7, 9], [4, 0, 9, 11], [7, 9, 0, 10], [9, 11, 10, 0]];
    const tree = neighborJoining(ids, matrix);
    assert.equal(tree.edges.length, 5); assert.equal(tree.nodes.length, 6);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) near(pathDistance(tree, ids[i], ids[j]), matrix[i][j]);
    const internal = tree.edges.filter(edge => tree.nodes[edge.a].label === null && tree.nodes[edge.b].label === null);
    assert.equal(internal.length, 1); near(internal[0].length, 2);
  });
  test('is stable under input permutations and does not mutate the original matrix', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const matrix = [[0, 5, 9, 9, 8], [5, 0, 10, 10, 9], [9, 10, 0, 8, 7], [9, 10, 8, 0, 3], [8, 9, 7, 3, 0]];
    const original = JSON.stringify(matrix), order = [4, 1, 3, 0, 2];
    const tree = neighborJoining(ids, matrix);
    assert.deepEqual(tree, neighborJoining(order.map(i => ids[i]), order.map(i => order.map(j => matrix[i][j]))));
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) near(pathDistance(tree, ids[i], ids[j]), matrix[i][j]);
    assert.equal(JSON.stringify(matrix), original);
  });
  test('preserves a negative limb in a nonmetric dissimilarity matrix', () => {
    const tree = neighborJoining(['A', 'B', 'C'], [[0, 1, 1], [1, 0, 4], [1, 4, 0]]);
    near(tree.edges.find(edge => tree.nodes[edge.b].label === 'A')!.length, -1);
    near(pathDistance(tree, 'B', 'C'), 4);
  });
  test('rejects asymmetric, sparse, infinite, negative and nonzero-diagonal inputs', () => {
    for (const matrix of [[[0, 1, 2], [0, 0, 2], [2, 2, 0]], [[1, 1, 1], [1, 0, 1], [1, 1, 0]], [[0, -1, 1], [-1, 0, 1], [1, 1, 0]], [[0, Infinity, 1], [Infinity, 0, 1], [1, 1, 0]], Array(3)]) {
      assert.throws(() => neighborJoining(['A', 'B', 'C'], matrix));
    }
  });
});

describe('unrooted split support, identifiability and replay', () => {
  test('finds the independently defined AB|CD quartet split and resamples with seed zero', () => {
    const result = inferAlignedPhylogeny(alignment, { bootstrap: 100, seed: 0 });
    assert.equal(result.splits.length, 1); assert.deepEqual(result.splits[0].side, ['A', 'B']); assert.deepEqual(result.splits[0].other, ['C', 'D']);
    near(result.splits[0].length, 0.5); near(result.distanceResidualRMSE, 0);
    assert.equal(result.splits[0].bootstrapCount, 100); assert.equal(result.splits[0].support, 1);
    assert.deepEqual(result, inferAlignedPhylogeny(alignment, { bootstrap: 100, seed: 0 }));
    assert.ok(result.newick.endsWith(';')); for (const id of result.taxa) assert.ok(result.newick.includes(`'${id}'`));
  });
  test('zero-length tie resolutions receive no supported splits', () => {
    const result = inferAlignedPhylogeny(fasta({ A: 'ACGT', B: 'ACGT', C: 'ACGT', D: 'ACGT' }), { bootstrap: 20 });
    assert.deepEqual(result.splits, []); assert.equal(result.variableSites, 0);
    assert.ok(result.warnings.some(warning => warning.includes('unresolved')));
  });
  test('withholds support when ANY requested JC69 bootstrap distance is saturated', () => {
    const result = inferAlignedPhylogeny(fasta({ A: 'AAAA', B: 'AAAA', C: 'CCAA', D: 'CCAA' }), { distance: 'jc69', bootstrap: 200, seed: 0 });
    assert.ok(result.bootstrap.saturated > 0); assert.equal(result.bootstrap.completed + result.bootstrap.saturated, 200);
    assert.equal(result.bootstrap.supportAvailable, false);
    for (const split of result.splits) { assert.equal(split.support, null); assert.equal(split.bootstrapCount, null); }
  });
  test('exports and replays exact sources and independently recomputed results', async () => {
    const experiment = await createAlignedPhylogenyExperiment(source, { bootstrap: 20, seed: 0 });
    const saved = serializeAnalysisRecord(experiment.record), loaded = await replayAlignedPhylogenyExperiment(saved);
    assert.deepEqual(loaded, experiment); assert.equal(loaded.source.kind, 'demo'); assert.equal(loaded.options.seed, 0);
  });
  test('rejects changed source bytes and unsupported method versions', async () => {
    const experiment = await createAlignedPhylogenyExperiment(source);
    const changed = structuredClone(experiment.record);
    changed.inputs[0].data = analysisJson({ ...source, fasta: alignment.replace('A\nA', 'A\nC') });
    await assert.rejects(replayAlignedPhylogenyExperiment(JSON.stringify(changed)), /checksum/);
    changed.method.version = '999'; await assert.rejects(replayAlignedPhylogenyExperiment(JSON.stringify(changed)), /incompatible/);
  });
  test('rejects forged results even after all content checksums have been recalculated', async () => {
    const experiment = await createAlignedPhylogenyExperiment(source);
    const forged = await createAnalysisRecord({ ...experiment.record, fields: { ...experiment.record.fields,
      phylogeny: { ...experiment.record.fields.phylogeny, value: { fabricated: true } } } });
    await assert.rejects(replayAlignedPhylogenyExperiment(serializeAnalysisRecord(forged)), /Recomputed/);
  });
  test('does not let changed defaults reinterpret an incomplete saved parameter set', async () => {
    const experiment = await createAlignedPhylogenyExperiment(source);
    const forged = await createAnalysisRecord({ ...experiment.record, parameters: { distance: 'p-distance' } });
    await assert.rejects(replayAlignedPhylogenyExperiment(serializeAnalysisRecord(forged)), /explicit/);
  });
  test('aborted calculations and replays never return accepted evidence', async () => {
    const controller = new AbortController(); controller.abort();
    assert.throws(() => inferAlignedPhylogeny(alignment, {}, controller.signal), /cancelled/);
    await assert.rejects(createAlignedPhylogenyExperiment(source, {}, controller.signal), /cancelled/);
    await assert.rejects(replayAlignedPhylogenyExperiment('{}', controller.signal), /cancelled/);
  });
  test('rejects unsupported options and malformed provenance', async () => {
    for (const input of [{ seed: -1 }, { seed: 2 ** 32 }, { bootstrap: 1 }, { bootstrap: 201 }, { bootstrap: NaN }]) assert.throws(() => resolvePhylogenyOptions(input));
    await assert.rejects(createAlignedPhylogenyExperiment({ ...source, reference: '' }), /provenance/);
  });
});
