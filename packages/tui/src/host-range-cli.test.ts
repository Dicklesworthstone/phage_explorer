import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseHostRangeCommand, executeHostRangeCommand, hostRangeMain } from '../../../scripts/host-range';
import { HOST_RANGE_LIMITS } from '../../core/src/analysis/host-range-evidence';

const header = 'phage_id,host_id,assay,condition,replicate,outcome,source';
const csv = `${header}
A,H1,plaque,Condition A,r1,positive,Lab record
A,H1,plaque,Condition A,r2,positive,Lab record
A,H2,plaque,Condition A,r1,negative,Lab record
A,H2,plaque,Condition A,r2,negative,Lab record
B,H2,plaque,Condition A,r1,positive,Lab record
B,H2,plaque,Condition A,r2,positive,Lab record
C,H3,plaque,Condition A,r1,indeterminate,Lab record
B,H1,spot,Condition A,r1,positive,Lab record`;
let root: string;
let input: string;
let serial = 0;
const fresh = () => join(root, `output-${++serial}.json`);
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'phage-host-range-')); input = join(root, 'observations.csv'); await writeFile(input, csv); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
function analyze(extra: string[] = [], output = fresh()) {
  const command = parseHostRangeCommand(['analyze', '--input', input, '--assay', 'plaque', '--condition', 'Condition A', '--output', output, ...extra]);
  if (command.type !== 'analyze') throw new Error('Expected analyze command');
  return command;
}

