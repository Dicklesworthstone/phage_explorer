import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, open, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAlignedPhylogenyExperiment, resolvePhylogenyOptions } from '../../core/src/analysis/aligned-phylogeny';
import { createAnalysisRecord, serializeAnalysisRecord, type AnalysisJson } from '../../core/src/analysis-result';
import { executePhylogenyTask, parsePhylogenyCommand, performPhylogenyTask, runPhylogenyCommand, type PhylogenyTask } from './headless-phylogeny';

const fasta = '>A\nAAAACCCC\n>B\nAAAACCCA\n>C\nAATTCCCC\n>D\nAATTCCCA\n';
const source = { name: 'CLI fixture', reference: 'Explicit synthetic aligned columns', kind: 'demo' as const };
const inferArgs = ['infer', '--input', 'input.fa', '--alignment', 'provided', '--name', source.name, '--reference', source.reference, '--output', 'out.json'];
const task = (): PhylogenyTask => ({ type: 'infer', content: fasta, source, options: resolvePhylogenyOptions({ bootstrap: 20, seed: 17 }) });
const temporary = () => mkdtemp(join(tmpdir(), 'phage-phylogeny-'));
const fileArgs = (input: string, output: string) => ['infer', '--input', input, '--alignment', 'provided', '--name', source.name, '--reference', source.reference,
  '--source', 'demo', '--bootstrap', '20', '--seed', '17', '--output', output];

test('commands require explicit alignment and provenance and retain safe defaults', () => {
  assert.deepEqual(parsePhylogenyCommand([]), { type: 'help' });
  assert.deepEqual(parsePhylogenyCommand(['--help']), { type: 'help' });
  const command = parsePhylogenyCommand(inferArgs);
  assert.equal(command.type, 'infer');
  if (command.type !== 'infer') throw new Error('Wrong command');
  assert.deepEqual(command.options, resolvePhylogenyOptions());
  assert.equal(command.source.kind, 'local');
  assert.equal(command.timeoutMs, 300000);
  assert.deepEqual(parsePhylogenyCommand(['verify', '--experiment', 'saved.json']), { type: 'verify', experimentPath: 'saved.json', timeoutMs: 300000 });
});

test('parser rejects malformed, repeated, inapplicable and silently coercible options', () => {
  const rejected = [
    [...inferArgs, '--seed', '1e2'], [...inferArgs, '--seed', '-1'], [...inferArgs, '--seed', '4294967296'],
    [...inferArgs, '--bootstrap', '19'], [...inferArgs, '--bootstrap', '201'], [...inferArgs, '--bootstrap', '20.5'],
    [...inferArgs, '--timeout-ms', '0'], [...inferArgs, '--timeout-ms', '3600001'], [...inferArgs, '--source', 'external'],
    [...inferArgs, '--distance', 'mash'], [...inferArgs, '--output', 'again.json'], [...inferArgs, '--unknown', 'x'],
    [...inferArgs, '--seed'], [...inferArgs, '--seed', '1\n'], inferArgs.filter(value => !['--alignment', 'provided'].includes(value)),
    inferArgs.map(value => value === 'provided' ? 'automatic' : value), ['export', '--experiment', 'x', '--output', 'y', '--format', 'pdf'],
    ['verify', '--experiment', 'x', '--seed', '2'], ['inspect', '--input', 'x', '--output', 'y'], ['infer', '--input', 'x'],
  ];
  for (const args of rejected) assert.throws(() => parsePhylogenyCommand(args), args.join(' '));
});

test('inspection reports shared complete-column coverage without printing bases', async () => {
  const result = await performPhylogenyTask({ type: 'inspect', content: '>B\nAANN\n>A\nAACC\n>C\nAAT-\n' });
  assert.deepEqual(result.summary, { taxa: ['A', 'B', 'C'], alignmentSites: 4, completeColumns: 2, excludedColumns: 2, homologyVerified: false });
  assert.equal(result.output, undefined);
});

test('headless output has exactly the same identity as the browser/core experiment', async () => {
  const result = await performPhylogenyTask(task());
  const direct = await createAlignedPhylogenyExperiment({ ...source, fasta }, { bootstrap: 20, seed: 17 });
  assert.equal(result.output, serializeAnalysisRecord(direct.record));
  assert.equal(result.summary.resultId, direct.record.resultId);
  assert.ok(!JSON.stringify(result.summary).includes('AAAACCCC'));
  const replay = await performPhylogenyTask({ type: 'verify', content: result.output! });
  assert.deepEqual(replay, result);
});

