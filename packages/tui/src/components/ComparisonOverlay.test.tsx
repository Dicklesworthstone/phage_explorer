import { describe, expect, it } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import type { Worker } from 'node:worker_threads';
import { importLocalGenomes, type PhageFull } from '@phage-explorer/core';
import { compareGenomes, type GenomeComparisonResult } from '@phage-explorer/comparison';
import { usePhageStore } from '@phage-explorer/state';
import { createLocalGenomeRepository } from '@phage-explorer/db-runtime';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import type { CompareJob } from '../workers/comparison-worker';
import { ComparisonOverlay, runComparisonInWorker } from './ComparisonOverlay';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Comparison did not reach the expected terminal state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const job: CompareJob = {
  phageA: { id: 1, name: 'First genome', accession: 'FIRST' },
  phageB: { id: 2, name: 'Second genome', accession: 'SECOND' },
  sequenceA: 'ACGT'.repeat(32), sequenceB: 'ACGT'.repeat(32), genesA: [], genesB: [],
};
const compute = (input: CompareJob) => compareGenomes(input.phageA, input.phageB,
  input.sequenceA, input.sequenceB, input.genesA, input.genesB, input.codonUsageA, input.codonUsageB);

class ControlledWorker extends EventEmitter {
  sent: CompareJob[] = [];
  terminations = 0;
  postError: Error | null = null;
  postMessage(input: CompareJob) {
    if (this.postError) throw this.postError;
    this.sent.push(input);
  }
  async terminate() { this.terminations++; return 0; }
}
const factory = (worker: ControlledWorker) => () => worker as unknown as Worker;

describe('owned terminal comparison worker', () => {
  it('computes an actual native-worker result for the supplied genomes', async () => {
    const result = await runComparisonInWorker(job);
    expect(result.phageA).toEqual(job.phageA);
    expect(result.phageB).toEqual(job.phageB);
    expect(result.biological.lengthA).toBe(128);
    expect(result.biological.lengthB).toBe(128);
    expect(result.biological.gcContentA).toBe(50);
    expect(result.kmerAnalysis.every(row => row.jaccardIndex === 1)).toBe(true);
  });

  it('does not create work for an already-cancelled request and terminates active cancellation once', async () => {
    const controller = new AbortController(), worker = new ControlledWorker();
    controller.abort();
    await expect(runComparisonInWorker(job, controller.signal, 1000, factory(worker))).rejects.toHaveProperty('name', 'AbortError');
    expect(worker.sent).toHaveLength(0);
    expect(worker.terminations).toBe(0);
    const active = new AbortController();
    const pending = runComparisonInWorker(job, active.signal, 1000, factory(worker));
    active.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    worker.emit('message', { ok: false, error: 'late result' });
    worker.emit('exit', 0);
    expect(worker.terminations).toBe(1);
  });

  it('settles worker exit, error and postMessage failures without falling back inline', async () => {
    for (const event of ['exit', 'error', 'post'] as const) {
      const worker = new ControlledWorker();
      if (event === 'post') worker.postError = new Error('cannot transfer job');
      const pending = runComparisonInWorker(job, undefined, 1000, factory(worker));
      if (event === 'exit') worker.emit('exit', 0);
      if (event === 'error') worker.emit('error', new Error('worker failed'));
      await expect(pending).rejects.toThrow(event === 'exit' ? 'exited without a result' : event === 'post' ? 'cannot transfer job' : 'worker failed');
      expect(worker.terminations).toBe(1);
    }
  });

  it('settles a silent worker at its deadline and rejects mismatched response inputs', async () => {
    const silent = new ControlledWorker();
    await expect(runComparisonInWorker(job, undefined, 5, factory(silent))).rejects.toThrow('timed out');
    expect(silent.terminations).toBe(1);
    const valid = await compute(job);
    for (const result of [
      { ...valid, phageB: { ...valid.phageB, accession: 'OTHER' } },
      { ...valid, biological: { ...valid.biological, lengthA: 1 } },
    ]) {
      const worker = new ControlledWorker();
      const pending = runComparisonInWorker(job, undefined, 1000, factory(worker));
      worker.emit('message', { ok: true, result });
      await expect(pending).rejects.toThrow('different inputs');
      expect(worker.terminations).toBe(1);
    }
  });
});

