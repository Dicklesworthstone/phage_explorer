import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { createDotPlotExperiment, exportDotPlotExperimentTsv } from '../../core/src/analysis/dot-plot';
import { createRestrictionDigestRecord, exportRestrictionDigestTsv } from '../../core/src/analysis/restriction-digest';
import { createCompatibilityExperiment, exportCompatibilityPairsTsv, type CompatibilityInput, type CompatibilityResult } from '../../core/src/analysis/alignment-compatibility';
import { createSpacerRecord, searchSpacerReferences, type SpacerGenome, type SpacerLibrary, type ReferenceSpacerHit } from '../../core/src/analysis/spacer-reference';
import { exportAttachmentProductsFasta, replayAttachmentExperiment, replayProphageExcisionRecord,
  type AttachmentReconstructionInput, type ProphageExcisionInput } from '../../core/src/analysis/prophage-excision';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker,
  type TerminalWorker, type WorkflowRuntime } from '../../../scripts/research-workflow';
import { executeTerminalResearchRequest, validateTerminalResearchRequest,
  type TerminalResearchRequest, type TerminalResearchResult } from './research-replay.worker';

const signal = () => new AbortController().signal;
async function fixtures() {
  const dot = (await createDotPlotExperiment({ sequence: 'anNt', accession: 'PRIVATE.1', source: 'local' }, { bins: 2, window: 2 })).record;
  // One circular EcoRI cut wraps the full-length molecule: [1,8) then [0,1).
  const digest = await createRestrictionDigestRecord('GAATTCAA', { enzymes: ['EcoRI'], topology: 'circular' }, { accession: 'CIRCLE.1', source: 'local' });
  return [dot, digest];
}
async function resign(record: AnalysisRecord, change: (copy: AnalysisRecord) => void) {
  const copy = structuredClone(record); change(copy);
  return serializeAnalysisRecord(await createAnalysisRecord({
    method: copy.method, parameters: copy.parameters, seed: copy.seed, references: copy.references, fields: copy.fields,
    inputs: copy.inputs.map(({ sha256: _sha, ...input }) => input),
  }));
}
async function invoke(args: string[], runtime: WorkflowRuntime = {}) {
  let output = '', error = '';
  const code = await researchWorkflowMain(args, value => { output += value; }, value => { error += value; }, runtime, 'phage-explorer workflow');
  return { code, output, error };
}
async function workspace() { return mkdtemp(join(tmpdir(), 'phage-experiment-test-')); }
async function absent(path: string) {
  await assert.rejects(lstat(path), (cause: NodeJS.ErrnoException) => cause.code === 'ENOENT');
}

/** Lifecycle-only transport fixture. Numerical tests below use the real worker. */
class ReplyWorker extends EventEmitter {
  terminations = 0;
  constructor(private readonly reply: (request: TerminalResearchRequest) => unknown) { super(); }
  postMessage(request: TerminalResearchRequest) {
    queueMicrotask(() => this.emit('message', this.reply(request)));
  }
  terminate() { this.terminations++; return Promise.resolve(0); }
}

