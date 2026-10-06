import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../index.tsx', import.meta.url));
interface Output { code: number | null; stdout: string; stderr: string }
function run(cwd: string, args: string[], executable = process.execPath, prefix = [entrypoint]): Promise<Output> {
  return new Promise((resolve, reject) => {
    // No catalog, terminal, relative source-tree paths or shell are provided.
    const child = spawn(executable, [...prefix, ...args], { cwd, env: { ...process.env,
      PHAGE_EXPLORER_DB_PATH: join(cwd, 'catalog-must-not-be-opened.db'),
      PHAGE_DB_PATH: join(cwd, 'catalog-must-not-be-opened.db'), BUN_BE_BUN: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Command did not settle: ${args.join(' ')}`)); }, 20000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    child.stderr.on('data', (text: string) => { stderr += text; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
function json(result: Output): Record<string, any> {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  // Multiple accidentally executed entrypoints, Ink output or banner text break this parse.
  return JSON.parse(result.stdout);
}
const fixture = () => mkdtemp(join(tmpdir(), 'phage-scientific-entrypoint-'));

describe('main executable research commands', () => {
  it('serves version and command-specific help without a catalog or terminal', async () => {
    const cwd = await fixture();
    const version = await run(cwd, ['--version']);
    assert.equal(version.code, 0); assert.match(version.stdout, /^phage-explorer \d+\.\d+\.\d+\n$/); assert.equal(version.stderr, '');
    for (const command of ['pangenome', 'codon-reference']) {
      const help = await run(cwd, [command, '--help']);
      assert.equal(help.code, 0, help.stderr); assert.equal(help.stderr, '');
      assert(help.stdout.includes(`phage-explorer ${command} `));
      assert(!help.stdout.includes('bun scripts/'), 'installed help must not require a checkout-only path');
    }
    const help = await run(cwd, ['--help']);
    assert.equal(help.code, 0); assert(help.stdout.includes('phage-explorer pangenome'));
    assert(help.stdout.includes('phage-explorer codon-reference'));
    assert.deepEqual(await readdir(cwd), []);
  });

  it('builds, verifies and exports a real affine graph through the main entrypoint', async () => {
    const cwd = await fixture(), input = join(cwd, 'literal name ; input.fasta');
    await writeFile(input, '>ref\nACGTACGT\n>query\nACGTTCGT\n');
    const inspected = json(await run(cwd, ['pangenome', 'inspect', '--input', input]));
    assert.equal(inspected.sequences.length, 2); assert.equal(inspected.hasGaps, false);
    const output = join(cwd, 'graph.json');
    const built = json(await run(cwd, ['pangenome', 'build', '--input', input, '--reference', 'ref',
      '--alignment', 'affine', '--terminal-gaps', 'alleles', '--output', output]));
    assert.equal(built.variants, 1); assert.equal(built.options.alignment, 'affine');
    const verified = json(await run(cwd, ['pangenome', 'verify', '--experiment', output]));
    assert.equal(verified.verified, true); assert.equal(verified.resultId, built.resultId);
    const original = join(cwd, 'recovered.fasta');
    json(await run(cwd, ['pangenome', 'export', '--experiment', output, '--format', 'original-fasta', '--output', original]));
    const fasta = await readFile(original, 'utf8');
    assert(fasta.includes('>query\nACGTTCGT\n')); assert(fasta.includes('>ref\nACGTACGT\n'));
    const bytes = await readFile(output);
    const duplicate = await run(cwd, ['pangenome', 'build', '--input', input, '--reference', 'ref', '--alignment', 'global', '--output', output]);
    assert.equal(duplicate.code, 1); assert.equal(duplicate.stdout, ''); assert.deepEqual(await readFile(output), bytes);
    assert(!(await readdir(cwd)).some(name => name.endsWith('.db')));
  });

  it('runs reference-codon scoring and fresh verification rather than illustrative host analysis', async () => {
    const cwd = await fixture(), genome = join(cwd, 'query.gb'), reference = join(cwd, 'counts.json'), output = join(cwd, 'codons.json');
    // Met/stop are excluded. AAA weight=1 and AAG weight=1/4 yield sqrt(1/4)=0.5.
    await writeFile(genome, 'LOCUS       QUERY 12 bp DNA linear\nACCESSION   QUERY\nFEATURES             Location/Qualifiers\n     CDS             1..12\n                     /locus_tag="gene1"\n                     /transl_table=11\nORIGIN\n        1 atgaaaaagtaa\n//\n');
    await writeFile(reference, JSON.stringify({ format: 'phage-explorer-codon-reference', version: 1,
      name: 'Hand-derived count reference', organism: 'Synthetic control', geneticCode: 11,
      source: { citation: 'Explicit test counts, not biological observations', version: '1' }, counts: { AAA: 4, AAG: 1 } }));
    const inspected = json(await run(cwd, ['codon-reference', 'inspect', '--genome', genome]));
    assert.equal(inspected.records[0].cds.length, 1);
    const built = json(await run(cwd, ['codon-reference', 'analyze', '--genome', genome, '--reference', reference, '--output', output]));
    assert.equal(built.method, 'reference-codon-adaptation'); assert.equal(built.cai, 0.5); assert.equal(built.scoredGenes, 1);
    const verified = json(await run(cwd, ['codon-reference', 'verify', '--experiment', output]));
    assert.equal(verified.verified, true); assert.equal(verified.resultId, built.resultId);
    assert.equal(verified.cai, 0.5); assert(!JSON.stringify(verified).includes('ATGAAAAAGTAA'));
    const link = join(cwd, 'do-not-replace.json');
    if (process.platform !== 'win32') {
      await symlink(output, link);
      const failed = await run(cwd, ['codon-reference', 'verify', '--experiment', output, '--output', link]);
      assert.equal(failed.code, 1); assert.equal(failed.stdout, '');
      assert.equal(json(await run(cwd, ['codon-reference', 'verify', '--experiment', output])).resultId, built.resultId);
    }
  });

  it('rejects non-regular codon inputs without blocking on a FIFO', async () => {
    const cwd = await fixture();
    const directory = await run(cwd, ['codon-reference', 'inspect', '--genome', cwd]);
    assert.equal(directory.code, 1); assert.equal(directory.stdout, ''); assert.match(directory.stderr, /regular files/);
    if (process.platform !== 'win32') {
      const pipe = join(cwd, 'never-opened-by-writer'); execFileSync('mkfifo', [pipe]);
      const result = await run(cwd, ['codon-reference', 'inspect', '--genome', pipe]);
      assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /regular files/);
    }
  });

  it('keeps invalid research arguments on the CLI failure path, never the interactive path', async () => {
    const cwd = await fixture();
    for (const args of [['pangenome'], ['codon-reference'], ['pangenome', 'inspect', '--no-catalog'],
      ['codon-reference', 'analyze', '--reference'], ['not-a-command']]) {
      const result = await run(cwd, args);
      assert.equal(result.code, 1); assert.equal(result.stdout, '');
      assert(!result.stderr.includes('database not found')); assert(!result.stderr.includes('raw mode'));
    }
    assert.deepEqual(await readdir(cwd), []);
  });
});
