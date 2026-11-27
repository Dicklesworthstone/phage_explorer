import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAlignmentPangenome, createAlignmentPangenomeRecord, type PangenomeInput } from '../../core/src/analysis/alignment-pangenome';
import { createPangenomePhylogenyExperiment, replayAlignedPhylogenyExperiment, resolvePhylogenyOptions } from '../../core/src/analysis/aligned-phylogeny';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { preparePhylogenyDownload } from '../../web/src/utils/phylogeny-download';
import { executePhylogenyTask, parsePhylogenyCommand, performPhylogenyTask, runPhylogenyCommand } from './headless-phylogeny';
import { executePhylogenyCommand as executeLegacyPhylogeny, parsePhylogenyCommand as parseLegacyPhylogeny } from '../../../scripts/phylogeny';

async function fixture() {
  const input: PangenomeInput = { format: 'phage-explorer-pangenome', version: 1, source: 'demo', name: 'PRIVATE_PARENT_NAME',
    sequences: ['AAAA--CCCCGGGGTTTT', 'TAAATTCCCCGGGGTTTT', 'AAAAGGTTTTGGGGTTTT', 'AAAATTTTTTGGGGTTTA']
      .map((sequence, i) => ({ id: ['A', 'B', 'C', 'D'][i], description: 'PRIVATE_INPUT_DESCRIPTION', sequence })) };
  const record = await createAlignmentPangenomeRecord(input, buildAlignmentPangenome(input, { referenceId: 'A', alignment: 'provided', terminalGaps: 'missing' }));
  const content = '\ufeff' + serializeAnalysisRecord(record).replace(/\n/g, '\r\n');
  const source = { name: 'PRIVATE_INFERENCE_NAME', reference: 'PRIVATE_HOMOLOGY_PROVENANCE' }, options = resolvePhylogenyOptions({ bootstrap: 20, seed: 0 });
  const experiment = await createPangenomePhylogenyExperiment({ ...source, experiment: content }, options);
  const dir = await mkdtemp(join(tmpdir(), 'phage-pangenome-phylogeny-'));
  await writeFile(join(dir, 'pangenome.json'), content);
  return { record, content, source, options, experiment, dir };
}
const inferArgs = (dir: string) => ['infer-pangenome', '--experiment', join(dir, 'pangenome.json'), '--column-policy', 'reference-backbone-complete',
  '--name', 'PRIVATE_INFERENCE_NAME', '--reference', 'PRIVATE_HOMOLOGY_PROVENANCE', '--bootstrap', '20', '--seed', '0', '--output', join(dir, 'phylogeny.json')];
const exportArgs = (dir: string, format: string, output: string, input = 'phylogeny.json') => ['export', '--experiment', join(dir, input), '--format', format, '--output', join(dir, output)];

