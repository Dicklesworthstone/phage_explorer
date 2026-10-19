import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { createAlignedPhylogenyExperiment } from '../../core/src/analysis/aligned-phylogeny';
import { rootAlignedPhylogenyExperiment } from '../../core/src/analysis/phylogeny-rooting';
import { createRootedTemporalExperiment, createRootedDatingExperiment, replayRootedDatingExperiment } from '../../core/src/analysis/phylogeny-temporal';
import { executePhylogenyTask, parsePhylogenyCommand, performPhylogenyTask, runPhylogenyCommand,
  type PhylogenyTask } from './headless-phylogeny';

// Disjoint private substitutions: pairwise difference counts are i+j+2.
// Independent NJ quartet formulas give paths from the explicitly chosen root.
// Dates impose a known 0.005 strict rate and a 2000 root without using the solver.
const fasta = '\uFEFF' + ['A', 'B', 'C', 'D'].map((id, i) =>
  `>${id} private fixture\r\n${'A'.repeat(i * 5)}${'G'.repeat(i + 1)}${'A'.repeat(100 - i * 5 - i - 1)}\r\n`).join('');
const source = { name: 'Synthetic CLI cohort', kind: 'demo' as const, reference: 'Private alignment provenance sentinel' };
const decision = { outgroup: ['A'], fractionFromOutgroup: .25, evidence: 'Private root evidence sentinel', dateIndependent: true as const };
const metadata = { name: source.name, kind: 'demo' as const, description: 'Private dates provenance sentinel',
  reference: null, license: 'CC0 synthetic fixture', dateIndependent: true as const };
const d = (n: number) => -.75 * Math.log(1 - 4 * (n / 100) / 3);
const a = (d(5) + (d(3) + d(4) - d(6) - d(7)) / 2) / 2;
const b = (d(5) + ((d(3) + d(6) - d(5)) / 2 - (d(4) + d(7) - d(5)) / 2)) / 2;
const c = d(5) - b, internal = (d(3) + d(6) - d(5)) / 2 - b;
const paths = [a / 4, a * .75 + internal + b, a * .75 + internal + c, a * .75 + d(5) - a];
const dates = paths.map(path => 2000 + path / .005);
const sampleTable = '\uFEFFsampleId\tcollectionDate\tdateSource\tpermutationGroup\r\n'
  + [3, 1, 0, 2].map(i => `${'ABCD'[i]}\t${dates[i]}\tPrivate sample source sentinel\t${i < 2 ? 'one' : 'two'}\r\n`).join('');
const temporalOptions = { permutations: 24, seed: 0 };
const close = (actual: number, expected: number, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
async function inputs() {
  const unrooted = await createAlignedPhylogenyExperiment({ ...source, fasta }, { distance: 'jc69', bootstrap: 20, seed: 42 });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(unrooted.record), decision);
  return { unrooted, rooted, content: serializeAnalysisRecord(rooted.record) };
}
async function temporalTask(overrides: Partial<Extract<PhylogenyTask, { type: 'temporal' }>> = {}): Promise<Extract<PhylogenyTask, { type: 'temporal' }>> {
  return { type: 'temporal', content: (await inputs()).content, metadataContent: JSON.stringify(metadata), sampleTable,
    optionsContent: JSON.stringify(temporalOptions), ...overrides };
}
async function rehash(record: AnalysisRecord) {
  return createAnalysisRecord({ method: record.method, inputs: record.inputs.map(({ sha256: _hash, ...input }) => input),
    parameters: record.parameters, seed: record.seed, references: record.references, fields: record.fields });
}
const temporary = () => mkdtemp(join(tmpdir(), 'phage-cli-workflow-'));

