import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codonReferenceMain, executeCodonReferenceCommand, parseCodonReferenceCommand, readCodonInput } from '../../../scripts/codon-reference';
import { replayReferenceCodonExperiment } from '../../core/src/analysis/codon-reference';

const reference = JSON.stringify({ format: 'phage-explorer-codon-reference', version: 1, name: 'CLI validation counts', organism: 'Synthetic numerical fixture',
  geneticCode: 11, source: { citation: 'Literal two-codon counts, not a biological prediction', version: '1' }, counts: { AAA: 8, AAG: 2 } });
const genome = `LOCUS       CLI_QUERY 6 bp DNA linear
ACCESSION   CLI_QUERY
FEATURES             Location/Qualifiers
     CDS             1..6
                     /locus_tag="query"
ORIGIN
        1 aaaaag
//
`;
async function fixture(content = genome) {
  // Retained fixtures follow the repository's no-deletion rule.
  const dir = await mkdtemp(join(tmpdir(), 'phage-reference-cli-'));
  const paths = { query: join(dir, 'query.gb'), reference: join(dir, 'counts.json'), output: join(dir, 'experiment.json'), dir };
  await writeFile(paths.query, content); await writeFile(paths.reference, reference);
  return paths;
}
const analyzeArgs = (paths: Awaited<ReturnType<typeof fixture>>) => ['analyze', '--genome', paths.query, '--reference', paths.reference, '--output', paths.output];

describe('reference CLI argument boundaries', () => {
  it('parses explicit analyze, verify, inspect and help without silently ignoring parameters', () => {
    assert.deepEqual(parseCodonReferenceCommand(['analyze', '--genome', 'q.gb', '--reference', 'r.json', '--output', 'e.json', '--gene-ids', '1,3', '--zero-count', '0']),
      { type: 'analyze', genomePath: 'q.gb', referencePath: 'r.json', outputPath: 'e.json', geneIds: [1, 3], zeroCountReplacement: 0 });
    assert.deepEqual(parseCodonReferenceCommand(['verify', '--experiment', 'e.json']), { type: 'verify', experimentPath: 'e.json' });
    assert.deepEqual(parseCodonReferenceCommand(['inspect', '--genome', 'q.gb']), { type: 'inspect', genomePath: 'q.gb' });
    assert.deepEqual(parseCodonReferenceCommand(['--help']), { type: 'help' });
  });
  it('rejects missing, duplicate, conflicting, malformed or unsupported options', () => {
    const valid = ['analyze', '--genome', 'q.gb', '--reference', 'r.json', '--output', 'o.json'];
    for (const args of [[], ['unknown'], ['analyze'], ['verify', '--experiment'], ['verify', '--experiment', 'x', '--genome', 'y'],
      [...valid, '--genome', 'other'], [...valid, '--zero-count', '1'], [...valid, '--gene-ids', '1,1'], [...valid, '--gene-ids', '0'],
      [...valid, '--gene-ids', '1.5'], [...valid, '--gene-ids', '1e3'], [...valid, '--gene-ids', '99999999999999999999'],
      [...valid, '--record', '\u001b[2J'], ['--help', '--output', 'x']]) assert.throws(() => parseCodonReferenceCommand(args));
  });
});