describe('terminal portable experiment replay', () => {
  it('replays browser alignment-compatibility evidence with exact original-column pairs and retained provenance', async () => {
    const input: CompatibilityInput = {
      format: 'phage-explorer-alignment-compatibility', version: 1, name: 'Independent four-haplotype control',
      source: { kind: 'demo', reference: 'Hand-constructed four-taxon alignment', version: '1', license: 'CC0' },
      alignment: { fasta: '>a\nAAA\n>b\nAAC\n>c\nACA\n>d\nACC\n', homologous: true,
        method: 'Explicit synthetic columns', reference: 'Columns 2 and 3 contain AA, AC, CA and CC once each.' },
    };
    const experiment = await createCompatibilityExperiment(input, { start: 1, end: 3 });
    assert.deepEqual(experiment.result.sites.map(site => site.column), [1, 2]);
    assert.deepEqual(experiment.result.pairs, [[0, 1, 1, 1, 1, 1]]);
    const content = serializeAnalysisRecord(experiment.record);
    const result = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' }, signal());
    assert(result.type === 'experiment-replayed');
    assert.deepEqual(await parseAnalysisRecord(result.exportText!), experiment.record);
    assert.equal(result.report.resultId, experiment.record.resultId);
    assert.equal(result.report.verified, true);
    assert(!JSON.stringify(result.report).includes(input.alignment.fasta));
    const table = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'tsv' }, signal());
    assert(table.type === 'experiment-replayed');
    assert.equal(table.exportText, exportCompatibilityPairsTsv(experiment));
    assert.equal(table.exportText!.trimEnd().split('\n').at(-1), '2\t3\tA\tC\tA\tC\t1\t1\t1\t1\tyes');

    // A fresh checksum does not turn false counts or altered provenance into
    // evidence. Recompute the embedded source before accepting any output.
    for (const change of [
      (r: AnalysisRecord) => { (r.fields.compatibility.value as unknown as CompatibilityResult).pairs[0][2] = 2; },
      (r: AnalysisRecord) => { r.parameters.start = 0; },
      (r: AnalysisRecord) => { (r.inputs[0].data as unknown as CompatibilityInput).alignment.fasta = '>a\nAAA\n>b\nAAA\n>c\nACC\n>d\nACC\n'; },
      (r: AnalysisRecord) => { r.inputs[0].source = 'local'; },
      (r: AnalysisRecord) => { r.method.version = '999'; },
    ]) {
      const altered = await resign(experiment.record, change);
      await parseAnalysisRecord(altered);
      await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content: altered, outputFormat: 'tsv' }, signal()));
    }

    const dir = await workspace(), source = join(dir, 'alignment.json'), output = join(dir, 'pairs.tsv');
    await writeFile(source, content);
    const invoked = await invoke(['replay-experiment', '--input', source, '--output', output, '--format', 'tsv']);
    assert.equal(invoked.code, 0, invoked.error);
    assert.equal(await readFile(output, 'utf8'), exportCompatibilityPairsTsv(experiment));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal((await invoke(['replay-experiment', '--input', source, '--output', output, '--format', 'tsv'])).code, 1);
  });

  it('replays a standalone spacer experiment from embedded sources and exports all wrapped hit coordinates', async () => {
    const genome: SpacerGenome = { name: 'Synthetic circular native control', accession: null, source: 'local',
      topology: 'circular', sequence: 'ACCTAGTGCAAGGTTTTACGATTCGGT' };
    const library: SpacerLibrary = { format: 'phage-explorer-spacer-library', version: 1, name: 'Synthetic native library',
      source: { kind: 'demo', reference: 'Independent 20-base sequence fixture', version: '1', license: 'CC0', scope: 'Synthetic host only' },
      hosts: [{ id: 'host', name: 'Test', strain: 'one', accession: 'synthetic:host' }],
      spacers: [{ id: 'spacer', hostId: 'host', arrayAccession: 'synthetic:array', sequence: 'ACGATTCGGTACCTAGTGCA',
        target: 'DNA', orientation: 'guide-equivalent', system: null, seed: null,
        pam: { side: '3prime', motif: 'NGG', reference: 'Explicit synthetic rule' } }] };
    const record = await createSpacerRecord(genome, library, searchSpacerReferences(genome, library, { hostId: 'host', maxMismatches: 0 }));
    const content = serializeAnalysisRecord(record);
    const replay = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' }, signal());
    assert(replay.type === 'experiment-replayed'); assert.deepEqual(await parseAnalysisRecord(replay.exportText!), record);
    const table = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'tsv' }, signal());
    assert(table.type === 'experiment-replayed');
    const lines = table.exportText!.trimEnd().split('\n'), hit = lines[2].split('\t');
    assert.equal(lines.length, 3); assert.deepEqual(hit.slice(2, 6), ['17', '37', '+', 'true']);
    assert.equal(hit[7], library.spacers[0].sequence); assert.equal(hit[10], 'matched'); assert.equal(hit[11], 'AGG');
    assert.deepEqual(JSON.parse(hit[6]), [{ start: 17, end: 27 }, { start: 0, end: 10 }]);
    assert.equal(JSON.parse(lines[0].slice(2)).status, 'sequence-matches');
    assert(!JSON.stringify(table.report).includes(genome.sequence));

    // All mutations have recomputed valid hashes. Numerical replay must still
    // reject old findings tied to altered inputs, rules, settings or coordinates.
    for (const change of [
      (r: AnalysisRecord) => { (r.fields.matches.value as unknown as ReferenceSpacerHit[])[0].start = 16; },
      (r: AnalysisRecord) => { r.parameters.hostId = 'absent-host'; },
      (r: AnalysisRecord) => { (r.inputs[0].data as unknown as SpacerGenome).sequence = 'C'.repeat(27); },
      (r: AnalysisRecord) => { (r.inputs[1].data as unknown as SpacerLibrary).spacers[0].pam!.motif = 'NAA'; },
      (r: AnalysisRecord) => { r.references[0].version = 'changed'; },
      (r: AnalysisRecord) => { r.method.version = '999'; },
    ]) {
      const altered = await resign(record, change);
      await parseAnalysisRecord(altered);
      await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content: altered, outputFormat: 'tsv' }, signal()));
    }
  });

  it('parses the experiment subcommand without changing tape flags or allowing ambient settings', () => {
    assert.deepEqual(parseWorkflowCommand(['replay-experiment', '--input', 'source.json']), {
      type: 'replay-experiment', input: 'source.json', timeoutMs: 300000, outputFormat: 'json',
    });
    assert.deepEqual(parseWorkflowCommand(['replay-experiment', '--input', 'source.json', '--output', 'matrix.tsv', '--format', 'tsv', '--timeout-ms', '5000']), {
      type: 'replay-experiment', input: 'source.json', output: 'matrix.tsv', outputFormat: 'tsv', timeoutMs: 5000,
    });
    assert.deepEqual(parseWorkflowCommand(['replay', '--input', 'tape.json', '--repetitions', '2', '--progress']), {
      type: 'replay', input: 'tape.json', timeoutMs: 300000, repetitions: 2, progress: true,
    });
    for (const rest of [['--format', 'tsv'], ['--repetitions', '2'], ['--progress'], ['--format', 'csv', '--output', 'x'],
      ['--timeout-ms', '0'], ['--timeout-ms', 'Infinity'], ['--output', 'x', '--output', 'y'], ['--window', '2']]) {
      assert.throws(() => parseWorkflowCommand(['replay-experiment', '--input', 'x', ...rest]));
    }
    assert.throws(() => parseWorkflowCommand(['inspect', '--input', 'x', '--format', 'tsv']));
    assert.throws(() => parseWorkflowCommand(['replay', '--input', 'x', '--format', 'tsv']));
  });

  it('requires exact request fields, bounded UTF-8 and an explicit supported output format', () => {
    const request = { type: 'replay-experiment', content: '{}', outputFormat: 'none' };
    validateTerminalResearchRequest(request);
    for (const value of [{ ...request, outputFormat: 'csv' }, { ...request, filename: '/private/file' },
      { ...request, content: 0 }, { ...request, content: 'α'.repeat(5 * 1024 * 1024 + 1) },
      { type: 'replay-experiment', content: '{}' }, { ...request, repetitions: 1 }]) {
      assert.throws(() => validateTerminalResearchRequest(value));
    }
    validateTerminalResearchRequest({ type: 'inspect', content: '{}' });
    validateTerminalResearchRequest({ type: 'replay', content: '{}', repetitions: 1, exportAnalysis: false });
  });

  it('recomputes browser-exported dot plot and circular digest through actual native workers', async () => {
    for (const record of await fixtures()) {
      const content = serializeAnalysisRecord(record);
      const result = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' }, signal());
      assert.equal(result.type, 'experiment-replayed');
      if (result.type !== 'experiment-replayed') throw new Error('Expected experiment replay');
      assert.equal(result.report.verified, true);
      assert.equal(result.report.headless, true);
      assert.equal(result.report.inputRecordSha256, createHash('sha256').update(content).digest('hex'));
      assert.equal(result.report.resultId, record.resultId);
      assert.equal(result.report.cacheKey, record.cacheKey);
      assert.deepEqual(result.report.method, record.method);
      assert.deepEqual(await parseAnalysisRecord(result.exportText!), record);
      const fresh = JSON.parse(result.exportText!) as AnalysisRecord;
      if (record.method.id === 'sequence-dot-plot') {
        assert.deepEqual(fresh.fields.direct.value, [0.5, 0, 0, 0.5]);
        assert.deepEqual(fresh.fields.inverted.value, [0, 0.5, 0.5, 0]);
      } else {
        assert.deepEqual(fresh.fields.cutSites.value, [1]);
        assert.deepEqual(fresh.fields.fragments.value, [{ start: 1, end: 1, length: 8, wrapsOrigin: true }]);
      }
      assert.equal(JSON.stringify(result.report).includes(String(record.inputs[0].data)), false);
    }
  });

  it('exports the same TSV as the browser and omits unrequested output', async () => {
    for (const record of await fixtures()) {
      const content = serializeAnalysisRecord(record);
      const table = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'tsv' }, signal());
      assert.equal(table.type, 'experiment-replayed');
      if (table.type !== 'experiment-replayed') throw new Error('Expected experiment');
      assert.equal(table.exportText, record.method.id === 'sequence-dot-plot' ? exportDotPlotExperimentTsv(record) : exportRestrictionDigestTsv(record));
      assert.equal(table.exportText!.includes(String(record.inputs[0].data)), false);
      const check = await executeTerminalResearchRequest({ type: 'replay-experiment', content, outputFormat: 'none' });
      assert.equal(check.type, 'experiment-replayed');
      if (check.type === 'experiment-replayed') assert.equal(check.exportText, null);
    }
  });

  it('refuses rehashed false scores and cut products rather than trusting valid checksums', async () => {
    for (const record of await fixtures()) {
      const content = await resign(record, copy => {
        if (copy.method.id === 'sequence-dot-plot') copy.fields.inverted.value = [0, 0, 0, 0];
        else copy.fields.cutSites.value = [2];
      });
      await parseAnalysisRecord(content); // This deliberately passes the hash boundary.
      await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' }, signal()), /Recomputed/);
    }
  });

  it('refuses unsupported method versions, changed references and changed source identity', async () => {
    const [record] = await fixtures();
    for (const change of [
      (r: AnalysisRecord) => { r.method.id = 'arbitrary-code'; },
      (r: AnalysisRecord) => { r.method.version = '999'; },
      (r: AnalysisRecord) => { r.references[0].version = 'changed'; },
      (r: AnalysisRecord) => { r.inputs[0].data = 'AAAA'; },
    ]) await assert.rejects(executeTerminalResearchRequest({ type: 'replay-experiment', content: await resign(record, change), outputFormat: 'none' }));
  });

  it('creates private JSON/TSV files exclusively, reports metadata, and never overwrites an input or output', async () => {
    const dir = await workspace(), [record] = await fixtures(), content = serializeAnalysisRecord(record);
    const input = join(dir, 'input.json'), output = join(dir, 'fresh.json'), tsv = join(dir, 'fresh.tsv');
    await writeFile(input, content);
    const replay = await invoke(['replay-experiment', '--input', input, '--output', output]);
    assert.equal(replay.code, 0, replay.error);
    assert.equal(replay.error, '');
    assert.equal(JSON.parse(replay.output).resultId, record.resultId);
    assert.deepEqual(await parseAnalysisRecord(await readFile(output, 'utf8')), record);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    const table = await invoke(['replay-experiment', '--input', input, '--output', tsv, '--format', 'tsv']);
    assert.equal(table.code, 0, table.error);
    assert.equal(await readFile(tsv, 'utf8'), exportDotPlotExperimentTsv(record));
    for (const existing of [input, output, tsv]) {
      const before = await readFile(existing, 'utf8');
      const fail = await invoke(['replay-experiment', '--input', input, '--output', existing]);
      assert.equal(fail.code, 1); assert.equal(fail.output, '');
      assert.equal(await readFile(existing, 'utf8'), before);
    }
  });

  // Windows symlink creation requires an OS privilege absent from normal installs.
  if (process.platform !== 'win32') it('does not create a dangling output symlink target', async () => {
    const dir = await workspace(), [record] = await fixtures();
    const input = join(dir, 'input.json'), link = join(dir, 'output.json'), target = join(dir, 'must-not-exist.json');
    await writeFile(input, serializeAnalysisRecord(record));
    await symlink(target, link, 'file');
    const result = await invoke(['replay-experiment', '--input', input, '--output', link]);
    assert.equal(result.code, 1); assert.equal(result.output, '');
    assert.equal((await lstat(link)).isSymbolicLink(), true); await absent(target);
  });

  it('returns failure with no success report or output file on malformed bytes or false numerical evidence', async () => {
    const dir = await workspace(), [record] = await fixtures();
    const invalid = [Buffer.from([0xff, 0xfe]), Buffer.from('{'),
      Buffer.from(await resign(record, copy => { copy.fields.direct.value = [1, 1, 1, 1]; })),
      Buffer.from(' '.repeat(10 * 1024 * 1024 + 1))];
    for (let i = 0; i < invalid.length; i++) {
      const input = join(dir, `bad-${i}.json`), output = join(dir, `output-${i}.json`);
      await writeFile(input, invalid[i]);
      const result = await invoke(['replay-experiment', '--input', input, '--output', output]);
      assert.equal(result.code, 1); assert.equal(result.output, ''); assert(result.error.length > 0); await absent(output);
    }
    assert.equal((await invoke(['replay-experiment', '--input', dir])).code, 1);
  });

  it('rejects responses for a different file, method, source or export contract and terminates the worker', async () => {
    const [record] = await fixtures(), content = serializeAnalysisRecord(record);
    const valid = await executeTerminalResearchRequest({ type: 'replay-experiment', content, outputFormat: 'none' });
    if (valid.type !== 'experiment-replayed') throw new Error('Expected experiment');
    for (const change of [
      (r: typeof valid) => { r.report.inputRecordSha256 = '0'.repeat(64); },
      (r: typeof valid) => { r.report.resultId = '0'.repeat(64); },
      (r: typeof valid) => { r.report.method.version = 'changed'; },
      (r: typeof valid) => { r.report.inputs[0].sha256 = '0'.repeat(64); },
      (r: typeof valid) => { r.exportText = 'unexpected'; },
    ]) {
      const changed: Extract<TerminalResearchResult, { type: 'experiment-replayed' }> = structuredClone(valid); change(changed);
      const worker: ReplyWorker = new ReplyWorker(() => changed);
      await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'none' }, signal(), undefined,
        () => worker as unknown as TerminalWorker), /Unexpected/);
      assert.equal(worker.terminations, 1);
    }
  });

  it('kills unresponsive CPU workers on timeout or explicit cancellation without writing output', async () => {
    const dir = await workspace(), [record] = await fixtures(), input = join(dir, 'input.json');
    await writeFile(input, serializeAnalysisRecord(record));
    for (const cancel of [false, true]) {
      const controller = new AbortController(), output = join(dir, cancel ? 'cancelled.json' : 'timed-out.json');
      let exited: Promise<number> | undefined;
      const result = await invoke(['replay-experiment', '--input', input, '--output', output, '--timeout-ms', cancel ? '30000' : '1000'], {
        signal: controller.signal,
        createWorker() {
          // Lifecycle probe: synchronous CPU work cannot process a cancel message.
          const worker = new Worker('for (;;) {}', { eval: true });
          exited = new Promise(resolve => worker.once('exit', resolve));
          if (cancel) worker.once('online', () => controller.abort(new DOMException('Stop', 'AbortError')));
          return worker;
        },
      });
      assert.equal(result.code, cancel ? 130 : 124, result.error);
      assert.equal(result.output, ''); await absent(output);
      assert(exited, 'the worker was actually created'); await exited;
    }
  });

  it('rejects pre-cancelled work before starting any worker', async () => {
    const [record] = await fixtures();
    const controller = new AbortController(); controller.abort(new DOMException('Cancelled', 'AbortError'));
    let created = 0;
    await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content: serializeAnalysisRecord(record), outputFormat: 'none' }, controller.signal,
      undefined, () => { created++; throw new Error('Must not create'); }), { name: 'AbortError' });
    assert.equal(created, 0);
  });

  it('keeps the legacy command-tape inspection response boundary intact', async () => {
    const content = JSON.stringify({ format: 'phage-explorer-commands', version: 1, name: 'Existing tape', context: { bundle: '{}' }, commands: [] });
    const inspection: TerminalResearchResult = { type: 'inspection', inspection: {
      format: 'phage-explorer-workflow-inspection', version: 1, name: 'Existing tape', canReplay: false,
      tapeSha256: createHash('sha256').update(content).digest('hex'), steps: [], genomes: [],
    } };
    const worker = new ReplyWorker(() => inspection);
    assert.deepEqual(await runTerminalResearchWorker({ type: 'inspect', content }, signal(), undefined, () => worker as unknown as TerminalWorker), inspection);
    assert.equal(worker.terminations, 1);
  });

  it('documents the integrated native invocation and embedded-source limitation in help', async () => {
    const help = await invoke(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.output, /phage-explorer workflow replay-experiment/);
    assert.match(help.output, /not source authentication or biological validation/);
    assert.match(help.output, /Recorded spacer comparisons use actionId overlay\.crispr/);
    assert.match(help.output, /spacer hits include protospacer\/PAM bases/);
    assert.equal(help.error, '');
  });
});

