import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { createAlignedPhylogenyExperiment, type NeighborJoiningTree } from './aligned-phylogeny';
import { rootAlignedPhylogenyExperiment, replayRootedPhylogenyExperiment, resolveOutgroupRooting,
  prepareRootedAncestralDataset, createRootedAncestralExperiment, replayRootedAncestralExperiment,
  ROOTED_ANCESTRAL_METHOD, type OutgroupRooting } from './phylogeny-rooting';
import { parseAncestralFasta, type AncestralDataset, type AncestralOptions, type AncestralResult } from './ancestral-reconstruction';

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

const ancestralRows = [
  { id: 'A', sequence: 'AAAAAAAAAAAAAAAAR-N?' },
  { id: 'B', sequence: 'AAAAAAAAAAAAAAAAAANN' },
  { id: 'C', sequence: 'CCCCAAAAAAAAAAAAY-??' },
  { id: 'D', sequence: 'CCCCAAAAAAAAAAAACANN' },
];
// Deliberately retain original header descriptions, row order, BOM, case and CRLF.
const ancestralFasta = '\uFEFF' + [3, 1, 0, 2].map(index => {
  const row = ancestralRows[index];
  return `>${row.id} supplied description ${row.id}\r\n${row.sequence.slice(0, 8).toLowerCase()} ${row.sequence.slice(8).toLowerCase()}`;
}).join('\r\n') + '\r\n';
const permission = 'Synthetic test alignment; reuse permitted.';
async function ancestralParent(distance: 'p-distance' | 'jc69' | 'k80' = 'jc69', fasta = ancestralFasta, kind: 'demo' | 'local' = 'demo') {
  const unrooted = await createAlignedPhylogenyExperiment({ name: 'Sourced quartet\noriginal label', kind,
    reference: 'Notebook A\nSupplied homologous alignment, synthetic root hypothesis.', fasta }, { distance, seed: 0, bootstrap: 0 });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(unrooted.record), decision());
  return { rooted, content: serializeAnalysisRecord(rooted.record) };
}
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

