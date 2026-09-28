import { describe, it, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { Readable, Writable, PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeHostMetabolism, createHostFluxRecord, replayHostFluxRecord, type HostModelInput } from '../../../core/src/analysis/host-metabolism';
import { parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { executeHostMetabolismJob, parseHostMetabolismCommand, runHostMetabolismCommand, runHostMetabolismJob } from './host-metabolism';

const model = (): HostModelInput => ({
  format: 'phage-explorer-host-model', version: 1,
  source: { kind: 'demo', name: 'Analytical two-reaction fixture', version: '1', organism: 'Synthetic', strain: 'None', accession: 'fixture',
    reference: 'One conserved pool, uptake <= 10, sink <= 4: objective is min(10,4).', license: 'Test fixture', fluxUnits: 'arbitrary', objectiveUnits: 'arbitrary' },
  medium: { name: 'Explicit fixture bounds', reference: 'No inferred medium', bounds: [] },
  cobra: { id: 'fixture', metabolites: [{ id: 'a', compartment: 'c' }], reactions: [
    { id: 'uptake', metabolites: { a: 1 }, lower_bound: 0, upper_bound: 10 },
    { id: 'sink', metabolites: { a: -1 }, lower_bound: 0, upper_bound: 4, objective_coefficient: 1 },
  ] },
});
const options = { changes: [{ reactionId: 'sink', lowerBound: 0, upperBound: 8,
  evidence: { kind: 'assumption' as const, reference: 'Analytical fixture', description: 'Raise sink capacity to eight; uptake remains ten.', gene: null } }], variability: ['uptake', 'sink'], objectiveLoss: 0 };
function output() {
  let text = '';
  return { stream: new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } }), text: () => text };
}
function io(input = '', signal?: AbortSignal) {
  const out = output(), err = output();
  return { stdin: Readable.from([input]), stdout: out.stream, stderr: err.stream, signal, out, err };
}
const direct: typeof runHostMetabolismJob = (job, _signal, progress) => executeHostMetabolismJob(job, progress);

// These are local analytic fixtures; published-reference verification is a separate real-model job.
describe('host metabolism command grammar and shared core', () => {
  it('offers help and distinguishes the only network operation', () => {
    expect(parseHostMetabolismCommand([])).toBeNull();
    expect(parseHostMetabolismCommand(['--help'])).toBeNull();
    expect(parseHostMetabolismCommand(['reference', 'e-coli-core'])?.operation).toBe('reference');
    expect(() => parseHostMetabolismCommand(['reference', 'https://example.com/private'])).toThrow('Unknown');
  });
  it('rejects missing operands, unknown flags, ambiguous stdin and incomplete raw metadata', () => {
    for (const args of [['analyze'], ['inspect','x','--unknown'], ['analyze','-','--params','-'], ['inspect','x','--source','s'], ['inspect','x','--params','p']]) {
      expect(() => parseHostMetabolismCommand(args)).toThrow();
    }
  });
  it('forbids changing saved replay evidence at either boundary', async () => {
    expect(() => parseHostMetabolismCommand(['replay','saved.json','--params','p'])).toThrow('cannot override');
    await expect(executeHostMetabolismJob({ operation: 'replay', input: '{}', parameters: '{}' })).rejects.toThrow('cannot override');
    await expect(executeHostMetabolismJob({ operation: 'reference', input: 'e-coli-core', source: '{}' })).rejects.toThrow('cannot override');
  });
  it('imports raw COBRA with explicit source and medium without changing the model', async () => {
    const original = model();
    const inspected = await executeHostMetabolismJob({ operation: 'inspect', input: JSON.stringify(original.cobra),
      source: JSON.stringify(original.source), medium: JSON.stringify(original.medium) });
    expect(JSON.parse(inspected.content)).toEqual(original);
    expect(inspected.resultId).toBeNull();
    await expect(executeHostMetabolismJob({ operation: 'inspect', input: JSON.stringify(original.cobra) })).rejects.toThrow();
  });
  it('produces the browser core result identity and independent optimum 4 -> 8', async () => {
    const input = model(), expected = await createHostFluxRecord(input, analyzeHostMetabolism(input, options));
    const executed = await executeHostMetabolismJob({ operation: 'analyze', input: JSON.stringify(input), parameters: JSON.stringify(options) });
    expect(executed.resultId).toBe(expected.resultId);
    const replay = await replayHostFluxRecord(executed.content);
    expect(replay.result.baseline.objective).toBe(4);
    expect(replay.result.perturbed?.objective).toBe(8);
    expect(replay.result.objectiveDelta).toBe(4);
    const reopened = await executeHostMetabolismJob({ operation: 'replay', input: executed.content });
    expect(reopened.verified).toBe(true); expect(reopened.resultId).toBe(executed.resultId);
  });
  it('preserves infeasibility rather than fabricating an objective', async () => {
    const input = model(); input.medium.bounds = [{ reactionId: 'uptake', lowerBound: 8, upperBound: 10 }];
    const executed = await executeHostMetabolismJob({ operation: 'analyze', input: JSON.stringify(input) });
    const replay = await replayHostFluxRecord(executed.content);
    expect(replay.result.baseline.status).toBe('infeasible');
    expect(replay.result.baseline.objective).toBeNull(); expect(replay.result.objectiveDelta).toBeNull();
  });
  it('rejects tampered result data and malformed or oversized settings', async () => {
    const saved = await executeHostMetabolismJob({ operation: 'analyze', input: JSON.stringify(model()) });
    const changed = JSON.parse(saved.content); changed.fields.baseline.value.objective = 999;
    await expect(executeHostMetabolismJob({ operation: 'replay', input: JSON.stringify(changed) })).rejects.toThrow();
    for (const parameters of ['[]', '{"objectiveLoss":-1}', ' '.repeat(128 * 1024 + 1)]) {
      await expect(executeHostMetabolismJob({ operation: 'analyze', input: JSON.stringify(model()), parameters })).rejects.toThrow();
    }
  });
});

