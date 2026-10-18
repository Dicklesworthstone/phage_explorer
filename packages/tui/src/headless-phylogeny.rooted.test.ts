import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlignedPhylogenyExperiment, type PhylogenySource } from '../../core/src/analysis/aligned-phylogeny';
import { rootAlignedPhylogenyExperiment, replayRootedPhylogenyExperiment, type OutgroupRooting } from '../../core/src/analysis/phylogeny-rooting';
import { exportPhylogeny } from '../../core/src/analysis/phylogeny-export';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { executePhylogenyTask, parsePhylogenyCommand, performPhylogenyTask, runPhylogenyCommand, type HeadlessPhylogenyFormat } from './headless-phylogeny';

const source: PhylogenySource = { name: 'Synthetic CLI quartet', kind: 'demo', reference: 'Synthetic private-substitution fixture, not biological evidence',
  fasta: '\uFEFF' + ['A', 'B', 'C', 'D'].map((id, i) => `>${id} original header\r\n${'A'.repeat(i * 5)}${'G'.repeat(i + 1)}${'A'.repeat(100 - i * 5 - i - 1)}\r\n`).join('') };
const decision: OutgroupRooting = { outgroup: ['A'], fractionFromOutgroup: .25, evidence: 'PRIVATE_ROOTING_NOTE', dateIndependent: true };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'phage-rooted-cli-'));
  const original = await createAlignedPhylogenyExperiment(source, { distance: 'jc69', bootstrap: 20, seed: 42 });
  const content = serializeAnalysisRecord(original.record);
  await writeFile(join(dir, 'unrooted.json'), content);
  await writeFile(join(dir, 'decision.json'), '\uFEFF' + JSON.stringify(decision));
  const rooted = await rootAlignedPhylogenyExperiment(content, decision);
  await writeFile(join(dir, 'browser-rooted.json'), serializeAnalysisRecord(rooted.record));
  return { dir, original, content, rooted };
}
const rootArgs = (dir: string, output = 'rooted.json') => ['root', '--experiment', join(dir, 'unrooted.json'), '--rooting', join(dir, 'decision.json'), '--output', join(dir, output)];
const exportArgs = (dir: string, format: string, output: string, input = 'browser-rooted.json') => ['export', '--experiment', join(dir, input), '--format', format, '--output', join(dir, output)];
const absent = async (path: string) => assert.rejects(stat(path), { code: 'ENOENT' });
async function rehash(record: AnalysisRecord) {
  return createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _sha, ...row }) => row) });
}