describe('verified rooted alignment to conditional ancestors', () => {
  test('retains original source bytes and every alignment column while deriving exact quoted tip IDs', async () => {
    const { rooted, content } = await ancestralParent();
    const prepared = await prepareRootedAncestralDataset('\uFEFF' + content, permission);
    assert.equal(rooted.unrooted.result.usedSites, 16);
    assert.equal(rooted.unrooted.result.alignmentSites, 20);
    assert.deepEqual(parseAncestralFasta(prepared.input.alignment.fasta), ancestralRows);
    assert.equal(prepared.input.tree.newick, rooted.result.newick);
    assert.equal(prepared.input.tree.units, 'substitutions/site');
    assert.match(prepared.input.tree.method, /^JC69 neighbor joining/);
    assert.equal(prepared.input.source.kind, 'demo');
    assert.equal(prepared.input.source.license, permission);
    assert.equal(prepared.input.name, 'Sourced quartet original label');
    assert.equal(prepared.rootedResultId, rooted.record.resultId);
    assert.equal(prepared.unrootedResultId, rooted.unrooted.record.resultId);
    assert.equal(prepared.rootedSource.content, content);
    const parent = JSON.parse(prepared.rootedSource.content) as AnalysisRecord;
    assert.equal((parent.inputs[0].data as { fasta: string }).fasta, ancestralFasta);
    assert.equal(serializeAnalysisRecord(rooted.record), content);
  });

  test('applies the ancestral gap/window policy to original sites omitted from NJ distances', async () => {
    const { content } = await ancestralParent();
    const missing = await createRootedAncestralExperiment(content, permission);
    const excluded = await createRootedAncestralExperiment(content, permission, { gapPolicy: 'exclude-column' });
    assert.equal(missing.result.alignmentColumns, 20);
    assert.equal(missing.result.analyzedColumns, 18);
    assert.equal(missing.result.sites[16].ambiguousTips, 2);
    assert.equal(missing.result.sites[17].column, 18);
    assert.equal(missing.result.sites[17].exclusion, null);
    assert.equal(excluded.result.sites[17].exclusion, 'gap');
    assert.deepEqual(missing.result.sites.slice(18).map(site => site.exclusion), ['all-missing', 'all-missing']);
    assert.equal(excluded.result.analyzedColumns, 17);
    assert.equal(missing.record.method.id, ROOTED_ANCESTRAL_METHOD.id);
    assert.equal(missing.record.fields.reconstruction.kind, 'demo');
    assert.deepEqual(missing.record.fields.lineage.coverage, { available: 2, total: 2, unit: 'records' });
    assert.deepEqual(await replayRootedAncestralExperiment(serializeAnalysisRecord(missing.record)), missing);
    assert.notEqual(missing.record.cacheKey, excluded.record.cacheKey);
    const window = await createRootedAncestralExperiment(content, permission, { startColumn: 17, endColumn: 18 });
    assert.deepEqual(window.result.sites.map(site => site.column), [17, 18]);
    assert.equal(parseAncestralFasta(window.input.alignment.fasta)[0].sequence.length, 20);
  });

  test('matches an independent closed-form root and joint-edge posterior for the inferred quartet', async () => {
    const { content } = await ancestralParent();
    const experiment = await createRootedAncestralExperiment(content, permission, { startColumn: 1, endColumn: 1 });
    // Four differences among sixteen retained columns give this exact JC69 edge.
    // Zero within-pair limbs fix the two endpoint states to A and C. Sum over
    // the four possible root states directly, without pruning or a tree parser.
    const distance = -0.75 * Math.log(2 / 3);
    const same = (t: number) => 0.25 + 0.75 * Math.exp(-4 * t / 3);
    const different = (t: number) => 0.25 - 0.25 * Math.exp(-4 * t / 3);
    const out = distance / 4, ingroup = distance * 3 / 4;
    const weights = [same(out) * different(ingroup), different(out) * same(ingroup),
      different(out) * different(ingroup), different(out) * different(ingroup)];
    const total = weights.reduce((sum, value) => sum + value, 0);
    const expected = weights.map(weight => weight / total), { nodes, patterns } = experiment.result;
    close(Math.exp(patterns[0].logLikelihood!), total / 4);
    patterns[0].nodes![0].forEach((value, state) => close(value, expected[state]));
    for (const [index, node] of nodes.entries()) {
      if (index === 0) continue;
      const label = node.label ?? nodes[node.children[0]].label!;
      const state = ['A', 'B'].includes(label) ? 0 : 1;
      patterns[0].nodes![index].forEach((value, s) => close(value, s === state ? 1 : 0));
      patterns[0].edges![index - 1].forEach((value, joint) => {
        const parentState = Math.floor(joint / 4), childState = joint % 4;
        const probability = childState !== state ? 0 : node.parent === 0 ? expected[parentState] : parentState === state ? 1 : 0;
        close(value, probability);
      });
    }
  });

  test('accepts K80 branch units while recording an independently supplied ancestral model and local provenance', async () => {
    const { rooted, content } = await ancestralParent('k80', ancestralFasta, 'local');
    const options: Partial<AncestralOptions> = { endColumn: 2, substitution: { model: 'HKY85',
      frequencies: [0.1, 0.2, 0.3, 0.4], kappa: 3, siteRates: [{ rate: 1, weight: 1 }], source: 'Explicit synthetic HKY assumption' } };
    const experiment = await createRootedAncestralExperiment(content, permission, options);
    assert.match(experiment.input.tree.method, /^K80 neighbor joining/);
    assert.equal(experiment.input.tree.newick, rooted.result.newick);
    assert.equal(experiment.result.options.substitution?.model, 'HKY85');
    assert.equal(experiment.record.fields.reconstruction.kind, 'simulation');
    assert.ok(experiment.record.inputs.every(input => input.source === 'local'));
    assert.ok(experiment.record.references.some(reference => reference.id === '10.1007/BF01731581'));
    assert.ok(experiment.record.references.some(reference => reference.id === 'substitution-model' && reference.version === 'HKY85'));
    assert.ok(experiment.result.warnings.some(warning => warning.includes('separate recorded assumption')));
    assert.deepEqual(await replayRootedAncestralExperiment(serializeAnalysisRecord(experiment.record)), experiment);
  });

  test('records default JC69 separately from the K80 distance model instead of estimating ancestral parameters', async () => {
    const { content } = await ancestralParent('k80');
    const experiment = await createRootedAncestralExperiment(content, permission, { endColumn: 1 });
    assert.equal(experiment.result.options.substitution, undefined);
    assert.ok(experiment.record.references.some(reference => reference.id === 'substitution-model' && reference.version === 'JC69'));
    assert.ok(experiment.result.warnings.some(warning => warning.startsWith('JC69 assumes')));
  });

  test('snapshots nested options before parent replay and binds license/model choices to identity', async () => {
    const { content } = await ancestralParent();
    const options: Partial<AncestralOptions> = { endColumn: 2, substitution: { model: 'HKY85', frequencies: [0.25, 0.25, 0.25, 0.25],
      kappa: 2, siteRates: [{ rate: 1, weight: 1 }], source: 'Declared model' } };
    const original = structuredClone(options), pending = createRootedAncestralExperiment(content, permission, options);
    options.endColumn = 20;
    if (options.substitution?.model === 'HKY85') { options.substitution.frequencies[0] = 0.9; options.substitution.kappa = 99; }
    const experiment = await pending;
    assert.equal(experiment.result.options.endColumn, 2);
    assert.deepEqual(experiment.result.options.substitution, original.substitution);
    const differentLicense = await createRootedAncestralExperiment(content, 'Alternate explicit permission', original);
    assert.deepEqual(differentLicense.result, experiment.result);
    assert.notEqual(differentLicense.record.cacheKey, experiment.record.cacheKey);
    assert.equal(differentLicense.rootedResultId, experiment.rootedResultId);
  });

  test('requires an explicit bounded license and a corrected rooted parent, never a generic or time-scaled record', async () => {
    const { content, rooted } = await ancestralParent();
    for (const license of ['', '   ', 'line\nbreak', '\u0000', 'x'.repeat(2001), 'α'.repeat(1001)]) {
      await assert.rejects(prepareRootedAncestralDataset(content, license), /license or usage permission/);
    }
    const pDistance = await ancestralParent('p-distance');
    await assert.rejects(prepareRootedAncestralDataset(pDistance.content, permission), /p-distance is not silently relabeled/);
    await assert.rejects(prepareRootedAncestralDataset(serializeAnalysisRecord(rooted.unrooted.record), permission), /incompatible/);
    const dated = structuredClone(rooted.record);
    dated.method = { id: 'rooted-nj-strict-clock-dating', version: '1.0.0', implementation: 'typescript' };
    await assert.rejects(prepareRootedAncestralDataset(serializeAnalysisRecord(await createAnalysisRecord(dated)), permission), /incompatible/);
    await assert.rejects(prepareRootedAncestralDataset(' '.repeat(10 * 1024 * 1024 + 1), permission), /10 MiB/);
  });

  test('rejects a hash-valid forged parent before deriving ancestry', async () => {
    const { rooted } = await ancestralParent();
    const parent = structuredClone(rooted.record);
    (parent.fields.rooting.value as { newick: string }).newick = "(('A':0,'B':0):0.1,('C':0,'D':0):0.2);";
    const forged = serializeAnalysisRecord(await createAnalysisRecord(parent));
    await parseAnalysisRecord(forged);
    await assert.rejects(createRootedAncestralExperiment(forged, permission), /Recomputed rooted phylogeny/);
  });

  test('fresh replay rejects substituted alignment, branches, lineage and posterior even after correct rehashing', async () => {
    const { content } = await ancestralParent();
    const experiment = await createRootedAncestralExperiment(content, permission, { endColumn: 2 });
    for (const mutate of [
      (record: AnalysisRecord) => { (record.inputs[0].data as unknown as AncestralDataset).alignment.fasta = '>A\nAA\n>B\nAA\n>C\nCC\n>D\nCC'; },
      (record: AnalysisRecord) => { (record.inputs[0].data as unknown as AncestralDataset).tree.newick = "(('A':0,'B':0):0.1,('C':0,'D':0):0.2);"; },
      (record: AnalysisRecord) => { (record.fields.lineage.value as { rootedResultId: string }).rootedResultId = '0'.repeat(64); },
      (record: AnalysisRecord) => { (record.fields.reconstruction.value as unknown as AncestralResult).patterns[0].nodes![0] = [1, 0, 0, 0]; },
    ]) {
      const record = structuredClone(experiment.record); mutate(record);
      const forged = serializeAnalysisRecord(await createAnalysisRecord(record));
      await parseAnalysisRecord(forged);
      await assert.rejects(replayRootedAncestralExperiment(forged), /Fresh linked ancestral evidence differs/);
    }
  });

  test('rejects substituted embedded parent output, missing parents and incompatible method versions', async () => {
    const { content } = await ancestralParent();
    const experiment = await createRootedAncestralExperiment(content, permission, { endColumn: 1 });
    const record = structuredClone(experiment.record), parent = record.inputs[1].data as unknown as AnalysisRecord;
    (parent.fields.rooting.value as { newick: string }).newick = '(invented);';
    record.inputs[1].data = JSON.parse(serializeAnalysisRecord(await createAnalysisRecord(parent)));
    await assert.rejects(replayRootedAncestralExperiment(serializeAnalysisRecord(await createAnalysisRecord(record))), /Recomputed rooted phylogeny/);
    const missing = structuredClone(experiment.record); missing.inputs.pop();
    await assert.rejects(replayRootedAncestralExperiment(serializeAnalysisRecord(await createAnalysisRecord(missing))), /requires the original rooted/);
    const wrong = structuredClone(experiment.record); wrong.method.version = '99';
    await assert.rejects(replayRootedAncestralExperiment(serializeAnalysisRecord(await createAnalysisRecord(wrong))), /incompatible/);
  });

  test('honors cancellation before work, during parent hashing and during reconstruction progress', async () => {
    const { content } = await ancestralParent();
    const before = new AbortController(); before.abort();
    await assert.rejects(prepareRootedAncestralDataset(content, permission, before.signal), { name: 'AbortError' });
    await assert.rejects(createRootedAncestralExperiment(content, permission, {}, before.signal), { name: 'AbortError' });
    const during = new AbortController();
    const pending = createRootedAncestralExperiment(content, permission, {}, during.signal); during.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const progressAbort = new AbortController();
    await assert.rejects(createRootedAncestralExperiment(content, permission, {}, progressAbort.signal, phase => {
      if (phase.startsWith('Reconstructing alignment columns')) progressAbort.abort();
    }), { name: 'AbortError' });
    const record = await createRootedAncestralExperiment(content, permission, { endColumn: 1 });
    await assert.rejects(replayRootedAncestralExperiment(serializeAnalysisRecord(record.record), before.signal), { name: 'AbortError' });
  });

  test('inherits reconstruction window bounds without truncating the retained source alignment', async () => {
    const long = ['A', 'B', 'C', 'D'].map((id, i) => `>${id}\n${i < 2 ? 'A'.repeat(5000) : 'C'.repeat(1000) + 'A'.repeat(4000)}`).join('\n');
    const { content } = await ancestralParent('jc69', long);
    const prepared = await prepareRootedAncestralDataset(content, permission);
    assert.equal(parseAncestralFasta(prepared.input.alignment.fasta)[0].sequence.length, 5000);
    await assert.rejects(createRootedAncestralExperiment(content, permission, { endColumn: 5000 }), /4096 columns/);
    const tail = await createRootedAncestralExperiment(content, permission, { startColumn: 4998, endColumn: 5000 });
    assert.equal(tail.result.alignmentColumns, 5000);
    assert.deepEqual(tail.result.sites.map(site => site.column), [4998, 4999, 5000]);
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
