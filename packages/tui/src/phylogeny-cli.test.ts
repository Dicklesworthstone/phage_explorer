import { test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executeAlignedPhylogenyRequest } from '../../web/src/workers/AlignedPhylogenySession';
import { parsePhylogenyCommand, executePhylogenyCommand, phylogenyMain, readPhylogenyInput } from '../../../scripts/phylogeny';
const alignment = '>A\nAAAAAAAA\n>B\nAAAAAAAA\n>C\nCCCCAAAA\n>D\nCCCCAAAA';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'phage-phylogeny-test-'));
  const input = join(dir, 'aligned.fa'), output = join(dir, 'experiment.json');
  await writeFile(input, alignment, { flag: 'wx' });
  const args = ['infer', '--alignment', input, '--source', 'Synthetic regression fixture', '--output', output, '--demo', '--bootstrap', '20', '--seed', '0'];
  return { dir, input, output, args };
}
async function run(args: string[]) {
  let stdout = '', stderr = '';
  const code = await phylogenyMain(args, text => { stdout += text; }, text => { stderr += text; });
  return { code, stdout, stderr };
}
test('strict parser requires explicit input/source/output and forbids replay overrides', () => {
  for (const args of [[], ['unknown'], ['infer', '--alignment', 'a.fa'], ['replay', '--experiment', 'x', '--seed', '0'],
    ['infer', '--seed', '-1'], ['infer', '--seed', '0x10'], ['inspect', '--alignment', 'a', '--alignment', 'b'],
    ['export', '--experiment', 'x', '--format', 'xml', '--output', 'y']]) assert.throws(() => parsePhylogenyCommand(args));
});
test('inspect needs no catalog and never prints private alignment bases', async () => {
  const f = await fixture(), result = await run(['inspect', '--alignment', f.input]);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).taxa, ['A', 'B', 'C', 'D']);
  assert.ok(!result.stdout.includes('AAAAAAAA'));
});
test('infer saves source-bound output with seed zero and owner-only access', async () => {
  const f = await fixture(), result = await run(f.args);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const saved = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(saved.parameters.seed, 0); assert.equal(saved.inputs[0].source, 'demo');
  assert.equal(saved.inputs[0].data.fasta, alignment);
  assert.equal(saved.fields.phylogeny.value.splits[0].support, 1);
  if (process.platform !== 'win32') assert.equal((await stat(f.output)).mode & 0o777, 0o600);
});
test('replay reproduces the exact experiment without option overrides', async () => {
  const f = await fixture(); assert.equal((await run(f.args)).code, 0);
  const copy = join(f.dir, 'verified.json');
  const result = await run(['replay', '--experiment', f.output, '--output', copy]);
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).verified, true);
  assert.equal(await readFile(copy, 'utf8'), await readFile(f.output, 'utf8'));
});
test('Newick, split supports and distances exports all recompute from the same experiment', async () => {
  const f = await fixture(); assert.equal((await run(f.args)).code, 0);
  for (const format of ['newick', 'distances', 'splits']) {
    const output = join(f.dir, format);
    const result = await run(['export', '--experiment', f.output, '--format', format, '--output', output]);
    assert.equal(result.code, 0, result.stderr);
    const content = await readFile(output, 'utf8');
    if (format === 'newick') { assert.ok(content.endsWith(';\n')); assert.ok(content.includes("'A'")); }
    if (format === 'distances') assert.ok(content.includes('A\t0\t0\t0.5\t0.5'));
    if (format === 'splits') assert.deepEqual(JSON.parse(content).splits[0].side, ['A', 'B']);
  }
});
test('bad checksums cannot be laundered through a Newick export', async () => {
  const f = await fixture(); assert.equal((await run(f.args)).code, 0);
  const changed = JSON.parse(await readFile(f.output, 'utf8')); changed.fields.phylogeny.value.newick = '(forged);';
  const bad = join(f.dir, 'bad.json'), output = join(f.dir, 'forged.nwk');
  await writeFile(bad, JSON.stringify(changed), { flag: 'wx' });
  const result = await run(['export', '--experiment', bad, '--format', 'newick', '--output', output]);
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
test('inference never replaces an existing output or symlink', async () => {
  const f = await fixture(); await writeFile(f.output, 'keep me', { flag: 'wx' });
  assert.equal((await run(f.args)).code, 1); assert.equal(await readFile(f.output, 'utf8'), 'keep me');
  if (process.platform !== 'win32') {
    const link = join(f.dir, 'existing-link'); await symlink(f.output, link);
    assert.equal((await run(['infer', '--alignment', f.input, '--source', 'synthetic', '--output', link])).code, 1);
    assert.equal(await readFile(f.output, 'utf8'), 'keep me');
  }
});
test('input bounds, regular-file checks, and UTF-8 decoding fail explicitly', async () => {
  const f = await fixture(); await assert.rejects(readPhylogenyInput(f.input, 1), /limit/);
  await assert.rejects(readPhylogenyInput(f.dir, 1024), /regular file/);
  const bad = join(f.dir, 'bad.fa'); await writeFile(bad, new Uint8Array([0xff, 0xfe]), { flag: 'wx' });
  await assert.rejects(readPhylogenyInput(bad, 1024));
});
test('saturation returns an error without creating a partial experiment', async () => {
  const f = await fixture(), saturated = join(f.dir, 'saturated.fa');
  await writeFile(saturated, '>A\nAAAA\n>B\nCCCC\n>C\nTTTT', { flag: 'wx' });
  const result = await run(['infer', '--alignment', saturated, '--source', 'synthetic', '--distance', 'jc69', '--output', f.output]);
  assert.equal(result.code, 1); assert.match(result.stderr, /undefined/); await assert.rejects(stat(f.output), { code: 'ENOENT' });
});
test('help supports the launcher invocation name without any files', async () => {
  let output = '';
  assert.equal(await phylogenyMain(['--help'], text => { output += text; }, () => assert.fail('unexpected error'), 'phage-explorer phylogeny'), 0);
  assert.ok(output.includes('phage-explorer phylogeny infer')); assert.ok(!output.includes('bun scripts'));
});
test('the executor accepts validated commands directly', async () => {
  const f = await fixture(), command = parsePhylogenyCommand(['inspect', '--alignment', f.input]);
  assert.ok(command.type !== 'help');
  assert.equal((await executePhylogenyCommand(command)).alignmentSites, 8);
});

// Invoke the actual launcher, not just phylogenyMain with a substituted help prefix.
const launcher = fileURLToPath(new URL('./index.tsx', import.meta.url));
function launch(args: string[], cwd: string) {
  return spawnSync(process.execPath, [launcher, ...args], { cwd, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PHAGE_EXPLORER_DB_PATH: join(cwd, 'no-catalog.db'), PHAGE_DB_PATH: join(cwd, 'no-catalog.db') } });
}
test('real terminal entry point exposes phylogeny help and inspection without a catalog or Ink', async () => {
  const f = await fixture();
  const help = launch(['phylogeny', '--help'], f.dir);
  assert.equal(help.status, 0, help.stderr); assert.equal(help.stderr, '');
  assert.ok(help.stdout.includes('phage-explorer phylogeny infer'));
  const inspect = launch(['phylogeny', 'inspect', '--alignment', f.input], f.dir);
  assert.equal(inspect.status, 0, inspect.stderr); assert.deepEqual(JSON.parse(inspect.stdout).taxa, ['A','B','C','D']);
  assert.ok(!inspect.stdout.includes('AAAAAAAA'));
});
test('actual launcher and browser worker operation exchange identical source-bound experiments', async () => {
  const f = await fixture(); const inferred = launch(['phylogeny', ...f.args], f.dir);
  assert.equal(inferred.status, 0, inferred.stderr);
  const content = await readFile(f.output, 'utf8');
  const fromWorker = await executeAlignedPhylogenyRequest({ kind: 'replay', content });
  assert.equal(fromWorker.record.resultId, JSON.parse(inferred.stdout).resultId);
  assert.equal(fromWorker.source.fasta, alignment); assert.equal(fromWorker.options.seed, 0);
  const replay = launch(['phylogeny', 'replay', '--experiment', f.output], f.dir);
  assert.equal(replay.status, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).resultId, fromWorker.record.resultId);
  assert.equal(JSON.parse(replay.stdout).verified, true);
  const output = join(f.dir, 'tree.nwk');
  const exported = launch(['phylogeny', 'export', '--experiment', f.output, '--format', 'newick', '--output', output], f.dir);
  assert.equal(exported.status, 0, exported.stderr); assert.equal(await readFile(output, 'utf8'), fromWorker.result.newick + '\n');
  const repeated = launch(['phylogeny', ...f.args], f.dir);
  assert.equal(repeated.status, 1); assert.equal(await readFile(f.output, 'utf8'), content);
});

