import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { createAlignedPhylogenyExperiment } from '../../core/src/analysis/aligned-phylogeny';
import { rootAlignedPhylogenyExperiment, createRootedAncestralExperiment, replayRootedAncestralExperiment } from '../../core/src/analysis/phylogeny-rooting';
import { ancestralFasta } from '../../core/src/analysis/ancestral-reconstruction';
import { createRootedTemporalExperiment, createRootedDatingExperiment, replayRootedDatingExperiment } from '../../core/src/analysis/phylogeny-temporal';
import { executePhylogenyTask, parsePhylogenyCommand, performPhylogenyTask, runPhylogenyCommand,
  type PhylogenyTask, type HeadlessPhylogenyFormat } from './headless-phylogeny';

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

const ancestralAlignment = '\uFEFF' + ['A', 'B', 'C', 'D'].map((id, i) =>
  `>${id} private fixture\r\n${'A'.repeat(i * 5)}${'G'.repeat(i + 1)}${'A'.repeat(100 - i * 5 - i - 1)}${['N-', 'RN', '--', 'AA'][i]}\r\n`).join('');
const ancestralOptions = { startColumn: 1, endColumn: 102, gapPolicy: 'missing' as const, minPosterior: .8 };
async function ancestralInput(distance: 'jc69' | 'k80' = 'k80') {
  const unrooted = await createAlignedPhylogenyExperiment({ ...source, fasta: ancestralAlignment }, { distance, bootstrap: 20, seed: 42 });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(unrooted.record), decision);
  const task: Extract<PhylogenyTask, { type: 'ancestral' }> = { type: 'ancestral', content: serializeAnalysisRecord(rooted.record),
    license: metadata.license, optionsContent: JSON.stringify(ancestralOptions) };
  return { unrooted, rooted, task };
}

test('ancestral parsing requires explicit parent and license and forbids replay overrides', () => {
  const args = ['ancestral', '--experiment', 'root.json', '--license', 'Permission for this alignment', '--options', 'settings.json', '--output', 'ancestors.json'];
  assert.deepEqual(parsePhylogenyCommand(args), { type: 'ancestral', experimentPath: 'root.json', license: 'Permission for this alignment',
    optionsPath: 'settings.json', outputPath: 'ancestors.json', timeoutMs: 300000 });
  for (const flag of ['--experiment', '--license', '--output']) {
    const missing = [...args], at = missing.indexOf(flag); missing.splice(at, 2);
    assert.throws(() => parsePhylogenyCommand(missing));
  }
  for (const bad of [[...args, '--license', 'other'], [...args, '--tree', 'override.nwk'], [...args, '--timeout-ms', '0'],
    ['verify', '--experiment', 'ancestral.json', '--options', 'override.json']]) assert.throws(() => parsePhylogenyCommand(bad));
});

test('real ancestral worker preserves JC69/K80 parents and every original alignment column', async () => {
  for (const distance of ['jc69', 'k80'] as const) {
    const { unrooted, rooted, task } = await ancestralInput(distance);
    const actual = await executePhylogenyTask(task, 10000);
    const expected = await createRootedAncestralExperiment(task.content, task.license, ancestralOptions);
    assert.equal(actual.output, serializeAnalysisRecord(expected.record));
    assert.equal(unrooted.result.usedSites, 100); assert.equal(expected.result.alignmentColumns, 102);
    assert.equal(expected.result.analyzedColumns, 102); assert.equal(expected.result.sites[100].ambiguousTips, 1);
    assert.equal(expected.input.tree.newick, rooted.result.newick);
    assert.match(expected.input.tree.method, new RegExp(distance.toUpperCase()));
    assert.equal(actual.summary.conditionalModel, 'JC69');
    assert.equal(actual.summary.unrootedResultId, unrooted.record.resultId);
    assert.equal(actual.summary.rootedResultId, rooted.record.resultId);
    assert.deepEqual(expected.record.inputs[1].data, JSON.parse(task.content));
    assert.deepEqual(await executePhylogenyTask({ type: 'verify', content: '\uFEFF' + actual.output! }, 10000), actual);
  }
});

