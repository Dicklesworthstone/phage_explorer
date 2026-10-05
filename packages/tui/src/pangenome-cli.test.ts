import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pangenomeMain, parsePangenomeCommand } from '../../../scripts/pangenome';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { parsePangenomeInput } from '../../core/src/analysis/alignment-pangenome';

async function run(args: string[]) {
  let stdout = '', stderr = '';
  const code = await pangenomeMain(args, text => { stdout += text; }, text => { stderr += text; });
  return { code, stdout, stderr };
}
async function fixture(sequence = 'ACGTCAGT', query = 'ACGTGCAGT') {
  const dir = await mkdtemp(join(tmpdir(), 'phage-pangenome-'));
  const input = join(dir, 'sequences.fasta'), output = join(dir, 'experiment.json');
  await writeFile(input, `>reference\n${sequence}\n>query\n${query}\n`);
  return { dir, input, output };
}
const build = (input: string, output: string, extra: string[] = []) =>
  ['build', '--input', input, '--output', output, '--reference', 'reference', '--alignment', 'wavefront', ...extra];
const absent = async (path: string) => { await assert.rejects(stat(path), { code: 'ENOENT' }); };

describe('pangenome command-line workflow', () => {
  it('requires explicit alignment/reference settings and rejects unsupported, repeated or malformed options', () => {
    assert.deepEqual(parsePangenomeCommand(['--help']), { type: 'help' });
    assert.deepEqual(parsePangenomeCommand(build('a', 'b')), { type: 'build', inputPath: 'a', outputPath: 'b',
      options: { referenceId: 'reference', alignment: 'wavefront', terminalGaps: 'missing' } });
    for (const args of [[], ['unknown'], ['build', '--input', 'a', '--output', 'b'],
      ['build', '--alignment', 'global', '--input', 'a', '--output', 'b'],
      [...build('a', 'b'), '--alignment', 'global'], [...build('a', 'b'), '--terminal-gaps', 'infer'],
      ['inspect', '--input'], ['inspect', '--input', 'a', '--force', 'true'], ['inspect', '--input', 'x\u001b[31m'],
      ['export', '--experiment', 'a', '--format', 'vcf', '--output', 'b'], ['verify', '--experiment', '--output'],
    ]) assert.throws(() => parsePangenomeCommand(args));
  });
  it('builds, verifies and exports a genome-scale graph using actual local files and safe summaries', async () => {
    const a = 'ACGT'.repeat(5000), b = a.slice(0, 10000) + 'T' + a.slice(10001);
    const f = await fixture(a, b);
    const inspected = await run(['inspect', '--input', f.input]);
    assert.equal(inspected.code, 0); assert.equal(inspected.stderr, '');
    assert.deepEqual(JSON.parse(inspected.stdout).sequences.map((s: { id: string; ungappedLength: number }) => [s.id, s.ungappedLength]), [['query', 20000], ['reference', 20000]]);
    const built = await run(build(f.input, f.output));
    assert.equal(built.code, 0, built.stderr);
    const summary = JSON.parse(built.stdout);
    assert.equal(summary.variants, 1); assert.equal(summary.referenceLength, 20000); assert.equal(summary.method.version, '3');
    assert.equal(summary.verified, false); assert.equal(summary.wavefront.pairs[0].distance, 1);
    assert(!built.stdout.includes(a.slice(0, 40))); assert(!inspected.stdout.includes(a.slice(0, 40)));
    const saved = await readFile(f.output, 'utf8'), record = await parseAnalysisRecord(saved);
    assert.equal(record.resultId, summary.resultId);
    if (process.platform !== 'win32') assert.equal((await stat(f.output)).mode & 0o777, 0o600);
    const copy = join(f.dir, 'verified.json');
    const verified = await run(['verify', '--experiment', f.output, '--output', copy]);
    assert.equal(verified.code, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).verified, true);
    assert.equal(JSON.parse(verified.stdout).resultId, record.resultId);
    assert.equal(await readFile(copy, 'utf8'), saved);
    const gfaPath = join(f.dir, 'graph.gfa'), fastaPath = join(f.dir, 'aligned.fasta'), datasetPath = join(f.dir, 'dataset.json');
    for (const [format, output] of [['gfa', gfaPath], ['fasta', fastaPath], ['dataset', datasetPath]]) {
      const result = await run(['export', '--experiment', f.output, '--format', format, '--output', output]);
      assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).verified, true);
      assert(!result.stdout.includes(a.slice(0, 40)));
    }
    // Independent GFA reader checks that the exported paths still spell both genomes.
    const segments = new Map<string, string>(), spellings: string[] = [];
    for (const line of (await readFile(gfaPath, 'utf8')).split('\n')) {
      const parts = line.split('\t');
      if (parts[0] === 'S') segments.set(parts[1], parts[2]);
      if (parts[0] === 'P') spellings.push(parts[2].split(',').map(id => { assert(id.endsWith('+')); return segments.get(id.slice(0, -1)); }).join(''));
    }
    assert.deepEqual(spellings.sort(), [a, b].sort());
    assert.deepEqual(parsePangenomeInput(await readFile(fastaPath, 'utf8')).sequences.map(s => s.sequence.replaceAll('-', '')).sort(), [a, b].sort());
    const dataset = parsePangenomeInput(await readFile(datasetPath, 'utf8'));
    assert.deepEqual(dataset.sequences.map(s => s.sequence).sort(), [a, b].sort());
    const rebuilt = join(f.dir, 'rebuilt.json');
    assert.equal((await run(build(datasetPath, rebuilt))).code, 0);
    assert.equal((await parseAnalysisRecord(await readFile(rebuilt, 'utf8'))).resultId, record.resultId);
  });
  it('refuses existing output files and symlinks without altering them', async () => {
    const f = await fixture();
    assert.equal((await run(build(f.input, f.output))).code, 0);
    const original = await readFile(f.output, 'utf8');
    assert.equal((await run(build(f.input, f.output))).code, 1);
    assert.equal((await run(['verify', '--experiment', f.output, '--output', f.output])).code, 1);
    assert.equal((await run(['export', '--experiment', f.output, '--format', 'gfa', '--output', f.output])).code, 1);
    assert.equal(await readFile(f.output, 'utf8'), original);
    const source = await readFile(f.input, 'utf8');
    assert.equal((await run(build(f.input, f.input))).code, 1); assert.equal(await readFile(f.input, 'utf8'), source);
    if (process.platform !== 'win32') {
      const link = join(f.dir, 'existing-link'); await symlink(f.input, link);
      assert.equal((await run(build(f.input, link))).code, 1);
      assert.equal(await readFile(f.input, 'utf8'), source);
    }
  });
  it('returns an error without creating outputs for invalid UTF-8, oversized, nonregular or malformed inputs', async () => {
    const f = await fixture();
    const invalid = join(f.dir, 'invalid'), big = join(f.dir, 'oversized');
    await writeFile(invalid, new Uint8Array([0xff, 0xfe, 0x80]));
    await writeFile(big, Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    for (const input of [invalid, big, f.dir]) {
      const result = await run(build(input, f.output));
      assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert(result.stderr.trim()); await absent(f.output);
    }
    const malformed = join(f.dir, 'malformed'); await writeFile(malformed, '>onlyone\nACGT');
    assert.equal((await run(build(malformed, f.output))).code, 1); await absent(f.output);
  });
  it('refuses an exhausted exact-alignment budget and permits the next valid invocation', async () => {
    const f = await fixture('A'.repeat(2100), 'C'.repeat(2100));
    const result = await run(build(f.input, f.output));
    assert.equal(result.code, 1); assert.match(result.stderr, /state budget/); await absent(f.output);
    const good = await fixture();
    assert.equal((await run(build(good.input, good.output))).code, 0);
  });
  it('keeps existing supplied/global workflows and explicit terminal-gap semantics', async () => {
    const f = await fixture('ACGT--', 'ACGTAA');
    for (const [policy, variants] of [['missing', 0], ['alleles', 1]] as const) {
      const output = join(f.dir, `${policy}.json`);
      const result = await run(['build', '--input', f.input, '--output', output, '--reference', 'reference', '--alignment', 'provided', '--terminal-gaps', policy]);
      assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).variants, variants);
      assert.equal(JSON.parse(result.stdout).method.version, '2');
      assert.equal((await run(['verify', '--experiment', output])).code, 0);
    }
    const small = await fixture();
    const global = await run(['build', '--input', small.input, '--output', small.output, '--reference', 'reference', '--alignment', 'global']);
    assert.equal(global.code, 0, global.stderr); assert.equal(JSON.parse(global.stdout).method.version, '2');
  });
  it('refuses forged graph content even when its checksums are recomputed, before creating an export', async () => {
    const f = await fixture(); assert.equal((await run(build(f.input, f.output))).code, 0);
    const saved = await parseAnalysisRecord(await readFile(f.output, 'utf8'));
    const fields = structuredClone(saved.fields); fields.variants.value = [];
    const forged = await createAnalysisRecord({ ...saved, fields });
    const path = join(f.dir, 'forged.json'), exported = join(f.dir, 'forged.gfa');
    await writeFile(path, serializeAnalysisRecord(forged));
    const result = await run(['export', '--experiment', path, '--format', 'gfa', '--output', exported]);
    assert.equal(result.code, 1); assert.match(result.stderr, /Recomputed/); await absent(exported);
    assert.equal((await run(['verify', '--experiment', path])).code, 1);
  });
  it('shows help without opening any files and sanitizes error control characters', async () => {
    assert.equal((await run(['--help'])).code, 0);
    const error = await run(['inspect', '--\u001b[31munknown', 'x']);
    assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert(!error.stderr.includes('\u001b'));
    const f = await fixture(); const before = await readdir(f.dir);
    const missing = await run(build(f.input, f.output).map(value => value === 'reference' ? 'absent' : value));
    assert.equal(missing.code, 1); assert.deepEqual(await readdir(f.dir), before);
  });
});