test('temporal/date parsing requires their own inputs and rejects irrelevant or repeated flags', () => {
  const args = ['temporal', '--experiment', 'root.json', '--metadata', 'cohort.json', '--samples', 'dates.tsv', '--output', 'result.json'];
  assert.deepEqual(parsePhylogenyCommand(args), { type: 'temporal', experimentPath: 'root.json', metadataPath: 'cohort.json',
    samplesPath: 'dates.tsv', outputPath: 'result.json', timeoutMs: 300000 });
  assert.deepEqual(parsePhylogenyCommand(['date', '--experiment', 'temporal.json', '--options', 'settings.json', '--output', 'dated.json']),
    { type: 'date', experimentPath: 'temporal.json', optionsPath: 'settings.json', outputPath: 'dated.json', timeoutMs: 300000 });
  for (const rejected of [args.slice(0, -2), args.filter(x => x !== '--metadata' && x !== 'cohort.json'),
    [...args, '--seed', '5'], [...args, '--options', 'a', '--options', 'b'],
    ['date', '--experiment', 'x', '--output', 'y', '--samples', 'z'], ['date', '--experiment', 'x', '--output', 'y', '--timeout-ms', '0']]) {
    assert.throws(() => parsePhylogenyCommand(rejected));
  }
});

test('real worker temporal and dating results match core/browser records and independent numerical expectations', async () => {
  const task = await temporalTask(), temporal = await executePhylogenyTask(task, 10000);
  const expected = await createRootedTemporalExperiment(task.content, { ...metadata, sampleTable }, temporalOptions);
  assert.equal(temporal.output, serializeAnalysisRecord(expected.record));
  const fit = expected.result.regression!;
  close(fit.slope, .005); close(fit.r2, 1);
  assert.equal(expected.result.randomization!.tailFraction, 1 / 24);
  const dating = await executePhylogenyTask({ type: 'date', content: temporal.output! }, 10000);
  const direct = await createRootedDatingExperiment(temporal.output!);
  assert.equal(dating.output, serializeAnalysisRecord(direct.datingRecord));
  assert.equal(direct.dating.status, 'fitted'); close(direct.dating.rate, .005); close(direct.dating.rootDate!, 2000, 1e-8);
  assert.ok(direct.dating.sumSquaredResiduals < 1e-20);
  for (const tip of direct.dating.nodes.filter(node => node.isTip)) close(tip.date, dates['ABCD'.indexOf(tip.label!)]);
  const replay = await executePhylogenyTask({ type: 'verify', content: '\uFEFF' + dating.output! }, 10000);
  assert.deepEqual(replay, dating);
});

test('filesystem pipeline runs infer, root, temporal, date, verifies and preserves original bytes', async () => {
  const dir = await temporary(), path = (name: string) => join(dir, name);
  await writeFile(path('input.fa'), fasta); await writeFile(path('rooting.json'), JSON.stringify(decision));
  await writeFile(path('cohort.json'), '\uFEFF' + JSON.stringify(metadata)); await writeFile(path('dates.tsv'), sampleTable);
  await writeFile(path('options.json'), JSON.stringify(temporalOptions));
  await runPhylogenyCommand(['infer', '--input', path('input.fa'), '--alignment', 'provided', '--name', source.name, '--reference', source.reference,
    '--source', 'demo', '--distance', 'jc69', '--bootstrap', '20', '--seed', '42', '--output', path('unrooted.json')]);
  await runPhylogenyCommand(['root', '--experiment', path('unrooted.json'), '--rooting', path('rooting.json'), '--output', path('rooted.json')]);
  await runPhylogenyCommand(['temporal', '--experiment', path('rooted.json'), '--metadata', path('cohort.json'), '--samples', path('dates.tsv'),
    '--options', path('options.json'), '--output', path('temporal.json')]);
  await runPhylogenyCommand(['date', '--experiment', path('temporal.json'), '--output', path('dated.json')]);
  const saved = await readFile(path('dated.json'), 'utf8'), replay = await replayRootedDatingExperiment(saved);
  assert.equal(replay.rootedSource.metadata.sampleTable, sampleTable);
  assert.equal(replay.result.options.seed, 0); close(replay.dating.rate, .005);
  await runPhylogenyCommand(['verify', '--experiment', path('dated.json'), '--output', path('copy.json')]);
  assert.equal(await readFile(path('copy.json'), 'utf8'), saved);
  await runPhylogenyCommand(['export', '--experiment', path('dated.json'), '--format', 'alignment-fasta', '--output', path('original.fa')]);
  assert.deepEqual(await readFile(path('original.fa')), await readFile(path('input.fa')));
  if (process.platform !== 'win32') assert.equal((await stat(path('dated.json'))).mode & 0o077, 0);
  await assert.rejects(runPhylogenyCommand(['date', '--experiment', path('temporal.json'), '--output', path('dated.json')]), /EEXIST/);
  if (process.platform !== 'win32') {
    await symlink(path('dated.json'), path('link.json'));
    await assert.rejects(runPhylogenyCommand(['date', '--experiment', path('temporal.json'), '--output', path('link.json')]), /EEXIST/);
  }
  assert.equal(await readFile(path('dated.json'), 'utf8'), saved);
});

