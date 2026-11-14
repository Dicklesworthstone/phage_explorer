import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, copyFile, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableBuildOptions, executableCompileArgs } from '../../../scripts/build';
import { parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import {
  createInactivationTemplate, parseInactivationInput, exportInactivationTsv, type InactivationFit,
} from '../../core/src/analysis/virion-stability';

const directory = () => mkdtemp(join(tmpdir(), 'phage-inactivation-launcher-'));
async function run(args: string[], cwd: string, isolated = false) {
  const child = Bun.spawn(args, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    ...(isolated ? { env: { ...process.env, PATH: cwd, NODE_PATH: '', NODE_OPTIONS: '' } } : {}) });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
function content(): string {
  const input = createInactivationTemplate();
  input.title = 'Independent relocated-executable arithmetic oracle';
  input.csv = 'time_min,plaque_count,dilution_fraction,volume_ml\n0,120,0.01,0.1\n10,60,0.01,0.1\n20,15,0.005,0.1\n30,15,0.01,0.1\n';
  return JSON.stringify(input);
}
async function checkFit(reportText: string, output: string, source: string) {
  const record = await parseAnalysisRecord(await readFile(output, 'utf8'));
  const report = JSON.parse(reportText), fit = record.fields.fit.value as unknown as InactivationFit;
  assert.equal(report.format, 'phage-explorer-inactivation-fit'); assert.equal(report.version, 1);
  assert.equal(report.headless, true); assert.equal(report.resultId, record.resultId);
  assert.equal(record.inputs[0].data, source); assert.equal(record.fields.fit.kind, 'demo');
  assert.equal(fit.status, 'estimated'); assert.equal(fit.totalPlaques, 210);
  // Independent concentrations after correcting exposure: 120000,60000,30000,15000.
  assert(Math.abs(fit.referencePFUPerMl - 120000) < 1e-5);
  assert(Math.abs(fit.decayRatePerMin! - Math.LN2 / 10) < 1e-10);
  assert(Math.abs(fit.halfLifeMin! - 10) < 1e-8);
  assert(fit.deviance < 1e-8); assert.equal(fit.fitted[2].dilution, .005);
  assert(!Object.hasOwn(report.summary, 'fitted'));
  return record;
}

it('dispatches the source launcher without a catalog and owns the measured-fit worker', async () => {
  const cwd = await directory(), launcher = fileURLToPath(new URL('./index.tsx', import.meta.url));
  const template = await run([process.execPath, launcher, 'workflow', 'stability-template'], cwd);
  assert.equal(template.code, 0, template.stderr);
  assert.equal(parseInactivationInput(template.stdout).provenance.kind, 'synthetic');
  const input = join(cwd, 'plates.json'), output = join(cwd, 'fit.json'), source = content();
  await writeFile(input, source, { flag: 'wx', mode: 0o600 });
  const fitted = await run([process.execPath, launcher, 'workflow', 'fit-stability', '--input', input, '--output', output], cwd);
  assert.equal(fitted.code, 0, fitted.stderr); await checkFit(fitted.stdout, output, source);
  assert.deepEqual((await readdir(cwd)).sort(), ['fit.json', 'plates.json']);
}, 30000);

it('embeds the measured-fit worker and strict replay in a relocated production executable', async () => {
  const staging = await directory(), cwd = await directory(), retained = await directory();
  const bundled = await Bun.build(executableBuildOptions(staging));
  assert.equal(bundled.success, true, bundled.logs.map(String).join('\n'));
  const name = process.platform === 'win32' ? 'phage-explorer.exe' : 'phage-explorer';
  const compiled = await run([process.execPath, ...executableCompileArgs(staging, join(staging, name)).slice(1)], staging);
  assert.equal(compiled.code, 0, compiled.stderr);
  const binary = join(cwd, name); await copyFile(join(staging, name), binary);
  // Keep build artifacts, but make their original paths unavailable to the binary.
  await rename(staging, join(retained, 'build-artifacts'));
  const template = await run([binary, 'workflow', 'stability-template'], cwd, true);
  assert.equal(template.code, 0, template.stderr);
  assert.equal(parseInactivationInput(template.stdout).provenance.kind, 'synthetic');
  const input = join(cwd, 'plates.json'), output = join(cwd, 'fit.json'), source = content();
  await writeFile(input, source, { flag: 'wx', mode: 0o600 });
  const fitted = await run([binary, 'workflow', 'fit-stability', '--input', input, '--output', output], cwd, true);
  assert.equal(fitted.code, 0, fitted.stderr);
  const record = await checkFit(fitted.stdout, output, source);
  const replayFile = join(cwd, 'replayed.json'), tsvFile = join(cwd, 'all-plates.tsv');
  const replay = await run([binary, 'workflow', 'replay-experiment', '--input', output, '--output', replayFile], cwd, true);
  assert.equal(replay.code, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).verified, true);
  assert.equal(serializeAnalysisRecord(await parseAnalysisRecord(await readFile(replayFile, 'utf8'))), serializeAnalysisRecord(record));
  const exported = await run([binary, 'workflow', 'replay-experiment', '--input', output, '--output', tsvFile, '--format', 'tsv'], cwd, true);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(await readFile(tsvFile, 'utf8'), exportInactivationTsv(record));
  const before = await readFile(output, 'utf8');
  const overwrite = await run([binary, 'workflow', 'fit-stability', '--input', input, '--output', output], cwd, true);
  assert.equal(overwrite.code, 1); assert.equal(overwrite.stdout, ''); assert.equal(await readFile(output, 'utf8'), before);
  assert.deepEqual((await readdir(cwd)).sort(), ['all-plates.tsv', 'fit.json', name, 'plates.json', 'replayed.json'].sort());
}, 120000);
