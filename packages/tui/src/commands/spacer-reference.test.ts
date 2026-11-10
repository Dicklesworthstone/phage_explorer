import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serializeAnalysisRecord, createAnalysisRecord } from '../../../core/src/analysis-result';
import type { SpacerGenome, SpacerLibrary } from '../../../core/src/analysis/spacer-reference';
import { SpacerReferenceSession, executeSpacerRequest, readSpacerGenome, type SpacerRequest } from '../../../web/src/workers/SpacerReferenceSession';
import { createTerminalSpacerWorker, readTerminalSpacerFile, writeTerminalSpacerFile, terminalSpacerHitsTsv, spacerTerminalLabel } from './spacer-reference';

const guide = 'ACGATTCGGTACCTAGTGCA';
const library: SpacerLibrary = { format: 'phage-explorer-spacer-library', version: 1, name: 'Native analytical fixture',
  source: { kind: 'demo', reference: 'Hand-constructed sequence controls', version: '1', license: 'CC0 synthetic fixture', scope: 'Two synthetic strains' },
  hosts: [{ id: 'H1', name: 'Synthetic host one', strain: 'one', accession: 'synthetic:one' },
    { id: 'H2', name: 'Synthetic host two', strain: 'two', accession: 'synthetic:two' }],
  spacers: [{ id: 'S1', hostId: 'H1', arrayAccession: 'synthetic:array', sequence: guide, system: null, target: 'DNA',
    orientation: 'guide-equivalent', pam: { side: '3prime', motif: 'NGG', reference: 'Explicit fixture rule' },
    seed: { start: 0, end: 5, maxMismatches: 0, reference: 'Explicit fixture seed' } },
  { id: 'unsupported', hostId: 'H2', arrayAccession: 'synthetic:RNA', sequence: guide, system: null, target: 'RNA',
    orientation: 'guide-equivalent', pam: null, seed: null }] };
const genome: SpacerGenome = { name: 'Native query', accession: 'synthetic:query', source: 'local',
  topology: 'linear', sequence: 'TTTT' + guide + 'AGG' };