describe('host metabolism terminal publication', () => {
  it('keeps JSON on stdout and progress on stderr for stdin input', async () => {
    const streams = io(JSON.stringify(model()));
    expect(await runHostMetabolismCommand(['analyze','-'], { ...streams, execute: direct })).toBe(0);
    const record = await parseAnalysisRecord(streams.out.text());
    expect(record.method.id).toBe('sourced-host-flux');
    expect(streams.err.text()).toContain('publishing');
    expect(streams.err.text()).not.toContain('Analytical two-reaction fixture');
  });
  it('does not open input or start work when an output already exists', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'host-existing-')), file = join(folder, 'keep.json');
    await writeFile(file, 'keep me', { flag: 'wx' }); let calls = 0;
    const streams = io();
    expect(await runHostMetabolismCommand(['analyze','missing.json','--output',file], { ...streams, execute: async () => { calls++; throw new Error('must not run'); } })).toBe(1);
    expect(calls).toBe(0); expect(await readFile(file, 'utf8')).toBe('keep me'); expect(streams.out.text()).toBe('');
  });
  it('publishes a new file that the browser core can replay', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'host-output-')), file = join(folder, 'analysis.json');
    const streams = io(JSON.stringify(model()));
    expect(await runHostMetabolismCommand(['analyze','-','--output',file], { ...streams, execute: direct })).toBe(0);
    expect(streams.out.text()).toBe('');
    expect((await replayHostFluxRecord(await readFile(file, 'utf8'))).result.baseline.objective).toBe(4);
  });
  it('rejects input links and malformed UTF-8 without publishing', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'host-input-')), file = join(folder, 'bad.json'), link = join(folder, 'link.json');
    await writeFile(file, Buffer.from([0xff]), { flag: 'wx' }); await symlink(file, link);
    for (const input of [file, link, folder]) {
      const streams = io(); expect(await runHostMetabolismCommand(['analyze', input], { ...streams, execute: direct })).toBe(1); expect(streams.out.text()).toBe('');
    }
  });
  it('aborts a pending stdin read without any output', async () => {
    const controller = new AbortController(), streams = io('', controller.signal), stdin = new PassThrough();
    const running = runHostMetabolismCommand(['analyze','-'], { ...streams, stdin, execute: direct });
    controller.abort(); expect(await running).toBe(130); expect(streams.out.text()).toBe('');
  });
  it('does not publish a result if interrupted before the publication point', async () => {
    const controller = new AbortController(), streams = io(JSON.stringify(model()), controller.signal);
    expect(await runHostMetabolismCommand(['analyze','-'], { ...streams, execute: async job => {
      const result = await executeHostMetabolismJob(job); controller.abort(); return result;
    } })).toBe(130);
    expect(streams.out.text()).toBe('');
  });
});

describe('native host-model worker and executable integration', () => {
  it('runs analysis and verified replay on separate real workers', async () => {
    const result = await runHostMetabolismJob({ operation: 'analyze', input: JSON.stringify(model()), parameters: JSON.stringify(options) });
    const replay = await runHostMetabolismJob({ operation: 'replay', input: result.content });
    expect(replay.verified).toBe(true); expect(replay.resultId).toBe(result.resultId);
  });
  it('terminates the actual worker on cancellation after computation starts', async () => {
    const controller = new AbortController(); let started = false;
    const job = runHostMetabolismJob({ operation: 'analyze', input: JSON.stringify(model()), parameters: JSON.stringify(options) }, controller.signal, phase => {
      if (phase === 'computing') { started = true; controller.abort(); }
    });
    await expect(job).rejects.toHaveProperty('name','AbortError'); expect(started).toBe(true);
  });
  it('executes the real main entrypoint without a catalog or terminal', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'host-process-'));
    const entry = resolve(import.meta.dir, '../index.tsx');
    // CI can run this same test against the compiled binary from an unrelated directory.
    const command = process.env.PHAGE_HOST_TEST_BINARY ? [resolve(process.env.PHAGE_HOST_TEST_BINARY)] : [process.execPath, entry];
    const child = Bun.spawn([...command, 'host-metabolism', 'analyze', '-'], { cwd: folder, stdin: new Blob([JSON.stringify(model())]), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, stderr);
    expect((await replayHostFluxRecord(stdout)).result.baseline.objective).toBe(4);
    const saved = await createHostFluxRecord(model(), analyzeHostMetabolism(model(), options));
    const childReplay = Bun.spawn([...command, 'host-metabolism', 'replay', '-'], { cwd: folder, stdin: new Blob([serializeAnalysisRecord(saved)]), stdout: 'pipe', stderr: 'pipe' });
    const [replayed, replayErrors, replayCode] = await Promise.all([new Response(childReplay.stdout).text(), new Response(childReplay.stderr).text(), childReplay.exited]);
    assert.equal(replayCode, 0, replayErrors); expect((await parseAnalysisRecord(replayed)).resultId).toBe(saved.resultId);
  }, 30000);
});