function attachmentInputs(): { integration: AttachmentReconstructionInput; excision: ProphageExcisionInput } {
  const source = { kind: 'local' as const, reference: 'Private source declaration sentinel; synthetic arithmetic control', version: '1', license: null };
  return {
    integration: { format: 'phage-explorer-attachment-reconstruction', version: 1,
      host: { name: 'Independent host control', accession: null, sequence: 'TTACGG', topology: 'linear', source },
      phage: { name: 'Independent phage control', accession: null, sequence: 'CCACAA', topology: 'circular', source },
      attB: { start: 2, end: 4, strand: '+', evidence: 'Declared synthetic AC core' },
      attP: { start: 2, end: 4, strand: '+', evidence: 'Declared synthetic AC core' }, circularization: 'already-circular' },
    excision: { format: 'phage-explorer-prophage-excision', version: 1,
      locus: { name: 'Independent integrated control', accession: null, sequence: 'CCGACGTTGATTAA', topology: 'linear', source },
      attL: { start: 2, end: 4, strand: '+', evidence: 'Declared synthetic GA core' },
      attR: { start: 8, end: 10, strand: '+', evidence: 'Declared synthetic GA core' } },
  };
}
function fastaProducts(text: string): string[] {
  return text.trimEnd().split(/^>/m).filter(Boolean).map(record => record.split('\n').slice(1).join(''));
}

