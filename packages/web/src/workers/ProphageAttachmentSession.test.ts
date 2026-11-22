import { describe, expect, it } from 'bun:test';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import type { AttachmentReconstructionInput } from '../../../core/src/analysis/prophage-excision';
import {
  executeAttachmentRequest, ProphageAttachmentSession,
  type ProphageAttachmentRequest, type ProphageAttachmentWorker,
  type ProphageAttachmentMessage, type ProphageAttachmentWork,
} from './ProphageAttachmentSession';

function fixture(): AttachmentReconstructionInput {
  const source = { kind: 'local' as const, reference: 'Hand-constructed sequence-composition control; not experimental observations',
    version: '1', license: 'CC0-1.0' };
  return { format: 'phage-explorer-attachment-reconstruction', version: 1,
    host: { name: 'Control host', accession: null, sequence: 'TTAGCC', topology: 'linear', source: { ...source } },
    phage: { name: 'Control phage', accession: null, sequence: 'CAAGTG', topology: 'circular', source: { ...source } },
    attB: { start: 2, end: 4, strand: '+', evidence: 'Declared synthetic shared AG core' },
    attP: { start: 2, end: 4, strand: '+', evidence: 'Declared synthetic shared AG core' },
    circularization: 'already-circular' };
}
function request(): ProphageAttachmentRequest { return { kind: 'analyze', input: fixture(), options: { flankLength: 2 } }; }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class ManualWorker implements ProphageAttachmentWorker {
  onmessage: ProphageAttachmentWorker['onmessage'] = null;
  onerror: ProphageAttachmentWorker['onerror'] = null;
  onmessageerror: ProphageAttachmentWorker['onmessageerror'] = null;
  posted: ProphageAttachmentRequest | null = null;
  terminated = 0;
  throwOnTerminate = false;
  constructor(private readonly onPost: (worker: ManualWorker) => void = () => {}) {}
  postMessage(value: ProphageAttachmentRequest) { this.posted = value; this.onPost(this); }
  terminate() { this.terminated++; if (this.throwOnTerminate) throw new Error('test termination failure'); }
  emit(message: ProphageAttachmentMessage) { this.onmessage?.({ data: message } as MessageEvent<ProphageAttachmentMessage>); }
}
function harness() {
  const workers: ManualWorker[] = [];
  let waiting = deferred<ManualWorker>();
  const session = new ProphageAttachmentSession(() => {
    const worker = new ManualWorker(value => { waiting.resolve(value); });
    workers.push(worker); return worker;
  });
  session.activate(); session.setScope('A');
  return { session, workers,
    async start(input: ProphageAttachmentRequest = request(), scope = 'A') {
      waiting = deferred<ManualWorker>();
      const completion = session.run(input, scope);
      const worker = await waiting.promise;
      return { completion, worker };
    },
  };
}
async function accept(job: { worker: ManualWorker; completion: Promise<boolean> }): Promise<ProphageAttachmentWork> {
  const value = await executeAttachmentRequest(job.worker.posted!);
  job.worker.emit({ kind: 'result', value });
  expect(await job.completion).toBe(true);
  return value;
}

describe('attachment worker dispatcher', () => {
  it('prepares a single FASTA locus and binds exact selected phage, metadata, cores and result', async () => {
    const input = fixture(), phases: string[] = [];
    const { sequence: _sequence, ...host } = input.host;
    const prepared: ProphageAttachmentRequest = { kind: 'prepare', hostContent: '>host locus\nttagcc\n',
      host, phage: input.phage, attB: input.attB, attP: input.attP,
      circularization: input.circularization, options: { flankLength: 2 } };
    const before = structuredClone(prepared);
    const value = await executeAttachmentRequest(prepared, phase => phases.push(phase));
    expect(value.input).toEqual(input);
    expect(value.result.integratedSequence).toBe('TTAGTGCAAGCC');
    expect(value.result.attL.sequence).toBe('TTAGTG');
    expect(value.result.attR.sequence).toBe('CAAGCC');
    expect(value.verified).toBe(false);
    expect(phases.length).toBeGreaterThan(1);
    expect(prepared).toEqual(before);
    const replay = await executeAttachmentRequest({ kind: 'replay', content: serializeAnalysisRecord(value.record) });
    expect(replay.verified).toBe(true);
    expect(replay.record.resultId).toBe(value.record.resultId);
    expect(replay.input.phage.source).toEqual(input.phage.source);
  });

  it('rejects multiple FASTA records, altered cores, oversized input and unsupported operations', async () => {
    const input = fixture(), { sequence: _sequence, ...host } = input.host;
    const base = { kind: 'prepare' as const, host, phage: input.phage, attB: input.attB, attP: input.attP,
      circularization: input.circularization };
    await expect(executeAttachmentRequest({ ...base, hostContent: '>one\nTTAGCC\n>two\nAG' })).rejects.toThrow(/one named FASTA/);
    await expect(executeAttachmentRequest({ ...base, hostContent: 'TTCGCC' })).rejects.toThrow(/do not match/);
    await expect(executeAttachmentRequest({ ...base, hostContent: ' '.repeat(4 * 1024 * 1024 + 1) })).rejects.toThrow(/4 MiB/);
    await expect(executeAttachmentRequest({ kind: 'replay', content: ' '.repeat(10 * 1024 * 1024 + 1) })).rejects.toThrow(/10 MiB/);
    await expect(executeAttachmentRequest({ kind: 'download' } as unknown as ProphageAttachmentRequest)).rejects.toThrow(/Unsupported/);
  });

  it('runs the real attachment worker and verifies its exported record on replay', async () => {
    let created = 0;
    const session = new ProphageAttachmentSession(() => {
      created++;
      return new Worker(new URL('./prophage-attachment.worker.ts', import.meta.url), { type: 'module' }) as unknown as ProphageAttachmentWorker;
    });
    session.activate(); session.setScope('native-worker');
    try {
      expect(await session.run(request(), 'native-worker')).toBe(true);
      const accepted = session.getSnapshot().accepted!;
      expect(accepted.result.integratedSequence).toBe('TTAGTGCAAGCC');
      expect(await session.run({ kind: 'replay', content: serializeAnalysisRecord(accepted.record) }, 'native-worker')).toBe(true);
      expect(session.getSnapshot().accepted?.record.resultId).toBe(accepted.record.resultId);
      expect(session.getSnapshot().accepted?.verified).toBe(true);
      expect(created).toBe(2);
    } finally { session.deactivate(); }
  }, 15000);
});

