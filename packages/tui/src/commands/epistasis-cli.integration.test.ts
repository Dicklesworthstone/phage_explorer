import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executableBuildOptions, executableCompileArgs } from '../../../../scripts/build';
import { parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { createEpistasisAssayTemplate, type EpistasisAssayResult } from '../../../core/src/analysis/epistasis-evidence';
import { executeEpistasisEvidenceRequest } from '../../../web/src/workers/EpistasisEvidenceSession';

const directory = () => mkdtemp(join(tmpdir(), 'phage-epistasis-binary-'));
async function run(args: string[], cwd: string, input = '', isolated = false) {
  const child = Bun.spawn(args, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    ...(isolated ? { env: { ...process.env, PATH: cwd, NODE_PATH: '', NODE_OPTIONS: '' } } : {}) });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  try {
    child.stdin.write(input); child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

it('retains measured assay worker and exact browser replay in a relocated production executable', async () => {
  const staging = await directory(), cwd = await directory(), retained = await directory();
  const bundled = await Bun.build(executableBuildOptions(staging));
  assert.equal(bundled.success, true, bundled.logs.map(String).join('\n'));
  const name = process.platform === 'win32' ? 'phage-explorer.exe' : 'phage-explorer';
  const compiled = await run([process.execPath, ...executableCompileArgs(staging, join(staging, name)).slice(1)], staging);
  assert.equal(compiled.code, 0, compiled.stderr);
  const binary = join(cwd, name); await copyFile(join(staging, name), binary);
  await rename(staging, join(retained, 'build-artifacts'));
  const help = await run([binary, 'epistasis', '--help'], cwd, '', true);
  assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /--metadata METADATA_JSON/);
  const dataset = createEpistasisAssayTemplate();
  const analysis = await run([binary, 'epistasis', 'analyze', '-', '--bootstrap-samples', '200', '--seed', '0'], cwd, JSON.stringify(dataset), true);
  assert.equal(analysis.code, 0, analysis.stderr);
  const record = await parseAnalysisRecord(analysis.stdout), result = record.fields.result.value as unknown as EpistasisAssayResult;
  assert.equal(result.pairs[0].contrast, 3); assert(result.pairs[0].interval95);
  assert.equal(record.fields.result.kind, 'demo');
  const browser = await executeEpistasisEvidenceRequest({ kind: 'analyze', dataset, options: { bootstrapSamples: 200, seed: 0 } });
  assert.equal(serializeAnalysisRecord(record), serializeAnalysisRecord(browser.record!));
  const replay = await run([binary, 'epistasis', 'replay', '-'], cwd, analysis.stdout, true);
  assert.equal(replay.code, 0, replay.stderr); assert.equal(replay.stdout, analysis.stdout);
  const tsv = await run([binary, 'epistasis', 'replay', '-', '--format', 'tsv', '--section', 'observations'], cwd, analysis.stdout, true);
  assert.equal(tsv.code, 0, tsv.stderr);
  assert.equal(tsv.stdout.trimEnd().split('\n').filter(row => !row.startsWith('#')).length, 25);
  assert.deepEqual(await readdir(cwd), [name]);
}, 120000);
