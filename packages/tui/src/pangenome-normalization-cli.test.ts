import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePangenomeCommand, pangenomeMain } from '../../../scripts/pangenome';
import { createAlignmentPangenomeRecord, parsePangenomeInput, replayAlignmentPangenome } from '../../core/src/analysis/alignment-pangenome';
import { serializeAnalysisRecord } from '../../core/src/analysis-result';

const complements: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
const rc = (s: string) => s.split('').reverse().map(c => complements[c]).join('');
const rotate = (s: string, offset: number) => s.slice(offset) + s.slice(0, offset);
function dna(length: number): string {
  let seed = 123456789;
  return Array.from({ length }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return 'ACGT'[(seed >>> 0) % 4]; }).join('');
}
async function cli(args: string[]) {
  let stdout = '', stderr = '';
  const code = await pangenomeMain(args, text => { stdout += text; }, text => { stderr += text; });
  return { code, stdout, stderr };
}
async function fixture(reference = dna(10000), query = rotate(rc(reference), 127)) {
  // Intentionally retain generated artifacts; never delete a caller's files.
  const directory = await mkdtemp(join(tmpdir(), 'phage-normalization-cli-'));
  const input = join(directory, 'genomes.fasta'), experiment = join(directory, 'experiment.json');
  await writeFile(input, `>ref\n${reference}\n>query\n${query}\n`, 'utf8');
  return { directory, input, experiment, reference, query };
}
const build = (input: string, output: string, extra: string[] = ['--normalization', 'circular', '--terminal-gaps', 'alleles']) =>
  ['build', '--input', input, '--reference', 'ref', '--alignment', 'wavefront', '--output', output, ...extra];

