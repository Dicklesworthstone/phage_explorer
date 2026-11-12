import { describe, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord, type AnalysisField } from '../analysis-result';
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
      // Deliberately forged: the spread over the field union is not a valid AnalysisField.
      phylogeny: { ...experiment.record.fields.phylogeny, value: { fabricated: true } } as unknown as AnalysisField } });
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

describe('Kimura two-parameter aligned distances', () => {
  test('classifies all twelve directed base changes against separate analytical oracles', () => {
    const transitions = new Set(['AG', 'GA', 'CT', 'TC']);
    for (const left of 'ACGT') for (const right of 'ACGT') {
      if (left === right) continue;
      const result = inferAlignedPhylogeny(fasta({ A: left.repeat(10), B: right + left.repeat(9), C: left.repeat(10) }), { distance: 'k80' });
      const transition = transitions.has(left + right);
      near(result.distances[0][1], transition ? 0.11157177565710488 : 0.10846614565746557);
      assert.equal(result.distances[1][0], result.distances[0][1]); assert.equal(result.distances[0][2], 0);
      assert.deepEqual(result.k80Comparisons?.[0], { taxonA: 'A', taxonB: 'B', comparedSites: 10,
        transitions: transition ? 1 : 0, transversions: transition ? 0 : 1 });
    }
  });
  test('recovers known evolutionary distance from Kimura forward transition probabilities', () => {
    // Independent forward-model oracle: Kimura (1980), Eqs. 5–6 and 9.
    // alpha*t=.1, beta*t=.025 imply K=2*alpha*t+4*beta*t=.3.
    const n = 100000, alphaT = .1, betaT = .025;
    const p = .25 - .5 * Math.exp(-4 * (alphaT + betaT)) + .25 * Math.exp(-8 * betaT);
    const q = .5 - .5 * Math.exp(-8 * betaT);
    const transitions = Math.round(n * p), transversions = Math.round(n * q);
    const result = inferAlignedPhylogeny(fasta({ A: 'A'.repeat(n),
      B: 'G'.repeat(transitions) + 'C'.repeat(transversions) + 'A'.repeat(n - transitions - transversions),
      C: 'A'.repeat(n) }), { distance: 'k80' });
    near(result.distances[0][1], 2 * alphaT + 4 * betaT, 1e-5);
    assert.equal(result.k80Comparisons?.[0].transitions, 15142);
    assert.equal(result.k80Comparisons?.[0].transversions, 9063);
  });
  test('matches the published 438-site example with 58 transitions and 63 transversions', () => {
    const changed = 'G'.repeat(58) + 'C'.repeat(63) + 'A'.repeat(317);
    const result = inferAlignedPhylogeny(fasta({ A: 'A'.repeat(438), B: changed, C: changed }), { distance: 'k80' });
    near(result.distances[0][1], 0.3474993549801952);
    assert.deepEqual(result.k80Comparisons?.[0],
      { taxonA: 'A', taxonB: 'B', comparedSites: 438, transitions: 58, transversions: 63 });
  });
  test('reduces to JC69 when the observed transition fraction is half the transversion fraction', () => {
    const input = fasta({ A: 'A'.repeat(100), B: 'G'.repeat(10) + 'C'.repeat(20) + 'A'.repeat(70), C: 'A'.repeat(100) });
    near(inferAlignedPhylogeny(input, { distance: 'k80' }).distances[0][1],
      inferAlignedPhylogeny(input, { distance: 'jc69' }).distances[0][1]);
  });
  test('counts substitutions only on the common complete-deletion mask', () => {
    const result = inferAlignedPhylogeny(fasta({ A: 'A'.repeat(10) + 'ACA', B: 'G' + 'A'.repeat(9) + 'GTC',
      C: 'A'.repeat(10) + 'N-?' }), { distance: 'k80' });
    assert.equal(result.usedSites, 10); assert.deepEqual(result.excludedColumns, [10, 11, 12]);
    near(result.distances[0][1], 0.11157177565710488);
    assert.deepEqual(result.k80Comparisons?.[0], { taxonA: 'A', taxonB: 'B', comparedSites: 10, transitions: 1, transversions: 0 });
  });
  test('rejects both exact saturation boundaries, including mixed transition and transversion counts', () => {
    for (const [n, transitions, transversions] of [[8, 4, 0], [8, 0, 4], [13, 6, 1]]) {
      const input = fasta({ A: 'A'.repeat(n), B: 'G'.repeat(transitions) + 'C'.repeat(transversions) + 'A'.repeat(n - transitions - transversions), C: 'A'.repeat(n) });
      assert.throws(() => inferAlignedPhylogeny(input, { distance: 'k80' }), /K80 is undefined/);
      assert.equal(inferAlignedPhylogeny(input).distances[0][1], (transitions + transversions) / n);
    }
    const nearBoundary = fasta({ A: 'A'.repeat(101), B: 'G'.repeat(50) + 'A'.repeat(51), C: 'A'.repeat(101) });
    assert.ok(Number.isFinite(inferAlignedPhylogeny(nearBoundary, { distance: 'k80' }).distances[0][1]));
  });
  test('uses weighted transition counts and withholds all support if any replicate is saturated', () => {
    const input = fasta({ A: 'AAAA', B: 'AAAA', C: 'GAAA', D: 'GAAA' });
    const k80 = inferAlignedPhylogeny(input, { distance: 'k80', bootstrap: 200, seed: 0 });
    const jc69 = inferAlignedPhylogeny(input, { distance: 'jc69', bootstrap: 200, seed: 0 });
    assert.ok(k80.bootstrap.saturated > jc69.bootstrap.saturated);
    assert.equal(k80.bootstrap.completed + k80.bootstrap.saturated, 200);
    assert.equal(k80.bootstrap.supportAvailable, false);
    for (const split of k80.splits) { assert.equal(split.support, null); assert.equal(split.bootstrapCount, null); }
    assert.ok(k80.warnings.some(warning => warning.includes('K80') && warning.includes('saturated')));
    assert.deepEqual(k80, inferAlignedPhylogeny(input, { distance: 'k80', bootstrap: 200, seed: 0 }));
    assert.deepEqual(k80.k80Comparisons?.find(pair => pair.taxonA === 'A' && pair.taxonB === 'C'),
      { taxonA: 'A', taxonB: 'C', comparedSites: 4, transitions: 1, transversions: 0 });
  });
  test('replays K80 evidence and rejects rehashed false counts or a substituted model', async () => {
    const input = { ...source, fasta: fasta({ A: 'A'.repeat(80), B: 'A'.repeat(80),
      C: 'G'.repeat(10) + 'A'.repeat(70), D: 'G'.repeat(10) + 'A'.repeat(70) }) };
    const experiment = await createAlignedPhylogenyExperiment(input, { distance: 'k80', bootstrap: 20, seed: 0 });
    assert.deepEqual(experiment.result.bootstrap, { requested: 20, completed: 20, saturated: 0, supportAvailable: true });
    assert.equal(experiment.result.splits[0].support, 1);
    assert.ok(experiment.record.references.some(reference => reference.id === '10.1007/BF01731581'));
    assert.deepEqual(await replayAlignedPhylogenyExperiment(serializeAnalysisRecord(experiment.record)), experiment);
    const counts = experiment.result.k80Comparisons!.map((pair, i) => i ? pair : { ...pair, transitions: pair.transitions + 1 });
    const forged = await createAnalysisRecord({ ...experiment.record, fields: { ...experiment.record.fields,
      phylogeny: { ...experiment.record.fields.phylogeny, value: analysisJson({ ...experiment.result, k80Comparisons: counts }) } as AnalysisField } });
    await assert.rejects(replayAlignedPhylogenyExperiment(serializeAnalysisRecord(forged)), /Recomputed/);
    const changedModel = await createAnalysisRecord({ ...experiment.record, parameters: { ...experiment.record.parameters, distance: 'jc69' } });
    await assert.rejects(replayAlignedPhylogenyExperiment(serializeAnalysisRecord(changedModel)), /Recomputed/);
  });
  test('preserves pre-K80 portable p-distance and JC69 identities byte for byte', async () => {
    // Captured from unchanged main f065740 with the original quartet and explicit seed zero.
    const fixtures = [
      ['p-distance', '58646638e0fbe9f6e775001f8cfa2652dfb4118b5a138321a046284624556ac1', 'c23eacea034087b890a20da2680794ea103c67838e08f41d94c5c6040e5e776c'],
      ['jc69', '5289eec35702c1b0200713eb943b916504aaae53483cfea0f8e34850d225dd0c', 'a5a25d01435c2d51f37e43864b91e39c2b52d2dce2599041eaa6f23cc3d3348b'],
    ] as const;
    for (const [distance, cacheKey, resultId] of fixtures) {
      const experiment = await createAlignedPhylogenyExperiment(source, { distance, bootstrap: 20, seed: 0 });
      assert.equal(experiment.record.cacheKey, cacheKey); assert.equal(experiment.record.resultId, resultId);
      assert.ok(!('k80Comparisons' in experiment.result));
      assert.deepEqual(await replayAlignedPhylogenyExperiment(serializeAnalysisRecord(experiment.record)), experiment);
    }
  });
});