test('newick keeps substitutions/site separate from explicitly dated Newick in years', async () => {
  const temporal = await performPhylogenyTask(await temporalTask());
  const dated = await performPhylogenyTask({ type: 'date', content: temporal.output! });
  const original = await performPhylogenyTask({ type: 'export', content: dated.output!, format: 'newick' });
  assert.ok(original.output!.startsWith('[&R][&branch_units=substitutions/site]'));
  assert.ok(original.output!.includes((await inputs()).rooted.result.newick));
  const years = await performPhylogenyTask({ type: 'export', content: dated.output!, format: 'dated-newick' });
  assert.ok(years.output!.includes('branch_units=years')); assert.ok(years.output!.includes('clock_validated=false'));
  assert.ok(years.output!.includes('source_node=n')); assert.notEqual(years.output, original.output);
  await assert.rejects(performPhylogenyTask({ type: 'export', content: temporal.output!, format: 'dated-newick' }), /requires a fitted/);
});

test('hash-valid forged temporal outputs and dating certificates fail verification and every available export', async () => {
  const temporal = await performPhylogenyTask(await temporalTask());
  const dated = await performPhylogenyTask({ type: 'date', content: temporal.output! });
  for (const [content, field] of [[temporal.output!, 'regression'], [dated.output!, 'dating']] as const) {
    const copy = JSON.parse(content) as AnalysisRecord;
    if (field === 'regression') (copy.fields.regression.value as { slope: number }).slope = .123;
    else ((copy.fields.dating.value as { certificate: { iterations: number } }).certificate).iterations += 100;
    const forged = serializeAnalysisRecord(await rehash(copy));
    await parseAnalysisRecord(forged); // Hashes really are valid; replay must find the false result.
    await assert.rejects(executePhylogenyTask({ type: 'verify', content: forged }, 10000), /differs/);
    for (const format of ['newick', 'unrooted-newick', 'distances-tsv', 'splits-tsv', 'alignment-fasta', 'rooting-json', 'dated-newick'] as const)
      await assert.rejects(performPhylogenyTask({ type: 'export', content: forged, format }), /differs/);
  }
});

test('bounded JSON settings reject primitives, unknown fields and embedded date-table overrides', async () => {
  const task = await temporalTask();
  for (const optionsContent of ['null', '[]', 'true', '{"seed":"0"}', '{"permutations":18}', '{"unknown":true}', 'x'.repeat(65537)])
    await assert.rejects(performPhylogenyTask({ ...task, optionsContent }));
  for (const metadataContent of ['null', '[]', JSON.stringify({ ...metadata, sampleTable: 'override' }), JSON.stringify({ ...metadata, dateIndependent: false }), 'x'.repeat(65537)])
    await assert.rejects(performPhylogenyTask({ ...task, metadataContent }));
  const temporal = await performPhylogenyTask(task);
  for (const optionsContent of ['null', '[]', '{"rateMode":"fixed","fixedRate":0.005}', '{"minimumRate":2,"maximumRate":1}', '{"excludedSamples":[]}'])
    await assert.rejects(performPhylogenyTask({ type: 'date', content: temporal.output!, optionsContent }));
});