describe('headless measured host-range commands', () => {
  test('help requires no input and reports the caller invocation', async () => {
    let stdout = '', stderr = '';
    expect(await hostRangeMain(['--help'], text => { stdout += text; }, text => { stderr += text; }, 'phage-explorer host-range')).toBe(0);
    expect(stdout).toContain('phage-explorer host-range analyze');
    expect(stdout).not.toContain('bun scripts/host-range.ts');
    expect(stderr).toBe('');
  });
  test('requires explicit context, rejects unknown and repeated scalar options and replay overrides', () => {
    for (const args of [[], ['analyze'], ['inspect', '--input', 'a', '--input', 'b'],
      ['replay', '--input', 'a', '--greedy'], ['inspect', '--input', 'a', '--mystery', 'b']]) {
      expect(() => parseHostRangeCommand(args)).toThrow();
    }
    expect(() => analyze(['--select', 'A', '--greedy'])).toThrow('not both');
    for (const value of ['0', '101', '1.5', 'NaN', 'Infinity', '1e2']) expect(() => analyze(['--min-replicates', value])).toThrow();
    expect(() => analyze(['--max-size', '11'])).toThrow();
    expect(() => parseHostRangeCommand(['analyze', '--input', input, '--assay', 'plaque', '--output', fresh()])).toThrow('condition');
  });
  test('inspect reports distinct contexts and exact IDs without echoing observations', async () => {
    const summary = await executeHostRangeCommand({ type: 'inspect', inputPath: input });
    expect(summary.observations).toBe(8);
    expect(summary.contexts).toEqual([{ assay: 'plaque', condition: 'Condition A' }, { assay: 'spot', condition: 'Condition A' }]);
    expect(summary.phageIds).toEqual(['A', 'B', 'C']);
    expect(JSON.stringify(summary)).not.toContain('Lab record');
  });
  test('records a deterministic greedy result without pooling spot observations', async () => {
    const command = analyze(['--greedy', '--min-replicates', '2', '--synthetic']);
    const summary = await executeHostRangeCommand(command);
    expect(summary.includedObservations).toBe(7);
    expect(summary.excludedObservations).toBe(1);
    expect(summary.coverage).toEqual({ selectedPhageIds: ['A', 'B'], supportedHostIds: ['H1', 'H2'], negativeHostIds: [], unresolvedHostIds: ['H3'], coverageFraction: 2 / 3 });
    const saved = JSON.parse(await readFile(command.outputPath, 'utf8'));
    expect(saved.provenance).toBe('synthetic');
    expect(saved.query.minReplicates).toBe(2);
    expect(saved.observations).toHaveLength(8);
    if (process.platform !== 'win32') expect((await stat(command.outputPath)).mode & 0o777).toBe(0o600);
  });
  test('analyze does not silently select a phage', async () => {
    const summary = await executeHostRangeCommand(analyze());
    expect(summary.coverage).toEqual({ selectedPhageIds: [], supportedHostIds: [], negativeHostIds: [], unresolvedHostIds: ['H1', 'H2', 'H3'], coverageFraction: 0 });
  });
  test('manual selection and exact repeated-ID filters survive replay', async () => {
    const command = analyze(['--phage', 'A', '--phage', 'B', '--host', 'H2', '--select', 'A']);
    const summary = await executeHostRangeCommand(command);
    expect(summary.coverage).toEqual({ selectedPhageIds: ['A'], supportedHostIds: [], negativeHostIds: ['H2'], unresolvedHostIds: [], coverageFraction: 0 });
    const copy = fresh();
    const replayed = await executeHostRangeCommand({ type: 'replay', inputPath: command.outputPath, outputPath: copy });
    expect(replayed.coverage).toEqual(summary.coverage);
    expect(await readFile(copy, 'utf8')).toBe(await readFile(command.outputPath, 'utf8'));
    const inspected = await executeHostRangeCommand({ type: 'inspect', inputPath: copy });
    expect(inspected.observations).toBe(8);
  });
  test('replay recomputes forged outputs and obeys the actual saved replicate threshold', async () => {
    const command = analyze(['--greedy']);
    await executeHostRangeCommand(command);
    const saved = JSON.parse(await readFile(command.outputPath, 'utf8'));
    saved.query.minReplicates = 3;
    saved.result = { supportedHostIds: ['H1', 'H2', 'H3'], coverageFraction: 1 };
    const forged = fresh(); await writeFile(forged, JSON.stringify(saved));
    const summary = await executeHostRangeCommand({ type: 'replay', inputPath: forged });
    expect(summary.recomputed).toBe(true);
    expect(summary.coverage).toEqual({ selectedPhageIds: ['A', 'B'], supportedHostIds: [], negativeHostIds: [], unresolvedHostIds: ['H1', 'H2', 'H3'], coverageFraction: 0 });
  });
  test('refuses duplicate/unknown filters before creating any output', async () => {
    for (const args of [['--phage', 'absent'], ['--host', 'H1', '--host', 'H1'], ['--select', 'absent'], ['--select', 'A', '--select', 'A']]) {
      const command = analyze(args);
      await expect(executeHostRangeCommand(command)).rejects.toThrow();
      expect(await Bun.file(command.outputPath).exists()).toBe(false);
    }
  });
  test('does not overwrite outputs, inputs, or symlink targets', async () => {
    const output = fresh(); await writeFile(output, 'keep me');
    await expect(executeHostRangeCommand(analyze([], output))).rejects.toThrow();
    expect(await readFile(output, 'utf8')).toBe('keep me');
    await expect(executeHostRangeCommand(analyze([], input))).rejects.toThrow();
    expect(await readFile(input, 'utf8')).toBe(csv);
    if (process.platform !== 'win32') {
      const link = fresh(); await symlink(output, link);
      await expect(executeHostRangeCommand(analyze([], link))).rejects.toThrow();
      expect(await readFile(output, 'utf8')).toBe('keep me');
    }
  });
  test('rejects oversized, non-UTF-8, and non-regular inputs without writing a result', async () => {
    const oversized = fresh(), invalid = fresh();
    await writeFile(oversized, Buffer.alloc(HOST_RANGE_LIMITS.bytes + 1, 65));
    await writeFile(invalid, Buffer.from([0xff, 0xfe, 0xfa]));
    for (const inputPath of [oversized, invalid, root]) {
      const command = { ...analyze(), inputPath };
      await expect(executeHostRangeCommand(command)).rejects.toThrow();
      expect(await Bun.file(command.outputPath).exists()).toBe(false);
    }
  });
  test('process entrypoint works from a directory with no database or project files', () => {
    const entrypoint = resolve(import.meta.dir, 'index.tsx');
    const result = Bun.spawnSync([process.execPath, entrypoint, 'host-range', 'inspect', '--input', input], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PHAGE_EXPLORER_DB_PATH: join(root, 'absent.db'), PHAGE_DB_PATH: join(root, 'also-absent.db') },
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(JSON.parse(new TextDecoder().decode(result.stdout)).observations).toBe(8);
  });
  test('returns a nonzero exit and no success summary for invalid data', async () => {
    const invalid = fresh(); await writeFile(invalid, `${header}\nA,H1,plaque,C,r1,positive,S\nA,H1,plaque,C,r1,negative,S`);
    let stdout = '', stderr = '';
    expect(await hostRangeMain(['inspect', '--input', invalid], text => { stdout += text; }, text => { stderr += text; })).toBe(1);
    expect(stdout).toBe(''); expect(stderr).toContain('duplicate');
  });
});
