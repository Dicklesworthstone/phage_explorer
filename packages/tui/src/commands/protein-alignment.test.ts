import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';
import { runProteinAlignmentCommand, parseProteinAlignmentCommand, type ProteinAlignmentCommandIO } from './protein-alignment';

const fasta = '>target primary\nACD-\n>homolog one\nACE-\n>homolog2\nACD-\n';
function capture() {
  let value = '';
  const stream = new Writable({ write(chunk, _encoding, done) { value += chunk.toString(); done(); } });
  return { stream, value: () => value };
}
function io(input = '') {
  const out = capture(), err = capture();
  return { stdin: Readable.from([Buffer.from(input)]), stdout: out.stream, stderr: err.stream,
    output: out.value, errors: err.value } satisfies ProteinAlignmentCommandIO & { output(): string; errors(): string };
}

describe('protein-alignment command', () => {
  it('parses explicit operations and prevents replay/source relabeling', () => {
    assert.equal(parseProteinAlignmentCommand([]), null);
    assert.equal(parseProteinAlignmentCommand(['--help']), null);
    assert.deepEqual(parseProteinAlignmentCommand(['analyze', '-', '--target', 'target', '--format', 'tsv', '--output', '-']),
      { operation: 'analyze', input: '-', target: 'target', format: 'tsv', output: undefined,
        name: undefined, source: undefined, reference: undefined, demo: false });
    assert.throws(() => parseProteinAlignmentCommand(['replay', 'saved.json', '--target', 'x']));
    assert.throws(() => parseProteinAlignmentCommand(['replay', 'saved.json', '--source', 'changed']));
    assert.throws(() => parseProteinAlignmentCommand(['inspect', 'input.faa', '--format', 'tsv']));
  });

  it('inspects FASTA without computation and preserves explicit attribution', async () => {
    const streams = io(fasta);
    assert.equal(await runProteinAlignmentCommand(['inspect', '-', '--name', 'Private MSA', '--source', 'Lab alignment',
      '--reference', 'Notebook 7'], streams), 0);
    const input = JSON.parse(streams.output());
    assert.equal(input.name, 'Private MSA');
    assert.deepEqual(input.source, { kind: 'local', description: 'Lab alignment', reference: 'Notebook 7' });
    assert.equal(input.rows[0].alignedSequence, 'ACD-');
    assert.equal(streams.errors(), '');
  });

  it('analyzes the selected target and verified replay preserves the exact result identity', async () => {
    const first = io(fasta);
    assert.equal(await runProteinAlignmentCommand(['analyze', '-', '--target', 'target'], first), 0);
    const record = await parseAnalysisRecord(first.output());
    assert.equal(record.method.id, 'supplied-protein-alignment-diversity');
    assert.equal(record.parameters.proteinId, 'target');
    const result = record.fields.diversity.value as any;
    assert.equal(result.residues[0].entropyBits, 0);
    assert.ok(result.residues[2].entropyBits > 0.9);
    const replay = io(first.output());
    assert.equal(await runProteinAlignmentCommand(['replay', '-'], replay), 0);
    assert.equal((await parseAnalysisRecord(replay.output())).resultId, record.resultId);
  });

  it('exports complete residue TSV from analyze and replay', async () => {
    const first = io(fasta);
    assert.equal(await runProteinAlignmentCommand(['analyze', '-', '--target', 'target', '--format', 'tsv'], first), 0);
    assert.match(first.output(), /target_record\tprotein_position_1based/);
    assert.match(first.output(), /target\t3\tD\t3\t3\t3/);
    const json = io(fasta);
    assert.equal(await runProteinAlignmentCommand(['analyze', '-', '--target', 'target'], json), 0);
    const replay = io(json.output());
    assert.equal(await runProteinAlignmentCommand(['replay', '-', '--format', 'tsv'], replay), 0);
    assert.match(replay.output(), /# method=protein-alignment-diversity/);
  });

  it('canonical JSON cannot be silently relabeled and failed work never overwrites an existing output', async () => {
    const inspected = io(fasta);
    assert.equal(await runProteinAlignmentCommand(['inspect', '-'], inspected), 0);
    const relabel = io(inspected.output());
    assert.equal(await runProteinAlignmentCommand(['analyze', '-', '--source', 'different'], relabel), 1);
    assert.match(relabel.errors(), /retains embedded attribution/);

    const dir = await mkdtemp(join(tmpdir(), 'phage-protein-alignment-'));
    const path = join(dir, 'existing.json');
    await writeFile(path, 'keep');
    const fileRun = io(fasta);
    assert.equal(await runProteinAlignmentCommand(['analyze', '-', '--output', path], fileRun), 1);
    assert.equal(await readFile(path, 'utf8'), 'keep');
    assert.equal(fileRun.output(), '');
  });

  it('cancellation returns 130 without publishing output', async () => {
    const controller = new AbortController(); controller.abort();
    const streams = io(fasta);
    assert.equal(await runProteinAlignmentCommand(['analyze', '-'], { ...streams, signal: controller.signal }), 130);
    assert.equal(streams.output(), '');
  });
});
