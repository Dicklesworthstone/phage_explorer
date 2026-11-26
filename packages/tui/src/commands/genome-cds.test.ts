import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import type { GenomeCdsResult } from '../../../core/src/genome-cds-export';
import { parseGenomeCdsCommand, runGenomeCdsCommand, type GenomeCdsCommandIO } from './genome-cds';

const source = `LOCUS       PRIVATE 18 bp DNA circular
ACCESSION   PRIVATE
FEATURES             Location/Qualifiers
     CDS             1..9
                     /locus_tag="duplicate"
     CDS             complement(10..18)
                     /locus_tag="duplicate"
                     /pseudo
ORIGIN
        1 atgaaataattatttcat
//
`;
function capture() {
  let value = '';
  const stream = new Writable({ write(chunk, _encoding, done) { value += chunk.toString(); done(); } });
  return { stream, value: () => value };
}
function io(input = '') {
  const out = capture(), err = capture();
  return { stdin: Readable.from([Buffer.from(input)]), stdout: out.stream, stderr: err.stream,
    output: out.value, errors: err.value } satisfies GenomeCdsCommandIO & { output(): string; errors(): string };
}
const entry = fileURLToPath(new URL('../../../../scripts/genome-cds.ts', import.meta.url));
const shippedEntry = fileURLToPath(new URL('../index.tsx', import.meta.url));
async function native(args: string[], cwd: string, input = '', launcher = entry) {
  const child = Bun.spawn([process.execPath, launcher, ...args], {
    cwd, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe',
  });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output, errors };
}

