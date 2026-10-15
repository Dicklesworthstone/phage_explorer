import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createAlignedPhylogenyExperiment } from './aligned-phylogeny';
import { exportPhylogeny, exportSupportedNewick } from './phylogeny-export';

const source = { name: 'Four-taxon fixture', kind: 'demo' as const, reference: 'Synthetic two-split control',
  fasta: '>A\nAAAA\n>B\nAAAA\n>C\nCCCC\n>D\nCCCC\n' };

test('supported Newick labels the unrooted edge once, as a percentage', async () => {
  const experiment = await createAlignedPhylogenyExperiment(source, { bootstrap: 20, seed: 7 });
  assert.equal(experiment.result.splits.length, 1);
  assert.equal(experiment.result.splits[0].support, 1);
  const text = exportSupportedNewick(experiment);
  assert.ok(text.startsWith('[&U]('));
  assert.ok(text.endsWith(');\n'));
  assert.equal(text.match(/\)100:/g)?.length, 1);
  for (const id of ['A', 'B', 'C', 'D']) assert.ok(text.includes(`'${id}':`));
  const rerooted = structuredClone(experiment);
  rerooted.result.tree.serializationRoot = rerooted.result.tree.nodes.find(node => node.label === null && node.id !== experiment.result.tree.serializationRoot)!.id;
  assert.equal(exportSupportedNewick(rerooted).match(/\)100:/g)?.length, 1);
});

test('zero support remains zero while absent support is omitted', async () => {
  const noBootstrap = await createAlignedPhylogenyExperiment(source);
  assert.ok(!/\)\d/.test(exportSupportedNewick(noBootstrap)));
  const measuredZero = await createAlignedPhylogenyExperiment(source, { bootstrap: 20 });
  measuredZero.result.splits[0].support = 0;
  measuredZero.result.splits[0].bootstrapCount = 0;
  assert.ok(exportSupportedNewick(measuredZero).includes(')0:'));
  const row = exportPhylogeny(noBootstrap, 'splits-tsv').split('\n').filter(line => line && !line.startsWith('#'))[1].split('\t');
  assert.equal(row.length, 8);
  assert.equal(row[3], '');
  assert.equal(row[7], '');
});

test('saturated bootstrap withholds Newick support instead of using successful replicates', async () => {
  const experiment = await createAlignedPhylogenyExperiment({ ...source, fasta: source.fasta.replaceAll('CCCC', 'CCAA') },
    { distance: 'jc69', bootstrap: 20, seed: 1 });
  assert.ok(experiment.result.bootstrap.saturated > 0);
  assert.equal(experiment.result.bootstrap.supportAvailable, false);
  assert.ok(!/\)\d/.test(exportSupportedNewick(experiment)));
});

test('unresolved trees do not acquire bootstrap labels and signed branches are retained', async () => {
  const unresolved = await createAlignedPhylogenyExperiment({ ...source, fasta: source.fasta.replaceAll('CCCC', 'AAAA') }, { bootstrap: 20 });
  assert.equal(unresolved.result.splits.length, 0);
  assert.ok(!/\)\d/.test(exportSupportedNewick(unresolved)));
  const negative = await createAlignedPhylogenyExperiment({ ...source, fasta: '>A\nAAAAAAAAAAAA\n>B\nCAAAAAAAAAAA\n>C\nCCAAAAAAAAAA\n' }, { distance: 'jc69' });
  assert.ok(negative.result.negativeEdges > 0);
  assert.ok(exportSupportedNewick(negative).includes(':-'));
});

test('distance and split tables preserve order, units, counts and result identity', async () => {
  const experiment = await createAlignedPhylogenyExperiment(source, { bootstrap: 20 });
  const distance = exportPhylogeny(experiment, 'distances-tsv');
  assert.ok(distance.includes(`# result_id\t${experiment.record.resultId}`));
  assert.ok(distance.includes('# distance_method\tp-distance'));
  assert.deepEqual(distance.split('\n').filter(line => line && !line.startsWith('#')), [
    'taxon\tA\tB\tC\tD', 'A\t0\t0\t1\t1', 'B\t0\t0\t1\t1', 'C\t1\t1\t0\t0', 'D\t1\t1\t0\t0',
  ]);
  const row = exportPhylogeny(experiment, 'splits-tsv').split('\n').filter(line => line && !line.startsWith('#'))[1].split('\t');
  assert.deepEqual(JSON.parse(row[0]), ['A', 'B']);
  assert.deepEqual(JSON.parse(row[1]), ['C', 'D']);
  assert.deepEqual(row.slice(3), ['20', '20', '20', '0', '1']);
});

test('original FASTA export is exact, including lowercase, headers and line endings', async () => {
  const original = '\uFEFF>B private description\r\naaaa\r\n>A\r\naaaa\r\n>C\r\nccaa\r\n';
  const experiment = await createAlignedPhylogenyExperiment({ ...source, fasta: original });
  assert.equal(exportPhylogeny(experiment, 'alignment-fasta'), original);
});
