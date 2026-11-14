import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  createInactivationRecord, parseInactivationInput, exportInactivationTsv,
  type InactivationInput, type InactivationFit,
} from '../../core/src/analysis/virion-stability';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { executeTerminalResearchRequest, validateTerminalResearchRequest } from './research-replay.worker';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker, type WorkflowRuntime } from '../../../scripts/research-workflow';

function assay(): InactivationInput {
  return {
    format: 'phage-explorer-inactivation-input', version: 1, measurement: 'infectious-plaque-counts',
    title: 'Synthetic exposure-aware inactivation oracle',
    provenance: { kind: 'synthetic', source: 'Hand-computed regression counts, not biological observations.', reference: null, license: 'CC0-1.0' },
    preparation: { phageId: 'PRIVATE_ORACLE_PHAGE', accession: null, batchId: 'one-preparation' },
    conditions: { temperatureC: 25, buffer: 'Synthetic test buffer', pH: 7,
      assayHost: 'Synthetic host', description: 'Independent exact-count plates at fixed conditions.' },
    // Exposure varies at 20 minutes. The concentrations are 120000,60000,30000,15000;
    // fitting corrected counts as though exposures were equal would give the wrong rate.
    csv: 'time_min,plaque_count,dilution_fraction,volume_ml\n0,120,0.01,0.1\n10,60,0.01,0.1\n20,15,0.005,0.1\n30,15,0.01,0.1\n',
    options: { supportDeviance: 3.84 },
  };
}
async function invoke(args: string[], runtime: WorkflowRuntime = {}) {
  let output = '', error = '';
  const code = await researchWorkflowMain(args, text => { output += text; }, text => { error += text; }, runtime);
  return { code, output, error };
}
async function fixture(input = assay()) {
  const directory = await mkdtemp(join(tmpdir(), 'phage-inactivation-cli-'));
  const file = join(directory, 'input.json'), output = join(directory, 'fit.json');
  const content = JSON.stringify(input);
  await writeFile(file, content, { flag: 'wx', mode: 0o600 });
  return { directory, input, content, file, output };
}
async function absent(path: string): Promise<void> { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
function near(actual: number | null, expected: number, tolerance = 1e-8): void {
  assert(actual !== null && Number.isFinite(actual));
  assert(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} differs from ${expected}`);
}
async function resign(record: AnalysisRecord, edit: (copy: AnalysisRecord) => void): Promise<string> {
  const copy = structuredClone(record); edit(copy);
  return serializeAnalysisRecord(await createAnalysisRecord({ method: copy.method,
    inputs: copy.inputs.map(({ sha256: _sha, ...input }) => input), parameters: copy.parameters,
    seed: copy.seed, references: copy.references, fields: copy.fields }));
}

describe('native measured virion inactivation workflow', () => {
  it('provides an explicitly synthetic complete template and strict method-specific command parsing', async () => {
    const template = await invoke(['stability-template']); assert.equal(template.code, 0, template.error);
    const parsed = parseInactivationInput(template.output);
    assert.equal(parsed.provenance.kind, 'synthetic'); assert.equal(parsed.measurement, 'infectious-plaque-counts');
    assert(parsed.preparation.batchId && parsed.conditions.assayHost && parsed.provenance.license);
    assert.deepEqual(parseWorkflowCommand(['fit-stability', '--input', 'plates.json']), {
      type: 'fit-stability', input: 'plates.json', timeoutMs: 300000, outputFormat: 'json',
    });
    assert.deepEqual(parseWorkflowCommand(['fit-stability', '--input', 'plates.json', '--output', 'fit.tsv', '--format', 'tsv', '--timeout-ms', '5000']), {
      type: 'fit-stability', input: 'plates.json', output: 'fit.tsv', outputFormat: 'tsv', timeoutMs: 5000,
    });
    for (const rest of [['--format', 'tsv'], ['--record', 'x'], ['--method', 'gc-skew'], ['--repetitions', '2'],
      ['--input', 'other'], ['--timeout-ms', '0'], ['--output', 'x', '--format', 'csv']]) {
      assert.throws(() => parseWorkflowCommand(['fit-stability', '--input', 'x', ...rest]));
    }
    assert.throws(() => parseWorkflowCommand(['stability-template', '--input', 'x']));
  });

  it('fits the independent dilution/volume oracle in a real worker and saves its exact source privately', async () => {
    const f = await fixture(), result = await invoke(['fit-stability', '--input', f.file, '--output', f.output]);
    assert.equal(result.code, 0, result.error); assert.equal(result.error, '');
    const report = JSON.parse(result.output), record = await parseAnalysisRecord(await readFile(f.output, 'utf8'));
    assert.equal(report.headless, true); assert.equal(report.resultId, record.resultId);
    assert.equal(report.inputFileSha256, createHash('sha256').update(f.content).digest('hex'));
    assert.equal(record.method.id, 'plaque-count-inactivation'); assert.equal(record.fields.fit.kind, 'demo');
    assert.equal(record.inputs[0].data, f.content); assert(!result.output.includes(f.input.csv));
    const fit = record.fields.fit.value as unknown as InactivationFit;
    assert.equal(fit.status, 'estimated'); near(fit.referencePFUPerMl, 120000);
    near(fit.decayRatePerMin, Math.LN2 / 10); near(fit.halfLifeMin, 10); near(fit.oneLogReductionMin, 10 * Math.LN10 / Math.LN2);
    near(fit.deviance, 0); assert.equal(fit.observations, 4); assert.equal(fit.totalPlaques, 210);
    assert(fit.support.lowerRatePerMin < fit.decayRatePerMin! && fit.support.upperRatePerMin! > fit.decayRatePerMin!);
    assert.equal(serializeAnalysisRecord(record), serializeAnalysisRecord(await createInactivationRecord(f.content)));
    if (process.platform !== 'win32') assert.equal((await lstat(f.output)).mode & 0o777, 0o600);
  });

  it('replays original measurements and exports every exposure/residual through the existing replay command', async () => {
    const f = await fixture(); assert.equal((await invoke(['fit-stability', '--input', f.file, '--output', f.output])).code, 0);
    const record = await parseAnalysisRecord(await readFile(f.output, 'utf8'));
    const table = join(f.directory, 'direct.tsv'), replayTable = join(f.directory, 'replayed.tsv'), replayJson = join(f.directory, 'replayed.json');
    const direct = await invoke(['fit-stability', '--input', f.file, '--output', table, '--format', 'tsv']);
    assert.equal(direct.code, 0, direct.error);
    const replay = await invoke(['replay-experiment', '--input', f.output, '--output', replayTable, '--format', 'tsv']);
    assert.equal(replay.code, 0, replay.error); assert.equal(JSON.parse(replay.output).verified, true);
    const tsv = await readFile(table, 'utf8'); assert.equal(tsv, await readFile(replayTable, 'utf8'));
    assert.equal(tsv, exportInactivationTsv(record));
    const rows = tsv.trimEnd().split('\n').filter(line => !line.startsWith('#'));
    assert.equal(rows.length, 5); assert(rows[0].includes('deviance_residual'));
    assert.deepEqual(rows[3].split('\t').slice(0, 4), ['20', '15', '0.005', '0.1']);
    const restored = await invoke(['replay-experiment', '--input', f.output, '--output', replayJson]);
    assert.equal(restored.code, 0, restored.error);
    assert.deepEqual(await parseAnalysisRecord(await readFile(replayJson, 'utf8')), record);
  });

  it('retains user-supplied zero-count evidence without inventing a rate or a lifetime', async () => {
    const input = assay(); input.provenance.kind = 'user-supplied';
    input.provenance.source = 'Regression of supplied attribution, not a claim of actual biological measurements.';
    input.csv = 'time_min,plaque_count,dilution_fraction,volume_ml\n0,0,0.01,0.1\n10,0,0.01,0.1\n';
    const f = await fixture(input), result = await invoke(['fit-stability', '--input', f.file, '--output', f.output]);
    assert.equal(result.code, 0, result.error);
    const record = await parseAnalysisRecord(await readFile(f.output, 'utf8'));
    assert.equal(record.fields.plates.kind, 'observation'); assert.equal(record.fields.fit.kind, 'fitted-estimate');
    const fit = record.fields.fit.value as unknown as InactivationFit;
    assert.equal(fit.status, 'unidentifiable'); assert.equal(fit.decayRatePerMin, null); assert.equal(fit.halfLifeMin, null);
    assert.equal(fit.support.upperRatePerMin, null); assert.equal(fit.fitted.length, 2);
    assert(fit.fitted.every(plate => plate.count === 0 && plate.expectedCount === 0));
  });

  it('rejects rehashed fabricated rates and source attribution before publishing replay output', async () => {
    const f = await fixture(), record = await createInactivationRecord(f.content);
    const edits: Array<(copy: AnalysisRecord) => void> = [
      copy => { (copy.fields.fit.value as unknown as InactivationFit).decayRatePerMin = 99; },
      copy => { (copy.fields.fit.value as unknown as InactivationFit).support.upperRatePerMin = 0; },
      copy => { copy.references[0].description = 'Different assay provenance'; },
    ];
    for (let i = 0; i < edits.length; i++) {
      const forged = await resign(record, edits[i]); await parseAnalysisRecord(forged);
      const file = join(f.directory, `forged-${i}.json`); await writeFile(file, forged, { flag: 'wx' });
      const result = await invoke(['replay-experiment', '--input', file, '--output', f.output]);
      assert.equal(result.code, 1); assert.equal(result.output, ''); assert.match(result.error, /Recomputed|differs/i); await absent(f.output);
    }
  });

  it('refuses wrong endpoints, censored/count-invalid CSV, oversized files and malformed UTF-8', async () => {
    const f = await fixture();
    const invalid: Array<string | Buffer> = ['{', Buffer.from([0xc3, 0x28]), ' '.repeat(1_000_001),
      JSON.stringify({ ...f.input, measurement: 'extracellular-pfu-per-ml' }),
      JSON.stringify({ ...f.input, csv: f.input.csv.replace('0,120,', '0,TNTC,') }),
      JSON.stringify({ ...f.input, csv: f.input.csv.replace('0,120,', '0,120.5,') }),
      JSON.stringify({ ...f.input, csv: f.input.csv.replace('plaque_count', 'count_status') }),
    ];
    for (let i = 0; i < invalid.length; i++) {
      const path = join(f.directory, `invalid-${i}`); await writeFile(path, invalid[i], { flag: 'wx' });
      const result = await invoke(['fit-stability', '--input', path, '--output', f.output]);
      assert.equal(result.code, 1); assert.equal(result.output, ''); assert(result.error); await absent(f.output);
    }
    assert.equal((await invoke(['fit-stability', '--input', f.directory])).code, 1);
  });

  it('does not overwrite the input, an existing result, or a dangling symbolic link', async () => {
    const f = await fixture(); await writeFile(f.output, 'KEEP', { flag: 'wx' });
    for (const output of [f.file, f.output]) {
      const before = await readFile(output, 'utf8');
      const result = await invoke(['fit-stability', '--input', f.file, '--output', output]);
      assert.equal(result.code, 1); assert.equal(result.output, ''); assert.equal(await readFile(output, 'utf8'), before);
    }
    if (process.platform !== 'win32') {
      const target = join(f.directory, 'never-written'), link = join(f.directory, 'output-link'); await symlink(target, link);
      assert.equal((await invoke(['fit-stability', '--input', f.file, '--output', link])).code, 1);
      assert((await lstat(link)).isSymbolicLink()); await absent(target);
    }
  });

  it('checks the response digest and embedded exact source before opening an output', async () => {
    const f = await fixture(), other = JSON.stringify({ ...f.input, title: 'Different submitted assay' });
    for (const wrongHash of [true, false]) {
      const record = await createInactivationRecord(wrongHash ? f.content : other);
      const response = { type: 'stability-fitted', recordJson: serializeAnalysisRecord(record),
        inputFileSha256: wrongHash ? '0'.repeat(64) : createHash('sha256').update(f.content).digest('hex') };
      const result = await invoke(['fit-stability', '--input', f.file, '--output', f.output], { createWorker: () => new Worker(
        `require('node:worker_threads').parentPort.once('message',()=>require('node:worker_threads').parentPort.postMessage(${JSON.stringify(response)}))`, { eval: true }) });
      assert.equal(result.code, 1); assert.equal(result.output, ''); await absent(f.output);
    }
  });

  it('terminates timed-out and cancelled worker ownership without accepting partial evidence', async () => {
    const f = await fixture();
    for (const cancel of [false, true]) {
      const controller = new AbortController(); let exited: Promise<number> | undefined;
      const result = await invoke(['fit-stability', '--input', f.file, '--output', f.output, '--timeout-ms', cancel ? '30000' : '1000'], {
        signal: controller.signal, createWorker() {
          const worker = new Worker('for (;;) {}', { eval: true }); exited = new Promise(resolve => worker.once('exit', resolve));
          if (cancel) worker.once('online', () => controller.abort(new DOMException('Stop', 'AbortError')));
          return worker;
        },
      });
      assert.equal(result.code, cancel ? 130 : 124, result.error); assert.equal(result.output, ''); await absent(f.output);
      assert(exited); await exited;
    }
    assert.equal((await invoke(['fit-stability', '--input', f.file, '--output', f.output])).code, 0);
  });

  it('rejects extra request fields and pre-cancelled work before allocation', async () => {
    const content = JSON.stringify(assay());
    validateTerminalResearchRequest({ type: 'fit-stability', content });
    assert.throws(() => validateTerminalResearchRequest({ type: 'fit-stability', content, path: '/never-read' }));
    const controller = new AbortController(); controller.abort(); let allocations = 0;
    await assert.rejects(runTerminalResearchWorker({ type: 'fit-stability', content }, controller.signal, undefined,
      () => { allocations++; throw new Error('Must not allocate a worker'); }), { name: 'AbortError' });
    assert.equal(allocations, 0);
    const reply = await executeTerminalResearchRequest({ type: 'fit-stability', content });
    assert.equal(reply.type, 'stability-fitted');
  });
});
