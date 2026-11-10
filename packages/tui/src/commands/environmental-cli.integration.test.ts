import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executableBuildOptions, executableCompileArgs } from '../../../../scripts/build';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';
import type { EnvironmentalDataset } from '../../../core/src/analysis/environmental-evidence';

const directory = () => mkdtemp(join(tmpdir(), 'phage-environment-binary-'));
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

it('runs the environmental producer and verifies its record inside a relocated production executable', async () => {
  const staging = await directory(), cwd = await directory(), retained = await directory();
  const bundled = await Bun.build(executableBuildOptions(staging));
  assert.equal(bundled.success, true, bundled.logs.map(String).join('\n'));
  const name = process.platform === 'win32' ? 'phage-explorer.exe' : 'phage-explorer';
  const compiled = await run([process.execPath, ...executableCompileArgs(staging, join(staging, name)).slice(1)], staging);
  assert.equal(compiled.code, 0, compiled.stderr);
  const binary = join(cwd, name); await copyFile(join(staging, name), binary);
  // Moving retained build artifacts prevents an accidental absolute source/worker path from passing.
  await rename(staging, join(retained, 'build-artifacts'));
  const dataset: EnvironmentalDataset = { format: 'phage-explorer-environmental', version: 1, name: 'Compiled synthetic control',
    query: { id: 'q', label: 'Query control', accession: null },
    source: { kind: 'demo', study: 'Two invented count observations', reference: null, version: '1', license: null },
    measurement: { type: 'counts', method: 'Synthetic counts', normalization: 'Equal-volume samples' },
    samples: [5, 0].map((count, index) => ({ id: `s${index}`, accession: null, biome: 'soil', country: null,
      location: null, collectionDate: null, occurrence: count ? 'detected' : 'not-detected', abundance: count })) };
  const help = await run([binary, 'environment', '--help'], cwd, '', true);
  assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /phage-explorer environment from-abundance/);
  const analysis = await run([binary, 'environment', 'analyze', '-'], cwd, JSON.stringify(dataset), true);
  assert.equal(analysis.code, 0, analysis.stderr);
  const record = await parseAnalysisRecord(analysis.stdout);
  const result = record.fields.environment.value as { biomes: Array<{ detectionFraction: number; meanAbundance: number }> };
  assert.equal(result.biomes[0].detectionFraction, 0.5); assert.equal(result.biomes[0].meanAbundance, 2.5);
  assert.equal(record.fields.environment.kind, 'demo');
  const replay = await run([binary, 'environment', 'replay', '-'], cwd, analysis.stdout, true);
  assert.equal(replay.code, 0, replay.stderr); assert.equal(replay.stdout, analysis.stdout);
  assert.deepEqual(await readdir(cwd), [name]);
}, 120000);
