import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePangenomeCommand, parsePangenomeCommand, pangenomeMain } from '../../../scripts/pangenome';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { replayAlignmentPangenome } from '../../core/src/analysis/alignment-pangenome';
import { reverseComplement } from '../../core/src/codons';

const reference = 'ATGAAATAATTATTCCAT';
const fasta = `>ref\n${reference}\n>query\nATGAAGTAATTATTTCAT\n>unknown\nATGNNNTAATTATTCCAT\n`;
const genbank = `LOCUS       REF 18 bp DNA linear
ACCESSION   REF
FEATURES             Location/Qualifiers
     CDS             1..9
                     /gene="direct"
     CDS             complement(10..18)
                     /gene="reverse"
ORIGIN
        1 ${reference}
//
`;
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'phage-cds-cli-'));
  const input = join(directory, 'genomes.fa'), annotation = join(directory, 'reference.gb');
  await writeFile(input, fasta); await writeFile(annotation, genbank);
  return { directory, input, annotation, output: join(directory, 'annotated.json') };
}
async function run(args: string[]) {
  const command = parsePangenomeCommand(args);
  if (command.type === 'help') throw new Error('Unexpected help');
  return executePangenomeCommand(command);
}
const build = (w: Awaited<ReturnType<typeof workspace>>, extra: string[] = []) =>
  ['build', '--input', w.input, '--reference', 'ref', '--alignment', 'provided', '--output', w.output, ...extra];

