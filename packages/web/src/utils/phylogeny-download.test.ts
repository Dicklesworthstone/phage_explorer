import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createAlignedPhylogenyExperiment, replayAlignedPhylogenyExperiment } from '../../../core/src/analysis/aligned-phylogeny';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { performPhylogenyTask } from '../../../tui/src/headless-phylogeny';
import { preparePhylogenyDownload, type PhylogenyDownloadFormat } from './phylogeny-download';

const source = { name: 'Shared export fixture', kind: 'demo' as const, reference: 'Synthetic aligned quartet; not sampled organisms',
  fasta: '\uFEFF>A original description\r\naaaa\r\n>B\r\naaaa\r\n>C\r\ncccc\r\n>D\r\ncccc\r\n' };

test('browser downloads and verified headless exports have identical bytes in all shared formats', async () => {
  const experiment = await createAlignedPhylogenyExperiment(source, { bootstrap: 20, seed: 42 });
  const content = serializeAnalysisRecord(experiment.record);
  const formats = [
    ['newick', 'newick'], ['distances', 'distances-tsv'], ['splits-tsv', 'splits-tsv'], ['alignment-fasta', 'alignment-fasta'],
  ] as const;
  for (const [browser, terminal] of formats) {
    const saved = preparePhylogenyDownload(experiment, browser);
    const headless = await performPhylogenyTask({ type: 'export', content, format: terminal });
    assert.equal(saved.content, headless.output);
  }
  assert.ok(preparePhylogenyDownload(experiment, 'newick').content.includes(')100:'));
});

test('browser JSON remains exactly replayable by core and headless verification', async () => {
  const experiment = await createAlignedPhylogenyExperiment(source, { bootstrap: 20 });
  const download = preparePhylogenyDownload(experiment, 'experiment');
  assert.equal(download.filename, 'aligned-phylogeny-experiment.json');
  assert.equal(download.mimeType, 'application/json');
  assert.equal(download.content, serializeAnalysisRecord(experiment.record));
  const replay = await replayAlignedPhylogenyExperiment(download.content);
  assert.equal(replay.record.resultId, experiment.record.resultId);
  assert.equal((await performPhylogenyTask({ type: 'verify', content: download.content })).output, download.content);
});

test('legacy split JSON retains nulls, warnings, identity and the established filename', async () => {
  const experiment = await createAlignedPhylogenyExperiment(source);
  const download = preparePhylogenyDownload(experiment, 'splits');
  assert.equal(download.filename, 'aligned-phylogeny-splits.json');
  assert.equal(download.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(download.content), {
    resultId: experiment.record.resultId, bootstrap: experiment.result.bootstrap,
    splits: experiment.result.splits, warnings: experiment.result.warnings,
  });
  assert.equal(JSON.parse(download.content).splits[0].support, null);
});

test('new split TSV and original FASTA use their own file types without losing input bytes', async () => {
  const experiment = await createAlignedPhylogenyExperiment(source);
  const table = preparePhylogenyDownload(experiment, 'splits-tsv');
  assert.equal(table.filename, 'aligned-phylogeny-splits-tsv.tsv');
  assert.equal(table.mimeType, 'text/tab-separated-values');
  assert.ok(table.content.includes('support_fraction'));
  assert.ok(table.content.includes(experiment.record.resultId));
  assert.ok(table.content.includes('\t\t0\t0\t0\t\n'));
  const fasta = preparePhylogenyDownload(experiment, 'alignment-fasta');
  assert.equal(fasta.filename, 'aligned-phylogeny-alignment-fasta.fasta');
  assert.equal(fasta.content, source.fasta);
  assert.equal(fasta.mimeType, 'text/plain');
});

test('browser exports do not relabel a user-conditioned root as the original inference', async () => {
  const original = await createAlignedPhylogenyExperiment(source, { bootstrap: 20 });
  const withRoot = { ...original, rooting: { result: { newick: '(NOT_THE_UNROOTED_TREE);' }, record: { resultId: 'conditional-root-record' } } };
  const download = preparePhylogenyDownload(withRoot, 'newick');
  assert.equal(download.content, preparePhylogenyDownload(original, 'newick').content);
  assert.ok(download.content.startsWith('[&U]'));
  assert.equal(preparePhylogenyDownload(withRoot, 'experiment').content, serializeAnalysisRecord(original.record));
});

test('unsupported runtime formats fail instead of selecting an unrelated output', async () => {
  const experiment = await createAlignedPhylogenyExperiment(source);
  for (const format of ['pdf', '__proto__', 'constructor']) {
    assert.throws(() => preparePhylogenyDownload(experiment, format as PhylogenyDownloadFormat), /Unsupported phylogeny download/);
  }
});