describe('owned attachment experiment lifecycle', () => {
  it('accepts the current result, releases its worker and preserves it after failure or cancellation', async () => {
    const h = harness(), first = await accept(await h.start());
    expect(h.session.getSnapshot()).toMatchObject({ scope: 'A', accepted: first, busy: false, error: null });
    expect(h.workers[0].terminated).toBe(1);
    expect(h.workers[0].onmessage).toBeNull();
    const failed = await h.start();
    failed.worker.emit({ kind: 'error', message: 'Declared cores do not match.' });
    expect(await failed.completion).toBe(false);
    expect(h.session.getSnapshot().accepted).toBe(first);
    expect(h.session.getSnapshot().error).toContain('do not match');
    const canceled = await h.start();
    h.session.cancel();
    expect(await canceled.completion).toBe(false);
    expect(canceled.worker.terminated).toBe(1);
    expect(h.session.getSnapshot()).toMatchObject({ accepted: first, busy: false });
    h.session.deactivate();
  });

  it('aborts a pending repository read promptly and never starts a worker for its late result', async () => {
    const h = harness(), reading = deferred<ProphageAttachmentRequest>(), began = deferred<AbortSignal>();
    const run = h.session.run(signal => { began.resolve(signal); return reading.promise; }, 'A');
    const signal = await began.promise;
    h.session.cancel();
    expect(signal.aborted).toBe(true);
    expect(await run).toBe(false);
    reading.resolve(request());
    await Promise.resolve(); await Promise.resolve();
    expect(h.workers).toHaveLength(0);
    expect(h.session.getSnapshot().busy).toBe(false);
    h.session.deactivate();
  });

  it('ignores an older worker result and cannot release the newer operation', async () => {
    const h = harness(), old = await h.start();
    const late = old.worker.onmessage!;
    const newer = await h.start();
    expect(await old.completion).toBe(false);
    const oldValue = await executeAttachmentRequest(old.worker.posted!);
    late({ data: { kind: 'result', value: oldValue } } as MessageEvent<ProphageAttachmentMessage>);
    expect(h.session.getSnapshot().accepted).toBeNull();
    expect(h.session.getSnapshot().busy).toBe(true);
    await accept(newer);
    expect(old.worker.terminated).toBe(1);
    expect(newer.worker.terminated).toBe(1);
    h.session.deactivate();
  });

  it('clears accepted work by default on source-scope replacement and ignores late completion', async () => {
    const h = harness(); await accept(await h.start());
    const pending = await h.start(), late = pending.worker.onmessage!;
    h.session.setScope('B');
    expect(await pending.completion).toBe(false);
    expect(h.session.getSnapshot()).toMatchObject({ scope: 'B', accepted: null, busy: false, error: null, notice: null });
    late({ data: { kind: 'error', message: 'Late source A failure' } } as MessageEvent<ProphageAttachmentMessage>);
    expect(h.session.getSnapshot().error).toBeNull();
    expect(await h.session.run(request(), 'A')).toBe(false);
    h.session.deactivate();
  });

  it('keeps the self-contained accepted sources on navigation while cancelling pending current-source work', async () => {
    const h = harness(), accepted = await accept(await h.start());
    const pending = await h.start(), late = pending.worker.onmessage!;
    h.session.setScope('B', true);
    expect(await pending.completion).toBe(false);
    expect(h.session.getSnapshot()).toMatchObject({ scope: 'B', accepted, busy: false, error: null, notice: null });
    const different = structuredClone(accepted); different.input.phage.name = 'Stale phage';
    late({ data: { kind: 'result', value: different } } as MessageEvent<ProphageAttachmentMessage>);
    expect(h.session.getSnapshot().accepted).toBe(accepted);
    expect(h.session.getSnapshot().accepted?.input.phage.name).toBe('Control phage');
    const imported = await h.start({ kind: 'replay', content: serializeAnalysisRecord(accepted.record) }, 'B');
    await accept(imported);
    expect(h.session.getSnapshot().accepted?.verified).toBe(true);
    expect(h.session.getSnapshot().accepted?.record.resultId).toBe(accepted.record.resultId);
    h.session.deactivate();
  });

  it('clones direct sources before any subscriber can change the submitted object', async () => {
    const h = harness(), raw = request();
    if (raw.kind !== 'analyze') throw new Error('Invalid test fixture');
    const unsubscribe = h.session.subscribe(() => { raw.input.phage.sequence = 'CAAGTA'; raw.input.phage.source.version = 'later'; });
    const job = await h.start(raw);
    unsubscribe();
    expect(job.worker.posted?.kind).toBe('analyze');
    if (job.worker.posted?.kind !== 'analyze') throw new Error('No analyze request');
    expect(job.worker.posted.input.phage.sequence).toBe('CAAGTG');
    expect(job.worker.posted.input.phage.source.version).toBe('1');
    const accepted = await accept(job);
    expect(accepted.result.integratedSequence).toBe('TTAGTGCAAGCC');
    h.session.deactivate();
  });

  it('settles cancellation even if worker termination throws', async () => {
    const h = harness(), job = await h.start();
    job.worker.throwOnTerminate = true;
    h.session.cancel();
    expect(await job.completion).toBe(false);
    expect(job.worker.terminated).toBe(1);
    expect(job.worker.onmessage).toBeNull();
    expect(job.worker.onerror).toBeNull();
    expect(h.session.getSnapshot().busy).toBe(false);
    h.session.deactivate();
  });

  it('rejects malformed worker result structures without replacing an accepted experiment', async () => {
    const h = harness(), accepted = await accept(await h.start());
    for (const alter of [
      (value: ProphageAttachmentWork) => { value.result.attL = null as unknown as ProphageAttachmentWork['result']['attL']; },
      (value: ProphageAttachmentWork) => { value.result.segments = null as unknown as ProphageAttachmentWork['result']['segments']; },
      (value: ProphageAttachmentWork) => { value.options.flankLength = -1; },
      (value: ProphageAttachmentWork) => { value.input.phage.source = null as unknown as ProphageAttachmentWork['input']['phage']['source']; },
      (value: ProphageAttachmentWork) => { value.record.method.version = '999'; },
      (value: ProphageAttachmentWork) => { value.record.inputs = [null, null, null] as unknown as ProphageAttachmentWork['record']['inputs']; },
      (value: ProphageAttachmentWork) => { value.record.fields.reconstruction = 'bad field' as unknown as ProphageAttachmentWork['record']['fields']['reconstruction']; },
      (value: ProphageAttachmentWork) => { value.record.fields.reconstruction.coverage = null as unknown as ProphageAttachmentWork['record']['fields']['reconstruction']['coverage']; },
      (value: ProphageAttachmentWork) => { value.record.references = [null] as unknown as ProphageAttachmentWork['record']['references']; },
      (value: ProphageAttachmentWork) => {
        const field = value.record.fields.reconstruction;
        if (field.kind === 'simulation') field.assumptions = null as unknown as string[];
      },
      (value: ProphageAttachmentWork) => {
        Object.defineProperty(value, 'result', { get: () => { throw new Error('Unexpected transport getter'); } });
      },
    ]) {
      const job = await h.start(), malformed = structuredClone(accepted); alter(malformed);
      job.worker.emit({ kind: 'result', value: malformed });
      expect(await job.completion).toBe(false);
      expect(h.session.getSnapshot().accepted).toBe(accepted);
      expect(h.session.getSnapshot().error).toContain('Unexpected attachment worker response');
      expect(job.worker.terminated).toBe(1);
    }
    h.session.deactivate();
  });

  it('owns error/messageerror, source failure and component deactivation without losing the prior result', async () => {
    const h = harness(), accepted = await accept(await h.start());
    const crash = await h.start(); crash.worker.onerror?.({} as ErrorEvent);
    expect(await crash.completion).toBe(false);
    expect(h.session.getSnapshot().error).toContain('worker failed');
    const corrupt = await h.start(); corrupt.worker.onmessageerror?.({} as MessageEvent);
    expect(await corrupt.completion).toBe(false);
    expect(h.session.getSnapshot().error).toContain('could not be read');
    expect(await h.session.run(() => Promise.reject(new Error('Repository sequence changed')), 'A')).toBe(false);
    expect(h.session.getSnapshot().error).toBe('Repository sequence changed');
    const pending = await h.start(); h.session.deactivate();
    expect(await pending.completion).toBe(false);
    expect(h.session.getSnapshot()).toMatchObject({ accepted, busy: false });
    expect(await h.session.run(request(), 'A')).toBe(false);
  });
});