function rootArgs(input: string, output: string): string[] {
  return ['root', '--experiment', input, '--outgroup', 'A,B', '--fraction', '0.25',
    '--rooting-evidence', 'Synthetic AB outgroup and explicit quarter-edge placement; not a biological claim.', '--date-independent', '--output', output];
}
test('root parser requires all explicit decisions and forbids rooting overrides during replay', () => {
  const args = rootArgs('original.json', 'rooted.json');
  const parsed = parsePhylogenyCommand(args);
  assert.ok(parsed.type === 'root'); assert.equal(parsed.rooting.fractionFromOutgroup, 0.25);
  for (const flag of ['--outgroup', '--fraction', '--rooting-evidence', '--date-independent']) {
    const missing = [...args]; const i = missing.indexOf(flag); missing.splice(i, flag === '--date-independent' ? 1 : 2);
    assert.throws(() => parsePhylogenyCommand(missing));
  }
  for (const value of ['', 'NaN', 'Infinity', '0x1', '1e-1', '-0.5', '0', '1']) {
    const invalid = [...args]; invalid[invalid.indexOf('--fraction') + 1] = value;
    assert.throws(() => parsePhylogenyCommand(invalid));
  }
  for (const outgroup of ['A,A', 'A,,B', ',A', 'A B']) {
    const invalid = [...args]; invalid[invalid.indexOf('--outgroup') + 1] = outgroup;
    assert.throws(() => parsePhylogenyCommand(invalid));
  }
  assert.throws(() => parsePhylogenyCommand([...args, '--date-independent']));
  assert.throws(() => parsePhylogenyCommand(['replay', '--experiment', 'rooted.json', '--fraction', '0.5']));
});
test('real launcher creates, replays and exports a source-bound explicit root without modifying its original', async () => {
  const f = await fixture(); assert.equal(launch(['phylogeny', ...f.args], f.dir).status, 0);
  const original = await readFile(f.output, 'utf8'), originalRecord = JSON.parse(original);
  const rootedPath = join(f.dir, 'rooted.json');
  const root = launch(['phylogeny', ...rootArgs(f.output, rootedPath)], f.dir);
  assert.equal(root.status, 0, root.stderr); assert.equal(root.stderr, '');
  const summary = JSON.parse(root.stdout), saved = await readFile(rootedPath, 'utf8'), record = JSON.parse(saved);
  assert.equal(summary.method.id, 'explicit-outgroup-rooted-nj'); assert.equal(summary.sourceResultId, originalRecord.resultId);
  assert.deepEqual(summary.distancePreservation, { pairs: 6, maxAbsoluteDifference: 0 });
  assert.ok(!root.stdout.includes('CCCCAAAA')); assert.equal(record.inputs[0].source, 'demo');
  assert.equal(record.inputs[0].data.fasta, alignment); assert.equal(record.seed, 0);
  const copy = join(f.dir, 'rooted-copy.json');
  const replay = launch(['phylogeny', 'replay', '--experiment', rootedPath, '--output', copy], f.dir);
  assert.equal(replay.status, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).verified, true);
  assert.equal(await readFile(copy, 'utf8'), saved); assert.equal(await readFile(f.output, 'utf8'), original);
  if (process.platform !== 'win32') assert.equal((await stat(rootedPath)).mode & 0o777, 0o600);
  for (const format of ['newick', 'distances', 'splits']) {
    const output = join(f.dir, `rooted-${format}`);
    const exported = launch(['phylogeny', 'export', '--experiment', rootedPath, '--format', format, '--output', output], f.dir);
    assert.equal(exported.status, 0, exported.stderr);
    const text = await readFile(output, 'utf8');
    if (format === 'newick') assert.equal(text, "(('A':0,'B':0):0.125,('C':0,'D':0):0.375);\n");
    if (format === 'distances') assert.ok(text.includes('A\t0\t0\t0.5\t0.5'));
    if (format === 'splits') {
      const splits = JSON.parse(text);
      assert.deepEqual(splits.splits, originalRecord.fields.phylogeny.value.splits);
      assert.equal(splits.sourceResultId, originalRecord.resultId); assert.match(splits.supportScope, /no root-placement support/);
    }
  }
});
test('rooting rejects absent, nonseparable and zero-length outgroups without creating output', async () => {
  const f = await fixture(); assert.equal((await run(f.args)).code, 0);
  for (const outgroup of ['missing', 'A,C', 'A']) {
    const output = join(f.dir, `rejected-${outgroup}.json`), args = rootArgs(f.output, output);
    args[args.indexOf('--outgroup') + 1] = outgroup;
    const rejected = await run(args);
    assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});
test('negative NJ branches cannot be laundered into a rooted downstream tree', async () => {
  const f = await fixture(), input = join(f.dir, 'negative.fa'), original = join(f.dir, 'negative.json'), output = join(f.dir, 'negative-rooted.json');
  await writeFile(input, '>A\nAAAAAAAA\n>B\nAAAAAAAC\n>C\nAAAAAACC', { flag: 'wx' });
  assert.equal((await run(['infer', '--alignment', input, '--source', 'Synthetic JC69 negative-limb fixture', '--distance', 'jc69', '--output', original, '--demo'])).code, 0);
  const args = rootArgs(original, output); args[args.indexOf('--outgroup') + 1] = 'A';
  const rejected = await run(args); assert.equal(rejected.code, 1); assert.match(rejected.stderr, /nonnegative original/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
test('rooted replay and export reject tampering before creating a verified copy', async () => {
  const f = await fixture(); assert.equal((await run(f.args)).code, 0);
  const output = join(f.dir, 'rooted.json'); assert.equal((await run(rootArgs(f.output, output))).code, 0);
  const saved = JSON.parse(await readFile(output, 'utf8')); saved.fields.rooting.value.newick = '(forged);';
  const forged = join(f.dir, 'forged.json'); await writeFile(forged, JSON.stringify(saved), { flag: 'wx' });
  for (const kind of ['replay', 'export']) {
    const destination = join(f.dir, `rejected-${kind}`);
    const args = [kind, '--experiment', forged, '--output', destination]; if (kind === 'export') args.push('--format', 'newick');
    assert.equal((await run(args)).code, 1); await assert.rejects(stat(destination), { code: 'ENOENT' });
  }
});
test('rooted exports refuse existing files and existing symlinks', async () => {
  const f = await fixture(); assert.equal((await run(f.args)).code, 0);
  const original = await readFile(f.output, 'utf8');
  assert.equal((await run(rootArgs(f.output, f.output))).code, 1); assert.equal(await readFile(f.output, 'utf8'), original);
  if (process.platform !== 'win32') {
    const link = join(f.dir, 'root-link'); await symlink(f.output, link);
    assert.equal((await run(rootArgs(f.output, link))).code, 1); assert.equal(await readFile(f.output, 'utf8'), original);
  }
});
test('root requires an original inference instead of accumulating rerooting edits', async () => {
  const f = await fixture(); assert.equal((await run(f.args)).code, 0);
  const rooted = join(f.dir, 'rooted.json'), output = join(f.dir, 'second-root.json');
  assert.equal((await run(rootArgs(f.output, rooted))).code, 0);
  const rejected = await run(rootArgs(rooted, output)); assert.equal(rejected.code, 1); assert.match(rejected.stderr, /incompatible/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