describe('headless pangenome to aligned phylogeny', () => {
  test('requires the explicit backbone policy and provenance and inherits source kind', () => {
    const parsed = parsePhylogenyCommand(inferArgs('/tmp'));
    assert.equal(parsed.type, 'infer-pangenome');
    if (parsed.type !== 'infer-pangenome') throw new Error('Wrong command');
    assert.deepEqual(parsed.options, { distance: 'p-distance', deletion: 'complete', bootstrap: 20, seed: 0 });
    assert.equal(parsed.experimentPath, '/tmp/pangenome.json');
    for (const args of [inferArgs('/tmp').filter((_, i) => i !== 3 && i !== 4), inferArgs('/tmp').map(value => value === 'reference-backbone-complete' ? 'all-columns' : value),
      [...inferArgs('/tmp'), '--source', 'local'], [...inferArgs('/tmp'), '--column-policy', 'reference-backbone-complete'],
      inferArgs('/tmp').filter((_, i) => i !== 7 && i !== 8)]) assert.throws(() => parsePhylogenyCommand(args));
  });

  test('runs actual parent reconstruction and inference in the terminable native worker with private summaries', async () => {
    const { content, source, options, experiment } = await fixture();
    const actual = await executePhylogenyTask({ type: 'infer-pangenome', content, source, options }, 30000);
    assert.equal(actual.output, serializeAnalysisRecord(experiment.record));
    assert.deepEqual(actual.summary.method, experiment.record.method); assert.equal(actual.summary.sourceKind, 'demo');
    assert.deepEqual(actual.summary.pangenome, { parentResultId: experiment.pangenome!.parentResultId,
      columnPolicy: 'reference-backbone-complete', alignmentColumns: 18, backboneColumns: 16, excludedReferenceGapColumns: 2, retainedColumns: 16 });
    assert.equal(actual.summary.usedSites, 16); assert.ok(!JSON.stringify(actual.summary).includes('PRIVATE_'));
  });

  test('creates a private replayable record, verifies it and exports original parent bytes and backbone FASTA', async () => {
    const { dir, experiment, content } = await fixture();
    const summary = await runPhylogenyCommand(inferArgs(dir));
    assert.equal((summary as Record<string, unknown>).resultId, experiment.record.resultId);
    const saved = await readFile(join(dir, 'phylogeny.json'), 'utf8');
    assert.deepEqual(await replayAlignedPhylogenyExperiment(saved), experiment);
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'phylogeny.json'))).mode & 0o777, 0o600);
    await runPhylogenyCommand(['verify', '--experiment', join(dir, 'phylogeny.json'), '--output', join(dir, 'verified.json')]);
    assert.equal(await readFile(join(dir, 'verified.json'), 'utf8'), saved);
    for (const [format, browserFormat, filename] of [
      ['pangenome-experiment', 'pangenome-experiment', 'parent-copy.json'], ['alignment-fasta', 'alignment-fasta', 'backbone.fa'],
      ['distances-tsv', 'distances', 'distances.tsv'], ['newick', 'newick', 'tree.nwk'],
    ] as const) {
      await runPhylogenyCommand(exportArgs(dir, format, filename));
      assert.equal(await readFile(join(dir, filename), 'utf8'), preparePhylogenyDownload(experiment, browserFormat).content);
    }
    assert.equal(await readFile(join(dir, 'parent-copy.json'), 'utf8'), content);
    assert.equal(await readFile(join(dir, 'backbone.fa'), 'utf8'), '>A\nAAAACCCCGGGGTTTT\n>B\nTAAACCCCGGGGTTTT\n>C\nAAAATTTTGGGGTTTT\n>D\nAAAATTTTGGGGTTTA\n');
    assert.match(await readFile(join(dir, 'distances.tsv'), 'utf8'), /0\.0625\t0\.25\t0\.3125/);
  });

  test('retains and exports the same exact parent after the headless explicit-root operation', async () => {
    const { dir, content, experiment } = await fixture();
    await writeFile(join(dir, 'phylogeny.json'), serializeAnalysisRecord(experiment.record));
    await writeFile(join(dir, 'rooting.json'), JSON.stringify({ outgroup: ['A', 'B'], fractionFromOutgroup: 0.5,
      evidence: 'Synthetic date-independent outgroup declaration.', dateIndependent: true }));
    const summary = await runPhylogenyCommand(['root', '--experiment', join(dir, 'phylogeny.json'), '--rooting', join(dir, 'rooting.json'), '--output', join(dir, 'rooted.json')]);
    assert.equal(((summary as Record<string, unknown>).method as { version: string }).version, '2.0.0');
    await runPhylogenyCommand(['verify', '--experiment', join(dir, 'rooted.json')]);
    await runPhylogenyCommand(exportArgs(dir, 'pangenome-experiment', 'root-parent.json', 'rooted.json'));
    assert.equal(await readFile(join(dir, 'root-parent.json'), 'utf8'), content);
  });

  test('refuses fabricated parent results and existing destinations without publishing evidence', async () => {
    const { dir, record } = await fixture();
    const altered = structuredClone(record); altered.fields.variants.value = [{ invented: true }];
    await writeFile(join(dir, 'pangenome.json'), serializeAnalysisRecord(await createAnalysisRecord(altered)));
    await assert.rejects(runPhylogenyCommand(inferArgs(dir)), /Recomputed pangenome/);
    await assert.rejects(stat(join(dir, 'phylogeny.json')), { code: 'ENOENT' });
    await writeFile(join(dir, 'pangenome.json'), serializeAnalysisRecord(record));
    await writeFile(join(dir, 'phylogeny.json'), 'existing work');
    await assert.rejects(runPhylogenyCommand(inferArgs(dir)), { code: 'EEXIST' });
    assert.equal(await readFile(join(dir, 'phylogeny.json'), 'utf8'), 'existing work');
  });

  test('timeout and cancellation stop parent reconstruction without creating output', async () => {
    const { dir, content, source, options } = await fixture();
    await assert.rejects(runPhylogenyCommand([...inferArgs(dir), '--timeout-ms', '1']), /exceeded/);
    await assert.rejects(stat(join(dir, 'phylogeny.json')), { code: 'ENOENT' });
    const controller = new AbortController();
    const pending = executePhylogenyTask({ type: 'infer-pangenome', content, source, options }, 30000, controller.signal);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  });

  test('rejects unavailable parent export for a regular aligned FASTA experiment', async () => {
    const created = await performPhylogenyTask({ type: 'infer', content: '>A\nAAAA\n>B\nAAAT\n>C\nAATT',
      source: { name: 'Direct alignment', kind: 'demo', reference: 'Synthetic three-taxon test.' }, options: resolvePhylogenyOptions() });
    await assert.rejects(performPhylogenyTask({ type: 'export', content: created.output!, format: 'pangenome-experiment' }), /pangenome/);
  });
});

