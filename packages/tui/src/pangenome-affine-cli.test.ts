import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePangenomeCommand, executePangenomeCommand, pangenomeMain } from '../../../scripts/pangenome';
import { replayAlignmentPangenome } from '../../core/src/analysis/alignment-pangenome';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';

const build = ['build', '--input', 'in.fa', '--reference', 'r', '--alignment', 'affine', '--output', 'out.json'];
const run = async (args: string[]) => {
  const command = parsePangenomeCommand(args); assert.notEqual(command.type, 'help');
  return executePangenomeCommand(command as Exclude<typeof command, { type: 'help' }>);
};
describe('affine pangenome CLI', () => {
  it('resolves explicit default/custom penalties and refuses flags on other models', () => {
    const parsed = parsePangenomeCommand(build); assert.equal(parsed.type, 'build');
    if (parsed.type !== 'build') throw new Error('Expected build');
    assert.deepEqual(parsed.options.affinePenalties, { mismatch: 4, gapOpen: 6, gapExtend: 1 });
    const custom = parsePangenomeCommand([...build, '--mismatch', '3', '--gap-open', '0', '--gap-extend', '2', '--normalization', 'strand']);
    assert.equal(custom.type, 'build');
    if (custom.type === 'build') assert.deepEqual(custom.options.affinePenalties, { mismatch: 3, gapOpen: 0, gapExtend: 2 });
    for (const extra of [ ['--mismatch', '0'], ['--gap-extend', '0'], ['--gap-open', '-1'], ['--mismatch', '1.5'],
      ['--gap-open', '65'], ['--gap-extend', 'NaN'], ['--mismatch', '2', '--mismatch', '3'], ['--normalization', 'circular'] ]) {
      assert.throws(() => parsePangenomeCommand([...build, ...extra]));
    }
    for (const alignment of ['provided', 'global', 'wavefront']) assert.throws(() => parsePangenomeCommand(
      build.map(value => value === 'affine' ? alignment : value).concat('--gap-open', '6')), /affine/);
  });
  it('writes, verifies and exports the actual affine graph while keeping source files private and unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-affine-'));
    const input = join(dir, 'input.fa'), output = join(dir, 'graph.json'), original = join(dir, 'original.fa');
    const source = '>r\nATGAAACCCGGGTAA\n>q\nATGAAGCCCCTAGGGTAA\n';
    await writeFile(input, source);
    const summary = await run(['build', '--input', input, '--reference', 'r', '--alignment', 'affine', '--mismatch', '3', '--gap-open', '4', '--gap-extend', '1', '--output', output]);
    const saved = await readFile(output, 'utf8'), experiment = await replayAlignmentPangenome(saved);
    assert.equal(experiment.graph.diagnostics.affine!.pairs[0].score, 10);
    assert.deepEqual(experiment.graph.options.affinePenalties, { mismatch: 3, gapOpen: 4, gapExtend: 1 });
    assert.equal(summary.resultId, experiment.record.resultId); assert(!JSON.stringify(summary).includes('ATGAAACCCGGGTAA'));
    assert.equal((await run(['verify', '--experiment', output])).verified, true);
    await run(['export', '--experiment', output, '--format', 'original-fasta', '--output', original]);
    assert.match(await readFile(original, 'utf8'), /ATGAAGCCCCTAGGGTAA/);
    await assert.rejects(run(['export', '--experiment', output, '--format', 'gfa', '--output', input]), /EEXIST/);
    assert.equal(await readFile(input, 'utf8'), source);
    assert.equal(await readFile(output, 'utf8'), saved);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  });
  it('builds coding consequences with affine costs and reannotates without losing their model identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-affine-cds-'));
    const input = join(dir, 'input.fa'), annotation = join(dir, 'r.gb'), output = join(dir, 'with-cds.json');
    await writeFile(input, '>r\nATGAAACCCGGGTAA\n>q\nATGAAGCCCCTAGGGTAA\n');
    await writeFile(annotation, 'LOCUS       R 15 bp DNA linear\nFEATURES             Location/Qualifiers\n     CDS             1..15\n                     /gene="known"\nORIGIN\n        1 atgaaacccgggtaa\n//\n');
    await run(['build', '--input', input, '--reference', 'r', '--alignment', 'affine', '--annotation', annotation, '--output', output]);
    const annotated = await replayAlignmentPangenome(await readFile(output, 'utf8'));
    assert.equal(annotated.cds!.consequences[0].queryProtein, 'MKPLG*');
    assert(annotated.record.references.some(r => r.id === 'sequence-graph-method' && r.version === '6'));
    const updated = join(dir, 'reannotated.json');
    await run(['annotate', '--experiment', output, '--annotation', annotation, '--output', updated]);
    assert.equal(await readFile(updated, 'utf8'), await readFile(output, 'utf8'));
    const protein = join(dir, 'protein.fa');
    await run(['export', '--experiment', output, '--format', 'protein-fasta', '--output', protein]);
    assert.match(await readFile(protein, 'utf8'), /MKPLG\*/);
  });
  it('rejects rehashed false costs and exhausted work without creating a destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-affine-errors-'));
    const input = join(dir, 'input.fa'), output = join(dir, 'saved.json');
    await writeFile(input, '>r\nACGT\n>q\nAGGT\n');
    await run(['build', '--input', input, '--reference', 'r', '--alignment', 'affine', '--output', output]);
    const saved = JSON.parse(await readFile(output, 'utf8'));
    saved.fields.diagnostics.value.affine.pairs[0].score = 0;
    const forged = join(dir, 'forged.json'), destination = join(dir, 'must-not-exist.fa');
    await writeFile(forged, serializeAnalysisRecord(await createAnalysisRecord(saved)));
    await assert.rejects(run(['export', '--experiment', forged, '--format', 'fasta', '--output', destination]), /differ/);
    await assert.rejects(stat(destination), /ENOENT/);
    const divergent = join(dir, 'divergent.fa');
    await writeFile(divergent, `>r\n${'A'.repeat(4000)}\n>q\n${'C'.repeat(4000)}\n`);
    let stdout = '', stderr = '';
    const code = await pangenomeMain(['build', '--input', divergent, '--reference', 'r', '--alignment', 'affine', '--output', destination],
      value => { stdout += value; }, value => { stderr += value; });
    assert.equal(code, 1); assert.equal(stdout, ''); assert.match(stderr, /budget/);
    await assert.rejects(stat(destination), /ENOENT/);
  });
});
