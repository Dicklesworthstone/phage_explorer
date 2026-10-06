import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, symlink, copyFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../index.tsx', import.meta.url));
interface Output { code: number | null; stdout: string; stderr: string }
function run(cwd: string, args: string[], executable = process.execPath, prefix = [entrypoint], environment: NodeJS.ProcessEnv = {}, timeoutMs = 20000): Promise<Output> {
  return new Promise((resolve, reject) => {
    // No catalog, terminal, relative source-tree paths or shell are provided.
    const child = spawn(executable, [...prefix, ...args], { cwd, env: { ...process.env,
      PHAGE_EXPLORER_DB_PATH: join(cwd, 'catalog-must-not-be-opened.db'),
      PHAGE_DB_PATH: join(cwd, 'catalog-must-not-be-opened.db'), BUN_BE_BUN: '', ...environment,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Command did not settle: ${args.join(' ')}`)); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    child.stderr.on('data', (text: string) => { stderr += text; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
function json(result: Output): Record<string, unknown> {
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
    for (const command of ['pangenome', 'codon-reference', 'workflow']) {
      const help = await run(cwd, [command, '--help']);
      assert.equal(help.code, 0, help.stderr); assert.equal(help.stderr, '');
      assert(help.stdout.includes(`phage-explorer ${command} `));
      assert(!help.stdout.includes('bun scripts/') && !help.stdout.includes('bun run workflow'), 'installed help must not require a checkout-only path');
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
    assert(Array.isArray(inspected.sequences)); assert.equal(inspected.sequences.length, 2); assert.equal(inspected.hasGaps, false);
    const output = join(cwd, 'graph.json');
    const built = json(await run(cwd, ['pangenome', 'build', '--input', input, '--reference', 'ref',
      '--alignment', 'affine', '--terminal-gaps', 'alleles', '--output', output]));
    assert.equal(built.variants, 1); assert.equal((built.options as { alignment: string }).alignment, 'affine');
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
    assert.equal((inspected.records as Array<{ cds: unknown[] }>)[0].cds.length, 1);
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
    for (const args of [['pangenome'], ['codon-reference'], ['workflow'], ['workflow', 'inspect', '--no-catalog'], ['pangenome', 'inspect', '--no-catalog'],
      ['codon-reference', 'analyze', '--reference'], ['not-a-command']]) {
      const result = await run(cwd, args);
      assert.equal(result.code, 1); assert.equal(result.stdout, '');
      assert(!result.stderr.includes('database not found')); assert(!result.stderr.includes('raw mode'));
    }
    assert.deepEqual(await readdir(cwd), []);
  });
});

/** A portable browser-format recording; expectations come from the existing producer,
 * with independently specified circular pair coordinates checked before export.
 */
async function recordedPairs(cwd: string) {
  const { importLocalGenomes, exportLocalGenomeBundle } = await import('../../../core/src/genome-import');
  const { createExactRepeatRecord } = await import('../../../core/src/analysis/exact-repeat-pairs');
  const { serializeCommandTape } = await import('../../../core/src/command-session');
  const parsed = await importLocalGenomes({ name: 'circle.fasta', text: '>circle\nACGTNNNNACGT' });
  const genome = parsed.genomes[0], options = { armLength: 4, maxGap: 4, maxPairs: 20, topology: 'circular' as const };
  const record = await createExactRepeatRecord(genome.sequence, options, { accession: genome.phage.accession, source: 'local' });
  assert.deepEqual(record.fields.pairs.value, [
    { type: 'direct', leftStart: 8, leftEnd: 12, rightStart: 0, rightEnd: 4, gap: 0 },
    { type: 'inverted', leftStart: 8, leftEnd: 12, rightStart: 0, rightEnd: 4, gap: 0 },
  ]);
  const tape = { format: 'phage-explorer-commands' as const, version: 1 as const, name: 'bun run workflow is user metadata, not help',
    context: { bundle: exportLocalGenomeBundle(parsed.genomes) }, commands: [{ actionId: 'overlay.repeats',
      parameters: { method: 'exact-pairs', contentId: genome.phage.localGenome!.contentId, ...options },
      expected: { method: record.method, cacheKey: record.cacheKey, resultId: record.resultId } }] };
  const input = join(cwd, 'workflow.json'); await writeFile(input, serializeCommandTape(tape));
  return { input, tape, record };
}

it('replays a portable circular-repeat workflow through the launcher and its owned thread', async () => {
  const cwd = await fixture(), { input, record, tape } = await recordedPairs(cwd), output = join(cwd, 'analysis.json');
  assert.equal(json(await run(cwd, ['workflow', 'inspect', '--input', input])).canReplay, true);
  const report = json(await run(cwd, ['workflow', 'replay', '--input', input, '--output', output]));
  assert.equal(report.verified, true); assert.equal(report.completed, 1); assert.equal(report.name, tape.name);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(saved.resultId, record.resultId); assert.deepEqual(saved.fields.pairs.value, record.fields.pairs.value);
  tape.commands[0].expected.resultId = 'f'.repeat(64);
  await writeFile(join(cwd, 'forged.json'), JSON.stringify(tape));
  const rejected = await run(cwd, ['workflow', 'replay', '--input', join(cwd, 'forged.json'), '--output', join(cwd, 'rejected.json')]);
  assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); assert.match(rejected.stderr, /differs/);
  assert(!(await readdir(cwd)).includes('rejected.json'));
});

it('embeds research workers in a relocated executable using the production two-stage configuration', async () => {
  const { executableBuildOptions, executableCompileArgs } = await import('../../../../scripts/build');
  const staging = await fixture(), cwd = await fixture();
  const built = await Bun.build(executableBuildOptions(staging));
  assert.equal(built.success, true, built.logs.map(log => String(log)).join('\n'));
  const binaryName = process.platform === 'win32' ? 'phage-explorer.exe' : 'phage-explorer';
  const stagedExecutable = join(staging, binaryName);
  const compileArgs = executableCompileArgs(staging, stagedExecutable);
  // Use the actual test runner's Bun; do not assume a second binary on PATH.
  const compiled = await run(staging, compileArgs.slice(1), process.execPath, [], {}, 90000);
  assert.equal(compiled.code, 0, compiled.stderr);
  const executable = join(cwd, binaryName); await copyFile(stagedExecutable, executable);
  // Retain build artifacts elsewhere so an absolute path back to staging cannot mask a missing embedded worker.
  const retained = await fixture(); await rename(staging, join(retained, 'build-artifacts'));
  const isolated = { PATH: cwd, NODE_PATH: '', NODE_OPTIONS: '', HOME: cwd, USERPROFILE: cwd };
  const { input, record } = await recordedPairs(cwd);
  for (const command of ['workflow', 'pangenome', 'codon-reference']) {
    const help = await run(cwd, [command, '--help'], executable, [], isolated);
    assert.equal(help.code, 0, help.stderr); assert(help.stdout.includes(`phage-explorer ${command} `));
  }
  const output = join(cwd, 'from-embedded-worker.json');
  const report = json(await run(cwd, ['workflow', 'replay', '--input', input, '--output', output], executable, [], isolated));
  assert.equal(report.verified, true);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).resultId, record.resultId);
  // Only the executable and user input/output were copied: no source or sidecar worker.
  assert.deepEqual((await readdir(cwd)).sort(), [binaryName, 'from-embedded-worker.json', 'workflow.json'].sort());
}, 120000);