describe('pangenome normalization terminal workflow', () => {
  it('parses normalization explicitly while keeping absent/none options identical to the previous contract', () => {
    const args = build('genomes.fa', 'experiment.json', []);
    assert.deepEqual(parsePangenomeCommand(args), parsePangenomeCommand([...args, '--normalization', 'none']));
    const strand = parsePangenomeCommand([...args, '--normalization', 'strand']);
    assert.equal(strand.type, 'build');
    if (strand.type !== 'build') throw new Error('Expected build');
    assert.deepEqual(strand.options, { referenceId: 'ref', alignment: 'wavefront', terminalGaps: 'missing', normalization: 'strand' });
    const circle = parsePangenomeCommand(build('genomes.fa', 'experiment.json'));
    assert.equal(circle.type, 'build');
    if (circle.type !== 'build') throw new Error('Expected build');
    assert.equal(circle.options.normalization, 'circular'); assert.equal(circle.options.terminalGaps, 'alleles');
    for (const invalid of [
      [...args, '--normalization', 'guess'], [...args, '--normalization', 'circular'],
      [...args, '--normalization', 'strand', '--normalization', 'strand'], [...args, '--normalization'],
      args.map(value => value === 'wavefront' ? 'provided' : value).concat('--normalization', 'strand'),
      ['inspect', '--input', 'genomes.fa', '--normalization', 'strand'],
    ]) assert.throws(() => parsePangenomeCommand(invalid));
    assert.deepEqual(parsePangenomeCommand(['export', '--experiment', 'experiment.json', '--format', 'original-fasta', '--output', 'original.fa']),
      { type: 'export', experimentPath: 'experiment.json', outputPath: 'original.fa', format: 'original-fasta' });
  });
  it('builds and verifies an exact reverse-rotated 10 kb genome with zero variants and metadata-only summaries', async () => {
    const files = await fixture(), result = await cli(build(files.input, files.experiment));
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.method.version, '4'); assert.equal(summary.variants, 0); assert.equal(summary.verified, false);
    const transform = summary.normalization.sequences.find((s: { sequenceId: string }) => s.sequenceId === 'query').transform;
    // RC reverses the direction of rotation: RC(L127(RC(ref))) = R127(ref).
    assert.deepEqual(transform, { strand: '-', offset: 127 });
    assert.equal(rotate(rc(files.query), 127), files.reference);
    assert(!result.stdout.includes(files.reference.slice(0, 80))); assert(!result.stdout.includes(files.query.slice(0, 80)));
    const verifiedPath = join(files.directory, 'verified.json');
    const verified = await cli(['verify', '--experiment', files.experiment, '--output', verifiedPath]);
    assert.equal(verified.code, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).verified, true);
    assert.equal(JSON.parse(verified.stdout).resultId, summary.resultId);
    assert.equal(await readFile(verifiedPath, 'utf8'), await readFile(files.experiment, 'utf8'));
    if (process.platform !== 'win32') assert.equal((await stat(files.experiment)).mode & 0o777, 0o600);
  });
  it('exports original and normalized FASTA, datasets and reversible GFA after actual recomputation', async () => {
    const files = await fixture(), built = await cli(build(files.input, files.experiment));
    assert.equal(built.code, 0, built.stderr);
    for (const format of ['original-fasta', 'fasta', 'dataset', 'gfa']) {
      const output = join(files.directory, `${format}.txt`);
      const result = await cli(['export', '--experiment', files.experiment, '--format', format, '--output', output]);
      assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).verified, true);
      const content = await readFile(output, 'utf8');
      if (format === 'gfa') {
        assert(content.includes('# path-transform\t'));
        const segments = new Map(content.split('\n').filter(l => l.startsWith('S\t')).map(l => { const [, id, seq] = l.split('\t'); return [id, seq]; }));
        const transforms = new Map(content.split('\n').filter(l => l.startsWith('# path-transform\t')).map(l => { const [, id, json] = l.split('\t'); return [id, JSON.parse(json) as { strand: string; offset: number }]; }));
        const labels = new Map(content.split('\n').filter(l => l.startsWith('# path-label\t')).map(l => { const [, id, json] = l.split('\t'); return [id, JSON.parse(json).id as string]; }));
        for (const line of content.split('\n').filter(l => l.startsWith('P\t'))) {
          const [, id, walk] = line.split('\t'), normalized = walk.split(',').map(node => segments.get(node.slice(0, -1))).join('');
          const transform = transforms.get(id)!;
          const unrotated = rotate(normalized, (normalized.length - transform.offset) % normalized.length);
          const original = transform.strand === '-' ? rc(unrotated) : unrotated;
          assert.equal(original, labels.get(id) === 'ref' ? files.reference : files.query);
        }
      } else {
        const parsed = parsePangenomeInput(content);
        assert.equal(parsed.sequences.find(s => s.id === 'ref')!.sequence, files.reference);
        assert.equal(parsed.sequences.find(s => s.id === 'query')!.sequence, format === 'fasta' ? files.reference : files.query);
      }
    }
  });
  it('reports planted edits at reference coordinates and preserves linear partial-input missingness', async () => {
    const reference = dna(2000), changedBase = reference[300] === 'A' ? 'C' : 'A';
    const changed = reference.slice(0, 300) + changedBase + reference.slice(301);
    const files = await fixture(reference, rotate(rc(changed), 715));
    const built = await cli(build(files.input, files.experiment)); assert.equal(built.code, 0, built.stderr);
    const { graph } = await replayAlignmentPangenome(await readFile(files.experiment, 'utf8'));
    assert.equal(graph.variants.length, 1);
    assert.deepEqual(graph.variants[0], { id: 'v1', type: 'snv', referenceStart: 300, referenceEnd: 301,
      reference: reference[300], alternate: changedBase, pathIds: [graph.paths.find(p => p.sequenceId === 'query')!.id] });
    const partial = await fixture(reference, rc(reference.slice(10, -10)));
    const result = await cli(build(partial.input, partial.experiment, ['--normalization', 'strand']));
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).variants, 0);
    const replay = await replayAlignmentPangenome(await readFile(partial.experiment, 'utf8'));
    assert.equal(replay.graph.diagnostics.comparisons[0].missingTerminalColumns, 20);
    assert.deepEqual(replay.graph.diagnostics.normalization!.sequences.find(s => s.sequenceId === 'query')!.transform, { strand: '-', offset: 0 });
  });
  it('fails without output files on insufficient evidence or unasserted circular topology', async () => {
    const files = await fixture('AAAACCCC', 'AAAAGCCC');
    const rejected = await cli(build(files.input, files.experiment));
    assert.equal(rejected.code, 1); assert.match(rejected.stderr, /decisive/); assert.equal(rejected.stdout, '');
    await assert.rejects(stat(files.experiment), { code: 'ENOENT' });
    const topology = await cli(build(files.input, files.experiment, ['--normalization', 'circular']));
    assert.equal(topology.code, 1); assert.match(topology.stderr, /terminal-gaps alleles/);
    await assert.rejects(stat(files.experiment), { code: 'ENOENT' });
    assert.equal(await readFile(files.input, 'utf8'), `>ref\n${files.reference}\n>query\n${files.query}\n`);
  });
  it('refuses existing files and symlinks when exporting original private sequences', async () => {
    const files = await fixture(), built = await cli(build(files.input, files.experiment));
    assert.equal(built.code, 0, built.stderr);
    const sentinel = join(files.directory, 'protected.txt'); await writeFile(sentinel, 'do not overwrite');
    const args = ['export', '--experiment', files.experiment, '--format', 'original-fasta', '--output'];
    const rejected = await cli([...args, sentinel]); assert.equal(rejected.code, 1);
    assert.equal(await readFile(sentinel, 'utf8'), 'do not overwrite');
    if (process.platform !== 'win32') {
      const link = join(files.directory, 'link.txt'); await symlink(sentinel, link);
      const linked = await cli([...args, link]); assert.equal(linked.code, 1);
      assert.equal(await readFile(sentinel, 'utf8'), 'do not overwrite');
    }
  });
  it('rejects rehashed forged normalization metadata before verify or export creates a destination', async () => {
    const files = await fixture(), built = await cli(build(files.input, files.experiment));
    assert.equal(built.code, 0, built.stderr);
    const { input, graph } = await replayAlignmentPangenome(await readFile(files.experiment, 'utf8'));
    const evidence = graph.diagnostics.normalization!.sequences.find(s => s.sequenceId === 'query')!;
    evidence.transform.offset = (evidence.transform.offset + 1) % files.query.length;
    const forged = await createAlignmentPangenomeRecord(input, graph), forgedPath = join(files.directory, 'forged.json');
    await writeFile(forgedPath, serializeAnalysisRecord(forged));
    for (const command of ['verify', 'export']) {
      const output = join(files.directory, `rejected-${command}.txt`);
      const result = await cli([command, '--experiment', forgedPath, '--output', output, ...(command === 'export' ? ['--format', 'original-fasta'] : [])]);
      assert.equal(result.code, 1); assert.match(result.stderr, /Recomputed/); assert.equal(result.stdout, '');
      await assert.rejects(stat(output), { code: 'ENOENT' });
    }
  });
});
