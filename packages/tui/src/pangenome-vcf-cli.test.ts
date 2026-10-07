import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePangenomeCommand, parsePangenomeCommand, pangenomeMain } from '../../../scripts/pangenome';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { buildAlignmentPangenome, createAlignmentPangenomeRecord, createAnnotatedAlignmentPangenome,
  parsePangenomeInput } from '../../core/src/analysis/alignment-pangenome';

const rows = (text: string) => text.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
async function fixture(fasta = '>ref\nACGT\n>a\nATGT\n>b\nAGGT\n>unknown\nANGT\n') {
  const dir = await mkdtemp(join(tmpdir(), 'phage-vcf-'));
  const input = parsePangenomeInput(fasta), graph = buildAlignmentPangenome(input, { referenceId: 'ref', alignment: 'provided', terminalGaps: 'alleles' });
  const record = await createAlignmentPangenomeRecord(input, graph), file = join(dir, 'analysis.json');
  await writeFile(file, serializeAnalysisRecord(record));
  return { dir, file, record, graph };
}
describe('verified VCF terminal exports', () => {
  it('recognizes both formats through the existing CLI and executable help convention', async () => {
    for (const format of ['vcf', 'reference-fasta']) assert.deepEqual(parsePangenomeCommand([
      'export', '--experiment', 'saved.json', '--format', format, '--output', 'new.file',
    ]), { type: 'export', experimentPath: 'saved.json', format, outputPath: 'new.file' });
    let help = '';
    assert.equal(await pangenomeMain(['--help'], text => { help += text; }, () => assert.fail('unexpected error'), 'phage-explorer pangenome'), 0);
    assert(help.includes('reference-fasta|vcf')); assert(help.includes('phage-explorer pangenome export'));
    assert.throws(() => parsePangenomeCommand(['export', '--experiment', 'x', '--format', 'gvcf', '--output', 'y']), /--format/);
  });
  it('freshly verifies multiallelic evidence before creating matched VCF and reference files', async () => {
    const f = await fixture(), vcf = join(f.dir, 'variants.vcf'), fasta = join(f.dir, 'reference.fa');
    const summary = await executePangenomeCommand({ type: 'export', experimentPath: f.file, outputPath: vcf, format: 'vcf' });
    assert.equal(summary.verified, true); assert.equal(summary.resultId, f.record.resultId); assert.equal(summary.exportedFormat, 'vcf');
    assert(!JSON.stringify(summary).includes('ATGT'));
    const content = await readFile(vcf, 'utf8');
    assert(content.includes('##phage_explorer_result=' + f.record.resultId));
    assert.deepEqual(rows(content), [['reference', '2', '.', 'C', 'G,T', '.', '.', 'AC=1,1;AN=2', 'GT', '2', '1', '.']]);
    await executePangenomeCommand({ type: 'export', experimentPath: f.file, outputPath: fasta, format: 'reference-fasta' });
    assert.equal(await readFile(fasta, 'utf8'), '>reference original_id_uri=ref\nACGT\n');
    if (process.platform !== 'win32') assert.equal((await stat(vcf)).mode & 0o777, 0o600);
    assert.equal(await readFile(f.file, 'utf8'), serializeAnalysisRecord(f.record));
  });
  it('rejects a rehashed forged graph before opening any output path', async () => {
    const f = await fixture(), destination = join(f.dir, 'forged.vcf');
    const { format: _f, version: _v, cacheKey: _c, resultId: _r, ...data } = structuredClone(f.record);
    // Shape-valid and rehashed, but not the numerical evidence from the inputs.
    const key = Object.keys(data.fields).find(key => Array.isArray(data.fields[key].value))!;
    data.fields[key].value = [];
    await writeFile(f.file, serializeAnalysisRecord(await createAnalysisRecord(data)));
    await assert.rejects(executePangenomeCommand({ type: 'export', experimentPath: f.file, outputPath: destination, format: 'vcf' }), /Recomputed/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  });
  it('never overwrites existing files or symlinks', async () => {
    const f = await fixture(), destination = join(f.dir, 'keep.vcf');
    await writeFile(destination, 'retained');
    const command = { type: 'export', experimentPath: f.file, outputPath: destination, format: 'vcf' } as const;
    await assert.rejects(executePangenomeCommand(command), { code: 'EEXIST' });
    assert.equal(await readFile(destination, 'utf8'), 'retained');
    if (process.platform !== 'win32') {
      const link = join(f.dir, 'link.vcf'); await symlink(destination, link);
      await assert.rejects(executePangenomeCommand({ ...command, outputPath: link }), { code: 'EEXIST' });
      assert.equal(await readFile(destination, 'utf8'), 'retained');
    }
  });
  it('exposes unsupported unresolved padding as failure without an empty or partial destination', async () => {
    const f = await fixture('>ref\nAN-GT\n>a\nANAGT\n'), destination = join(f.dir, 'unresolved.vcf');
    let output = '', error = '';
    const code = await pangenomeMain(['export', '--experiment', f.file, '--format', 'vcf', '--output', destination],
      text => { output += text; }, text => { error += text; });
    assert.equal(code, 1); assert.equal(output, ''); assert.match(error, /unresolved reference/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
    // Reference export is independent of whether every allele can be called.
    await executePangenomeCommand({ type: 'export', experimentPath: f.file, format: 'reference-fasta', outputPath: join(f.dir, 'reference.fa') });
    assert.match(await readFile(join(f.dir, 'reference.fa'), 'utf8'), /ANGT/);
  });
  it('exports integrated GenBank CDS experiments and header-only identical comparisons', async () => {
    const f = await fixture(), sequence = 'ATGAAATAA';
    const input = parsePangenomeInput(`>ref\n${sequence}\n>a\nATGAAGTAA`);
    const annotation = { name: 'reference.gb', text: `LOCUS       REF 9 bp DNA linear\nACCESSION   REF\nFEATURES             Location/Qualifiers\n     CDS             1..9\n                     /transl_table=11\nORIGIN\n        1 ${sequence}\n//\n` };
    const result = await createAnnotatedAlignmentPangenome(input, { referenceId: 'ref', alignment: 'affine', terminalGaps: 'alleles' }, annotation);
    await writeFile(f.file, serializeAnalysisRecord(result.record));
    const destination = join(f.dir, 'annotated.vcf');
    await executePangenomeCommand({ type: 'export', experimentPath: f.file, outputPath: destination, format: 'vcf' });
    assert.deepEqual(rows(await readFile(destination, 'utf8')), [['reference', '6', '.', 'A', 'G', '.', '.', 'AC=1;AN=1', 'GT', '1']]);
    const same = await fixture('>ref\nACGT\n>a\nACGT\n');
    await executePangenomeCommand({ type: 'export', experimentPath: same.file, outputPath: join(same.dir, 'same.vcf'), format: 'vcf' });
    const text = await readFile(join(same.dir, 'same.vcf'), 'utf8');
    assert.equal(rows(text).length, 0); assert(text.includes('#CHROM\t')); assert(text.includes('Variant-only: absence is not a coverage assertion'));
  });
});