describe('pangenome CDS command-line producer and exports', () => {
  it('builds, verifies and exports hand-derived CDS/protein changes through actual files', async () => {
    const w = await workspace();
    const result = await run(build(w, ['--annotation', w.annotation]));
    const coding = result.coding as { available: number; changed: number; unavailable: number };
    assert.deepEqual([coding.available, coding.changed, coding.unavailable], [3, 2, 1]);
    assert(!JSON.stringify(result).includes(reference), 'stdout must not contain genome bases');
    const content = await readFile(w.output, 'utf8');
    const replay = await replayAlignmentPangenome(content);
    assert.equal(replay.record.method.version, '5');
    assert.deepEqual(replay.cds!.consequences.map(row => row.queryProtein), ['MK*', null, 'MK*', 'ME*']);
    const verified = await run(['verify', '--experiment', w.output]);
    assert.equal(verified.resultId, result.resultId); assert.equal(verified.verified, true);
    for (const format of ['consequences-tsv', 'cds-fasta', 'protein-fasta']) {
      const output = join(w.directory, format);
      await run(['export', '--experiment', w.output, '--format', format, '--output', output]);
      const data = await readFile(output, 'utf8');
      if (format === 'protein-fasta') assert.deepEqual(data.trim().split(/\n(?=>)/).map(block => block.split('\n').slice(1).join('')), ['MK*', 'ME*', 'MK*', 'MK*', 'ME*']);
      if (format === 'consequences-tsv') { assert.match(data, /synonymous/); assert.match(data, /amino-acid-change/); assert.match(data, /unavailable/); }
      if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    }
  });
  it('annotates a verified older graph without changing that source, and exposes annotation/CDS selection', async () => {
    const w = await workspace();
    await run(build(w));
    const before = await readFile(w.output, 'utf8');
    assert.equal((await parseAnalysisRecord(before)).method.version, '2');
    const metadata = await run(['inspect-annotations', '--annotation', w.annotation]);
    const records = metadata.records as Array<{ contentId: string; cds: Array<{ id: number }> }>;
    assert.deepEqual(records[0].cds.map(g => g.id), [1, 2]);
    assert(!JSON.stringify(metadata).includes(reference));
    const output = join(w.directory, 'selected.json');
    const result = await run(['annotate', '--experiment', w.output, '--annotation', w.annotation,
      '--annotation-record', records[0].contentId, '--gene-ids', '2', '--output', output]);
    assert.equal((result.coding as { genes: number }).genes, 1);
    assert.equal(await readFile(w.output, 'utf8'), before);
    const fresh = await replayAlignmentPangenome(await readFile(output, 'utf8'));
    assert.deepEqual(fresh.cds!.genes.map(gene => gene.geneId), [2]);
  });
  it('requires explicit disambiguation for identical bases with different annotations', async () => {
    const w = await workspace();
    await writeFile(w.annotation, genbank + genbank.replace('/gene="direct"', '/gene="different"'));
    await assert.rejects(run(build(w, ['--annotation', w.annotation])), /exactly one GenBank/);
    await assert.rejects(stat(w.output), { code: 'ENOENT' });
    const metadata = await run(['inspect-annotations', '--annotation', w.annotation]);
    const records = metadata.records as Array<{ contentId: string }>;
    assert.equal(records.length, 2);
    await run(build(w, ['--annotation', w.annotation, '--annotation-record', records[1].contentId, '--gene-ids', '1']));
    const fresh = await replayAlignmentPangenome(await readFile(w.output, 'utf8'));
    assert.equal(fresh.cds!.genes[0].name, 'different');
  });
  it('rejects mismatched annotations, absent CDS and unannotated coding exports before creating files', async () => {
    const w = await workspace();
    await writeFile(w.annotation, genbank.replace(reference, 'ATGCAATAATTATTCCAT'));
    await assert.rejects(run(build(w, ['--annotation', w.annotation])), /exactly one GenBank/);
    await assert.rejects(stat(w.output), { code: 'ENOENT' });
    await writeFile(w.annotation, genbank);
    await assert.rejects(run(build(w, ['--annotation', w.annotation, '--gene-ids', '999'])), /CDS ID is absent/);
    await run(build(w));
    const out = join(w.directory, 'missing.fa');
    await assert.rejects(run(['export', '--experiment', w.output, '--format', 'protein-fasta', '--output', out]), /no coding consequences/);
    await assert.rejects(stat(out), { code: 'ENOENT' });
  });
  it('never overwrites an existing source/output or follows a destination symlink', async () => {
    const w = await workspace(); await run(build(w, ['--annotation', w.annotation]));
    const before = await readFile(w.output, 'utf8');
    await assert.rejects(run(['annotate', '--experiment', w.output, '--annotation', w.annotation, '--output', w.output]), { code: 'EEXIST' });
    const link = join(w.directory, 'export-link'); await symlink(w.annotation, link);
    await assert.rejects(run(['export', '--experiment', w.output, '--format', 'cds-fasta', '--output', link]), { code: 'EEXIST' });
    assert.equal(await readFile(w.output, 'utf8'), before); assert.equal(await readFile(w.annotation, 'utf8'), genbank);
  });
  it('recomputes coding effects rather than trusting even a rehashed forged report', async () => {
    const w = await workspace(); await run(build(w, ['--annotation', w.annotation]));
    const record = await parseAnalysisRecord(await readFile(w.output, 'utf8'));
    const { format: _format, version: _version, cacheKey: _cacheKey, resultId: _resultId, ...options } = record;
    (options.fields.codingConsequences.value as Array<{ queryProtein: string }>)[0].queryProtein = 'FORGED';
    const forged = await createAnalysisRecord(options);
    const forgedPath = join(w.directory, 'forged.json'); await writeFile(forgedPath, serializeAnalysisRecord(forged));
    await assert.rejects(run(['export', '--experiment', forgedPath, '--format', 'protein-fasta', '--output', join(w.directory, 'bad.fa')]), /Recomputed annotated graph/);
  });
  it('carries normalization into coding analysis while keeping the GenBank in reference coordinates', async () => {
    const w = await workspace();
    const query = reverseComplement(reference.slice(6) + reference.slice(0, 6));
    await writeFile(w.input, `>ref\n${reference}\n>query\n${query}\n`);
    await writeFile(w.annotation, genbank.replace('linear', 'circular'));
    await run(['build', '--input', w.input, '--reference', 'ref', '--alignment', 'wavefront', '--normalization', 'circular',
      '--terminal-gaps', 'alleles', '--annotation', w.annotation, '--output', w.output]);
    const fresh = await replayAlignmentPangenome(await readFile(w.output, 'utf8'));
    assert.equal(fresh.graph.variants.length, 0);
    assert.deepEqual(fresh.cds!.consequences.map(row => row.effects), [['unchanged'], ['unchanged']]);
    assert.deepEqual(fresh.cds!.consequences.map(row => row.queryProtein), ['MK*', 'ME*']);
  });
  it('rejects ambiguous CLI syntax and reports nonzero errors without sequence output', async () => {
    const w = await workspace();
    for (const args of [build(w, ['--gene-ids', '1']), build(w, ['--annotation-record', 'REF']),
      build(w, ['--annotation', w.annotation, '--gene-ids', '1,1']), ['annotate', '--experiment', w.output, '--output', 'x'],
      ['inspect-annotations', '--annotation', w.annotation, '--gene-ids', '1']]) assert.throws(() => parsePangenomeCommand(args));
    let stdout = '', stderr = '';
    const exit = await pangenomeMain(build(w, ['--annotation', w.annotation, '--gene-ids', '999']), value => { stdout += value; }, value => { stderr += value; });
    assert.equal(exit, 1); assert.equal(stdout, ''); assert.match(stderr, /absent/); assert(!stderr.includes(reference));
  });
});
