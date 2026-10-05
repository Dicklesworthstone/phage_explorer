import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { executePangenomeRequest, pangenomeRequestFromLocalGenomes, PangenomeSession,
  type PangenomeRequest, type PangenomeWorker, type PangenomeMessage } from './PangenomeSession';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { parsePangenomeInput } from '../../../core/src/analysis/alignment-pangenome';

const ids = ['a'.repeat(64), 'b'.repeat(64)];
const base = 'ACGT'.repeat(4000);
const genomes = () => [
  { sequence: base, phage: { name: 'Private reference', accession: 'SAME', localGenome: { contentId: ids[0] } } },
  { sequence: base.slice(0, 8000) + 'T' + base.slice(8001), phage: { name: 'Private query', accession: 'SAME', localGenome: { contentId: ids[1] } } },
];
// Transport/lifetime fixture: computation is the actual production executor,
// but this port is in-process, not evidence of a particular browser's Worker.
class Port implements PangenomeWorker {
  onmessage: PangenomeWorker['onmessage'] = null;
  onerror: PangenomeWorker['onerror'] = null;
  onmessageerror: PangenomeWorker['onmessageerror'] = null;
  terminated = 0;
  deliver: (() => Promise<void>) | null = null;
  constructor(private hold: boolean) {}
  postMessage(value: PangenomeRequest): void {
    const request = structuredClone(value), handler = this.onmessage;
    const send = (data: PangenomeMessage) => handler?.call(this as unknown as Worker, { data: structuredClone(data) } as MessageEvent);
    this.deliver = async () => {
      try { const result = await executePangenomeRequest(request, phase => send({ kind: 'progress', phase })); send({ kind: 'result', result }); }
      catch (cause) { send({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }); }
    };
    if (!this.hold) void this.deliver();
  }
  terminate(): void { this.terminated++; }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('related-genome pangenome workflow', () => {
  it('selects private records by content identity, not colliding accessions, and snapshots source values', () => {
    const inputs = genomes();
    const request = pangenomeRequestFromLocalGenomes(inputs, ids);
    assert.equal(request.kind, 'local-genomes');
    if (request.kind !== 'local-genomes') throw new Error('Expected local genomes');
    assert.deepEqual(request.input.sequences.map(s => s.id), ids.map(id => `local-${id}`));
    inputs[1].sequence = 'AAAA'; inputs[0].phage.name = 'Changed';
    assert.equal(request.input.sequences[1].sequence.length, 16000);
    assert.equal(request.input.sequences[0].description, 'Private reference (SAME)');
  });
  it('rejects missing, duplicated or unbounded selections before submitting them', () => {
    assert.throws(() => pangenomeRequestFromLocalGenomes(genomes(), [ids[0]]), /2–24/);
    assert.throws(() => pangenomeRequestFromLocalGenomes(genomes(), [ids[0], ids[0]]), /distinct/);
    assert.throws(() => pangenomeRequestFromLocalGenomes(genomes(), [ids[0], 'c'.repeat(64)]), /missing/);
    assert.throws(() => pangenomeRequestFromLocalGenomes(genomes(), [ids[0], 'invalid']), /identity/);
    assert.throws(() => pangenomeRequestFromLocalGenomes([...genomes(), genomes()[0]], ids), /duplicated/);
    assert.throws(() => pangenomeRequestFromLocalGenomes(genomes(), Array.from({ length: 25 }, (_, i) => i.toString(16).padStart(64, '0'))), /2–24/);
  });
  it('loads selected genomes without secretly running alignment and rejects gaps or demo relabeling', async () => {
    const request = pangenomeRequestFromLocalGenomes(genomes(), ids);
    const loaded = await executePangenomeRequest(request);
    assert.equal(loaded.options.alignment, 'wavefront'); assert.equal(loaded.options.terminalGaps, 'missing');
    assert.equal(loaded.graph, null); assert.equal(loaded.record, null);
    if (request.kind !== 'local-genomes') throw new Error('Expected local genomes');
    await assert.rejects(executePangenomeRequest({ ...request, input: { ...request.input, source: 'demo' } }), /local ungapped/);
    const gap = structuredClone(request); gap.input.sequences[0].sequence = 'AC-GT';
    await assert.rejects(executePangenomeRequest(gap), /ungapped/);
  });
  it('runs a selected-genome graph, exports the real result, and recomputes it on reopen', async () => {
    const ports: Port[] = [];
    const session = new PangenomeSession(() => { const port = new Port(false); ports.push(port); return port; });
    session.activate();
    await session.run(pangenomeRequestFromLocalGenomes(genomes(), ids));
    const loaded = session.getSnapshot().accepted!;
    await session.run({ kind: 'analyze', input: loaded.input, options: { ...loaded.options, referenceId: `local-${ids[0]}` } });
    const accepted = session.getSnapshot().accepted!;
    assert.equal(session.getSnapshot().error, null);
    assert.deepEqual(accepted.graph!.variants.map(v => [v.referenceStart, v.referenceEnd, v.reference, v.alternate]), [[8000, 8001, 'A', 'T']]);
    const output = serializeAnalysisRecord(accepted.record!);
    await session.run({ kind: 'import', content: output, filename: 'saved.json' });
    assert.equal(session.getSnapshot().accepted!.verified, true);
    assert.equal(session.getSnapshot().accepted!.record!.resultId, accepted.record!.resultId);
    assert(ports.every(port => port.terminated === 1));
    session.deactivate();
  });
  it('keeps accepted results through budget errors and permits a later successful run', async () => {
    const session = new PangenomeSession(() => new Port(false)); session.activate();
    await session.run(pangenomeRequestFromLocalGenomes(genomes(), ids));
    const prior = session.getSnapshot().accepted!;
    const input = parsePangenomeInput(`>ref\n${'A'.repeat(2100)}\n>query\n${'C'.repeat(2100)}`);
    await session.run({ kind: 'analyze', input, options: { alignment: 'wavefront', referenceId: 'ref', terminalGaps: 'alleles' } });
    assert.match(session.getSnapshot().error!, /state budget/);
    assert.equal(session.getSnapshot().accepted, prior); assert.equal(session.getSnapshot().busy, false);
    await session.run({ kind: 'analyze', input: prior.input, options: prior.options });
    assert.equal(session.getSnapshot().error, null); assert.equal(session.getSnapshot().accepted!.graph!.variants.length, 1);
    session.deactivate();
  });
  it('cancels a held request, terminates its worker, and refuses even a captured late handler', async () => {
    const ports: Port[] = []; let hold = false;
    const session = new PangenomeSession(() => { const p = new Port(hold); ports.push(p); return p; }); session.activate();
    await session.run(pangenomeRequestFromLocalGenomes(genomes(), ids));
    const prior = session.getSnapshot().accepted!;
    hold = true;
    const pending = session.run({ kind: 'analyze', input: prior.input, options: prior.options }); await tick();
    session.cancel(); await pending;
    assert.equal(ports[1].terminated, 1); assert.equal(session.getSnapshot().accepted, prior);
    hold = false;
    await session.run({ kind: 'demo' });
    const replacement = session.getSnapshot().accepted;
    await ports[1].deliver!();
    assert.equal(session.getSnapshot().accepted, replacement);
    assert.equal(session.getSnapshot().error, null);
    session.deactivate();
  });
});