describe('genome-cds native command', () => {
  it('requires explicit operations, typed selections and immutable replay inputs', () => {
    assert.equal(parseGenomeCdsCommand([]), null);
    assert.equal(parseGenomeCdsCommand(['--help']), null);
    assert.deepEqual(parseGenomeCdsCommand(['export', '-', '--record', 'PRIVATE', '--genes', '2,1', '--format', 'cds-fasta', '--output', '-']), {
      operation: 'export', input: '-', record: 'PRIVATE', geneIds: [2, 1], format: 'cds-fasta', output: undefined,
    });
    for (const args of [
      ['replay', '-', '--record', 'PRIVATE'], ['replay', '-', '--genes', '1'],
      ['inspect', '-', '--genes', '1'], ['inspect', '-', '--format', 'tsv'],
      ['export', '-', '--genes', '1,1'], ['export', '-', '--genes', '1e1'],
      ['export', '-', '--genes', '0'], ['export', '-', '--genes', '1, 2'],
      ['export', '-', '--format', 'unknown'], ['export', '', '--record', 'PRIVATE'],
    ]) assert.throws(() => parseGenomeCdsCommand(args));
  });

  it('inspects record/CDS choices and exports all rows, while sequence FASTA clearly reports omissions', async () => {
    const inspect = io(source);
    assert.equal(await runGenomeCdsCommand(['inspect', '-'], inspect), 0, inspect.errors());
    const record = JSON.parse(inspect.output()).records[0];
    assert.equal(record.accession, 'PRIVATE');
    assert.match(record.contentId, /^[a-f0-9]{64}$/);
    assert.deepEqual(record.cds.map((row: { id: number }) => row.id), [1, 2]);
    const dna = io(source);
    assert.equal(await runGenomeCdsCommand(['export', '-', '--record', record.contentId, '--format', 'cds-fasta'], dna), 0, dna.errors());
    assert.equal(dna.output().split('\n').filter(line => line === 'ATGAAATAA').length, 2);
    const proteins = io(source);
    assert.equal(await runGenomeCdsCommand(['export', '-', '--format', 'protein-fasta'], proteins), 0, proteins.errors());
    assert.match(proteins.output(), /exported=1 omitted=1/);
    assert.match(proteins.output(), /\nMK\*\n$/);
    const table = io(source);
    assert.equal(await runGenomeCdsCommand(['export', '-', '--format', 'tsv'], table), 0, table.errors());
    assert.equal(table.output().trim().split('\n').filter(line => !line.startsWith('#')).length, 3);
    assert.match(table.output(), /Unsupported \/pseudo qualifier/);
  });

  it('replays exact embedded input and refuses forged, rehashed outputs before writing', async () => {
    const first = io(source);
    assert.equal(await runGenomeCdsCommand(['export', '-', '--genes', '1'], first), 0, first.errors());
    const record = await parseAnalysisRecord(first.output());
    assert.deepEqual(record.parameters.geneIds, [1]);
    assert.deepEqual(record.inputs[0].data, { name: 'stdin genome', text: source });
    const replay = io(first.output());
    assert.equal(await runGenomeCdsCommand(['replay', '-'], replay), 0, replay.errors());
    assert.equal((await parseAnalysisRecord(replay.output())).resultId, record.resultId);
    const forged = structuredClone(record);
    (forged.fields.cds.value as unknown as GenomeCdsResult).rows[0].cds = 'AAAAAA';
    const { format: _format, version: _version, cacheKey: _cache, resultId: _result, ...options } = forged;
    const content = serializeAnalysisRecord(await createAnalysisRecord(options));
    const rejected = io(content);
    assert.equal(await runGenomeCdsCommand(['replay', '-', '--format', 'cds-fasta'], rejected), 1);
    assert.equal(rejected.output(), '');
    assert.match(rejected.errors(), /Recomputed genome CDS/);
  });

  it('runs the real native launcher with files/stdin in an empty directory without creating a catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-genome-cds-'));
    const input = join(dir, 'private.gb'), saved = join(dir, 'saved.json'), proteins = join(dir, 'proteins.faa');
    await writeFile(input, source);
    const first = await native(['export', input, '--output', saved], dir);
    assert.equal(first.code, 0, first.errors); assert.equal(first.output, '');
    assert.equal((await stat(saved)).mode & 0o777, 0o600);
    const record = await parseAnalysisRecord(await readFile(saved, 'utf8'));
    assert.equal((record.fields.cds.value as unknown as GenomeCdsResult).summary.proteinsUnavailable, 1);
    const replay = await native(['replay', '-', '--format', 'protein-fasta', '--output', proteins], dir, await readFile(saved, 'utf8'));
    assert.equal(replay.code, 0, replay.errors);
    assert.match(await readFile(proteins, 'utf8'), /\nMK\*\n$/);
    assert.deepEqual((await readdir(dir)).sort(), ['private.gb', 'proteins.faa', 'saved.json']);
    const stdout = await native(['export', '-', '--genes', '2', '--format', 'cds-fasta'], dir, source);
    assert.equal(stdout.code, 0, stdout.errors);
    assert.match(stdout.output, /gene_id=2/); assert.match(stdout.output, /\nATGAAATAA\n$/);
    const overwrite = await native(['export', input, '--output', saved], dir);
    assert.equal(overwrite.code, 1); assert.match(overwrite.errors, /already exists/);
    assert.equal((await parseAnalysisRecord(await readFile(saved, 'utf8'))).resultId, record.resultId);
  });

  it('routes the shipped CLI to database-free CDS export before initializing the catalog or terminal UI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-genome-cds-entry-'));
    const help = await native(['genome-cds', '--help'], dir, '', shippedEntry);
    assert.equal(help.code, 0, help.errors);
    assert.match(help.output, /genome-cds inspect INPUT/);
    const exported = await native(['genome-cds', 'export', '-'], dir, source, shippedEntry);
    assert.equal(exported.code, 0, exported.errors);
    const record = await parseAnalysisRecord(exported.output);
    assert.equal((record.fields.cds.value as unknown as GenomeCdsResult).summary.selectedCds, 2);
    const replayed = await native(['genome-cds', 'replay', '-', '--format', 'protein-fasta'], dir, exported.output, shippedEntry);
    assert.equal(replayed.code, 0, replayed.errors);
    assert.match(replayed.output, /\nMK\*\n$/);
    assert.deepEqual(await readdir(dir), []);
  });

  it('never creates failed or cancelled output, including when no protein sequence is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-genome-cds-errors-'));
    const output = join(dir, 'failed.faa');
    const streams = io(source);
    assert.equal(await runGenomeCdsCommand(['export', '-', '--genes', '2', '--format', 'protein-fasta', '--output', output], streams), 1);
    assert.match(streams.errors(), /No supported protein/); assert.equal(streams.output(), '');
    await assert.rejects(stat(output), { code: 'ENOENT' });
    const controller = new AbortController(); controller.abort();
    const cancelled = io(source);
    assert.equal(await runGenomeCdsCommand(['export', '-', '--output', output], { ...cancelled, signal: controller.signal }), 130);
    await assert.rejects(stat(output), { code: 'ENOENT' });
    const invalidUtf8 = io();
    assert.equal(await runGenomeCdsCommand(['export', '-'], { ...invalidUtf8, stdin: Readable.from([Buffer.from([0xff])]) }), 1);
    assert.equal(invalidUtf8.output(), '');
    const oversized = io(' '.repeat(10 * 1024 * 1024 + 1));
    assert.equal(await runGenomeCdsCommand(['export', '-'], oversized), 1);
    assert.equal(oversized.output(), '');
  });
});