test('no silent p-distance conversion, missing-date inference or automatic step skipping', async () => {
  const { unrooted, content } = await inputs();
  await assert.rejects(performPhylogenyTask(await temporalTask({ content: serializeAnalysisRecord(unrooted.record) })), /method\/version/);
  await assert.rejects(performPhylogenyTask({ type: 'date', content }), /method\/version/);
  // Power-of-two columns make p-distances exactly representable, avoiding unrelated roundoff-negative NJ limbs.
  const binaryFasta = fasta.split('\r\n').map(line => line && !line.startsWith('>') && !line.startsWith('\uFEFF>') ? line + 'A'.repeat(28) : line).join('\r\n');
  const p = await createAlignedPhylogenyExperiment({ ...source, fasta: binaryFasta }, { distance: 'p-distance' });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(p.record), decision);
  await assert.rejects(performPhylogenyTask(await temporalTask({ content: serializeAnalysisRecord(rooted.record) })), /requires a JC69/);
  const missing = await performPhylogenyTask(await temporalTask({ sampleTable: sampleTable.replace(String(dates[1]), '') }));
  await assert.rejects(performPhylogenyTask({ type: 'date', content: missing.output! }), /Every dated-tree tip/);
});

test('unavailable diagnostics remain replayable and exclusions do not prune strict-clock tips', async () => {
  const temporal = await performPhylogenyTask(await temporalTask({ optionsContent: JSON.stringify({ ...temporalOptions, excludedSamples: ['A'] }) }));
  assert.equal((temporal.summary.temporal as { slope: unknown }).slope, null);
  assert.equal(temporal.summary.retainedTips, 3);
  const dated = await performPhylogenyTask({ type: 'date', content: temporal.output! });
  const replay = await replayRootedDatingExperiment(dated.output!);
  assert.equal(replay.dating.exactTips, 4); assert.equal(replay.result.regression, null);
  close(replay.dating.rate, .005);
});

test('sourced fixed rates, interval dates and rate-boundary results keep their distinct meanings', async () => {
  const intervalTable = sampleTable.replace(String(dates[3]), String(Math.floor(dates[3])));
  const temporal = await performPhylogenyTask(await temporalTask({ sampleTable: intervalTable }));
  const dated = await performPhylogenyTask({ type: 'date', content: temporal.output!, optionsContent:
    JSON.stringify({ rateMode: 'fixed', fixedRate: .005, rateSource: 'Private sourced rate sentinel' }) });
  const replay = await replayRootedDatingExperiment(dated.output!);
  assert.equal(replay.dating.options.rateMode, 'fixed'); assert.equal(replay.dating.intervalTips, 1);
  close(replay.dating.rate, .005); close(replay.dating.rootDate!, 2000, 1e-8);
  assert.ok(!JSON.stringify(dated.summary).includes('Private sourced rate sentinel'));
  const exact = await performPhylogenyTask(await temporalTask());
  const boundary = await performPhylogenyTask({ type: 'date', content: exact.output!, optionsContent: '{"minimumRate":0.02,"maximumRate":0.1}' });
  const summary = boundary.summary.dating as { status: string; rootDate: number | null; rate: number | null };
  assert.equal(summary.status, 'rate-boundary'); assert.equal(summary.rootDate, null); assert.equal(summary.rate, null);
  assert.equal((await performPhylogenyTask({ type: 'verify', content: boundary.output! })).output, boundary.output);
  await assert.rejects(performPhylogenyTask({ type: 'export', content: boundary.output!, format: 'dated-newick' }), /Only a certified/);
});