async function fixture() {
  const { genomes } = await importLocalGenomes({ name: 'comparison.fa',
    text: '>FIRST\n' + 'ACGT'.repeat(32) + '\n>SECOND\n' + 'ATGG'.repeat(32)
      + '\n>THIRD\n' + 'TTCC'.repeat(32) + '\n' });
  const repository = createLocalGenomeRepository<PhageRepository>(null, genomes);
  const phages = await repository.listPhages();
  usePhageStore.setState({ phages, comparisonPhageAIndex: 0, comparisonPhageBIndex: 1,
    comparisonResult: null, comparisonLoading: false, comparisonTab: 'summary',
    comparisonSelectingPhage: null, overlays: ['comparison'], terminalCols: 110, terminalRows: 40 });
  return { repository, phages };
}
function controlledRunner() {
  const jobs: { job: CompareJob; signal: AbortSignal | undefined; result: ReturnType<typeof deferred<GenomeComparisonResult>> }[] = [];
  const run: typeof runComparisonInWorker = (input, signal) => {
    const result = deferred<GenomeComparisonResult>();
    jobs.push({ job: input, signal, result });
    return result.promise;
  };
  return { jobs, run };
}
function terminal(repository: PhageRepository, runWorker?: typeof runComparisonInWorker) {
  let output = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) {
    output += stripVTControlCharacters(chunk.toString()); callback();
  } }), { columns: 110, rows: 40 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (_value: boolean) => { ready = true; }, ref() {}, unref() {} });
  const ui = render(<ComparisonOverlay repository={repository} runWorker={runWorker} />, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  return { ui, output: () => output, ready: () => ready, press: (value: string) => stdin.write(value),
    replace: (next: PhageRepository) => ui.rerender(<ComparisonOverlay repository={next} runWorker={runWorker} />) };
}