describe('native fresh attachment and excision authoring', () => {
  it('exposes explicit synthetic source templates and strictly validates command options', async () => {
    for (const kind of ['attachment', 'excision'] as const) {
      const result = await invoke([`${kind}-template`]);
      assert.equal(result.code, 0, result.error); assert.match(result.output, /SYNTHETIC/);
      const computed = await executeTerminalResearchRequest({ type: `analyze-${kind}`, content: result.output, options: { flankLength: 2 } });
      assert.equal(computed.type, 'attachment-analyzed');
      assert.deepEqual(parseWorkflowCommand([`analyze-${kind}`, '--input', 'sources.json', '--flank', '0']), {
        type: `analyze-${kind}`, input: 'sources.json', timeoutMs: 300000, options: { flankLength: 0 }, outputFormat: 'json',
      });
      for (const flags of [['--flank', '-1'], ['--flank', '1001'], ['--flank', '1.5'], ['--flank', 'NaN'],
        ['--flank', '2', '--flank', '3'], ['--format', 'fasta'], ['--output', 'x', '--format', 'tsv'], ['--topology', 'linear']]) {
        assert.throws(() => parseWorkflowCommand([`analyze-${kind}`, '--input', 'x', ...flags]));
      }
    }
    const help = await invoke(['--help']);
    assert.match(help.output, /phage-explorer workflow analyze-attachment/);
    assert.match(help.output, /phage-explorer workflow analyze-excision/);
    assert.match(help.output, /zero-based/);
  });

  it('authors exact independent products, preserves their maps and source declarations, and replays both export formats', async () => {
    const { integration, excision } = attachmentInputs(), dir = await workspace();
    for (const [kind, input, expected] of [
      ['attachment', integration, ['TTACAACCACGG']], ['excision', excision, ['GACGTT', 'CCGATTAA']],
    ] as const) {
      const path = join(dir, kind + '-sources.json'), output = join(dir, kind + '-record.json');
      const verified = join(dir, kind + '-verified.json'), fasta = join(dir, kind + '.fasta'), replayFasta = join(dir, kind + '-verified.fasta');
      const content = JSON.stringify(input); await writeFile(path, content);
      const result = await invoke([`analyze-${kind}`, '--input', path, '--flank', '2', '--output', output]);
      assert.equal(result.code, 0, result.error);
      const report = JSON.parse(result.output), record = await parseAnalysisRecord(await readFile(output, 'utf8'));
      assert.equal(report.headless, true); assert.equal(report.verified, undefined);
      assert.equal(report.inputFileSha256, createHash('sha256').update(content).digest('hex'));
      assert.equal(report.resultId, record.resultId); assert.equal(report.summary.conservation.conserved, true);
      assert.deepEqual(report.summary.products.map((p: { bases: number; sha256: string }) => [p.bases, p.sha256]),
        expected.map(sequence => [sequence.length, createHash('sha256').update(sequence).digest('hex')]));
      assert(!result.output.includes('Private source declaration sentinel'));
      for (const sequence of [...expected, integration.host.sequence, excision.locus.sequence]) assert(!result.output.includes(sequence));
      if (kind === 'attachment') {
        const replay = await replayAttachmentExperiment(await readFile(output, 'utf8'));
        assert.deepEqual(replay.input, input); assert.equal(replay.result.integratedSequence, expected[0]);
        assert.deepEqual(replay.result.segments, [
          { source: 'host', sourceStart: 0, sourceEnd: 2, strand: '+', productStart: 0, productEnd: 2 },
          { source: 'phage', sourceStart: 2, sourceEnd: 6, strand: '+', productStart: 2, productEnd: 6 },
          { source: 'phage', sourceStart: 0, sourceEnd: 2, strand: '+', productStart: 6, productEnd: 8 },
          { source: 'host', sourceStart: 2, sourceEnd: 6, strand: '+', productStart: 8, productEnd: 12 },
        ]);
      } else {
        const replay = await replayProphageExcisionRecord(await readFile(output, 'utf8'));
        assert.deepEqual(replay.input, input);
        assert.deepEqual([replay.result.excisedPhage.sequence, replay.result.restoredHost.sequence], expected);
        assert.deepEqual(replay.result.sourceCuts, { start: 2, end: 8, wrapsOrigin: false });
      }
      for (const args of [
        ['replay-experiment', '--input', output, '--output', verified],
        [`analyze-${kind}`, '--input', path, '--flank', '2', '--output', fasta, '--format', 'fasta'],
        ['replay-experiment', '--input', output, '--output', replayFasta, '--format', 'fasta'],
      ]) { const checked = await invoke(args); assert.equal(checked.code, 0, checked.error); }
      assert.equal(await readFile(output, 'utf8'), await readFile(verified, 'utf8'));
      const productText = await readFile(fasta, 'utf8');
      assert.equal(productText, await readFile(replayFasta, 'utf8'));
      assert.deepEqual(fastaProducts(productText), expected);
      assert.match(productText, /conditional_reconstruction=true/); assert(productText.includes(record.resultId));
      if (kind === 'excision') { assert.match(productText, />excised_phage topology=circular/); assert.match(productText, />restored_host topology=linear/); }
      if (process.platform !== 'win32') {
        assert.equal((await stat(output)).mode & 0o777, 0o600); assert.equal((await stat(fasta)).mode & 0o777, 0o600);
      }
      const failure = await invoke([`analyze-${kind}`, '--input', path, '--output', output]);
      assert.equal(failure.code, 1); assert.equal(failure.output, ''); assert.equal(await readFile(output, 'utf8'), await readFile(verified, 'utf8'));
    }
  });

  it('preserves reverse insertion and circular origin-crossing product coordinates through actual workers', async () => {
    const { integration, excision } = attachmentInputs();
    integration.phage.sequence = 'CCGTAA'; integration.attP.strand = '-';
    const reverse = await runTerminalResearchWorker({ type: 'analyze-attachment', content: JSON.stringify(integration), options: { flankLength: 0 } }, signal());
    assert(reverse.type === 'attachment-analyzed');
    const integrationRecord = await parseAnalysisRecord(reverse.recordJson);
    assert.deepEqual(fastaProducts(exportAttachmentProductsFasta(integrationRecord)), ['TTACGGTTACGG']);
    assert.equal((integrationRecord.fields.reconstruction.value as { insertionStrand: string }).insertionStrand, '-');
    excision.locus.sequence = 'TTGATTAACCGACG'; excision.locus.topology = 'circular';
    excision.attL.start = 10; excision.attL.end = 12; excision.attR.start = 2; excision.attR.end = 4;
    const circular = await runTerminalResearchWorker({ type: 'analyze-excision', content: JSON.stringify(excision), options: { flankLength: 2 } }, signal());
    assert(circular.type === 'attachment-analyzed');
    const parsed = await replayProphageExcisionRecord(circular.recordJson);
    assert.deepEqual([parsed.result.excisedPhage.sequence, parsed.result.restoredHost.sequence], ['GACGTT', 'GATTAACC']);
    assert.deepEqual(parsed.result.sourceCuts, { start: 10, end: 2, wrapsOrigin: true });
    assert.deepEqual(parsed.result.excisedPhage.segments, [
      { sourceStart: 10, sourceEnd: 14, strand: '+', productStart: 0, productEnd: 4 },
      { sourceStart: 0, sourceEnd: 2, strand: '+', productStart: 4, productEnd: 6 },
    ]);
    assert.equal(parsed.result.restoredHost.sourceOrigin, 2);
    const fasta = exportAttachmentProductsFasta(parsed.record);
    assert.match(fasta, />restored_host topology=circular.*source_origin_start0=2/);
  });

  it('rejects invalid, oversized, mismatched or ambiguous declarations before allocating a worker or creating outputs', async () => {
    const { integration, excision } = attachmentInputs();
    const invalid = [
      JSON.stringify({ ...integration, host: { ...integration.host, sequence: 'TTANGG' } }),
      JSON.stringify({ ...integration, phage: { ...integration.phage, sequence: 'CCGTAA' } }),
      JSON.stringify({ ...integration, host: { ...integration.host, topology: 'unknown' } }),
      JSON.stringify({ ...integration, phage: { ...integration.phage, topology: 'linear' } }),
      JSON.stringify({ ...integration, attB: { ...integration.attB, start: -1 } }),
      JSON.stringify({ ...integration, filename: '/private/genome.fa' }), JSON.stringify(excision),
      '{"private raw content":', ' '.repeat(4 * 1024 * 1024 + 1),
    ];
    for (const content of invalid) {
      let created = false;
      await assert.rejects(runTerminalResearchWorker({ type: 'analyze-attachment', content, options: { flankLength: 2 } }, signal(), undefined,
        () => { created = true; throw new Error('Unexpected allocation'); }));
      assert.equal(created, false);
    }
    for (const bad of [
      { ...excision, attR: { ...excision.attR, strand: '-' } },
      { ...excision, attR: { ...excision.attR, start: 2, end: 4 } },
    ]) await assert.rejects(executeTerminalResearchRequest({ type: 'analyze-excision', content: JSON.stringify(bad), options: { flankLength: 2 } }));
    for (const options of [{}, { flankLength: 2, invented: true }, { flankLength: Infinity }, { flankLength: -1 }]) {
      assert.throws(() => validateTerminalResearchRequest({ type: 'analyze-attachment', content: '{}', options }));
    }
    const dir = await workspace(), input = join(dir, 'bad.json'), output = join(dir, 'must-not-exist.json');
    await writeFile(input, invalid[0]);
    const result = await invoke(['analyze-attachment', '--input', input, '--output', output]);
    assert.equal(result.code, 1); assert.equal(result.output, ''); await absent(output);
  });

  it('binds worker replies to exact original source metadata, sites, settings and operation', async () => {
    const request = { type: 'analyze-attachment' as const, content: JSON.stringify(attachmentInputs().integration), options: { flankLength: 2 } };
    const actual = await executeTerminalResearchRequest(request); assert(actual.type === 'attachment-analyzed');
    const record = await parseAnalysisRecord(actual.recordJson);
    for (const change of [
      (copy: AnalysisRecord) => { (copy.inputs[0].data as { name: string }).name = 'A different captured source'; },
      (copy: AnalysisRecord) => { (copy.inputs[2].data as { attB: { evidence: string } }).attB.evidence = 'Different supplied evidence'; },
      (copy: AnalysisRecord) => { copy.parameters = { flankLength: 3 }; },
      (copy: AnalysisRecord) => { copy.method.version = '999'; },
    ]) {
      const recordJson = await resign(record, change);
      const changed: ReplyWorker = new ReplyWorker((): TerminalResearchResult => ({ ...actual, recordJson }));
      await assert.rejects(runTerminalResearchWorker(request, signal(), undefined, () => changed as unknown as TerminalWorker), /differs/);
      assert.equal(changed.terminations, 1);
    }
    for (const reply of [{ ...actual, inputFileSha256: '0'.repeat(64) }, { ...actual, requestSha256: '0'.repeat(64) }]) {
      const worker = new ReplyWorker(() => reply);
      await assert.rejects(runTerminalResearchWorker(request, signal(), undefined, () => worker as unknown as TerminalWorker), /Unexpected/);
    }
  });

  it('fails forged numerical replay and refuses FASTA for methods without reconstructed products', async () => {
    const result = await executeTerminalResearchRequest({ type: 'analyze-attachment', content: JSON.stringify(attachmentInputs().integration), options: { flankLength: 2 } });
    assert(result.type === 'attachment-analyzed');
    const record = await parseAnalysisRecord(result.recordJson);
    const forged = await resign(record, copy => { (copy.fields.reconstruction.value as { integratedSequence: string }).integratedSequence = 'A'.repeat(12); });
    await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content: forged, outputFormat: 'fasta' }, signal()), /differs/);
    const [dot] = await fixtures();
    await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content: serializeAnalysisRecord(dot), outputFormat: 'fasta' }, signal()), /FASTA.*only/);
  });

  it('rejects substituted FASTA even when the worker reports the correct verified experiment', async () => {
    const { integration, excision } = attachmentInputs();
    const requests: TerminalResearchRequest[] = [
      { type: 'analyze-attachment', content: JSON.stringify(integration), options: { flankLength: 2 } },
      { type: 'analyze-excision', content: JSON.stringify(excision), options: { flankLength: 2 } },
    ];
    const dir = await workspace();
    for (const request of requests) {
      const fresh = await executeTerminalResearchRequest(request); assert(fresh.type === 'attachment-analyzed');
      const verified = await executeTerminalResearchRequest({ type: 'replay-experiment', content: fresh.recordJson, outputFormat: 'fasta' });
      assert(verified.type === 'experiment-replayed');
      const input = join(dir, request.type + '.json'), output = join(dir, request.type + '.fasta');
      await writeFile(input, fresh.recordJson);
      const worker: ReplyWorker = new ReplyWorker((): TerminalResearchResult => ({ ...verified, exportText: '>wrong\nAAAA\n' }));
      const result = await invoke(['replay-experiment', '--input', input, '--output', output, '--format', 'fasta'], {
        createWorker: () => worker as unknown as TerminalWorker,
      });
      assert.equal(result.code, 1); assert.equal(result.output, '');
      assert.match(result.error, /FASTA output differs/); assert.equal(worker.terminations, 1);
      await absent(output);
    }
  });

  it('cancels an allocated native reconstruction worker without publishing a result and can run again', async () => {
    const dir = await workspace(), input = join(dir, 'sources.json'), output = join(dir, 'cancelled.json');
    await writeFile(input, JSON.stringify(attachmentInputs().integration));
    const controller = new AbortController(); let exited: Promise<number> | null = null;
    const result = await invoke(['analyze-attachment', '--input', input, '--output', output], {
      signal: controller.signal, createWorker: () => {
        const worker = new Worker(new URL('./research-replay.worker.ts', import.meta.url));
        exited = new Promise(resolve => worker.once('exit', resolve));
        const post = worker.postMessage.bind(worker);
        worker.postMessage = message => { post(message); controller.abort(new DOMException('Stop reconstruction', 'AbortError')); };
        return worker;
      },
    });
    assert.equal(result.code, 130); assert.equal(result.output, ''); await absent(output); assert(exited); await exited;
    const successful = await invoke(['analyze-attachment', '--input', input]);
    assert.equal(successful.code, 0, successful.error);
  });
});