describe('headless explicit rooting', () => {
  it('requires an explicit decision file and rejects unknown, duplicate or malformed flags', () => {
    const parsed = parsePhylogenyCommand(rootArgs('/tmp'));
    assert.equal(parsed.type, 'root');
    assert.deepEqual(parsed, { type: 'root', experimentPath: '/tmp/unrooted.json', rootingPath: '/tmp/decision.json', outputPath: '/tmp/rooted.json', timeoutMs: 300000 });
    for (const args of [rootArgs('/tmp').slice(0, 3), [...rootArgs('/tmp'), '--rooting', 'other'], [...rootArgs('/tmp'), '--midpoint', 'true'], [...rootArgs('/tmp'), '--timeout-ms', 'NaN']]) {
      assert.throws(() => parsePhylogenyCommand(args));
    }
  });
  it('computes the existing root operation through the actual static worker, with private summaries', async () => {
    const { original, content, rooted } = await fixture();
    const actual = await executePhylogenyTask({ type: 'root', content, rootingContent: JSON.stringify(decision) }, 30000);
    assert.equal(actual.output, serializeAnalysisRecord(rooted.record));
    assert.equal(actual.summary.resultId, rooted.record.resultId); assert.equal(actual.summary.unrootedResultId, original.record.resultId);
    assert.equal(actual.summary.sourceKind, 'demo'); assert.equal(actual.summary.outgroupTaxa, 1);
    assert.equal(actual.summary.fractionFromOutgroup, .25);
    assert.ok(!JSON.stringify(actual.summary).includes(decision.evidence)); assert.ok(!JSON.stringify(actual.summary).includes(source.fasta));
  });
  it('creates a private rooted record on disk and restores exactly the same browser/core result', async () => {
    const { dir, rooted } = await fixture();
    const summary = await runPhylogenyCommand(rootArgs(dir));
    assert.equal(typeof summary, 'object');
    const content = await readFile(join(dir, 'rooted.json'), 'utf8');
    assert.equal(content, serializeAnalysisRecord(rooted.record));
    assert.deepEqual((await replayRootedPhylogenyExperiment(content)).result, rooted.result);
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'rooted.json'))).mode & 0o777, 0o600);
  });
  it('verifies and copies rooted browser records without trusting stored output', async () => {
    const { dir, rooted } = await fixture();
    const summary = await runPhylogenyCommand(['verify', '--experiment', join(dir, 'browser-rooted.json'), '--output', join(dir, 'verified.json')]);
    assert.equal((summary as Record<string, unknown>).resultId, rooted.record.resultId);
    assert.equal(await readFile(join(dir, 'verified.json'), 'utf8'), serializeAnalysisRecord(rooted.record));
  });
  it('exports rooted topology without mistaking it for the arbitrary unrooted display root', async () => {
    const { dir, rooted, original } = await fixture();
    await runPhylogenyCommand(exportArgs(dir, 'newick', 'rooted.nwk'));
    await runPhylogenyCommand(exportArgs(dir, 'unrooted-newick', 'parent.nwk'));
    assert.equal(await readFile(join(dir, 'rooted.nwk'), 'utf8'), `[&R]${rooted.result.newick}\n`);
    assert.equal(await readFile(join(dir, 'parent.nwk'), 'utf8'), exportPhylogeny(original, 'newick'));
  });
  it('retains exact original aligned FASTA bytes and the resolved root decision', async () => {
    const { dir, rooted } = await fixture();
    await runPhylogenyCommand(exportArgs(dir, 'alignment-fasta', 'original.fa'));
    await runPhylogenyCommand(exportArgs(dir, 'rooting-json', 'decision-copy.json'));
    assert.equal(await readFile(join(dir, 'original.fa'), 'utf8'), source.fasta);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'decision-copy.json'), 'utf8')), rooted.result.rooting);
  });
  it('exports original distance/split evidence while identifying both parent and selected root', async () => {
    const { rooted, original } = await fixture();
    for (const format of ['distances-tsv', 'splits-tsv'] as const) {
      const result = await performPhylogenyTask({ type: 'export', content: serializeAnalysisRecord(rooted.record), format });
      assert.equal(result.output, `# rooted_result_id\t${rooted.record.resultId}\n` + exportPhylogeny(original, format));
    }
  });
  it('rejects rehashed fabricated rooted outputs before creating any export file', async () => {
    const { dir, rooted } = await fixture(), forged = structuredClone(rooted.record);
    (forged.fields.rooting.value as unknown as { newick: string }).newick = '(A:1,B:2,C:3,D:4);';
    const content = serializeAnalysisRecord(await rehash(forged)); await parseAnalysisRecord(content);
    await writeFile(join(dir, 'forged.json'), content);
    await assert.rejects(runPhylogenyCommand(exportArgs(dir, 'newick', 'forged.nwk', 'forged.json')), /Recomputed rooted phylogeny differs/);
    await absent(join(dir, 'forged.nwk'));
  });
  it('never assumes a missing root fraction, evidence or date-independent declaration', async () => {
    const { content } = await fixture();
    for (const changed of [{ ...decision, fractionFromOutgroup: undefined }, { ...decision, evidence: '' }, { ...decision, dateIndependent: false }, { ...decision, outgroup: ['missing'] }]) {
      await assert.rejects(performPhylogenyTask({ type: 'root', content, rootingContent: JSON.stringify(changed) }));
    }
  });
  it('refuses rootless decision exports without inventing defaults', async () => {
    const { dir } = await fixture();
    await assert.rejects(runPhylogenyCommand(exportArgs(dir, 'rooting-json', 'invented.json', 'unrooted.json')), /explicitly rooted/);
    await absent(join(dir, 'invented.json'));
  });
  it('retains existing unrooted inspect, inference, verification and export semantics', async () => {
    const { content, original } = await fixture();
    const inspect = await performPhylogenyTask({ type: 'inspect', content: source.fasta });
    assert.deepEqual(inspect.summary.taxa, ['A', 'B', 'C', 'D']); assert.equal(inspect.summary.completeColumns, 100);
    const inferred = await executePhylogenyTask({ type: 'infer', content: source.fasta, source, options: original.options }, 30000);
    assert.equal(inferred.output, content);
    assert.equal((await performPhylogenyTask({ type: 'verify', content })).output, content);
    for (const format of ['newick', 'unrooted-newick', 'distances-tsv', 'splits-tsv', 'alignment-fasta'] as HeadlessPhylogenyFormat[]) {
      const value = await performPhylogenyTask({ type: 'export', content, format });
      assert.equal(value.output, exportPhylogeny(original, format === 'unrooted-newick' ? 'newick' : format as 'newick'));
    }
  });
  it('does not overwrite output files or symbolic links', async () => {
    const { dir } = await fixture();
    await writeFile(join(dir, 'existing.json'), 'keep');
    await assert.rejects(runPhylogenyCommand(rootArgs(dir, 'existing.json')), { code: 'EEXIST' });
    assert.equal(await readFile(join(dir, 'existing.json'), 'utf8'), 'keep');
    await symlink(join(dir, 'existing.json'), join(dir, 'linked.json'));
    await assert.rejects(runPhylogenyCommand(rootArgs(dir, 'linked.json')), { code: 'EEXIST' });
    assert.equal(await readFile(join(dir, 'existing.json'), 'utf8'), 'keep');
  });
  it('refuses oversized, malformed UTF-8 and non-file decision inputs before writing', async () => {
    const { dir } = await fixture();
    await writeFile(join(dir, 'oversized.json'), ' '.repeat(64 * 1024 + 1));
    await writeFile(join(dir, 'bad-utf8.json'), Buffer.from([0xff, 0xfe]));
    for (const [name, input] of [['oversized', join(dir, 'oversized.json')], ['utf8', join(dir, 'bad-utf8.json')], ['directory', dir]]) {
      await assert.rejects(runPhylogenyCommand(['root', '--experiment', join(dir, 'unrooted.json'), '--rooting', input, '--output', join(dir, name + '-out.json')]));
      await absent(join(dir, name + '-out.json'));
    }
  });
  it('terminates interrupted workers and creates no file after deadline/pre-abort', async () => {
    const { dir, content } = await fixture();
    const controller = new AbortController();
    const pending = executePhylogenyTask({ type: 'root', content, rootingContent: JSON.stringify(decision) }, 30000, controller.signal);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(runPhylogenyCommand(rootArgs(dir, 'cancelled.json'), controller.signal), { name: 'AbortError' });
    await absent(join(dir, 'cancelled.json'));
    await assert.rejects(runPhylogenyCommand([...rootArgs(dir, 'timeout.json'), '--timeout-ms', '1']), /exceeded/);
    await absent(join(dir, 'timeout.json'));
  });
  it('rejects invalid direct-worker timeouts instead of silently converting them to one millisecond', async () => {
    for (const timeout of [0, -1, NaN, Infinity, 1.5, 3600001]) {
      await assert.rejects(executePhylogenyTask({ type: 'inspect', content: source.fasta }, timeout), /Task timeout/);
    }
  });
});