test('every export rejects a forged result even after its checksums are regenerated', async () => {
  const original = await createAlignedPhylogenyExperiment({ ...source, fasta });
  const record = structuredClone(original.record);
  record.fields.phylogeny.value = { ...(record.fields.phylogeny.value as Record<string, AnalysisJson>), variableSites: 999 };
  const forged = await createAnalysisRecord({ method: record.method, parameters: record.parameters, seed: record.seed, references: record.references,
    fields: record.fields, inputs: record.inputs.map(input => ({ id: input.id, accession: input.accession, source: input.source, description: input.description, data: input.data })) });
  const content = serializeAnalysisRecord(forged);
  for (const format of ['newick', 'distances-tsv', 'splits-tsv', 'alignment-fasta'] as const) {
    await assert.rejects(performPhylogenyTask({ type: 'export', content, format }), /Recomputed phylogeny differs/);
  }
  await assert.rejects(performPhylogenyTask({ type: 'verify', content }), /Recomputed phylogeny differs/);
});

test('a real worker computes the same result and terminates on success or failure', async () => {
  assert.deepEqual(await executePhylogenyTask(task(), 10000), await performPhylogenyTask(task()));
  await assert.rejects(executePhylogenyTask({ type: 'inspect', content: '>A\nATG\n' }, 10000), /at least three/);
});

test('worker cancellation and deadlines reject without returning a partial result', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executePhylogenyTask(task(), 10000, controller.signal), { name: 'AbortError' });
  const expensive: PhylogenyTask = { type: 'infer', content: ['A', 'B', 'C'].map(id => `>${id}\n${'A'.repeat(100000)}\n`).join(''),
    source, options: resolvePhylogenyOptions({ bootstrap: 200 }) };
  await assert.rejects(executePhylogenyTask(expensive, 1), /exceeded 1 ms/);
  const active = new AbortController();
  const running = executePhylogenyTask(expensive, 10000, active.signal);
  active.abort();
  await assert.rejects(running, { name: 'AbortError' });
});

test('files round-trip through inference, verification and export without overwriting', async () => {
  const directory = await temporary(), input = join(directory, 'aligned.fa'), output = join(directory, 'experiment.json'), copy = join(directory, 'copy.json');
  await writeFile(input, fasta);
  const summary = await runPhylogenyCommand(fileArgs(input, output));
  assert.equal(typeof summary, 'object');
  const first = await readFile(output, 'utf8');
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o077, 0);
  await runPhylogenyCommand(['verify', '--experiment', output, '--output', copy]);
  assert.equal(await readFile(copy, 'utf8'), first);
  const tree = join(directory, 'tree.nwk');
  await runPhylogenyCommand(['export', '--experiment', copy, '--format', 'newick', '--output', tree]);
  assert.ok((await readFile(tree, 'utf8')).startsWith('[&U]'));
  const original = join(directory, 'original.fa');
  await runPhylogenyCommand(['export', '--experiment', copy, '--format', 'alignment-fasta', '--output', original]);
  assert.equal(await readFile(original, 'utf8'), fasta);
  await assert.rejects(runPhylogenyCommand(fileArgs(input, output)), /EEXIST/);
  assert.equal(await readFile(output, 'utf8'), first);
  if (process.platform !== 'win32') {
    const link = join(directory, 'linked-output.json');
    await symlink(output, link);
    await assert.rejects(runPhylogenyCommand(fileArgs(input, link)), /EEXIST/);
    assert.equal(await readFile(output, 'utf8'), first);
  }
});

test('invalid computation and aborted requests create no output file', async () => {
  const directory = await temporary(), input = join(directory, 'bad.fa'), output = join(directory, 'must-not-exist.json');
  await writeFile(input, '>A\nNNNN\n>B\nNNNN\n>C\nNNNN\n');
  await assert.rejects(runPhylogenyCommand(fileArgs(input, output)), /No complete/);
  await assert.rejects(access(output), /ENOENT/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runPhylogenyCommand(fileArgs(input, output), controller.signal), { name: 'AbortError' });
  await assert.rejects(access(output), /ENOENT/);
});

test('bounded reader rejects oversized files, directories and invalid UTF-8', async () => {
  const directory = await temporary(), large = join(directory, 'large.fa'), invalid = join(directory, 'invalid.fa');
  const file = await open(large, 'wx');
  try { await file.truncate(2 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(runPhylogenyCommand(['inspect', '--input', large]), /exceeds/);
  await assert.rejects(runPhylogenyCommand(['inspect', '--input', directory]), /regular file|EISDIR/);
  await writeFile(invalid, Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(runPhylogenyCommand(['inspect', '--input', invalid]));
});


test('physical FASTA import/export preserves a UTF-8 BOM while saved JSON accepts one', async () => {
  const directory = await temporary(), input = join(directory, 'bom.fa'), output = join(directory, 'bom.json'), original = join(directory, 'original.fa');
  const text = '\uFEFF' + fasta.replaceAll('\n', '\r\n');
  await writeFile(input, text);
  await runPhylogenyCommand(fileArgs(input, output));
  const saved = await readFile(output, 'utf8');
  assert.equal(JSON.parse(saved).inputs[0].data.fasta, text);
  const withBom = join(directory, 'bom-experiment.json');
  await writeFile(withBom, '\uFEFF' + saved);
  await runPhylogenyCommand(['export', '--experiment', withBom, '--format', 'alignment-fasta', '--output', original]);
  assert.deepEqual(await readFile(original), await readFile(input));
});