describe('terminal comparison source ownership and recovery', () => {
  it('shows missing-source errors once and only retries after the R key', async () => {
    const previous = usePhageStore.getState();
    const { repository } = await fixture();
    let reads = 0;
    const unavailable = { ...repository, getPhageById: async () => { reads++; return null; } } as PhageRepository;
    const test = terminal(unavailable);
    try {
      await waitFor(() => test.output().includes('A selected genome is no longer available'));
      expect(reads).toBe(2);
      expect(usePhageStore.getState().comparisonLoading).toBe(false);
      usePhageStore.getState().nextComparisonTab();
      await flush();
      expect(reads).toBe(2);
      await waitFor(test.ready);
      test.press('r');
      await waitFor(() => reads === 4);
      await waitFor(() => !usePhageStore.getState().comparisonLoading);
      expect(reads).toBe(4);
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('cannot replace a newer selected-pair result with a late previous response', async () => {
    const previous = usePhageStore.getState();
    const { repository, phages } = await fixture();
    const runner = controlledRunner(), test = terminal(repository, runner.run);
    try {
      await waitFor(() => runner.jobs.length === 1);
      usePhageStore.getState().setComparisonPhageB(2);
      await waitFor(() => runner.jobs.length === 2);
      expect(runner.jobs[0].signal?.aborted).toBe(true);
      const accepted = await compute(runner.jobs[1].job);
      runner.jobs[1].result.resolve(accepted);
      await waitFor(() => usePhageStore.getState().comparisonResult === accepted);
      runner.jobs[0].result.resolve(await compute(runner.jobs[0].job));
      await flush();
      expect(usePhageStore.getState().comparisonResult).toBe(accepted);
      expect(accepted.phageB.id).toBe(phages[2].id);
      expect(usePhageStore.getState().comparisonLoading).toBe(false);
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('owns repository replacements even when both numeric IDs stay the same', async () => {
    const previous = usePhageStore.getState();
    const { repository } = await fixture();
    const runner = controlledRunner(), test = terminal(repository, runner.run);
    try {
      await waitFor(() => runner.jobs.length === 1);
      const replacement = { ...repository, getSequenceWindow: async () => 'G'.repeat(128) } as PhageRepository;
      test.replace(replacement);
      await waitFor(() => runner.jobs.length === 2);
      expect(runner.jobs[0].signal?.aborted).toBe(true);
      expect(runner.jobs[1].job.sequenceA).toBe('G'.repeat(128));
      runner.jobs[0].result.resolve(await compute(runner.jobs[0].job));
      await flush();
      expect(usePhageStore.getState().comparisonResult).toBeNull();
      const accepted = await compute(runner.jobs[1].job);
      runner.jobs[1].result.resolve(accepted);
      await waitFor(() => usePhageStore.getState().comparisonResult === accepted);
      expect(accepted.biological.gcContentA).toBe(100);
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('does not fetch sequences or launch work after obsolete metadata resolves', async () => {
    const previous = usePhageStore.getState();
    const { repository } = await fixture();
    const reads: { id: number; value: ReturnType<typeof deferred<PhageFull | null>> }[] = [];
    const sequenceReads: number[] = [];
    const delayed = { ...repository,
      getPhageById: (id: number) => { const value = deferred<PhageFull | null>(); reads.push({ id, value }); return value.promise; },
      getSequenceWindow: async (id: number, start: number, end: number) => {
        sequenceReads.push(id); return repository.getSequenceWindow(id, start, end);
      },
    } as PhageRepository;
    const runner = controlledRunner(), test = terminal(delayed, runner.run);
    try {
      await waitFor(() => reads.length === 2);
      usePhageStore.getState().setComparisonPhageB(2);
      await waitFor(() => reads.length === 4);
      for (const old of reads.slice(0, 2)) old.value.resolve(await repository.getPhageById(old.id));
      await flush();
      expect(sequenceReads).toHaveLength(0);
      expect(runner.jobs).toHaveLength(0);
      for (const current of reads.slice(2)) current.value.resolve(await repository.getPhageById(current.id));
      await waitFor(() => runner.jobs.length === 1);
      expect(sequenceReads).toEqual(reads.slice(2).map(read => read.id));
      test.ui.unmount();
      await flush();
      expect(runner.jobs[0].signal?.aborted).toBe(true);
      runner.jobs[0].result.resolve(await compute(runner.jobs[0].job));
      await flush();
      expect(usePhageStore.getState().comparisonResult).toBeNull();
      expect(usePhageStore.getState().comparisonLoading).toBe(false);
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('rejects incomplete inputs before computing and recovers from a failed worker on explicit retry', async () => {
    const previous = usePhageStore.getState();
    const { repository } = await fixture();
    let incomplete = true;
    const source = { ...repository, getSequenceWindow: async (id: number, start: number, end: number) =>
      incomplete ? '' : repository.getSequenceWindow(id, start, end) } as PhageRepository;
    const runner = controlledRunner(), test = terminal(source, runner.run);
    try {
      await waitFor(() => test.output().includes('A complete sequence could not be loaded'));
      expect(runner.jobs).toHaveLength(0);
      incomplete = false;
      await waitFor(test.ready); test.press('r');
      await waitFor(() => runner.jobs.length === 1);
      runner.jobs[0].result.reject(new Error('intentional worker failure'));
      await waitFor(() => test.output().includes('intentional worker failure'));
      expect(usePhageStore.getState().comparisonResult).toBeNull();
      expect(usePhageStore.getState().comparisonLoading).toBe(false);
      usePhageStore.getState().nextComparisonTab(); await flush();
      expect(runner.jobs).toHaveLength(1);
      test.press('r');
      await waitFor(() => runner.jobs.length === 2);
      const accepted = await compute(runner.jobs[1].job);
      runner.jobs[1].result.resolve(accepted);
      await waitFor(() => usePhageStore.getState().comparisonResult === accepted);
      test.press('\u001b');
      await waitFor(() => !usePhageStore.getState().overlays.includes('comparison'));
      expect(usePhageStore.getState().comparisonResult).toBeNull();
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('cycles only rendered terminal tabs while a request is pending and cancels on close', async () => {
    const previous = usePhageStore.getState();
    const { repository } = await fixture();
    const runner = controlledRunner(), test = terminal(repository, runner.run);
    try {
      await waitFor(() => runner.jobs.length === 1 && test.ready());
      for (const expected of ['kmer', 'information', 'correlation', 'biological', 'genes', 'structural', 'summary']) {
        test.press('\t');
        await waitFor(() => usePhageStore.getState().comparisonTab === expected);
      }
      test.press('\u001b');
      await waitFor(() => !usePhageStore.getState().overlays.includes('comparison'));
      expect(runner.jobs[0].signal?.aborted).toBe(true);
      expect(usePhageStore.getState().comparisonLoading).toBe(false);
      runner.jobs[0].result.resolve(await compute(runner.jobs[0].job));
      await flush();
      expect(usePhageStore.getState().comparisonResult).toBeNull();
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });
});