const analyze = (): SpacerRequest => ({ kind: 'analyze', genome, library, options: { hostId: null, maxMismatches: 0 } });
function fixture() {
  const scope = {}, session = new SpacerReferenceSession(createTerminalSpacerWorker);
  session.activate(); session.setScope(scope);
  return { scope, session };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe('native spacer reference transport and private file boundaries', () => {
  it('uses the real worker to inspect references, search both strands and preserve exact source identities', async () => {
    const { session, scope } = fixture();
    try {
      await session.run(scope, { kind: 'library', content: JSON.stringify(library) });
      assert.equal(session.getSnapshot().error, null); assert.equal(session.getSnapshot().accepted, null);
      assert.deepEqual(session.getSnapshot().library, library);
      await session.run(scope, analyze());
      const state = session.getSnapshot(); assert.equal(state.error, null);
      const value = state.accepted!; assert(value.record); assert(value.result);
      assert.equal(value.result.status, 'sequence-matches'); assert.equal(value.result.searchedRecords, 1);
      assert.equal(value.result.selectedRecords, 2); assert.equal(value.result.excluded[0].spacerId, 'unsupported');
      assert.deepEqual(value.result.hits.map(hit => [hit.start, hit.end, hit.strand]), [[4, 24, '+']]);
      assert.equal(value.result.hits[0].pam.sequence, 'AGG'); assert.equal(value.result.hits[0].pam.status, 'matched');
      assert.equal(value.result.hits[0].seed.mismatches, 0); assert.equal(value.result.hits[0].seed.status, 'matched');
      assert.deepEqual(value.record.inputs[0].data, genome); assert.deepEqual(value.record.inputs[1].data, library);
      const independent = await executeSpacerRequest(analyze());
      assert.equal(value.record.resultId, independent.record!.resultId, 'Native and browser use the identical computation/record contract.');
      const minus = { ...genome, sequence: 'CCTTGCACTAGGTACCGAATCGTAAAA' };
      await session.run(scope, { kind: 'analyze', genome: minus, library, options: {} });
      const reverse = session.getSnapshot().accepted!.result!.hits;
      assert.deepEqual(reverse.map(hit => [hit.start, hit.end, hit.strand, hit.pam.sequence]), [[3, 23, '-', 'AGG']]);
    } finally { session.deactivate(); }
  });

  it('distinguishes no host records, unsupported references and actual no-matches', async () => {
    const { session, scope } = fixture();
    try {
      await session.run(scope, { kind: 'analyze', genome, library, options: { hostId: 'H2' } });
      assert.equal(session.getSnapshot().accepted!.result!.status, 'unsupported-references');
      const empty = { ...library, spacers: [] };
      await session.run(scope, { kind: 'analyze', genome, library: empty, options: {} });
      assert.equal(session.getSnapshot().accepted!.result!.status, 'no-spacer-data');
      await session.run(scope, { kind: 'analyze', genome: { ...genome, sequence: 'C'.repeat(27) }, library, options: {} });
      assert.equal(session.getSnapshot().accepted!.result!.status, 'no-sequence-match');
      assert.equal(session.getSnapshot().accepted!.result!.coverage[0].unambiguousStarts, 8);
    } finally { session.deactivate(); }
  });

  it('verifies saved browser evidence and refuses altered genomes or rehashed invented hits', async () => {
    const { session, scope } = fixture();
    try {
      const browser = await executeSpacerRequest(analyze());
      const content = serializeAnalysisRecord(browser.record!);
      await session.run(scope, { kind: 'replay', content, genome });
      const before = session.getSnapshot().accepted!;
      assert.equal(before.verified, true); assert.equal(before.record!.resultId, browser.record!.resultId);
      for (const changed of [{ ...genome, sequence: genome.sequence.slice(1) }, { ...genome, topology: 'circular' as const }]) {
        await session.run(scope, { kind: 'replay', content, genome: changed });
        assert.match(session.getSnapshot().error!, /Selected genome/);
        assert.strictEqual(session.getSnapshot().accepted, before);
      }
      const tampered = structuredClone(browser.record!);
      (tampered.fields.matches.value as Array<Record<string, unknown>>)[0].start = 0;
      const forged = await createAnalysisRecord({ ...tampered, inputs: tampered.inputs.map(({ sha256: _sha256, ...input }) => input) });
      await session.run(scope, { kind: 'replay', content: serializeAnalysisRecord(forged), genome });
      assert.match(session.getSnapshot().error!, /Fresh spacer evidence/);
      assert.strictEqual(session.getSnapshot().accepted, before);
    } finally { session.deactivate(); }
  });

  it('cancels a real worker on progress and retains the previously accepted evidence', async () => {
    const { session, scope } = fixture();
    try {
      await session.run(scope, analyze()); const before = session.getSnapshot().accepted;
      let cancelled = false;
      const unsubscribe = session.subscribe(() => {
        if (session.getSnapshot().phase.startsWith('Searching')) { cancelled = true; session.cancel(); }
      });
      await session.run(scope, analyze()); unsubscribe();
      assert.equal(cancelled, true); assert.equal(session.getSnapshot().busy, false);
      assert.strictEqual(session.getSnapshot().accepted, before);
      await session.run(scope, { kind: 'library', content: '{invalid' });
      assert(session.getSnapshot().error); assert.strictEqual(session.getSnapshot().accepted, before);
    } finally { session.deactivate(); }
  });

  it('abandons late repository reads even when the replacement has the same numeric genome ID', async () => {
    const { session, scope } = fixture(), length = deferred<number>(), entered = deferred<void>();
    let sequenceReads = 0;
    const old = { getFullGenomeLength: () => { entered.resolve(); return length.promise; },
      getSequenceWindow: async () => { sequenceReads++; return genome.sequence; } };
    try {
      await session.run(scope, { kind: 'library', content: JSON.stringify(library) });
      const pending = session.run(scope, async signal => ({ kind: 'analyze', library, options: {},
        genome: await readSpacerGenome(old, { id: 7, name: genome.name, accession: genome.accession, localGenome: true }, 'linear', signal) }));
      await entered.promise;
      const next = {}; session.setScope(next); await pending;
      length.resolve(genome.sequence.length);
      await new Promise(done => setTimeout(done, 10));
      assert.equal(sequenceReads, 0); assert.equal(session.getSnapshot().accepted, null);
      assert.deepEqual(session.getSnapshot().library, library);
      const replacement = { getFullGenomeLength: async () => 27, getSequenceWindow: async () => 'C'.repeat(27) };
      await session.run(next, async signal => ({ kind: 'analyze', library, options: {},
        genome: await readSpacerGenome(replacement, { id: 7, name: genome.name, accession: genome.accession }, 'linear', signal) }));
      assert.equal(session.getSnapshot().accepted!.result!.status, 'no-sequence-match');
    } finally { session.deactivate(); }
  });

  it('bounds UTF-8 reads and exclusively publishes private files without replacing existing outputs or links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phage-spacer-files-'));
    const input = join(directory, 'source.json'), target = join(directory, 'saved.json');
    await writeFile(input, JSON.stringify(library));
    assert.equal(await readTerminalSpacerFile(input, 2 * 1024 * 1024), JSON.stringify(library));
    await assert.rejects(readTerminalSpacerFile(input, 4), /limit/);
    await assert.rejects(readTerminalSpacerFile(directory, 100), /regular/);
    const malformed = join(directory, 'bad-utf8'); await writeFile(malformed, Buffer.from([0xff, 0xfe]));
    await assert.rejects(readTerminalSpacerFile(malformed, 100));
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(readTerminalSpacerFile(input, 100000, cancelled.signal), { name: 'AbortError' });
    await writeTerminalSpacerFile(target, 'accepted'); assert.equal((await stat(target)).mode & 0o777, 0o600);
    await assert.rejects(writeTerminalSpacerFile(target, 'replacement'), { code: 'EEXIST' });
    const link = join(directory, 'saved-link'); await symlink(target, link);
    await assert.rejects(writeTerminalSpacerFile(link, 'replacement'), { code: 'EEXIST' });
    assert.equal(await readFile(target, 'utf8'), 'accepted');
    await assert.rejects(writeTerminalSpacerFile('bad\u001bpath', 'data'), /control/);
  });

  it('exports every hit with explicit coordinates, rules and accepted provenance without altering source labels', async () => {
    const value = await executeSpacerRequest(analyze());
    const lines = terminalSpacerHitsTsv(value).trimEnd().split('\n');
    const meta = JSON.parse(lines[0].slice(2));
    assert.equal(meta.resultId, value.record!.resultId); assert.equal(meta.source.kind, 'demo');
    assert.equal(meta.searchedRecords, 1); assert.equal(meta.complete, true);
    assert.equal(lines.length, 3);
    const row = lines[2].split('\t');
    assert.deepEqual(row.slice(2, 6), ['4', '24', '+', 'false']);
    assert.equal(row[10], 'matched'); assert.equal(row[11], 'AGG'); assert.equal(row[15], '0');
    assert.equal(spacerTerminalLabel('\u001b[31munsafe\u202ehost\u0007'), 'unsafe�host�');
    assert.equal(value.library.name, library.name);
  });
});