test('ancestral exports retain original inputs, source identities and conditional consensus', async () => {
  const { unrooted, rooted, task } = await ancestralInput();
  const accepted = await performPhylogenyTask(task), expected = await replayRootedAncestralExperiment(accepted.output!);
  const view = async (format: HeadlessPhylogenyFormat) => performPhylogenyTask({
    type: 'export', content: accepted.output!, format,
  });
  assert.equal((await view('ancestral-fasta')).output, ancestralFasta(expected.result));
  assert.equal((await view('alignment-fasta')).output, ancestralAlignment);
  assert.equal((await view('newick')).output, `[&R][&branch_units=substitutions/site]\n${rooted.result.newick}\n`);
  assert.deepEqual(JSON.parse((await view('rooting-json')).output!), decision);
  for (const format of ['distances-tsv', 'splits-tsv'] as const) {
    const text = (await view(format)).output!;
    assert.ok(text.includes(`# selected_result_id\t${expected.record.resultId}\n`));
    assert.ok(text.includes(`# rooted_result_id\t${rooted.record.resultId}\n`));
    assert.ok(text.includes(`# result_id\t${unrooted.record.resultId}\n`));
  }
  const splits = JSON.parse((await view('splits-json')).output!);
  assert.equal(splits.selectedResultId, expected.record.resultId);
  assert.equal(splits.sourceResultId, unrooted.record.resultId); assert.deepEqual(splits.splits, unrooted.result.splits);
  await assert.rejects(view('dated-newick'), /requires a fitted/);
  await assert.rejects(performPhylogenyTask({ type: 'export', content: task.content, format: 'ancestral-fasta' }), /requires a linked ancestral/);
});

test('ancestral worker rejects rehashed output forgeries before verification or any export', async () => {
  const { task } = await ancestralInput(), result = await performPhylogenyTask(task);
  const copy = JSON.parse(result.output!) as AnalysisRecord;
  (copy.fields.reconstruction.value as { logLikelihood: number }).logLikelihood += 1;
  const forged = serializeAnalysisRecord(await rehash(copy));
  await parseAnalysisRecord(forged);
  await assert.rejects(executePhylogenyTask({ type: 'verify', content: forged }, 10000), /differs/);
  for (const format of ['ancestral-fasta', 'alignment-fasta', 'newick', 'unrooted-newick', 'distances-tsv', 'splits-tsv', 'splits-json', 'rooting-json'] as const) {
    await assert.rejects(performPhylogenyTask({ type: 'export', content: forged, format }), /differs/);
  }
});