describe('headless explicit source-region selection', () => {
  test('keeps the legacy entry point mask and verified-export behavior consistent', async () => {
    const { dir } = await fixture(), output = join(dir, 'legacy-masked.json');
    const raw = parseLegacyPhylogeny(['infer', '--alignment', 'supplied.fa', '--source', 'Synthetic provenance',
      '--output', 'new.json', '--exclude-regions', '3:8']);
    if (raw.type !== 'infer') throw new Error('Expected raw inference');
    assert.deepEqual(raw.options.excludedRegions, [{ start: 3, end: 8 }]);
    const command = parseLegacyPhylogeny(['infer-pangenome', '--experiment', join(dir, 'pangenome.json'),
      '--column-policy', 'reference-backbone-complete', '--source', 'Synthetic provenance', '--output', output,
      '--exclude-regions', '3:8']);
    if (command.type !== 'infer-pangenome') throw new Error('Expected parent inference');
    const summary = await executeLegacyPhylogeny(command);
    assert.equal(summary.usedSites, 13);
    const saved = await replayAlignedPhylogenyExperiment(await readFile(output, 'utf8'));
    assert.equal(saved.record.method.version, '4.0.0');
    await executeLegacyPhylogeny({ type: 'export', experiment: output, format: 'distances', output: join(dir, 'legacy-distances.tsv') });
    assert.match(await readFile(join(dir, 'legacy-distances.tsv'), 'utf8'), /# excluded_region_coordinates\tpangenome-parent-alignment/);
  }, 30000);
  test('parses the same canonical half-open notation for raw and parent-alignment inputs', () => {
    for (const args of [inferArgs('/tmp'), ['infer', '--input', 'aligned.fa', '--alignment', 'provided',
      '--name', 'Synthetic quartet', '--reference', 'Independent test alignment', '--output', 'new.json']]) {
      const parsed = parsePhylogenyCommand([...args, '--exclude-regions', '6:8,3:6']);
      if (parsed.type !== 'infer' && parsed.type !== 'infer-pangenome') throw new Error('Expected inference');
      assert.deepEqual(parsed.options.excludedRegions, [{ start: 3, end: 8 }]);
      for (const invalid of ['3-8', '1:1', '-1:2', '0:9007199254740992']) {
        assert.throws(() => parsePhylogenyCommand([...args, '--exclude-regions', invalid]));
      }
    }
  });
  test('runs masked parent projection, verifies it, and retains exact mapping and source exports', async () => {
    const { dir, content } = await fixture();
    const summary = await runPhylogenyCommand([...inferArgs(dir), '--exclude-regions', '3:8']) as Record<string, unknown>;
    assert.equal(summary.usedSites, 13);
    const saved = await readFile(join(dir, 'phylogeny.json'), 'utf8'), experiment = await replayAlignedPhylogenyExperiment(saved);
    assert.equal(experiment.record.method.version, '4.0.0');
    assert.deepEqual(experiment.pangenome?.regionExclusions?.parentColumns, [3, 4, 5, 6, 7]);
    assert.deepEqual(experiment.pangenome?.regionExclusions?.backboneColumns, [3, 4, 5]);
    assert.deepEqual(experiment.result.distances, [[0, 1, 2, 3], [1, 0, 3, 4], [2, 3, 0, 1], [3, 4, 1, 0]].map(row => row.map(value => value / 13)));
    await runPhylogenyCommand(['verify', '--experiment', join(dir, 'phylogeny.json')]);
    await runPhylogenyCommand(exportArgs(dir, 'distances-tsv', 'masked.tsv'));
    assert.match(await readFile(join(dir, 'masked.tsv'), 'utf8'), /# excluded_regions_json\t\[\{"start":3,"end":8\}\]/);
    await runPhylogenyCommand(exportArgs(dir, 'pangenome-experiment', 'original-parent.json'));
    assert.equal(await readFile(join(dir, 'original-parent.json'), 'utf8'), content);
    const args = [...inferArgs(dir), '--exclude-regions', '0:18'].map(value => value === join(dir, 'phylogeny.json') ? join(dir, 'invalid.json') : value);
    await assert.rejects(runPhylogenyCommand(args), /every source alignment column/);
    await assert.rejects(stat(join(dir, 'invalid.json')), { code: 'ENOENT' });
  }, 30000);
});
