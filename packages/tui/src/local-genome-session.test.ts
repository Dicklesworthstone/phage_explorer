import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importLocalGenomes, exportLocalGenomeBundle, GENOME_IMPORT_LIMITS, type GenomeImportResult } from '../../core/src/genome-import';
import type { PhageRepository } from '../../db-runtime/src/types';
import { TerminalGenomeSession, loadTerminalGenomeFile, terminalGenomeLabel, type TerminalGenomeAccepted } from './local-genome-session';
import { readTerminalGenomeFile } from './local-genome-import.worker';

const genbank = `LOCUS       joined                    18 bp    DNA     linear
ACCESSION   joined
FEATURES             Location/Qualifiers
     CDS             complement(join(1..6,13..18))
                     /gene="reverse_join"
ORIGIN
        1 atgaaacccgggtttcat
//
`;
const parsed = () => importLocalGenomes({ name: 'reference.gb', text: genbank });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phage-terminal-import-'));
  const source = join(directory, 'source with spaces.gb');
  await writeFile(source, genbank);
  return { directory, source };
}
describe('interactive terminal local genome sessions', () => {
  it('reads real files in an owned worker and stages them without changing the accepted repository', async () => {
    const { source } = await fixture();
    const session = new TerminalGenomeSession(null);
    const original = session.getSnapshot().repository;
    await session.prepare(source);
    assert.equal(session.getSnapshot().error, null);
    assert.equal(session.getSnapshot().localCount, 0);
    assert.strictEqual(session.getSnapshot().repository, original);
    assert.deepEqual(await original.listPhages(), []);
    const review = session.getSnapshot().review!;
    assert.equal(review.genomes[0].sequence, 'ATGAAACCCGGGTTTCAT');
    assert.equal(review.genomes[0].original.text, genbank);
    assert.deepEqual(review.genomes[0].phage.genes[0].qualifiers!._segments,
      [{ start: 12, end: 18, strand: '-' }, { start: 0, end: 6, strand: '-' }]);
    let installed: TerminalGenomeAccepted | undefined;
    assert.equal(await session.accept(false, value => { installed = value; }), true);
    assert.equal(installed!.view.scrollPosition, 0);
    assert.equal(installed!.selected.localGenome!.contentId, review.genomes[0].phage.localGenome!.contentId);
    assert.equal(await installed!.repository.getSequenceWindow(installed!.selected.id, 12, 18), 'TTTCAT');
    assert.equal(session.getSnapshot().localCount, 1);
    await session.close();
  });
  it('requires an explicit collision decision and never replaces a catalog or earlier private record', async () => {
    const imported = await parsed();
    const catalog = { ...imported.genomes[0].phage, id: 1, localGenome: undefined };
    let writes = 0;
    const base = { listPhages: async () => [catalog], close: async () => {},
      setPreference: async () => { writes++; }, getSequenceWindow: async () => 'CATALOG' } as unknown as PhageRepository;
    const session = new TerminalGenomeSession(base, [], async () => imported);
    await session.prepare('source');
    let installs = 0;
    assert.equal(await session.accept(false, () => { installs++; }), false);
    assert.match(session.getSnapshot().error!, /Explicitly allow/);
    assert.equal(installs, 0);
    assert.equal(session.getSnapshot().localCount, 0);
    assert(session.getSnapshot().review);
    assert.equal(await session.accept(true, () => { installs++; }), true);
    assert.equal((await session.getSnapshot().repository.listPhages()).length, 2);
    assert.equal(await session.getSnapshot().repository.getSequenceWindow(1, 0, 7), 'CATALOG');
    assert.equal(writes, 0);
    await session.prepare('again');
    await session.accept(true, () => { installs++; });
    assert.equal(session.getSnapshot().localCount, 1, 'reimport is content-deduplicated');
    assert.equal(catalog.name, imported.genomes[0].phage.name);
  });
  it('rechecks the live catalog on acceptance and keeps review after a catalog read failure', async () => {
    const imported = await parsed();
    let fail = true;
    const base = { listPhages: async () => { if (fail) throw new Error('catalog unavailable'); return []; }, close: async () => {} } as unknown as PhageRepository;
    const session = new TerminalGenomeSession(base, [], async () => imported);
    await session.prepare('source');
    assert.equal(await session.accept(false, () => assert.fail('must not install')), false);
    assert.match(session.getSnapshot().error!, /catalog unavailable/);
    fail = false;
    assert.equal(await session.accept(false, () => {}), true);
  });
  it('cancels late parsing without publishing its data over a newer review', async () => {
    const pending = deferred<GenomeImportResult>(), imported = await parsed();
    let requests = 0;
    const session = new TerminalGenomeSession(null, [], async () => ++requests === 1 ? pending.promise : imported);
    const old = session.prepare('old');
    session.cancel();
    await session.prepare('new');
    const review = session.getSnapshot().review;
    pending.resolve(await importLocalGenomes({ name: 'old.fa', text: '>old\nCCCCCCCC' }));
    await old;
    assert.strictEqual(session.getSnapshot().review, review);
    assert.equal(session.getSnapshot().localCount, 0);
  });
  it('cancels acceptance during a catalog read with no host or repository mutation', async () => {
    const pending = deferred<Awaited<ReturnType<PhageRepository['listPhages']>>>();
    const base = { listPhages: () => pending.promise, close: async () => {} } as unknown as PhageRepository;
    const session = new TerminalGenomeSession(base, [], parsed);
    await session.prepare('source');
    const repo = session.getSnapshot().repository;
    const adding = session.accept(false, () => assert.fail('cancelled install'));
    session.cancel(); pending.resolve([]);
    assert.equal(await adding, false);
    assert.strictEqual(session.getSnapshot().repository, repo);
    assert.equal(session.getSnapshot().localCount, 0);
    assert(session.getSnapshot().review);
  });
  it('returns promptly from an already-aborted native worker request and isolates concurrent calls', async () => {
    const { source } = await fixture();
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(loadTerminalGenomeFile(source, aborted.signal), { name: 'AbortError' });
    const cancelled = new AbortController();
    const old = loadTerminalGenomeFile(source, cancelled.signal);
    const current = loadTerminalGenomeFile(source, new AbortController().signal);
    cancelled.abort();
    await assert.rejects(old, { name: 'AbortError' });
    assert.equal((await current).genomes[0].original.text, genbank);
  });
  it('writes source-and-view bundles exclusively and reparses the exact reverse-frame residue view', async () => {
    const { directory } = await fixture();
    const imported = await parsed(), genome = imported.genomes[0];
    const view = { contentId: genome.phage.localGenome!.contentId, viewMode: 'aa' as const, readingFrame: -2 as const, scrollPosition: 3 };
    const session = new TerminalGenomeSession(null, imported.genomes);
    const target = join(directory, 'saved.json');
    assert.equal(await session.save(target, view), true);
    const content = await readFile(target, 'utf8');
    const replay = await importLocalGenomes({ name: 'saved.json', text: content });
    assert.deepEqual(replay.genomes, imported.genomes);
    assert.deepEqual(replay.view, view);
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal(await session.save(target, view), false);
    assert.equal(await readFile(target, 'utf8'), content);
    const reopened = new TerminalGenomeSession(null);
    await reopened.prepare(target);
    let installed: TerminalGenomeAccepted | undefined;
    assert.equal(await reopened.accept(false, value => { installed = value; }), true);
    assert.deepEqual(installed!.view, view);
    const link = join(directory, 'existing-link.json');
    await symlink(target, link);
    assert.equal(await session.save(link, view), false);
    assert.equal(await readFile(target, 'utf8'), content);
  });
  it('validates residue coordinates before installing or creating an export', async () => {
    const { directory } = await fixture();
    const imported = await parsed(), genome = imported.genomes[0];
    const view = { contentId: genome.phage.localGenome!.contentId, viewMode: 'aa' as const, readingFrame: 0 as const, scrollPosition: 6 };
    const session = new TerminalGenomeSession(null, [], async () => ({ ...imported, view }));
    await session.prepare('bad view');
    assert.equal(await session.accept(false, () => assert.fail('invalid view')), false);
    assert.match(session.getSnapshot().error!, /outside/);
    const loaded = new TerminalGenomeSession(null, imported.genomes);
    assert.equal(await loaded.save(join(directory, 'invalid.json'), view), false);
    await assert.rejects(stat(join(directory, 'invalid.json')), { code: 'ENOENT' });
  });
  it('sanitizes display copies without changing original source, annotation or bundle identity', async () => {
    const imported = await importLocalGenomes({ name: 'safe.fa', text: '>escape\u001b[31m-name\nACGTACGT' });
    const session = new TerminalGenomeSession(null, imported.genomes);
    const display = await session.getSnapshot().repository.listPhages();
    assert.equal(display[0].name.includes('\u001b'), false);
    const exported = await importLocalGenomes({ name: 'bundle.json', text: session.exportBundle() });
    assert.deepEqual(exported.genomes, imported.genomes);
    assert.equal(terminalGenomeLabel('a\u001b[31mb\u0000c'), 'ab�c');
  });
  it('refuses invalid files, invalid UTF-8, oversized inputs and filesystem pipes/devices', async () => {
    const { directory } = await fixture();
    await assert.rejects(readTerminalGenomeFile(directory), /regular file/);
    await assert.rejects(readTerminalGenomeFile(join(directory, 'missing')), { code: 'ENOENT' });
    await assert.rejects(readTerminalGenomeFile('bad\u0000path'), /control/);
    const bad = join(directory, 'bad.fa');
    await writeFile(bad, Buffer.from([255, 254]));
    await assert.rejects(readTerminalGenomeFile(bad), /encoded data/);
    const large = join(directory, 'large.fa');
    await writeFile(large, Buffer.alloc(GENOME_IMPORT_LIMITS.bytes + 1, 65));
    await assert.rejects(readTerminalGenomeFile(large), /10 MiB/);
    if (process.platform !== 'win32') {
      await assert.rejects(readTerminalGenomeFile('/dev/null'), /regular file/);
      const { spawnSync } = await import('node:child_process');
      const fifo = join(directory, 'input-pipe');
      const made = spawnSync('mkfifo', [fifo]);
      assert.equal(made.status, 0, 'fixture pipe creation');
      await assert.rejects(readTerminalGenomeFile(fifo), /regular file/);
    }
    const session = new TerminalGenomeSession(null, [], parsed);
    await session.prepare('valid');
    const count = session.getSnapshot().localCount;
    // A failed source has no stale review attached to its filename.
    const failed = new TerminalGenomeSession(null);
    await failed.prepare(bad);
    assert.equal(failed.getSnapshot().review, null);
    assert.equal(failed.getSnapshot().localCount, count);
    await mkdir(join(directory, 'untouched'));
  });
  it('keeps the old repository if the host refuses installation and closes only its owned base once', async () => {
    let closed = 0;
    const base = { listPhages: async () => [], close: async () => { closed++; } } as unknown as PhageRepository;
    const session = new TerminalGenomeSession(base, [], parsed);
    await session.prepare('source');
    const previous = session.getSnapshot().repository;
    assert.equal(await session.accept(false, () => { throw new Error('host refused'); }), false);
    assert.strictEqual(session.getSnapshot().repository, previous);
    assert.equal(session.getSnapshot().localCount, 0);
    assert.equal(closed, 0);
    await session.close(); await session.close();
    assert.equal(closed, 1);
    await assert.rejects(session.prepare('source'), /closed/);
  });
  it('merges multiple sources and exports the entire accepted set, not just the latest import', async () => {
    const first = await parsed(), second = await importLocalGenomes({ name: 'other.fa', text: '>other\nGATTACAGATTACA' });
    const session = new TerminalGenomeSession(null, first.genomes, async () => second);
    await session.prepare('other');
    assert.equal(await session.accept(false, () => {}), true);
    const replay = await importLocalGenomes({ name: 'all.json', text: session.exportBundle() });
    assert.deepEqual(replay.genomes, [...first.genomes, ...second.genomes]);
    assert.equal(session.getSnapshot().localBases, 32); // 18 + two seven-base GATTACA units
    assert.equal(JSON.parse(session.exportBundle()).inputs.length, 2);
    const original = JSON.stringify(first);
    exportLocalGenomeBundle(first.genomes);
    assert.equal(JSON.stringify(first), original);
  });
});
