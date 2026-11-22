import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { buildAlignmentPangenome, createAlignmentPangenomeRecord, type AlignmentGraphOptions, type PangenomeInput } from './alignment-pangenome';
import { createPangenomePhylogenyExperiment, replayAlignedPhylogenyExperiment, type PangenomePhylogenySource } from './aligned-phylogeny';
import { exportPhylogeny } from './phylogeny-export';
import { rootAlignedPhylogenyExperiment, replayRootedPhylogenyExperiment, createRootedAncestralExperiment,
  replayRootedAncestralExperiment, type OutgroupRooting } from './phylogeny-rooting';

// Independent 16-site additive quartet: one private change in B/D, four changes
// on AB|CD. The two insertion columns have no shared homology declaration.
const backbone = ['AAAACCCCGGGGTTTT', 'TAAACCCCGGGGTTTT', 'AAAATTTTGGGGTTTT', 'AAAATTTTGGGGTTTA'];
const inserted = backbone.map((row, i) => row.slice(0, 4) + ['--', 'TT', 'GG', 'TT'][i] + row.slice(4));
const ids = ['A', 'B', 'C', 'D'];
const expectedDistances = [[0, 1, 4, 5], [1, 0, 5, 6], [4, 5, 0, 1], [5, 6, 1, 0]].map(row => row.map(value => value / 16));
const provenance = 'Synthetic independent quartet with four shared substitutions and two private substitutions; insertion homology is intentionally unspecified.';
const rooting: OutgroupRooting = { outgroup: ['A', 'B'], fractionFromOutgroup: 0.5, evidence: 'Synthetic date-independent AB outgroup hypothesis.', dateIndependent: true };

async function parent(rows = inserted, settings: Partial<AlignmentGraphOptions> = { alignment: 'provided' }, kind: PangenomeInput['source'] = 'demo') {
  const input: PangenomeInput = { format: 'phage-explorer-pangenome', version: 1, name: 'Independent pangenome fixture', source: kind,
    sequences: rows.map((sequence, i) => ({ id: ids[i], description: `Original description ${ids[i]}`, sequence })) };
  const graph = buildAlignmentPangenome(input, { referenceId: 'A', terminalGaps: 'missing', ...settings });
  const record = await createAlignmentPangenomeRecord(input, graph);
  // Noncanonical whitespace/BOM are part of the original input, not discarded on export.
  const content = '\ufeff' + serializeAnalysisRecord(record).replace(/\n/g, '\r\n');
  const source: PangenomePhylogenySource = { name: 'Backbone quartet', reference: provenance, experiment: content };
  return { input, graph, record, content, source };
}
async function rehash(record: AnalysisRecord): Promise<string> {
  return serializeAnalysisRecord(await createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _sha, ...input }) => input) }));
}

