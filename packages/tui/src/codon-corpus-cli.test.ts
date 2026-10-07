import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codonReferenceMain, executeCodonReferenceCommand, parseCodonReferenceCommand } from '../../../scripts/codon-reference';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { parseCodonReference } from '../../core/src/analysis/codon-reference';

const gb = (sequence = 'ATGAAAAAAAAAAAGTAA') => `LOCUS       REF ${sequence.length} bp DNA linear\nDEFINITION  Corpus fixture.\nACCESSION   REF\nVERSION     REF.1\nFEATURES             Location/Qualifiers\n     CDS             1..${sequence.length}\nORIGIN\n        1 ${sequence.toLowerCase()}\n//\n`;
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'phage-corpus-')), genome = join(dir, 'reference.gb'), corpus = join(dir, 'corpus.json');
  await writeFile(genome, gb());
  const args = ['build-reference', '--genome', genome, '--output', corpus, '--name', 'Fixture reference', '--organism', 'Synthetic',
    '--citation', 'Hand-enumerated fixture', '--reference-version', 'test-1', '--genetic-code', '1'];
  return { dir, genome, corpus, args };
}
async function execute(args: string[]) {
  const command = parseCodonReferenceCommand(args); assert.notEqual(command.type, 'help');
  return executeCodonReferenceCommand(command as Exclude<typeof command, { type: 'help' }>);
}

describe('codon corpus CLI producer and verified interchange', () => {
  it('builds a private source-inclusive corpus and recounts before count-only export', async () => {
    const f = await setup(), summary = await execute(f.args), countsPath = join(f.dir, 'counts.json');
    assert.equal(summary.codons, 6); assert.equal(summary.countedCds, 1);
    assert(!JSON.stringify(summary).includes('ATGAAAAAAAAAAAGTAA'));
    const corpus = await parseAnalysisRecord(await readFile(f.corpus, 'utf8'));
    assert.equal((corpus.inputs[0].data as { text: string }).text, gb());
    const verification = await execute(['verify-reference', '--experiment', f.corpus]);
    assert.equal(verification.resultId, summary.resultId); assert.equal(verification.verified, true);
    await execute(['export-reference', '--experiment', f.corpus, '--output', countsPath]);
    const counts = parseCodonReference(await readFile(countsPath, 'utf8'));
    assert.equal(counts.counts.AAA, 3); assert.equal(counts.counts.AAG, 1); assert.equal(Object.keys(counts.counts).length, 64);
    if (process.platform !== 'win32') assert.equal((await stat(f.corpus)).mode & 0o777, 0o600);
  });
  it('uses source-backed or count-only references in the existing scoring and verification commands', async () => {
    const f = await setup(); await execute(f.args);
    const query = join(f.dir, 'query.gb'); await writeFile(query, gb('ATGAAAAAGTAA'));
    const result = await execute(['analyze', '--genome', query, '--reference', f.corpus, '--output', join(f.dir, 'query.json')]);
    assert(Math.abs(Number(result.cai) - Math.sqrt(1 / 3)) < 1e-12);
    const fresh = await execute(['verify', '--experiment', join(f.dir, 'query.json')]);
    assert.equal(fresh.resultId, result.resultId);
    const record = await parseAnalysisRecord(await readFile(join(f.dir, 'query.json'), 'utf8'));
    assert.equal(record.method.version, '2');
    assert.equal(record.inputs.find(i => i.id === 'reference')!.data, await readFile(f.corpus, 'utf8'));
  });
  it('requires explicit metadata and precise CDS selection without ignoring incompatible options', async () => {
    const f = await setup();
    for (const change of [['--genetic-code', '4'], ['--unavailable', 'skip'], ['--zero-count', '0.5'], ['--gene-ids', '1']]) {
      const base = change[0] === '--genetic-code' ? f.args.slice(0, -2) : f.args;
      assert.throws(() => parseCodonReferenceCommand([...base, ...change]));
    }
    assert.throws(() => parseCodonReferenceCommand(f.args.slice(0, -2)), /Missing required/);
    const summary = await execute([...f.args, '--record', 'REF.1', '--gene-ids', '1']);
    assert.equal(summary.countedCds, 1);
  });
  it('does not open an output for unsupported input, bad source claims, or forged counts', async () => {
    const f = await setup();
    await writeFile(f.genome, '>FASTA\nATGAAATAA');
    await assert.rejects(execute(f.args), /FASTA/); await assert.rejects(access(f.corpus));
    await writeFile(f.genome, gb()); await execute(f.args);
    const record = await parseAnalysisRecord(await readFile(f.corpus, 'utf8'));
    const { format: _f, version: _v, cacheKey: _c, resultId: _r, ...options } = record;
    (options.fields.reference.value as { counts: Record<string, number> }).counts.AAA++;
    const forged = join(f.dir, 'forged.json'), output = join(f.dir, 'not-created.json');
    await writeFile(forged, serializeAnalysisRecord(await createAnalysisRecord(options)));
    await assert.rejects(execute(['export-reference', '--experiment', forged, '--output', output]), /Recomputed/);
    await assert.rejects(access(output));
  });
  it('retains existing destinations and symlinks and reports truthful CLI failures', async () => {
    const f = await setup(); await execute(f.args);
    const original = await readFile(f.corpus, 'utf8');
    await assert.rejects(execute(f.args), /EEXIST/); assert.equal(await readFile(f.corpus, 'utf8'), original);
    if (process.platform !== 'win32') {
      const link = join(f.dir, 'existing-link.json'); await symlink(f.corpus, link);
      await assert.rejects(execute(['export-reference', '--experiment', f.corpus, '--output', link]), /EEXIST/);
      assert.equal(await readFile(f.corpus, 'utf8'), original);
    }
    let stdout = '', stderr = '';
    const code = await codonReferenceMain(['build-reference'], s => { stdout += s; }, s => { stderr += s; });
    assert.equal(code, 1); assert.equal(stdout, ''); assert.match(stderr, /required/);
    await codonReferenceMain(['--help'], s => { stdout += s; }, () => {}, 'phage-explorer codon-reference');
    assert.match(stdout, /phage-explorer codon-reference build-reference/);
  });
});