test('ancestral filesystem pipeline verifies before writing and refuses invalid settings, deadlines and cancellation', async () => {
  const { task } = await ancestralInput(), dir = await temporary(), path = (name: string) => join(dir, name);
  await writeFile(path('rooted.json'), task.content); await writeFile(path('settings.json'), task.optionsContent!);
  const args = ['ancestral', '--experiment', path('rooted.json'), '--license', task.license, '--options', path('settings.json'), '--output', path('ancestors.json')];
  await runPhylogenyCommand(args);
  const saved = await readFile(path('ancestors.json'), 'utf8');
  assert.equal(saved, (await performPhylogenyTask(task)).output);
  await runPhylogenyCommand(['verify', '--experiment', path('ancestors.json'), '--output', path('verified.json')]);
  assert.equal(await readFile(path('verified.json'), 'utf8'), saved);
  if (process.platform !== 'win32') assert.equal((await stat(path('ancestors.json'))).mode & 0o077, 0);
  await assert.rejects(runPhylogenyCommand(args), /EEXIST/);
  const failed = args.map(value => value === path('ancestors.json') ? path('failed.json') : value);
  for (const content of ['[]', '{"endColumn":103}', '{"unknown":true}', '{"substitution":{"model":"HKY85"}}']) {
    await writeFile(path('settings.json'), content);
    await assert.rejects(runPhylogenyCommand(failed)); await assert.rejects(access(path('failed.json')), /ENOENT/);
  }
  await writeFile(path('settings.json'), task.optionsContent!);
  await assert.rejects(runPhylogenyCommand([...failed, '--timeout-ms', '1']), /exceeded 1 ms/);
  const controller = new AbortController(), work = runPhylogenyCommand(failed, controller.signal); controller.abort();
  await assert.rejects(work, { name: 'AbortError' }); await assert.rejects(access(path('failed.json')), /ENOENT/);
  const active = new AbortController(), pending = executePhylogenyTask(task, 10000, active.signal); active.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('ancestral settings remain explicit and private when a supplied model differs from the tree distance model', async () => {
  const { task } = await ancestralInput();
  const supplied = { ...ancestralOptions, substitution: { model: 'HKY85', frequencies: [.3, .2, .2, .3], kappa: 3,
    source: 'Private model assumption sentinel', siteRates: [{ rate: 1, weight: 1 }] } };
  const request = { ...task, optionsContent: JSON.stringify(supplied) };
  const expected = await performPhylogenyTask({ ...request });
  const pending = performPhylogenyTask(request);
  request.content = 'changed'; request.license = ''; request.optionsContent = '{}';
  assert.deepEqual(await pending, expected);
  assert.equal(expected.summary.conditionalModel, 'HKY85');
  const summary = JSON.stringify(expected.summary);
  for (const secret of [source.reference, decision.evidence, supplied.substitution.source, ancestralAlignment]) assert.ok(!summary.includes(secret));
  const replay = await replayRootedAncestralExperiment(expected.output!);
  assert.deepEqual(replay.result.options.substitution, supplied.substitution);
  const filtered = await performPhylogenyTask({ ...task, optionsContent: JSON.stringify({ ...ancestralOptions, gapPolicy: 'exclude-column' }) });
  assert.equal(filtered.summary.excludedColumns, 2);
});

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

function readTable(content: string): Array<Record<string, string>> {
  const lines = content.trimEnd().split('\n').filter(line => !line.startsWith('#'));
  const header = lines.shift()!.split('\t');
  return lines.map(line => {
    const cells = line.split('\t');
    assert.equal(cells.length, header.length);
    return Object.fromEntries(header.map((key, i) => [key, cells[i]]));
  });
}

test('temporal tables export numerical residuals, exact date bounds and source identities without rounding', async () => {
  const temporal = await performPhylogenyTask(await temporalTask());
  const dated = await performPhylogenyTask({ type: 'date', content: temporal.output! });
  for (const content of [temporal.output!, dated.output!]) {
    const saved = JSON.parse(content) as AnalysisRecord;
    const exported = await performPhylogenyTask({ type: 'export', content, format: 'temporal-tsv' });
    const text = exported.output!, rows = readTable(text);
    assert.equal(rows.length, 4);
    assert.ok(text.includes(`# selected_result_id\t${saved.resultId}\n`));
    assert.ok(text.includes(`# temporal_result_id\t${temporal.summary.resultId}\n`));
    assert.ok(text.includes('# source_kind\tdemo\n'));
    assert.ok(text.includes('# distance_unit\tsubstitutions/site\n'));
    assert.ok(text.includes('# clock_validated\tfalse\n'));
    for (const row of rows) {
      const i = 'ABCD'.indexOf(row.sample_id);
      assert.ok(i >= 0);
      assert.equal(Number(row.exact_collection_year), dates[i]);
      assert.equal(row.exact_collection_year, row.collection_lower_year);
      assert.equal(row.exact_collection_year, row.collection_upper_year);
      close(Number(row.root_to_tip_distance), paths[i]);
      close(Number(row.predicted_distance), .005 * (dates[i] - 2000));
      close(Number(row.residual), 0);
      close(Number(row.leave_one_out_slope), .005);
      assert.equal(row.included, 'true');
      assert.equal(JSON.parse(row.exclusion_json), null);
      assert.equal(JSON.parse(row.date_source_json), 'Private sample source sentinel');
      assert.equal(JSON.parse(row.permutation_group_json), i < 2 ? 'one' : 'two');
    }
  }
});

test('uncertain, missing and excluded dates stay distinguishable from zero in exported rows', async () => {
  const table = sampleTable.replace(String(dates[3]), '2003').replace(String(dates[1]), '');
  const temporal = await performPhylogenyTask(await temporalTask({ sampleTable: table,
    optionsContent: JSON.stringify({ ...temporalOptions, excludedSamples: ['C'] }) }));
  const exported = await performPhylogenyTask({ type: 'export', content: temporal.output!, format: 'temporal-tsv' });
  const rows = new Map(readTable(exported.output!).map(row => [row.sample_id, row]));
  assert.equal(rows.get('D')!.exact_collection_year, '');
  assert.equal(rows.get('D')!.collection_lower_year, '2003');
  assert.equal(rows.get('D')!.collection_upper_year, '2004');
  assert.match(JSON.parse(rows.get('D')!.exclusion_json), /Uncertain/);
  assert.equal(rows.get('B')!.collection_lower_year, '');
  assert.equal(rows.get('B')!.collection_upper_year, '');
  assert.match(JSON.parse(rows.get('B')!.exclusion_json), /Missing collection date/);
  assert.equal(rows.get('C')!.exact_collection_year, String(dates[2]));
  assert.equal(JSON.parse(rows.get('C')!.exclusion_json), 'Explicit user exclusion');
  assert.equal(rows.get('A')!.included, 'true');
  for (const row of rows.values()) {
    assert.equal(row.predicted_distance, ''); assert.equal(row.residual, '');
    assert.equal(row.leverage, ''); assert.equal(row.leave_one_out_slope, '');
  }
});

test('node date tables expose every branch with correct calendar and genetic units', async () => {
  const temporal = await performPhylogenyTask(await temporalTask());
  const dated = await performPhylogenyTask({ type: 'date', content: temporal.output! });
  const output = await performPhylogenyTask({ type: 'export', content: dated.output!, format: 'dates-tsv' });
  const rows = readTable(output.output!), byId = new Map(rows.map(row => [row.node_id, row]));
  assert.equal(rows.length, 7); // Four tips, two NJ internals, one explicit inserted root.
  assert.equal(rows.filter(row => row.is_tip === 'true').length, 4);
  assert.ok(output.output!.includes('# rate_mode\testimate\n'));
  assert.ok(output.output!.includes('# uncertainty\tnot-estimated\n'));
  const root = rows.find(row => row.parent_id === '')!;
  close(Number(root.calendar_year), 2000, 1e-8);
  assert.equal(root.collection_lower_year, ''); assert.equal(root.collection_upper_year, '');
  assert.equal(root.duration_years, '0'); assert.equal(root.source_length, '0');
  for (const row of rows) {
    if (row.parent_id) {
      const parent = byId.get(row.parent_id)!;
      close(Number(row.duration_years), Number(row.calendar_year) - Number(parent.calendar_year));
      close(Number(row.fitted_length), .005 * Number(row.duration_years));
      close(Number(row.residual), Number(row.source_length) - Number(row.fitted_length));
    }
    if (row.is_tip === 'true') {
      const label = JSON.parse(row.label_json) as string;
      assert.equal(Number(row.calendar_year), dates['ABCD'.indexOf(label)]);
      assert.equal(row.calendar_year, row.collection_lower_year);
      assert.equal(row.calendar_year, row.collection_upper_year);
    }
  }
});

test('typed text exports round-trip quotes, Unicode, backslashes and formula-like metadata', async () => {
  const tricky = '=HYPERLINK("fixture","α") + \\path - @literal';
  // CSV quoting is the input contract; the exported typed text is JSON, not CSV.
  const cell = '"' + tricky.replaceAll('"', '""') + '"';
  const table = 'sampleId,collectionDate,dateSource,accession,permutationGroup\n'
    + [0, 1, 2, 3].map(i => `${'ABCD'[i]},${dates[i]},${cell},${cell},${cell}`).join('\n') + '\n';
  const temporal = await performPhylogenyTask(await temporalTask({ sampleTable: table }));
  const exported = await performPhylogenyTask({ type: 'export', content: temporal.output!, format: 'temporal-tsv' });
  for (const row of readTable(exported.output!)) {
    for (const key of ['accession_json', 'date_source_json', 'permutation_group_json']) {
      assert.equal(JSON.parse(row[key]), tricky);
      assert.ok(row[key].startsWith('"\\u003d'));
      assert.ok(!/[=+@-]/.test(row[key]));
    }
  }
});

test('original collection table survives linked dating and physical export byte-for-byte', async () => {
  const temporal = await performPhylogenyTask(await temporalTask());
  const dated = await performPhylogenyTask({ type: 'date', content: temporal.output! });
  const directory = await temporary(), input = join(directory, 'saved.json'), output = join(directory, 'original.tsv');
  await writeFile(input, dated.output!);
  await runPhylogenyCommand(['export', '--experiment', input, '--format', 'samples-table', '--output', output]);
  assert.deepEqual(await readFile(output), Buffer.from(sampleTable, 'utf8'));
  const tablePath = join(directory, 'residuals.tsv');
  await runPhylogenyCommand(['export', '--experiment', input, '--format', 'temporal-tsv', '--output', tablePath]);
  assert.equal(readTable(await readFile(tablePath, 'utf8')).length, 4);
  await assert.rejects(runPhylogenyCommand(['export', '--experiment', input, '--format', 'samples-table', '--output', output]), /EEXIST/);
});

test('new exports replay before trusting data and reject inapplicable or unavailable node tables', async () => {
  const temporal = await performPhylogenyTask(await temporalTask());
  const date = await performPhylogenyTask({ type: 'date', content: temporal.output! });
  const forged = JSON.parse(date.output!) as AnalysisRecord;
  (forged.fields.dating.value as unknown as { rootDate: number }).rootDate = 1900;
  const content = serializeAnalysisRecord(await rehash(forged));
  await parseAnalysisRecord(content);
  for (const format of ['samples-table', 'temporal-tsv', 'dates-tsv'] as const) {
    await assert.rejects(performPhylogenyTask({ type: 'export', content, format }), /differs/);
    const { unrooted, rooted } = await inputs();
    for (const record of [unrooted.record, rooted.record]) {
      await assert.rejects(performPhylogenyTask({ type: 'export', content: serializeAnalysisRecord(record), format }), /requires a/);
    }
  }
  const boundary = await performPhylogenyTask({ type: 'date', content: temporal.output!, optionsContent: '{"minimumRate":0.02,"maximumRate":0.1}' });
  const directory = await temporary(), input = join(directory, 'boundary.json'), output = join(directory, 'must-not-exist.tsv');
  await writeFile(input, boundary.output!);
  await assert.rejects(runPhylogenyCommand(['export', '--experiment', input, '--format', 'dates-tsv', '--output', output]), /requires a fitted/);
  await assert.rejects(access(output), /ENOENT/);
});