test('bad files, invalid computation, deadlines and cancellation create no output', async () => {
  const dir = await temporary(), path = (s: string) => join(dir, s), task = await temporalTask();
  await writeFile(path('root.json'), task.content); await writeFile(path('cohort.json'), JSON.stringify(metadata));
  await writeFile(path('dates.tsv'), sampleTable); await writeFile(path('invalid.json'), Buffer.from([0xff]));
  const args = ['temporal', '--experiment', path('root.json'), '--metadata', path('cohort.json'), '--samples', path('dates.tsv'), '--output', path('out.json')];
  await assert.rejects(runPhylogenyCommand([...args, '--options', path('invalid.json')]));
  await assert.rejects(runPhylogenyCommand([...args, '--options', dir]), /regular file|EISDIR/);
  await writeFile(path('large.json'), ' '.repeat(65537));
  await assert.rejects(runPhylogenyCommand([...args, '--options', path('large.json')]), /exceeds/);
  await assert.rejects(runPhylogenyCommand([...args, '--timeout-ms', '1']), /exceeded 1 ms/);
  const controller = new AbortController(), work = runPhylogenyCommand(args, controller.signal); controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  await assert.rejects(access(path('out.json')), /ENOENT/);
  const active = new AbortController(), pending = executePhylogenyTask(task, 10000, active.signal); active.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('stdout summaries exclude private sequence, sample metadata, alignment and rooting descriptions', async () => {
  const temporal = await performPhylogenyTask(await temporalTask());
  const dated = await performPhylogenyTask({ type: 'date', content: temporal.output! });
  for (const result of [temporal, dated]) {
    const text = JSON.stringify(result.summary);
    for (const secret of ['Private alignment provenance sentinel', 'Private root evidence sentinel', 'Private dates provenance sentinel',
      'Private sample source sentinel', 'AAAAAGGAAAA', sampleTable]) assert.ok(!text.includes(secret));
    assert.equal(result.summary.sourceKind, 'demo');
  }
});

test('direct workflow calls snapshot original strings before dynamic imports yield', async () => {
  const task = await temporalTask();
  const expected = await performPhylogenyTask({ ...task });
  const pending = performPhylogenyTask(task);
  task.content = 'changed'; task.metadataContent = '{}'; task.sampleTable = ''; task.optionsContent = '{"seed":5}';
  assert.deepEqual(await pending, expected);
  const dateTask: Extract<PhylogenyTask, { type: 'date' }> = { type: 'date', content: expected.output! };
  const direct = await performPhylogenyTask({ ...dateTask });
  const dating = performPhylogenyTask(dateTask); dateTask.content = 'changed';
  assert.deepEqual(await dating, direct);
});

test('unrooted and explicitly rooted verification and exports retain their original contracts', async () => {
  const { unrooted, rooted, content } = await inputs();
  for (const record of [unrooted.record, rooted.record]) {
    const serialized = serializeAnalysisRecord(record);
    assert.equal((await performPhylogenyTask({ type: 'verify', content: serialized })).output, serialized);
    assert.equal((await performPhylogenyTask({ type: 'export', content: serialized, format: 'alignment-fasta' })).output, fasta);
    await assert.rejects(performPhylogenyTask({ type: 'export', content: serialized, format: 'dated-newick' }), /requires a fitted/);
  }
  const root = await performPhylogenyTask({ type: 'export', content, format: 'newick' });
  assert.equal(root.output, `[&R]${rooted.result.newick}\n`);
  const parent = await performPhylogenyTask({ type: 'export', content, format: 'unrooted-newick' });
  assert.ok(parent.output!.startsWith('[&U]'));
  const rootDecision = await performPhylogenyTask({ type: 'export', content, format: 'rooting-json' });
  assert.deepEqual(JSON.parse(rootDecision.output!), decision);
});
