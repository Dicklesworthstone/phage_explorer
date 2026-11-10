import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { parseProteinReferenceBundle, proteinReferenceContentHash } from '../../core/src/protein-reference';
import {
  PROTEIN_STRUCTURE_LIMITS, PROTEIN_STRUCTURE_METHOD, createProteinStructureExperiment,
  exportProteinStructureTsv, proteinStructureResultFromRecord, resolveProteinStructureOptions,
  type ProteinStructureOptions, type ResolvedProteinStructureOptions, type ProteinStructureResult,
} from '../../core/src/analysis/tail-fiber-structure';
import { terminalProteinStructureRequestSha256, validateTerminalResearchRequest, type TerminalResearchRequest } from './research-replay.worker';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker, type TerminalWorker, type WorkflowRuntime } from '../../../scripts/research-workflow';

const referenceText = await Bun.file(new URL('../../../data/protein-references/lambda-lamb-v1.json', import.meta.url)).text();
const reference = await parseProteinReferenceBundle(JSON.parse(referenceText));
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const request = (options: ProteinStructureOptions = {}): Extract<TerminalResearchRequest, { type: 'analyze-protein-structure' }> =>
  ({ type: 'analyze-protein-structure', content: referenceText, options });
const run = (job: TerminalResearchRequest) => runTerminalResearchWorker(job, new AbortController().signal);

async function cli(args: string[], runtime: WorkflowRuntime = {}) {
  let output = '', error = '';
  const code = await researchWorkflowMain(args, text => { output += text; }, text => { error += text; }, runtime);
  return { code, output, error };
}

async function rehash(record: AnalysisRecord, change: (copy: AnalysisRecord) => void): Promise<string> {
  const copy = structuredClone(record); change(copy);
  return serializeAnalysisRecord(await createAnalysisRecord({
    method: copy.method, parameters: copy.parameters, seed: copy.seed, references: copy.references, fields: copy.fields,
    inputs: copy.inputs.map(({ sha256: _sha, ...input }) => input),
  }));
}

class ReplyWorker extends EventEmitter {
  terminated = 0;
  posted: Extract<TerminalResearchRequest, { type: 'analyze-protein-structure' }> | null = null;
  constructor(private readonly recordJson: string | null) { super(); }
  postMessage(job: Extract<TerminalResearchRequest, { type: 'analyze-protein-structure' }>) {
    this.posted = job;
    if (this.recordJson !== null) queueMicrotask(() => this.emit('message', {
      type: 'protein-structure-analyzed', inputFileSha256: hash(job.content),
      requestSha256: terminalProteinStructureRequestSha256({ content: job.content, options: job.options as ResolvedProteinStructureOptions }),
      recordJson: this.recordJson,
    }));
  }
  terminate() { this.terminated++; return Promise.resolve(0); }
}

