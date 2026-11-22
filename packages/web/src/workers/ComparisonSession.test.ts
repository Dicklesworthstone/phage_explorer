import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { importLocalGenomes, serializeAnalysisRecord, type PhageFull } from '@phage-explorer/core';
import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
import type { ComparisonGenomeInput, GenomeComparisonExperiment } from '@phage-explorer/comparison';
import { runGenomeComparisonJob } from '../../../tui/src/commands/genome-comparison';
import { replaySavedResearch, validateResearchSnapshotContent } from '../db/research-storage';
import { ComparisonReplaySession, readComparisonPair, runWebComparison, type ComparisonWorker } from './ComparisonSession';
import type { ComparisonAnalysisJob, ComparisonJob, ComparisonWorkerMessage } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const sequenceA = 'ATGAAACCCCCCGGGTTT', sequenceB = sequenceA + 'A';
const firstInput = { name: 'comparison-source.gb', text: [
  'LOCUS       compare_source            18 bp    DNA     linear',
  'ACCESSION   COMPAREA.1', 'FEATURES             Location/Qualifiers',
  '     CDS             complement(join(1..6,13..18))',
  '                     /gene="joined_reverse"', '                     /product="comparison fixture"',
  '                     /transl_table=11', 'ORIGIN', '        1 atgaaaccccccgggttt', '//', '',
].join('\n') };
const secondInput = { name: 'comparison-query.fa', text: '>COMPAREB.1\n' + sequenceB + '\n' };
const options = { kmerSizes: [3, 5], maxEditDistanceLength: 100, editDistanceWindowSize: 10, editDistanceWindowCount: 3 };
async function source(input: typeof firstInput): Promise<ComparisonGenomeInput> {
  const { phage, sequence } = (await importLocalGenomes(input)).genomes[0];
  return { phage: { id: phage.id, name: phage.name, accession: phage.accession }, source: 'local', sequence, genes: phage.genes, codonUsage: null };
}
function job(a: ComparisonGenomeInput, b: ComparisonGenomeInput): ComparisonAnalysisJob {
  return { kind: 'analyze', jobId: 'complete-browser-comparison', phageA: a.phage, phageB: b.phage,
    sourceA: a.source, sourceB: b.source, sequenceA: a.sequence, sequenceB: b.sequence,
    genesA: a.genes, genesB: b.genes, codonUsageA: a.codonUsage, codonUsageB: b.codonUsage, options };
}
async function accepted(): Promise<GenomeComparisonExperiment> {
  return runWebComparison(job(await source(firstInput), await source(secondInput)));
}
class ControlledWorker implements ComparisonWorker {
  onmessage: ((event: MessageEvent<ComparisonWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: ComparisonJob | null = null;
  started = deferred<void>();
  terminated = 0;
  postMessage(value: ComparisonJob) { this.posted = value; this.started.resolve(); }
  terminate() { this.terminated++; }
  result(experiment: GenomeComparisonExperiment) {
    this.onmessage?.({ data: { jobId: this.posted!.jobId, ok: true, experiment } } as MessageEvent<ComparisonWorkerMessage>);
  }
}

describe('complete browser comparison experiments', () => {
  it('runs actual browser/native workers and replays a browser export through the real CLI entrypoint', async () => {
    const browser = await accepted();
    const exported = serializeAnalysisRecord(browser.record);
    expect(browser.genomeA.sequence).toBe(sequenceA); expect(browser.genomeB.sequence).toBe(sequenceB);
    expect(browser.genomeA.genes[0].qualifiers?._location).toBe('complement(join(1..6,13..18))');
    expect(browser.genomeB.genes).toHaveLength(0);
    const diff = browser.result.sequenceDiff;
    expect(diff?.status).toBe('complete');
    if (diff?.status === 'complete') {
      expect(diff.stats).toMatchObject({ distance: 1, insertions: 1, deletions: 0, substitutions: 0 });
      expect(diff.runs.at(-1)).toMatchObject({ operation: 'insertion', startA: 18, endA: 18, startB: 18, endB: 19 });
      expect(diff.mask).toHaveLength(18);
    }
    const native = await runGenomeComparisonJob({ operation: 'run', genomeA: firstInput, genomeB: secondInput, parameters: JSON.stringify(options) });
    const reopened = await runWebComparison({ kind: 'replay', jobId: 'from-terminal', content: native });
    expect(reopened.record).toEqual(browser.record);
    expect(validateResearchSnapshotContent('comparison', native)).toBeGreaterThan(0);

    const entry = fileURLToPath(new URL('../../../tui/src/index.tsx', import.meta.url));
    const child = Bun.spawn([process.execPath, entry, 'comparison', 'replay', '-'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(exported); child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(stderr).not.toContain('Error');
    expect(JSON.parse(stdout)).toEqual(browser.record);
  });

  it('retains exact repository annotations before asynchronous base reads can outlive them', async () => {
    const imported = await importLocalGenomes({ name: 'private.fa', text: '>A\nAAACCC\n>B\nAAAGCC\n' });
    const repository = createLocalGenomeRepository(null, imported.genomes);
    const a = await repository.getPhageById(imported.genomes[0].phage.id), b = await repository.getPhageById(imported.genomes[1].phage.id);
    if (!a || !b) throw new Error('Expected imported genomes.');
    a.genes = [{ id: 7, name: 'original', locusTag: null, product: null, strand: '+', type: 'CDS', startPos: 0, endPos: 6 }];
    a.codonUsage = { codonCounts: { AAA: 1, CCC: 1 }, aaCounts: { K: 1, P: 1 } };
    const gate = deferred<void>(), requested = deferred<void>();
    const reading = readComparisonPair({ getPhageById: async id => id === a.id ? a : b,
      getSequenceWindow: async (...args) => { requested.resolve(); await gate.promise; return repository.getSequenceWindow(...args); } }, a, b, new AbortController().signal);
    await requested.promise;
    a.genes[0].name = 'changed'; a.codonUsage.codonCounts.AAA = 99;
    gate.resolve();
    const [left, right] = await reading;
    expect(left.genes[0].name).toBe('original'); expect(left.codonUsage?.codonCounts.AAA).toBe(1);
    const experiment = await runWebComparison(job(left, right));
    expect(experiment.genomeA).toEqual(left); expect(experiment.record.inputs[0].source).toBe('local');
    expect(experiment.result.geneContent.genesA).toBe(1);
  });

  it('rejects missing, truncated and oversized sources and stops abandoned metadata before base reads', async () => {
    const imported = await importLocalGenomes({ name: 'limits.fa', text: '>A\nAAACCC\n>B\nAAAGCC\n' });
    const [a, b] = imported.genomes.map(genome => genome.phage);
    const repository = createLocalGenomeRepository(null, imported.genomes), controller = new AbortController();
    await expect(readComparisonPair({ getPhageById: async () => null, getSequenceWindow: async () => '' }, a, b, controller.signal)).rejects.toThrow('no longer available');
    await expect(readComparisonPair({ getPhageById: repository.getPhageById.bind(repository), getSequenceWindow: async () => 'AAA' }, a, b, controller.signal)).rejects.toThrow('complete sequence');
    let baseReads = 0;
    await expect(readComparisonPair({ getPhageById: async id => ({ ...(id === a.id ? a : b), genomeLength: 1000001 }),
      getSequenceWindow: async () => { baseReads++; return ''; } }, a, b, controller.signal)).rejects.toThrow('1,000,000');
    const gate = deferred<PhageFull>(), requested = deferred<void>();
    const delayed = { getPhageById: async () => { requested.resolve(); return gate.promise; },
      getSequenceWindow: async () => { baseReads++; return ''; } };
    const pending = readComparisonPair(delayed, a, b, controller.signal, 5);
    await requested.promise;
    await expect(pending).rejects.toThrow('timed out');
    gate.resolve(a); await Promise.resolve(); await Promise.resolve();
    expect(baseReads).toBe(0);
  });

  it('reopens a saved snapshot only after verification and preserves accepted evidence on read failure or cancellation', async () => {
    const experiment = await accepted(), content = serializeAnalysisRecord(experiment.record);
    const session = new ComparisonReplaySession(); session.activate();
    const scope = {}, controller = new AbortController();
    await replaySavedResearch(controller.signal, { run: () => session.run(scope, content), cancel: () => session.cancel(scope), error: () => session.getSnapshot().error });
    const first = session.getSnapshot().accepted;
    expect(first?.record).toEqual(experiment.record);
    await expect(replaySavedResearch(controller.signal, { run: () => session.run(scope, '{broken'), cancel: () => session.cancel(scope), error: () => session.getSnapshot().error })).rejects.toThrow();
    expect(session.getSnapshot().accepted).toBe(first);
    const gate = deferred<string>();
    const pending = session.run(scope, () => gate.promise);
    session.cancel(scope); gate.resolve(content);
    expect(await pending).toBe(false); expect(session.getSnapshot().accepted).toBe(first);
    expect(session.getSnapshot().busy).toBe(false); session.deactivate();
  });

  it('keeps a new replay owner when an obsolete scope cleans up and discards queued replies', async () => {
    const experiment = await accepted(), content = serializeAnalysisRecord(experiment.record);
    const workers = [new ControlledWorker(), new ControlledWorker()]; let next = 0;
    const session = new ComparisonReplaySession(() => workers[next++]); session.activate();
    const scopeA = {}, scopeB = {};
    const old = session.run(scopeA, content); await workers[0].started.promise;
    const queued = workers[0].onmessage!;
    const current = session.run(scopeB, content); await workers[1].started.promise;
    session.cancel(scopeA);
    expect(workers[0].terminated).toBe(1); expect(workers[1].terminated).toBe(0);
    workers[1].result(experiment);
    expect(await current).toBe(true); expect(await old).toBe(false);
    queued({ data: { jobId: workers[0].posted!.jobId, ok: false, error: 'obsolete failure' } } as MessageEvent<ComparisonWorkerMessage>);
    expect(session.getSnapshot().accepted).toBe(experiment); expect(session.getSnapshot().error).toBeNull();
    expect(workers[1].terminated).toBe(1); session.deactivate();
  });

  it('does not spawn a worker when reading an import exceeds its deadline', async () => {
    const worker = new ControlledWorker(), gate = deferred<string>();
    const session = new ComparisonReplaySession(() => worker, 1000, 5); session.activate();
    expect(await session.run({}, () => gate.promise)).toBe(false);
    expect(session.getSnapshot().error).toContain('timed out');
    gate.resolve('{}'); await Promise.resolve();
    expect(worker.posted).toBeNull(); expect(session.getSnapshot().accepted).toBeNull(); session.deactivate();
  });
});
