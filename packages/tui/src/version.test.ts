import { expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { computeDatabaseContentDigest } from '../../../scripts/build-web-db';
import { version } from '../../../package.json';

test('source or compiled entrypoint reports its version without a catalog or terminal', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'phage-version-'));
  const command = process.env.PHAGE_HOST_TEST_BINARY
    ? [resolve(process.env.PHAGE_HOST_TEST_BINARY)]
    : [process.execPath, resolve(import.meta.dir, 'index.tsx')];
  for (const flag of ['--version', '-V']) {
    const child = Bun.spawn([...command, flag], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe(`phage-explorer ${version}\n`);
  }
});

test('catalog diagnostics follow the interactive resolver and fingerprint one read-only SQLite snapshot', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'phage-catalog-info-'));
  const publicDir = join(cwd, 'packages', 'web', 'public');
  await mkdir(publicDir, { recursive: true });
  const source = join(publicDir, 'phage.db');
  const other = join(cwd, 'phage.db');
  function makeCatalog(path: string, name: string) {
    const db = new Database(path, { create: true });
    try {
      db.exec('CREATE TABLE phages(name TEXT); CREATE TABLE genes(id INTEGER PRIMARY KEY)');
      db.query('INSERT INTO phages VALUES (?)').run(name);
      db.exec('INSERT INTO genes VALUES (1), (2)');
      return computeDatabaseContentDigest(db);
    } finally { db.close(); }
  }
  const expected = makeCatalog(source, 'published'), alternate = makeCatalog(other, 'alternate');
  expect(expected).not.toBe(alternate);
  const command = process.env.PHAGE_HOST_TEST_BINARY ? [resolve(process.env.PHAGE_HOST_TEST_BINARY)]
    : [process.execPath, resolve(import.meta.dir, 'index.tsx')];
  const invoke = (env: Record<string, string> = {}, args: string[] = ['--catalog-info']) =>
    Bun.spawnSync([...command, ...args], { cwd, env: { ...process.env, HOME: cwd,
      PHAGE_EXPLORER_DB_PATH: '', PHAGE_DB_PATH: '', ...env }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  for (const [env, path, contentVersion] of [
    [{}, source, expected],
    [{ PHAGE_DB_PATH: 'phage.db' }, other, alternate],
    [{ PHAGE_EXPLORER_DB_PATH: source, PHAGE_DB_PATH: other }, source, expected],
  ] as [Record<string, string>, string, string][]) {
    const run = invoke(env);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toEqual({ path, contentVersion, phages: 1, genes: 2 });
    expect(run.stderr.toString()).toBe('');
  }
  for (const invalid of [join(cwd, 'missing.db'), publicDir]) {
    const env = { PHAGE_EXPLORER_DB_PATH: invalid, PHAGE_DB_PATH: other };
    for (const args of [['--catalog-info'], []]) {
      const run = invoke(env, args);
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain(`Cannot use catalog selected by PHAGE_EXPLORER_DB_PATH at ${invalid}`);
      expect(run.stdout.toString()).toBe('');
    }
  }
});