describe('reference CLI actual file workflow', () => {
  it('imports, scores, writes privately, reopens and recomputes the browser-compatible record', async () => {
    const paths = await fixture();
    let stdout = '', stderr = '';
    assert.equal(await codonReferenceMain(analyzeArgs(paths), value => { stdout += value; }, value => { stderr += value; }), 0);
    assert.equal(stderr, ''); assert.equal(JSON.parse(stdout).cai, 0.5);
    assert(!stdout.includes('AAAAAG')); assert(!stdout.includes('"counts"'));
    const saved = await readFile(paths.output, 'utf8');
    const replay = await replayReferenceCodonExperiment(saved);
    assert.equal(replay.analysis.summary.cai, 0.5);
    assert.equal((await stat(paths.output)).mode & 0o777, 0o600);
    const verified = await executeCodonReferenceCommand({ type: 'verify', experimentPath: paths.output, outputPath: join(paths.dir, 'verified.json') });
    assert.equal(verified.verified, true); assert.equal(verified.resultId, replay.record.resultId);
    assert.equal(await readFile(join(paths.dir, 'verified.json'), 'utf8'), saved);
  });
  it('refuses to overwrite existing output files, query inputs, reference inputs or symlinks', async () => {
    const paths = await fixture();
    for (const output of [paths.query, paths.reference, paths.output]) {
      if (output === paths.output) await writeFile(output, 'existing output');
      const before = await readFile(output);
      await assert.rejects(executeCodonReferenceCommand({ type: 'analyze', genomePath: paths.query, referencePath: paths.reference, outputPath: output,
        geneIds: null, zeroCountReplacement: 0.5 }), /EEXIST/);
      assert.deepEqual(await readFile(output), before);
    }
    const link = join(paths.dir, 'output-link'); await symlink(paths.query, link);
    await assert.rejects(executeCodonReferenceCommand({ type: 'analyze', genomePath: paths.query, referencePath: paths.reference, outputPath: link,
      geneIds: null, zeroCountReplacement: 0.5 }), /EEXIST/);
    assert.equal(await readFile(paths.query, 'utf8'), genome);
  });
  it('requires unambiguous record selection and lets inspect resolve accession collisions', async () => {
    const paths = await fixture(genome + genome.replace('aaaaag', 'aagaag'));
    const inspected = await executeCodonReferenceCommand({ type: 'inspect', genomePath: paths.query });
    const records = inspected.records as Array<{ contentId: string; cds: Array<{ id: number }> }>;
    assert.equal(records.length, 2); assert.equal(records[0].cds[0].id, 1);
    assert(!JSON.stringify(inspected).includes('AAAAAG'));
    const command = { type: 'analyze' as const, genomePath: paths.query, referencePath: paths.reference, outputPath: paths.output, geneIds: [1], zeroCountReplacement: 0.5 as const };
    await assert.rejects(executeCodonReferenceCommand(command), /exactly one/);
    await assert.rejects(executeCodonReferenceCommand({ ...command, record: 'CLI_QUERY' }), /exactly one/);
    const summary = await executeCodonReferenceCommand({ ...command, record: records[1].contentId });
    assert.equal(summary.cai, 0.25);
  });
  it('preserves a real zero score and exports partial reference coverage honestly', async () => {
    const paths = await fixture();
    await writeFile(paths.reference, reference.replace('"AAG":2', '"AAG":0'));
    const command = { type: 'analyze' as const, genomePath: paths.query, referencePath: paths.reference, outputPath: paths.output, geneIds: null, zeroCountReplacement: 0 as const };
    assert.equal((await executeCodonReferenceCommand(command)).cai, 0);
    await writeFile(paths.reference, reference.replace('"AAA":8,"AAG":2', '"TTT":8,"TTC":2'));
    const summary = await executeCodonReferenceCommand({ ...command, outputPath: join(paths.dir, 'unavailable.json') });
    assert.equal(summary.cai, null); assert.equal(summary.scoredGenes, 0);
  });
  it('validates inputs before creating output and returns nonzero on malformed reference or saved result', async () => {
    const paths = await fixture(); await writeFile(paths.reference, '{}');
    let stdout = '', stderr = '';
    assert.equal(await codonReferenceMain(analyzeArgs(paths), value => { stdout += value; }, value => { stderr += value; }), 1);
    assert.equal(stdout, ''); assert(stderr.length > 0);
    await assert.rejects(stat(paths.output), /ENOENT/);
    await writeFile(paths.output, '{"format":"made-up"}');
    await assert.rejects(executeCodonReferenceCommand({ type: 'verify', experimentPath: paths.output }));
  });
  it('bounds input bytes and rejects malformed UTF-8 and directories', async () => {
    const paths = await fixture();
    await assert.rejects(readCodonInput(paths.query, 5), /limit/);
    await assert.rejects(readCodonInput(paths.dir, 128), /regular files/);
    const invalid = join(paths.dir, 'bad-utf8'); await writeFile(invalid, new Uint8Array([0xff, 0xfe, 0xff]));
    await assert.rejects(readCodonInput(invalid, 100));
    const exact = join(paths.dir, 'exact'); await writeFile(exact, 'ACGT');
    assert.equal(await readCodonInput(exact, 4), 'ACGT');
  });
});