describe('terminal protein reference evidence workflow', () => {
  it('keeps explicit source and geometry settings separate from other workflow commands', () => {
    const parsed = parseWorkflowCommand(['analyze-protein-structure', '--input', 'reference.json',
      '--protein', 'lambda-j', '--chain', 'D', '--cutoff', '15', '--min-separation', '4', '--contact-scope', 'chain',
      '--format', 'tsv', '--section', 'contacts', '--output', 'new contacts.tsv']);
    assert(parsed.type === 'analyze-protein-structure');
    assert.deepEqual(parsed.options, { proteinId: 'lambda-j', chainLabelAsymId: 'D', contactCutoffAngstrom: 15,
      minSequenceSeparation: 4, contactScope: 'chain' });
    assert.equal(parsed.section, 'contacts'); assert.equal(parsed.output, 'new contacts.tsv');
    const alignment = parseWorkflowCommand(['analyze-protein-structure', '--input', 'reference.json', '--chain', 'none']);
    assert(alignment.type === 'analyze-protein-structure'); assert.equal(alignment.options.chainLabelAsymId, null);
    assert.deepEqual(parseWorkflowCommand(['inspect-protein-reference', '--input', 'reference.json']),
      { type: 'inspect-protein-reference', input: 'reference.json', timeoutMs: 300000 });
    for (const flags of [
      ['--cutoff', '0'], ['--cutoff', 'NaN'], ['--cutoff', '31'], ['--cutoff', '-1'], ['--cutoff', '1e1'],
      ['--min-separation', '0'], ['--min-separation', '1.5'], ['--min-separation', '10001'],
      ['--contact-scope', 'complex'], ['--cutoff', '8', '--cutoff', '9'], ['--k', '2'],
      ['--format', 'tsv'], ['--section', 'contacts', '--output', 'new'], ['--format', 'tsv', '--section', 'windows', '--output', 'new'],
    ]) assert.throws(() => parseWorkflowCommand(['analyze-protein-structure', '--input', 'reference.json', ...flags]));
    assert.throws(() => parseWorkflowCommand(['inspect-protein-reference', '--input', 'x', '--cutoff', '8']));
    assert.throws(() => parseWorkflowCommand(['replay-experiment', '--input', 'x', '--chain', 'D']));
  });

  it('rejects malformed settings and source identities before worker allocation', async () => {
    for (const options of [null, [], { invented: undefined }, { contactCutoffAngstrom: NaN }]) {
      assert.throws(() => validateTerminalResearchRequest({ ...request(), options }));
    }
    let allocations = 0;
    const createWorker = (): TerminalWorker => { allocations++; throw new Error('Worker should not be allocated.'); };
    for (const options of [
      { proteinId: 'not-in-reference' }, { chainLabelAsymId: 'Z' }, { chainLabelAsymId: 'A' },
      { contactCutoffAngstrom: 31 }, { minSequenceSeparation: 0 },
    ]) {
      await assert.rejects(runTerminalResearchWorker(request(options), new AbortController().signal, undefined, createWorker));
    }
    const damaged = JSON.parse(referenceText); damaged.proteins[0].sequence = 'AAAA';
    await assert.rejects(runTerminalResearchWorker({ ...request(), content: JSON.stringify(damaged) },
      new AbortController().signal, undefined, createWorker), /checksum|identity/i);
    assert.equal(allocations, 0);
  });

  it('enforces the smaller reference limit on UTF-8 bytes before parsing or allocating a worker', () => {
    const content = 'é'.repeat(PROTEIN_STRUCTURE_LIMITS.referenceBytes / 2 + 1);
    assert(content.length < PROTEIN_STRUCTURE_LIMITS.referenceBytes);
    assert.throws(() => validateTerminalResearchRequest({ type: 'inspect-protein-reference', content }), /UTF-8/);
    assert.throws(() => validateTerminalResearchRequest({ ...request(), content }), /UTF-8/);
  });

  it('inspects actual reference identities and mapped coverage without printing protein sequences', async () => {
    const reply = await run({ type: 'inspect-protein-reference', content: referenceText });
    assert(reply.type === 'protein-reference-inspected');
    assert.equal(reply.report.bundleSha256, reference.bundleSha256);
    assert.equal(reply.report.inputFileSha256, hash(referenceText));
    assert.deepEqual(reply.report.proteins, [
      { id: 'lambda-j', accession: 'P03749', residues: 1132 },
      { id: 'shigella-lamb', accession: 'Q3YUU9', residues: 446 },
      { id: 'secphi27-j', accession: 'P0DXX7', residues: 1192 },
    ]);
    assert.deepEqual(reply.report.chains.map(chain => [chain.labelAsymId, chain.authAsymId, chain.observedResidues]),
      [['D', 'Z', 420], ['A', 'A', 422]]);
    assert.equal(reply.report.alignment.columns, 1228);
    assert(!('verified' in reply.report));
    for (const protein of reference.proteins) assert(!JSON.stringify(reply).includes(protein.sequence));
    assert.match(reply.report.interpretation, /no selected genome/i);
  });

  it('computes real source entropy and CA geometry in the production native worker, then freshly replays them', async () => {
    const reply = await run(request()); assert(reply.type === 'protein-structure-analyzed');
    const record = await parseAnalysisRecord(reply.recordJson);
    assert.deepEqual(record.method, PROTEIN_STRUCTURE_METHOD);
    assert.deepEqual(record.parameters, resolveProteinStructureOptions(reference));
    assert.equal(record.seed, null); assert.equal(record.inputs.length, 1);
    assert.equal(record.inputs[0].id, 'reference'); assert.deepEqual(record.inputs[0].data, analysisJson(reference));
    const result = proteinStructureResultFromRecord(record);
    assert.deepEqual(result.protein, { id: 'lambda-j', accession: 'P03749', length: 1132 });
    // Independently counted from the pinned two-row alignment and observed CA coordinates.
    assert.equal(result.residues.filter(row => row.alignment?.entropyBits === 0).length, 374);
    assert.equal(result.residues.filter(row => row.alignment?.entropyBits === 1).length, 722);
    assert.equal(result.residues.filter(row => row.alignment?.entropyBits === null).length, 36);
    assert.equal(result.residues[0].alignment?.column, 5);
    assert.equal(result.residues[5].alignment?.column, 14);
    assert.equal(result.residues[33].alignment?.column, 42);
    assert.equal(result.residues[33].alignment?.entropyBits, null);
    assert.equal(result.coverage.coordinateResidues, 420);
    assert.equal(result.coverage.unmappedResidues, 712);
    assert.equal(result.coverage.intrachainContacts, 958);
    assert.equal(result.coverage.interchainContacts, 0);
    const first = result.contacts.find(contact => contact.query.proteinPosition === 713 && contact.partner.proteinPosition === 795)!;
    assert(first); assert(Math.abs(first.distanceAngstrom - 5.831259040721811) < 1e-9);
    const nearest = Math.min(...result.contacts.map(contact => contact.distanceAngstrom));
    assert(Math.abs(nearest - 3.8222645120399497) < 1e-9);
    const replay = await run({ type: 'replay-experiment', content: reply.recordJson, outputFormat: 'json' });
    assert(replay.type === 'experiment-replayed'); assert.equal(replay.report.verified, true);
    assert.equal(replay.report.resultId, record.resultId); assert.equal(replay.exportText, reply.recordJson);
  });

  it('preserves chain-only and alignment-only missingness and explicit assembly distance settings', async () => {
    const chainReply = await run(request({ contactScope: 'chain' }));
    assert(chainReply.type === 'protein-structure-analyzed');
    const chainResult = proteinStructureResultFromRecord(await parseAnalysisRecord(chainReply.recordJson));
    assert(chainResult.residues.every(row => row.interchainNeighbors === null));
    assert.equal(chainResult.coverage.intrachainContacts, 958);
    const alignmentReply = await run(request({ chainLabelAsymId: null }));
    assert(alignmentReply.type === 'protein-structure-analyzed');
    const alignmentResult = proteinStructureResultFromRecord(await parseAnalysisRecord(alignmentReply.recordJson));
    assert.equal(alignmentResult.chain, null); assert.equal(alignmentResult.coverage.coordinateResidues, 0);
    assert(alignmentResult.residues.every(row => row.coordinate === null && row.intrachainNeighbors === null));
    assert.equal(alignmentResult.coverage.entropyResidues, 1096);
    const wider = await run(request({ contactCutoffAngstrom: 15 }));
    assert(wider.type === 'protein-structure-analyzed');
    const contacts = proteinStructureResultFromRecord(await parseAnalysisRecord(wider.recordJson)).contacts.filter(contact => contact.kind === 'interchain');
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].query.proteinPosition, 1050); assert.equal(contacts[0].partner.proteinPosition, 101);
    assert(Math.abs(contacts[0].distanceAngstrom - 14.8488165858428) < 1e-9);
  });

  it('rejects fabricated scientific output even when its generic record hashes are valid', async () => {
    const { record } = await createProteinStructureExperiment(reference);
    for (const change of [
      (copy: AnalysisRecord) => { (copy.fields.structure.value as unknown as ProteinStructureResult).residues[0].alignment!.entropyBits = 3; },
      (copy: AnalysisRecord) => { (copy.fields.structure.value as unknown as ProteinStructureResult).contacts[0].distanceAngstrom = 99; },
    ]) {
      const fabricated = await rehash(record, change);
      await parseAnalysisRecord(fabricated);
      await assert.rejects(run({ type: 'replay-experiment', content: fabricated, outputFormat: 'json' }), /differs|reproduc/i);
    }
  });

  it('binds accepted worker records to exact input, parameters, method, source and seed', async () => {
    const { record } = await createProteinStructureExperiment(reference);
    const { bundleSha256: _previousHash, ...foreignPayload } = { ...reference, id: reference.id + '-different-source' };
    const foreignReference = { ...foreignPayload, bundleSha256: await proteinReferenceContentHash(foreignPayload) };
    for (const change of [
      (copy: AnalysisRecord) => { copy.inputs[0].data = analysisJson(foreignReference); },
      (copy: AnalysisRecord) => { (copy.parameters as Record<string, unknown>).contactCutoffAngstrom = 7; },
      (copy: AnalysisRecord) => { copy.inputs[0].source = 'local'; },
      (copy: AnalysisRecord) => { copy.inputs[0].accession = 'different-protein'; },
      (copy: AnalysisRecord) => { copy.seed = 9; },
      (copy: AnalysisRecord) => { copy.method.implementation += '-different'; },
    ]) {
      const worker = new ReplyWorker(await rehash(record, change));
      await assert.rejects(runTerminalResearchWorker(request(), new AbortController().signal, undefined,
        () => worker as unknown as TerminalWorker), /differs from the submitted/);
      assert.equal(worker.terminated, 1);
      assert.deepEqual(worker.posted!.options, resolveProteinStructureOptions(reference));
    }
  });

  it('cancels pending source validation before allocation and terminates active workers exactly once', async () => {
    const controller = new AbortController(); let allocations = 0;
    const pending = runTerminalResearchWorker(request(), controller.signal, undefined, () => {
      allocations++; return new ReplyWorker(null) as unknown as TerminalWorker;
    });
    controller.abort(new DOMException('Cancelled during validation', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(allocations, 0);
    const active = new AbortController(), worker = new ReplyWorker(null);
    const running = runTerminalResearchWorker(request(), active.signal, undefined, () => {
      queueMicrotask(() => active.abort(new DOMException('Cancelled during computation', 'AbortError')));
      return worker as unknown as TerminalWorker;
    });
    await assert.rejects(running, { name: 'AbortError' }); assert.equal(worker.terminated, 1);
    worker.emit('message', { type: 'error', message: 'Late old result' });
    assert.equal(worker.terminated, 1);
  });

  it('writes private outputs exclusively, preserves sources and exports full residue/contact tables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phage-protein-cli-'));
    const input = join(directory, 'source reference.json'), output = join(directory, 'new experiment.json');
    await writeFile(input, referenceText);
    const first = await cli(['analyze-protein-structure', '--input', input, '--output', output]);
    assert.equal(first.code, 0, first.error);
    const recordText = await readFile(output, 'utf8'), record = await parseAnalysisRecord(recordText);
    assert.equal(JSON.parse(first.output).resultId, record.resultId);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    for (const protein of reference.proteins) assert(!first.output.includes(protein.sequence));
    const residuePath = join(directory, 'residues.tsv'), contactsPath = join(directory, 'contacts.tsv');
    const replay = await cli(['replay-experiment', '--input', output, '--format', 'tsv', '--output', residuePath]);
    assert.equal(replay.code, 0, replay.error); assert.equal(JSON.parse(replay.output).resultId, record.resultId);
    assert.equal(await readFile(residuePath, 'utf8'), exportProteinStructureTsv(record, 'residues'));
    const contacts = await cli(['analyze-protein-structure', '--input', input, '--format', 'tsv', '--section', 'contacts', '--output', contactsPath]);
    assert.equal(contacts.code, 0, contacts.error);
    assert.equal(await readFile(contactsPath, 'utf8'), exportProteinStructureTsv(record, 'contacts'));
    const existing = await cli(['analyze-protein-structure', '--input', input, '--output', output]);
    assert.equal(existing.code, 1); assert.equal(existing.output, ''); assert.equal(await readFile(output, 'utf8'), recordText);
    const link = join(directory, 'existing-link.json'); await symlink(input, link);
    const linked = await cli(['analyze-protein-structure', '--input', input, '--output', link]);
    assert.equal(linked.code, 1); assert.equal(await readFile(input, 'utf8'), referenceText);
  });

  it('creates neither success output nor a result file after cancellation, timeout or invalid UTF-8', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phage-protein-errors-'));
    const input = join(directory, 'reference.json'), output = join(directory, 'never-created.json');
    await writeFile(input, referenceText);
    const controller = new AbortController(); controller.abort(new DOMException('Cancelled', 'AbortError'));
    const cancelled = await cli(['analyze-protein-structure', '--input', input, '--output', output], { signal: controller.signal });
    assert.equal(cancelled.code, 130); assert.equal(cancelled.output, '');
    await assert.rejects(stat(output), { code: 'ENOENT' });
    const worker = new ReplyWorker(null);
    const timed = await cli(['analyze-protein-structure', '--input', input, '--output', output, '--timeout-ms', '30'],
      { createWorker: () => worker as unknown as TerminalWorker });
    assert.equal(timed.code, 124); assert.equal(timed.output, '');
    await assert.rejects(stat(output), { code: 'ENOENT' });
    const invalid = join(directory, 'invalid-utf8.json'); await writeFile(invalid, Buffer.from([0xff]));
    const bad = await cli(['analyze-protein-structure', '--input', invalid, '--output', output]);
    assert.equal(bad.code, 1); assert.equal(bad.output, '');
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });
});