describe('pangenome reference-backbone phylogeny', () => {
  test('excludes independent insertion columns and recovers hand-derived distances and AB|CD topology', async () => {
    const original = await parent();
    const experiment = await createPangenomePhylogenyExperiment(original.source, { bootstrap: 20, seed: 0 });
    const { result, pangenome } = experiment;
    assert.equal(experiment.record.method.version, '2.0.0');
    assert.equal(experiment.source.kind, 'demo');
    assert.equal(result.usedSites, 16); assert.equal(result.variableSites, 6);
    assert.deepEqual(result.distances, expectedDistances);
    assert.equal(result.splits.length, 1);
    assert.deepEqual(result.splits[0].side, ['A', 'B']); assert.deepEqual(result.splits[0].other, ['C', 'D']);
    assert.equal(result.splits[0].length, 0.25);
    assert.deepEqual(pangenome?.excludedReferenceGapColumns, [4, 5]);
    assert.deepEqual(pangenome?.backboneColumns, [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert.deepEqual(pangenome?.retainedAlignmentColumns, pangenome?.backboneColumns);
    assert.equal(pangenome?.parentResultId, original.record.resultId);
    assert.deepEqual(experiment.record.fields.pangenome.coverage, { available: 16, total: 18, unit: 'bases' });
    assert.equal(exportPhylogeny(experiment, 'pangenome-experiment'), original.content);
    assert.equal(exportPhylogeny(experiment, 'alignment-fasta'), ids.map((id, i) => `>${id}\n${backbone[i]}`).join('\n') + '\n');
    assert.match(exportPhylogeny(experiment, 'distances-tsv'), /# excluded_reference_gap_sites\t2/);
    assert.deepEqual(await replayAlignedPhylogenyExperiment(serializeAnalysisRecord(experiment.record)), experiment);
  });

  test('reports complete deletion in both projected and original coordinates with a shared denominator', async () => {
    const rows = [...inserted]; rows[2] = rows[2].slice(0, 14) + 'N' + rows[2].slice(15);
    const experiment = await createPangenomePhylogenyExperiment((await parent(rows)).source);
    assert.equal(experiment.result.usedSites, 15);
    assert.deepEqual(experiment.result.excludedColumns, [12]);
    assert.deepEqual(experiment.pangenome?.retainedAlignmentColumns, [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17]);
    assert.deepEqual(experiment.result.distances, [[0, 1, 4, 5], [1, 0, 5, 6], [4, 5, 0, 1], [5, 6, 1, 0]].map(row => row.map(value => value / 15)));
  });

  for (const alignment of ['global', 'wavefront', 'affine'] as const) {
    test(`reconstructs a real ${alignment} alignment from unaligned parent sequences`, async () => {
      // A/B share one backbone; C/D share the same independently known terminal
      // substitution. TT is inserted only in B/D after the four-base anchor.
      const rows = ['ACGTACGATCGT', 'ACGTTTACGATCGT', 'ACGTACGATCGC', 'ACGTTTACGATCGC'];
      const original = await parent(rows, { alignment }, 'local');
      const experiment = await createPangenomePhylogenyExperiment(original.source);
      assert.equal(experiment.source.kind, 'local');
      assert.equal(experiment.result.alignmentSites, 12); assert.equal(experiment.result.usedSites, 12);
      assert.deepEqual(experiment.result.distances, [[0, 0, 1 / 12, 1 / 12], [0, 0, 1 / 12, 1 / 12], [1 / 12, 1 / 12, 0, 0], [1 / 12, 1 / 12, 0, 0]]);
      assert.equal(experiment.pangenome?.excludedReferenceGapColumns.length, 2);
      assert.deepEqual(experiment.result.splits[0].side, ['A', 'B']);
      assert.deepEqual(await replayAlignedPhylogenyExperiment(serializeAnalysisRecord(experiment.record)), experiment);
    });
  }

  test('captures caller inputs and settings before yielding, and never relabels a demo parent as local', async () => {
    const original = await parent(); const options = { bootstrap: 0, seed: 17 };
    const pending = createPangenomePhylogenyExperiment(original.source, options);
    original.source.experiment = '{}'; original.source.name = 'Changed after submission'; options.seed = 99;
    const experiment = await pending;
    assert.equal(experiment.pangenome?.source.experiment, original.content);
    assert.equal(experiment.source.name, 'Backbone quartet'); assert.equal(experiment.options.seed, 17);
    assert.equal(experiment.source.kind, 'demo');
    await assert.rejects(createPangenomePhylogenyExperiment({ ...original.source, kind: 'local' } as PangenomePhylogenySource), /Supply a pangenome/);
  });

  test('rejects self-consistently rehashed parent graphs, parameters and child projection/results', async () => {
    const original = await parent();
    const graphForgery = structuredClone(original.record); graphForgery.fields.graph.value = { fabricated: true };
    await assert.rejects(createPangenomePhylogenyExperiment({ ...original.source, experiment: await rehash(graphForgery) }), /Recomputed pangenome/);
    const parameterForgery = structuredClone(original.record); parameterForgery.parameters.referenceId = 'B';
    await assert.rejects(createPangenomePhylogenyExperiment({ ...original.source, experiment: await rehash(parameterForgery) }), /Recomputed pangenome/);
    const experiment = await createPangenomePhylogenyExperiment(original.source);
    const maskForgery = structuredClone(experiment.record); (maskForgery.fields.pangenome.value as { retainedAlignmentColumns: number[] }).retainedAlignmentColumns.push(4);
    await assert.rejects(replayAlignedPhylogenyExperiment(await rehash(maskForgery)), /Recomputed pangenome/);
    const resultForgery = structuredClone(experiment.record); (resultForgery.fields.phylogeny.value as { distances: number[][] }).distances[0][1] = 0;
    await assert.rejects(replayAlignedPhylogenyExperiment(await rehash(resultForgery)), /Recomputed pangenome/);
    const policyForgery = structuredClone(experiment.record); policyForgery.parameters.columnPolicy = 'all-columns';
    await assert.rejects(replayAlignedPhylogenyExperiment(await rehash(policyForgery)), /reference-backbone/);
  });

  test('retains original parent bytes through explicit rooting, replay and conditional ancestral reconstruction', async () => {
    // This paired fixture has an exactly zero within-pair distance, so corrected
    // NJ limbs are nonnegative and rooting is well-defined without clipping.
    const rows = [inserted[0], inserted[0], inserted[2], inserted[2]];
    const original = await parent(rows);
    const experiment = await createPangenomePhylogenyExperiment(original.source, { distance: 'jc69' });
    const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(experiment.record), rooting);
    assert.equal(rooted.record.method.version, '2.0.0');
    assert.equal(rooted.record.inputs[0].id, 'unrootedPhylogeny');
    assert.deepEqual(await replayRootedPhylogenyExperiment(serializeAnalysisRecord(rooted.record)), rooted);
    assert.equal(rooted.unrooted.pangenome?.source.experiment, original.content);
    const ancestral = await createRootedAncestralExperiment(serializeAnalysisRecord(rooted.record), 'Synthetic test fixture', { endColumn: 16 });
    const replayed = await replayRootedAncestralExperiment(serializeAnalysisRecord(ancestral.record));
    const restoredRoot = await replayRootedPhylogenyExperiment(replayed.rootedSource.content);
    assert.equal(exportPhylogeny(restoredRoot.unrooted, 'pangenome-experiment'), original.content);
    assert.equal(replayed.input.alignment.fasta, experiment.source.fasta);
    const altered = structuredClone(rooted.record); (altered.parameters.phylogeny as { seed: number }).seed = 7;
    await assert.rejects(replayRootedPhylogenyExperiment(await rehash(altered)), /original phylogeny options/);
  });

  test('rejects too few taxa, empty complete-site sets, oversized backbones and aborted reconstruction', async () => {
    await assert.rejects(createPangenomePhylogenyExperiment((await parent(inserted.slice(0, 2))).source), /taxa/);
    await assert.rejects(createPangenomePhylogenyExperiment((await parent(['NN', 'AA', 'TT'])).source), /No complete/);
    await assert.rejects(createPangenomePhylogenyExperiment((await parent(['A'.repeat(100001), 'A'.repeat(100001), 'A'.repeat(100001)])).source), /100000/);
    const original = await parent(), before = new AbortController(); before.abort();
    await assert.rejects(createPangenomePhylogenyExperiment(original.source, {}, before.signal), { name: 'AbortError' });
    const during = new AbortController(); const pending = createPangenomePhylogenyExperiment(original.source, {}, during.signal); during.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });
});
