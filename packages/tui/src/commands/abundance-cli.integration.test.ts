import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';

const entry = fileURLToPath(new URL('../index.tsx', import.meta.url));
const worker = fileURLToPath(new URL('../workers/abundance-worker.ts', import.meta.url));
const command = fileURLToPath(new URL('./abundance.ts', import.meta.url));
const text = 'taxon,S1,S2,S3\nA,1,4,16\nB,16,4,1\n';
const params = '{"pseudocount":0,"numNiches":1,"seed":0,"permutations":19,"qvalueThreshold":1}';
async function run(args: string[], cwd: string, input?: string) {
  const child = Bun.spawn(args, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.end(input ?? '');
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe('abundance source CLI and standalone worker packaging', () => {
  it('routes the real CLI without a catalog and produces browser-compatible records and nonzero failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-abundance-cli-'));
    const parameters = join(dir, 'parameters.json'); await writeFile(parameters, params);
    const first = await run([process.execPath, entry, 'abundance', 'analyze', '-', '--params', parameters], dir, text);
    assert.equal(first.code, 0, first.stderr);
    const record = await parseAnalysisRecord(first.stdout);
    assert.equal(record.seed, 0);
    assert.equal(record.method.id, 'abundance-clr-nmf');
    const saved = join(dir, 'record.json'); await writeFile(saved, first.stdout, { flag: 'wx' });
    const replay = await run([process.execPath, entry, 'abundance', 'replay', saved], dir);
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal(replay.stdout, first.stdout);
    const invalid = await run([process.execPath, entry, 'abundance', 'analyze', '-'], dir, 'not an abundance table');
    assert.equal(invalid.code, 1); assert.equal(invalid.stdout, '');
    const badArgs = await run([process.execPath, entry, 'abundance', 'replay', saved, '--params', parameters], dir);
    assert.equal(badArgs.code, 2); assert.equal(badArgs.stdout, '');
    const output = await run([process.execPath, entry, 'abundance', 'inspect', '-', '--output', saved], dir, text);
    assert.equal(output.code, 1); assert.equal(await readFile(saved, 'utf8'), first.stdout);
  }, 30000);

  it('SIGINT interrupts a stalled real stdin read and publishes no file', async () => {
    if (process.platform === 'win32') return; // POSIX signal delivery; data/worker cancellation is covered on all platforms.
    const dir = await mkdtemp(join(tmpdir(), 'phage-abundance-interrupt-'));
    const output = join(dir, 'must-not-exist.json');
    const child = Bun.spawn([process.execPath, entry, 'abundance', 'analyze', '-', '--output', output], {
      cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const reader = child.stderr.getReader(); let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      while (!stderr.includes('reading-inputs')) {
        const { done, value } = await reader.read();
        assert.equal(done, false, stderr);
        stderr += new TextDecoder().decode(value);
      }
      child.kill('SIGINT');
      child.stdin.end();
      assert.equal(await child.exited, 130);
      assert.equal(await new Response(child.stdout).text(), '');
      assert.equal(await lstat(output).then(() => false, e => e.code === 'ENOENT'), true);
    } finally {
      clearTimeout(timeout); reader.releaseLock();
    }
  }, 15000);

  it('embeds the worker in a two-stage executable and runs it from a directory with no source files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-abundance-compiled-'));
    const fixture = join(dir, 'abundance-entry.ts');
    await writeFile(fixture, `import { runAbundanceProcess } from ${JSON.stringify(command)};\nawait runAbundanceProcess(Bun.argv.slice(2));\n`);
    const bundled = await Bun.build({ entrypoints: [fixture, worker], outdir: join(dir, 'bundles'),
      naming: '[name].js', target: 'bun', define: { PHAGE_ABUNDANCE_WORKER: JSON.stringify('./abundance-worker.js') } });
    assert.equal(bundled.success, true, bundled.logs.map(String).join('\n'));
    const binary = join(dir, process.platform === 'win32' ? 'abundance.exe' : 'abundance');
    const compile = await run([process.execPath, 'build', join(dir, 'bundles/abundance-entry.js'),
      join(dir, 'bundles/abundance-worker.js'), '--compile', '--outfile', binary], dir);
    assert.equal(compile.code, 0, compile.stderr);
    const elsewhere = await mkdtemp(join(tmpdir(), 'phage-abundance-empty-'));
    const result = await run([binary, 'analyze', '-'], elsewhere, text);
    assert.equal(result.code, 0, result.stderr);
    const parsed = await parseAnalysisRecord(result.stdout);
    const replay = await run([binary, 'replay', '-'], elsewhere, result.stdout);
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal((await parseAnalysisRecord(replay.stdout)).resultId, parsed.resultId);
  }, 120000);
});
