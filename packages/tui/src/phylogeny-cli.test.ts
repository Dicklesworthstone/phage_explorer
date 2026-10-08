import { test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
test('help is callable through the compiled launcher invocation without any files', async () => {
  let output = '';
  assert.equal(await phylogenyMain(['--help'], text => { output += text; }, () => assert.fail('unexpected error'), 'phage-explorer phylogeny'), 0);
  assert.ok(output.includes('phage-explorer phylogeny infer')); assert.ok(!output.includes('bun scripts'));
});
test('the executor accepts validated commands directly', async () => {
  const f = await fixture(), command = parsePhylogenyCommand(['inspect', '--alignment', f.input]);
  assert.ok(command.type !== 'help');
  assert.equal((await executePhylogenyCommand(command)).alignmentSites, 8);
});
