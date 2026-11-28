/**
 * install.sh behavior under the conditions a `curl | bash` user actually has.
 *
 * Each case runs the real installer with the stock shell (`/bin/bash` where it
 * exists, which is bash 3.2 on macOS) and a PATH holding only ordinary system
 * tools: no `flock` (stock macOS has none), and, where a case says so, no
 * SHA-256 tool. Release downloads go through a `curl` stand-in that serves a
 * local directory laid out like a GitHub release (binary, `phage.db`,
 * optional `phage.db.gz`, `sha256.txt`); everything else (locking, checksum
 * lookup, verification, staging and the final rename) is the installer's own
 * code. These cases are not evidence about the published release; the
 * `PHAGE_INSTALLER_LIVE=1` case below runs the installer against the real
 * GitHub release instead.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { version as treeVersion } from '../../../package.json';

const INSTALLER = resolve(import.meta.dir, '../../../install.sh');
const SHELL = existsSync('/bin/bash') ? '/bin/bash' : (Bun.which('bash') ?? 'bash');
const VERSION = 'v9.9.9';
const PLATFORM =
  process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'unsupported';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const ASSET = `phage-explorer-${PLATFORM}-${ARCH}`;
const supported = PLATFORM !== 'unsupported';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const BASE_TOOLS = [
  'awk', 'cat', 'chmod', 'cp', 'gunzip', 'gzip', 'head', 'id', 'ln', 'mkdir', 'mktemp',
  'mv', 'rm', 'rmdir', 'sed', 'sleep', 'sort', 'tr', 'uname', 'wc', 'grep',
];
const HASH_TOOLS = ['sha256sum', 'shasum', 'openssl', 'perl'];

/** A PATH directory with only the named host tools, plus a release-serving curl. */
/** `hashTools`: true = every SHA-256 tool the host has, false = none, or an exact list. */
/**
 * `stallOn`: the first download of that asset writes half its bytes, creates
 * `stallMarker`, and then hangs like a stalled connection; later downloads are normal.
 */
function toolDir(
  root: string,
  releaseDir: string,
  opts: { hashTools: boolean | string[]; flock?: boolean; stallOn?: string; stallMarker?: string; version: string }
) {
  const dir = join(root, 'tools');
  mkdirSync(dir);
  const hashes = opts.hashTools === true ? HASH_TOOLS : opts.hashTools === false ? [] : opts.hashTools;
  const names = [...BASE_TOOLS, ...hashes, ...(opts.flock ? ['flock'] : [])];
  for (const name of names) {
    const found = Bun.which(name);
    if (found) symlinkSync(found, join(dir, name));
  }
  const curl = join(dir, 'curl');
  writeFileSync(
    curl,
    `#!${SHELL}
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://github.com/Dicklesworthstone/phage_explorer/releases/download/${opts.version}/*) ;;
  *) exit 22 ;;
esac
src="${releaseDir}/\${url##*/}"
[ -f "$src" ] || exit 22
${
  opts.stallOn && opts.stallMarker
    ? `if [ "\${url##*/}" = "${opts.stallOn}" ] && [ -n "$out" ] && [ ! -e "${opts.stallMarker}" ]; then
  size=$(wc -c <"$src")
  head -c $((size / 2)) "$src" >"$out"
  : >"${opts.stallMarker}"
  exec sleep 60
fi
`
    : ''
}if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
`
  );
  chmodSync(curl, 0o755);
  return dir;
}

interface Release {
  binary: Uint8Array;
  db: Uint8Array;
  /** Bytes served as phage.db.gz; omitted when undefined. */
  gz?: Uint8Array;
  /** Serve the plain phage.db asset. */
  plainDb?: boolean;
  /** sha256.txt lines; defaults to correct sums for the binary and phage.db; null = no sha256.txt. */
  sums?: string[] | null;
  /** Contents of the binary's .sha256 sidecar, when the release publishes one. */
  sidecar?: string;
}

function makeRelease(root: string, release: Release) {
  const dir = join(root, 'release');
  mkdirSync(dir);
  writeFileSync(join(dir, ASSET), release.binary);
  if (release.plainDb !== false) writeFileSync(join(dir, 'phage.db'), release.db);
  if (release.gz) writeFileSync(join(dir, 'phage.db.gz'), release.gz);
  if (release.sums !== null) {
    const sums = release.sums ?? [`${sha256(GOOD_BINARY)}  ${ASSET}`, `${sha256(GOOD_DB)}  phage.db`];
    writeFileSync(join(dir, 'sha256.txt'), sums.join('\n') + '\n');
  }
  if (release.sidecar !== undefined) writeFileSync(join(dir, `${ASSET}.sha256`), release.sidecar);
  return dir;
}

const GOOD_BINARY = new TextEncoder().encode('#!/bin/sh\necho phage-explorer test build\n');
const GOOD_DB = new Uint8Array(4096).map((_, i) => (i * 7 + 3) % 251);
const OLD_BINARY = new TextEncoder().encode('#!/bin/sh\necho previous install\n');
const OLD_DB = new Uint8Array(512).fill(42);
const flipped = (bytes: Uint8Array) => {
  const copy = Uint8Array.from(bytes);
  copy[copy.length - 2] ^= 0x01;
  return copy;
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  home: string;
  dest: string;
  tmp: string;
}

interface InstallOptions {
  args?: string[];
  hashTools?: boolean | string[];
  flock?: boolean;
  previous?: boolean;
  databaseMode?: 'default' | 'skip' | 'replace';
  version?: string;
  destName?: string;
  homeName?: string;
  tmpName?: string;
  stallOn?: string;
  before?: (tmp: string) => void;
}

/** Lay out HOME, TMPDIR, the release and the tools; return the installer's argv and env. */
function prepareInstall(release: Release, opts: InstallOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'phage-install-'));
  const home = join(root, opts.homeName ?? 'home');
  const dest = join(root, opts.destName ?? 'bin');
  const tmp = join(root, opts.tmpName ?? 'tmp');
  const stallMarker = join(root, 'download-stalled');
  mkdirSync(home);
  mkdirSync(tmp);
  if (opts.previous) {
    mkdirSync(dest);
    writeFileSync(join(dest, 'phage-explorer'), OLD_BINARY, { mode: 0o755 });
    mkdirSync(join(home, '.phage-explorer'));
    writeFileSync(join(home, '.phage-explorer', 'phage.db'), OLD_DB);
  }
  const releaseDir = makeRelease(root, release);
  const tools = toolDir(root, releaseDir, {
    version: opts.version ?? VERSION,
    hashTools: opts.hashTools ?? true,
    flock: opts.flock,
    stallOn: opts.stallOn,
    stallMarker,
  });
  opts.before?.(tmp);
  const databaseArgs = opts.databaseMode === 'default' ? [] :
    [opts.databaseMode === 'skip' ? '--without-database' : '--with-database'];
  const argv = [SHELL, INSTALLER, '--dest', dest, ...databaseArgs, ...(opts.args ?? [])];
  const env = { PATH: tools, HOME: home, TMPDIR: tmp, VERSION: opts.version ?? VERSION };
  return { argv, env, home, dest, tmp, stallMarker };
}

const V141_DB_SHA = '245d0b5115a28d780637816f1b9524b253620d11363a1ab4fcd9749043694b99';

// Model the identity of the old release without checking a 3 MB binary into the
// test suite. The opt-in published upgrade below exercises the actual v1.4.1 bytes.
function prepareReleasedCatalog(release: Release, opts: InstallOptions = {}) {
  const prepared = prepareInstall(release, { ...opts, previous: true, databaseMode: 'default' });
  const wrapper = join(prepared.tmp, 'old-release');
  mkdirSync(wrapper);
  const hashTool = Bun.which('sha256sum');
  const command = hashTool ? `"${hashTool}"` : `"${Bun.which('shasum')}" -a 256`;
  writeFileSync(join(wrapper, 'sha256sum'), `#!${SHELL}
sum="$(${command})" || exit 1
case "\${sum%% *}" in
  ${sha256(OLD_DB)}) echo '${V141_DB_SHA}  -' ;;
  *) echo "$sum" ;;
esac
`, { mode: 0o755 });
  prepared.env.PATH = wrapper + ':' + prepared.env.PATH;
  return prepared;
}

function runPrepared(prepared: ReturnType<typeof prepareInstall>): Run {
  const result = Bun.spawnSync(prepared.argv, { env: prepared.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    home: prepared.home,
    dest: prepared.dest,
    tmp: prepared.tmp,
  };
}

/** Model a tagged checkout and compilation. Use real Bun for manifest parsing. */
function provideTaggedSource(prepared: ReturnType<typeof prepareInstall>, manifest: unknown, windows = false) {
  const data = join(prepared.tmp, 'checkout/packages/web/public');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'phage.db'), GOOD_DB);
  writeFileSync(join(data, 'phage.db.manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(prepared.tmp, 'built-binary'), GOOD_BINARY);

  const wrappers = join(prepared.tmp, 'source-tools');
  mkdirSync(wrappers);
  if (windows) {
    writeFileSync(join(wrappers, 'uname'), `#!${SHELL}\ncase "$1" in -s) echo MINGW64_NT-10.0 ;; -m) echo x86_64 ;; esac\n`, { mode: 0o755 });
  }
  writeFileSync(join(wrappers, 'git'), `#!${SHELL}
[[ "$1" == clone && "$4" == --branch && "$5" == "$VERSION" ]] || exit 1
cp -R "$TMPDIR/checkout/." "$7"
`, { mode: 0o755 });
  writeFileSync(join(wrappers, 'bun'), `#!${SHELL}
case "$1" in
  install) exit 0 ;;
  run) [[ "$2" == build ]] && mkdir -p dist && cp "$TMPDIR/built-binary" dist/phage-explorer${windows ? '.exe' : ''} ;;
  *) exec "${process.execPath}" "$@" ;;
esac
`, { mode: 0o755 });
  prepared.env.PATH = wrappers + ':' + prepared.env.PATH;
}

function runInstaller(release: Release, opts: InstallOptions = {}): Run {
  return runPrepared(prepareInstall(release, opts));
}

const mkdirLockPath = (tmp: string) => join(tmp, `phage-explorer-install-${process.getuid?.()}.lock.d`);
const flockPath = (tmp: string) => join(tmp, `phage-explorer-install-${process.getuid?.()}.lock`);

const installedBinary = (run: Run) => readFileSync(join(run.dest, 'phage-explorer'));
const installedDb = (run: Run) => readFileSync(join(run.home, '.phage-explorer', 'phage.db'));
const leftovers = (run: Run) => [
  ...(existsSync(run.dest) ? readdirSync(run.dest) : []),
  ...(existsSync(join(run.home, '.phage-explorer')) ? readdirSync(join(run.home, '.phage-explorer')) : []),
].filter((name) => name.includes('.download.') || name.includes('.rollback.'));

function expectUnchanged(run: Run) {
  expect(Buffer.compare(installedBinary(run), Buffer.from(OLD_BINARY))).toBe(0);
  expect(Buffer.compare(installedDb(run), Buffer.from(OLD_DB))).toBe(0);
  expect(leftovers(run)).toEqual([]);
}

describe.skipIf(!supported)('install.sh on a stock shell without flock', () => {
  test('installs the verified binary and database and leaves no lock or staging files', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB });
    expect(run.stderr).not.toContain('Another installation');
    expect(run.code).toBe(0);
    expect(Buffer.compare(installedBinary(run), Buffer.from(GOOD_BINARY))).toBe(0);
    expect(Buffer.compare(installedDb(run), Buffer.from(GOOD_DB))).toBe(0);
    expect(run.stdout).toContain(`Checksum verified: ${ASSET}`);
    expect(run.stdout).toContain('Checksum verified: phage.db');
    expect(leftovers(run)).toEqual([]);
    // The lock directory and the downloaded sha256.txt are both gone.
    expect(readdirSync(run.tmp).filter((name) => name.startsWith('phage-explorer-'))).toEqual([]);
  });

  test('a fresh default install includes the release catalog and verifies its bytes', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB }, { databaseMode: 'default' });
    expect(run.code).toBe(0);
    expect(installedDb(run)).toEqual(Buffer.from(GOOD_DB));
    expect(run.stdout).toContain('Checksum verified: phage.db');
    expect(leftovers(run)).toEqual([]);
  });

  test('a default upgrade keeps an existing catalog even if the release has no database asset', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB, plainDb: false },
      { previous: true, databaseMode: 'default' });
    expect(run.code).toBe(0);
    expect(installedBinary(run)).toEqual(Buffer.from(GOOD_BINARY));
    expect(installedDb(run)).toEqual(Buffer.from(OLD_DB));
    expect(run.stdout).toContain('Keeping the existing catalog');
  });

  test('a default upgrade replaces an unmodified older release catalog with verified bytes', () => {
    const run = runPrepared(prepareReleasedCatalog({ binary: GOOD_BINARY, db: GOOD_DB }));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Updating the unmodified release catalog');
    expect(installedDb(run)).toEqual(Buffer.from(GOOD_DB));
    expect(installedBinary(run)).toEqual(Buffer.from(GOOD_BINARY));
    expect(leftovers(run)).toEqual([]);
  });

  test('failure to publish the binary restores the automatically upgraded catalog', () => {
    const prepared = prepareReleasedCatalog({ binary: GOOD_BINARY, db: GOOD_DB });
    const wrapper = join(prepared.tmp, 'old-release');
    writeFileSync(join(wrapper, 'mv'), `#!${SHELL}
case "$2" in */.phage-explorer.download.*) exit 1 ;; esac
exec "${Bun.which('mv')}" "$@"
`, { mode: 0o755 });
    const run = runPrepared(prepared);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain('Updating the unmodified release catalog');
    expectUnchanged(run);
  });

  test.each(['explicit', 'fallback'])('a tagged %s source build upgrades a known old catalog', (mode) => {
    const prepared = prepareReleasedCatalog({ binary: GOOD_BINARY, db: GOOD_DB },
      { args: mode === 'explicit' ? ['--from-source'] : [] });
    if (mode === 'fallback') {
      const asset = join(prepared.tmp, '../release', ASSET);
      renameSync(asset, asset + '.unavailable');
    }
    provideTaggedSource(prepared, { sha256: sha256(GOOD_DB) });
    const run = runPrepared(prepared);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Updating the unmodified release catalog');
    expect(installedBinary(run)).toEqual(Buffer.from(GOOD_BINARY));
    expect(installedDb(run)).toEqual(Buffer.from(GOOD_DB));
    expect(leftovers(run)).toEqual([]);
  });

  test('stages the native .exe and verified catalog on Windows after a missing release binary', () => {
    const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB });
    provideTaggedSource(prepared, { sha256: sha256(GOOD_DB) }, true);
    const run = runPrepared(prepared);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('falling back to source build');
    expect(readFileSync(join(run.dest, 'phage-explorer.exe'))).toEqual(Buffer.from(GOOD_BINARY));
    expect(installedDb(run)).toEqual(Buffer.from(GOOD_DB));
    expect(leftovers(run)).toEqual([]);
  });

  test('installs an exact non-tip commit and its catalog through Git without consulting releases', () => {
    const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB }, { version: '', databaseMode: 'default' });
    const git = Bun.which('git')!;
    const repo = join(prepared.tmp, 'history');
    const data = join(repo, 'packages/web/public');
    mkdirSync(data, { recursive: true });
    const runGit = (...args: string[]) => {
      const result = Bun.spawnSync([git, '-C', repo, ...args], { env: { ...process.env, HOME: prepared.home } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    runGit('init', '-q');
    runGit('config', 'user.name', 'Installer fixture');
    runGit('config', 'user.email', 'installer@example.invalid');
    runGit('config', '--global', `url.file://${repo}.insteadOf`, 'https://github.com/Dicklesworthstone/phage_explorer.git');
    writeFileSync(join(data, 'phage.db'), GOOD_DB);
    writeFileSync(join(data, 'phage.db.manifest.json'), JSON.stringify({ sha256: sha256(GOOD_DB) }));
    writeFileSync(join(repo, 'program'), GOOD_BINARY);
    mkdirSync(join(repo, 'fixture-lib'));
    writeFileSync(join(repo, 'fixture-lib/package.json'), JSON.stringify({ name: 'fixture-lib', version: '1.0.0' }));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({
      name: 'revision-install-fixture', dependencies: { 'fixture-lib': 'file:./fixture-lib' },
      scripts: { build: 'mkdir -p dist && cp program dist/phage-explorer' },
    }));
    const lock = Bun.spawnSync([process.execPath, 'install', '--lockfile-only'], { cwd: repo });
    expect(lock.exitCode).toBe(0);
    runGit('add', '.');
    runGit('commit', '-qm', 'Pinned build');
    const requested = runGit('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'program'), OLD_BINARY);
    writeFileSync(join(data, 'phage.db'), OLD_DB);
    runGit('commit', '-qam', 'Different branch tip');
    runGit('rm', '--cached', 'bun.lock');
    runGit('commit', '-qm', 'Missing dependency lock');
    const unlocked = runGit('rev-parse', 'HEAD');
    symlinkSync(git, join(prepared.env.PATH, 'git'));
    symlinkSync(process.execPath, join(prepared.env.PATH, 'bun'));
    writeFileSync(join(prepared.env.PATH, 'curl'), '#!/bin/sh\n: > "$TMPDIR/contacted-release"\nexit 1\n', { mode: 0o755 });
    prepared.argv.push('--revision', requested.toUpperCase());
    const run = runPrepared(prepared);
    expect(run.code).toBe(0);
    expect(installedBinary(run)).toEqual(Buffer.from(GOOD_BINARY));
    expect(installedDb(run)).toEqual(Buffer.from(GOOD_DB));
    expect(existsSync(join(prepared.tmp, 'contacted-release'))).toBe(false);

    prepared.argv[prepared.argv.length - 1] = unlocked;
    const withoutLock = runPrepared(prepared);
    expect(withoutLock.code).not.toBe(0);
    expect(withoutLock.stderr).toContain('no Bun lockfile');
    expect(installedBinary(withoutLock)).toEqual(Buffer.from(GOOD_BINARY));

    prepared.argv[prepared.argv.length - 1] = 'f'.repeat(40);
    const missing = runPrepared(prepared);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('Cannot check out requested commit');
    expect(installedBinary(missing)).toEqual(Buffer.from(GOOD_BINARY));
    expect(installedDb(missing)).toEqual(Buffer.from(GOOD_DB));
  });

  test.each([
    { revision: 'main', version: '', message: 'full 40-character' },
    { revision: 'a'.repeat(40), version: VERSION, message: 'Choose one install target' },
  ])('rejects an ambiguous or invalid revision before changing an installation', ({ revision, version, message }) => {
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB },
      { previous: true, version, args: ['--revision', revision] });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(message);
    expectUnchanged(run);
  });

  test('a corrupt source catalog aborts before replacing either installed file', () => {
    const prepared = prepareReleasedCatalog({ binary: GOOD_BINARY, db: GOOD_DB }, { args: ['--from-source'] });
    provideTaggedSource(prepared, { sha256: sha256(flipped(GOOD_DB)) });
    const run = runPrepared(prepared);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Checksum mismatch');
    expectUnchanged(run);
  });

  test('source upgrades preserve custom catalogs and require a top-level target checksum', () => {
    const release = { binary: GOOD_BINARY, db: GOOD_DB };
    const custom = prepareInstall(release, { previous: true, databaseMode: 'default', args: ['--from-source'] });
    const missingSum = prepareReleasedCatalog(release, { args: ['--from-source'] });
    provideTaggedSource(custom, { sha256: sha256(GOOD_DB) });
    provideTaggedSource(missingSum, { artifacts: { gzip: { sha256: sha256(GOOD_DB) } } });
    for (const prepared of [custom, missingSum]) {
      const run = runPrepared(prepared);
      expect(run.code).toBe(0);
      expect(installedBinary(run)).toEqual(Buffer.from(GOOD_BINARY));
      expect(installedDb(run)).toEqual(Buffer.from(OLD_DB));
      if (prepared === custom) expect(run.stderr).toContain('differs from the catalog shipped');
    }
  });

  test('a pinned downgrade and a release missing its database checksum both preserve a known catalog', () => {
    const release = { binary: GOOD_BINARY, db: GOOD_DB };
    const cases = [
      prepareReleasedCatalog(release, { version: 'v1.4.0' }),
      prepareReleasedCatalog({ ...release, sums: [`${sha256(GOOD_BINARY)}  ${ASSET}`] }),
      prepareReleasedCatalog(release, { args: ['--insecure-skip-checksums'] }),
    ];
    for (const prepared of cases) {
      const run = runPrepared(prepared);
      expect(run.code).toBe(0);
      expect(installedDb(run)).toEqual(Buffer.from(OLD_DB));
      expect(installedBinary(run)).toEqual(Buffer.from(GOOD_BINARY));
    }
  });

  test('a catalog edited while the new database downloads survives the upgrade', () => {
    const prepared = prepareReleasedCatalog({ binary: GOOD_BINARY, db: GOOD_DB });
    const wrapper = join(prepared.tmp, 'old-release');
    writeFileSync(join(wrapper, 'cp'), `#!${SHELL}
case "$1" in */release/phage.db) echo 'local edits' > "$HOME/.phage-explorer/phage.db" ;; esac
exec "${Bun.which('cp')}" "$@"
`, { mode: 0o755 });
    const run = runPrepared(prepared);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('catalog changed during the upgrade');
    expect(installedDb(run).toString()).toBe('local edits\n');
    expect(installedBinary(run)).toEqual(Buffer.from(OLD_BINARY));
    expect(leftovers(run)).toEqual([]);
  });

  test('a symlink to an older catalog remains a symlink', () => {
    const prepared = prepareReleasedCatalog({ binary: GOOD_BINARY, db: GOOD_DB });
    const catalog = join(prepared.home, '.phage-explorer', 'phage.db');
    renameSync(catalog, catalog + '.managed');
    symlinkSync(catalog + '.managed', catalog);
    const run = runPrepared(prepared);
    expect(run.code).toBe(0);
    expect(lstatSync(catalog).isSymbolicLink()).toBe(true);
    expect(installedDb(run)).toEqual(Buffer.from(OLD_DB));
  });

  test('an older catalog with a local SQLite journal is preserved', () => {
    const prepared = prepareReleasedCatalog({ binary: GOOD_BINARY, db: GOOD_DB });
    const journal = join(prepared.home, '.phage-explorer', 'phage.db-wal');
    writeFileSync(journal, 'pending local updates');
    const run = runPrepared(prepared);
    expect(run.code).toBe(0);
    expect(installedDb(run)).toEqual(Buffer.from(OLD_DB));
    expect(readFileSync(journal, 'utf8')).toBe('pending local updates');
  });

  test('an explicit replacement preserves committed WAL data until the writer closes', () => {
    const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB }, { previous: true });
    const catalog = join(prepared.home, '.phage-explorer', 'phage.db');
    writeFileSync(catalog, '');
    const writer = new Database(catalog);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES ('saved locally')");
      const before = [catalog, catalog + '-wal', catalog + '-shm'].map(path => readFileSync(path));
      const run = runPrepared(prepared);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('SQLite');
      expect(installedBinary(run)).toEqual(Buffer.from(OLD_BINARY));
      expect([catalog, catalog + '-wal', catalog + '-shm'].map(path => readFileSync(path))).toEqual(before);
      expect(writer.query('SELECT body FROM notes').get()).toEqual({ body: 'saved locally' });
      expect(leftovers(run)).toEqual([]);
    } finally { writer.close(); }
    const retry = runPrepared(prepared);
    expect(retry.code).toBe(0);
    expect(installedDb(retry)).toEqual(Buffer.from(GOOD_DB));
  });

  test.each(['-wal', '-shm', '-journal'])('a first install preserves an orphaned SQLite %s sidecar', suffix => {
    const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB }, { databaseMode: 'default' });
    const data = join(prepared.home, '.phage-explorer');
    mkdirSync(data);
    const sidecar = join(data, 'phage.db' + suffix);
    symlinkSync(join(data, 'missing'), sidecar);
    const run = runPrepared(prepared);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('SQLite');
    expect(lstatSync(sidecar).isSymbolicLink()).toBe(true);
    expect(existsSync(join(data, 'phage.db'))).toBe(false);
    expect(existsSync(join(run.dest, 'phage-explorer'))).toBe(false);
    expect(leftovers(run)).toEqual([]);
  });

  test('a default upgrade over a different catalog keeps it, warns and names the replacing command', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB }, { previous: true, databaseMode: 'default' });
    expect(run.code).toBe(0);
    expect(installedBinary(run)).toEqual(Buffer.from(GOOD_BINARY));
    expect(installedDb(run)).toEqual(Buffer.from(OLD_DB));
    expect(run.stderr).toContain(`differs from the catalog shipped with ${VERSION}`);
    expect(run.stderr).toContain('install.sh | bash -s -- --with-database');
    expect(leftovers(run)).toEqual([]);
  });

  test('a default upgrade over the release catalog keeps it without a warning', () => {
    const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB }, { previous: true, databaseMode: 'default' });
    writeFileSync(join(prepared.home, '.phage-explorer', 'phage.db'), GOOD_DB);
    const run = runPrepared(prepared);
    expect(run.code).toBe(0);
    expect(installedDb(run)).toEqual(Buffer.from(GOOD_DB));
    expect(run.stdout).toContain('Keeping the existing catalog');
    expect(run.stderr).not.toContain('differs from the catalog');
  });

  test('stays silent about a kept catalog when the release gives nothing reliable to compare', () => {
    const cases: [Release, string[]][] = [
      [{ binary: GOOD_BINARY, db: GOOD_DB, sums: [`${sha256(GOOD_BINARY)}  ${ASSET}`] }, []],
      [{ binary: GOOD_BINARY, db: GOOD_DB, sums: null, sidecar: `${sha256(GOOD_BINARY)}  ${ASSET}\n` }, []],
      [{ binary: GOOD_BINARY, db: GOOD_DB }, ['--insecure-skip-checksums']],
    ];
    for (const [release, args] of cases) {
      const run = runInstaller(release, { previous: true, databaseMode: 'default', args });
      expect(run.code).toBe(0);
      expect(installedBinary(run)).toEqual(Buffer.from(GOOD_BINARY));
      expect(installedDb(run)).toEqual(Buffer.from(OLD_DB));
      expect(run.stderr).not.toContain('differs from the catalog');
    }
  });

  test('--with-database replaces a different catalog without the kept-catalog warning', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB }, { previous: true });
    expect(run.code).toBe(0);
    expect(installedDb(run)).toEqual(Buffer.from(GOOD_DB));
    expect(run.stderr).not.toContain('differs from the catalog');
  });

  test('a binary-only install leaves the catalog directory uncreated', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB, plainDb: false }, { databaseMode: 'skip' });
    expect(run.code).toBe(0);
    expect(existsSync(join(run.home, '.phage-explorer'))).toBe(false);
  });

  for (const kind of ['file', 'directory', 'symlink'] as const) {
    test(`a competing ${kind} at the catalog destination survives a first install`, () => {
      const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB }, { databaseMode: 'default' });
      const wrapper = join(prepared.tmp, 'concurrent-catalog');
      mkdirSync(wrapper);
      // Interpose at publication, after all preflight checks.
      writeFileSync(join(wrapper, 'ln'), `#!${SHELL}
target="$HOME/.phage-explorer/phage.db"
case "${kind}" in
  file) printf 'concurrent catalog' >"$target" ;;
  directory) mkdir "$target" ;;
  symlink) mkdir "$TMPDIR/other"; "${Bun.which('ln')}" -s "$TMPDIR/other" "$target" ;;
esac
exec "${Bun.which('ln')}" "$@"
`, { mode: 0o755 });
      prepared.env.PATH = wrapper + ':' + prepared.env.PATH;
      const run = runPrepared(prepared);
      expect(run.code).not.toBe(0);
      const target = join(run.home, '.phage-explorer', 'phage.db');
      if (kind === 'file') expect(installedDb(run).toString()).toBe('concurrent catalog');
      else {
        expect(lstatSync(target).isSymbolicLink()).toBe(kind === 'symlink');
        expect(readdirSync(target)).toEqual([]);
      }
      expect(existsSync(join(run.dest, 'phage-explorer'))).toBe(false);
      expect(leftovers(run)).toEqual([]);
    });
  }

  for (const replaceLinkedFile of [false, true]) {
    test(`a failed binary rename rolls back only our own freshly linked catalog (replaced=${replaceLinkedFile})`, () => {
      const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB }, { databaseMode: 'default' });
      const wrapper = join(prepared.tmp, 'fail-binary-rename');
      mkdirSync(wrapper);
      writeFileSync(join(wrapper, 'mv'), `#!${SHELL}
case "$2" in
  */.phage-explorer.download.*)
    if [ "${replaceLinkedFile}" = true ]; then
      printf 'concurrent replacement' >"$HOME/.phage-explorer/other.db"
      "${Bun.which('mv')}" -f "$HOME/.phage-explorer/other.db" "$HOME/.phage-explorer/phage.db"
    fi
    exit 1 ;;
esac
exec "${Bun.which('mv')}" "$@"
`, { mode: 0o755 });
      prepared.env.PATH = wrapper + ':' + prepared.env.PATH;
      const run = runPrepared(prepared);
      expect(run.code).not.toBe(0);
      if (replaceLinkedFile) expect(installedDb(run).toString()).toBe('concurrent replacement');
      else expect(existsSync(join(run.home, '.phage-explorer', 'phage.db'))).toBe(false);
      expect(existsSync(join(run.dest, 'phage-explorer'))).toBe(false);
      expect(leftovers(run)).toEqual([]);
    });
  }

  test('a fresh default install rejects a corrupt catalog before publishing the binary', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: flipped(GOOD_DB) }, { databaseMode: 'default' });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Checksum mismatch for phage.db');
    expect(existsSync(join(run.dest, 'phage-explorer'))).toBe(false);
    expect(existsSync(join(run.home, '.phage-explorer', 'phage.db'))).toBe(false);
    expect(leftovers(run)).toEqual([]);
  });

  test('refuses a binary whose bytes differ from sha256.txt and changes nothing', () => {
    const run = runInstaller({ binary: flipped(GOOD_BINARY), db: GOOD_DB }, { previous: true });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`Checksum mismatch for ${ASSET}`);
    expectUnchanged(run);
  });

  test('refuses a database whose bytes differ from sha256.txt and installs neither artifact', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: flipped(GOOD_DB) }, { previous: true });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Checksum mismatch for phage.db');
    expectUnchanged(run);
  });

  for (const destination of ['binary', 'database'] as const) {
    test(`refuses a directory at the ${destination} path before replacing either artifact`, () => {
      const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB }, { previous: true });
      const path = destination === 'binary'
        ? join(prepared.dest, 'phage-explorer')
        : join(prepared.home, '.phage-explorer', 'phage.db');
      renameSync(path, path + '.old');
      mkdirSync(path);
      const run = runPrepared(prepared);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(path);
      expect(readdirSync(path)).toEqual([]);
      const unaffected = destination === 'binary' ? installedDb(run) : installedBinary(run);
      expect(unaffected).toEqual(Buffer.from(destination === 'binary' ? OLD_DB : OLD_BINARY));
      expect(leftovers(run)).toEqual([]);
    });
  }

  for (const previous of [false, true]) {
    for (const failure of ['rename-error', 'term-between-renames'] as const) {
      test(`${failure} rolls back the ${previous ? 'upgrade' : 'new installation'}`, () => {
        const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB }, { previous });
        const wrapper = join(prepared.tmp, 'inject-failure');
        mkdirSync(wrapper);
        writeFileSync(join(wrapper, 'mv'), `#!${SHELL}
case "$2" in
  */.phage-explorer.download.*|*/.phage.db.download.*)
    if [ -e "$TMPDIR/first-rename" ]; then
      exit 1
    fi ;;
  *) exec "${Bun.which('mv')}" "$@" ;;
esac
"${Bun.which('mv')}" "$@" || exit 1
: >"$TMPDIR/first-rename"
if [ "${failure}" = term-between-renames ]; then kill -TERM "$PPID"; fi
`, { mode: 0o755 });
        prepared.env.PATH = wrapper + ':' + prepared.env.PATH;
        const run = runPrepared(prepared);
        expect(run.code).toBe(failure === 'rename-error' ? 1 : 143);
        if (previous) {
          expectUnchanged(run);
        } else {
          expect(existsSync(join(run.dest, 'phage-explorer'))).toBe(false);
          expect(existsSync(join(run.home, '.phage-explorer', 'phage.db'))).toBe(false);
          expect(leftovers(run)).toEqual([]);
        }
      });
    }
  }

  test('refuses a release whose sha256.txt has no phage.db entry', () => {
    const run = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB, sums: [`${sha256(GOOD_BINARY)}  ${ASSET}`] },
      { previous: true }
    );
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('publishes no SHA-256 for phage.db');
    expectUnchanged(run);
  });

  test('without any SHA-256 tool it fails instead of skipping the check', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB }, { previous: true, hashTools: false });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Cannot compute the SHA-256');
    expectUnchanged(run);
  });

  test('a database that cannot be downloaded fails the install', () => {
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB, plainDb: false }, { previous: true });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Could not download the database');
    expectUnchanged(run);
  });

  test('accepts phage.db.gz only when the decompressed bytes match phage.db', () => {
    const good = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB, gz: gzipSync(GOOD_DB), plainDb: false });
    expect(good.code).toBe(0);
    expect(Buffer.compare(installedDb(good), Buffer.from(GOOD_DB))).toBe(0);

    const bad = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB, gz: gzipSync(flipped(GOOD_DB)), plainDb: false },
      { previous: true }
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('Checksum mismatch for phage.db (from phage.db.gz)');
    expectUnchanged(bad);
  });

  test('the explicit opt-out installs unverified bytes and says so loudly', () => {
    const run = runInstaller(
      { binary: flipped(GOOD_BINARY), db: GOOD_DB },
      { args: ['--insecure-skip-checksums'] }
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('WITHOUT SHA-256 verification');
    expect(run.stderr).toContain(`NOT VERIFIED (--insecure-skip-checksums): ${ASSET}`);
    expect(Buffer.compare(installedBinary(run), Buffer.from(flipped(GOOD_BINARY)))).toBe(0);
  });

  test('a lock held by a running installer blocks a second one', () => {
    const holder = Bun.spawn(['sleep', '10']);
    try {
      const run = runInstaller(
        { binary: GOOD_BINARY, db: GOOD_DB },
        {
          previous: true,
          before: (tmp) => {
            const lock = join(tmp, `phage-explorer-install-${process.getuid?.()}.lock.d`);
            mkdirSync(lock);
            writeFileSync(join(lock, 'pid'), `${holder.pid}\n`);
          },
        }
      );
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('Another installation is in progress');
      expectUnchanged(run);
    } finally {
      holder.kill();
    }
  });

  test('a lock left by an installer that is no longer running is retired', () => {
    const gone = Bun.spawnSync(['sh', '-c', 'echo $$']);
    const deadPid = gone.stdout.toString().trim();
    const run = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB },
      {
        before: (tmp) => {
          const lock = join(tmp, `phage-explorer-install-${process.getuid?.()}.lock.d`);
          mkdirSync(lock);
          writeFileSync(join(lock, 'pid'), `${deadPid}\n`);
        },
      }
    );
    expect(run.code).toBe(0);
    expect(Buffer.compare(installedBinary(run), Buffer.from(GOOD_BINARY))).toBe(0);
    // The retired lock was replaced by this installer's own and then released.
    expect(existsSync(join(run.tmp, `phage-explorer-install-${process.getuid?.()}.lock.d`))).toBe(false);
  });

  test('falls back to the binary\'s .sha256 sidecar and still refuses a wrong one', () => {
    const good = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB, sums: null, sidecar: `${sha256(GOOD_BINARY)}  ${ASSET}\n` },
      { databaseMode: 'skip' }
    );
    expect(good.code).toBe(0);
    expect(Buffer.compare(installedBinary(good), Buffer.from(GOOD_BINARY))).toBe(0);

    const bad = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB, sums: null, sidecar: `${sha256(OLD_BINARY)}  ${ASSET}\n` },
      { databaseMode: 'skip', previous: true }
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain(`Checksum mismatch for ${ASSET}`);
    expectUnchanged(bad);
  });

  // GNU sha256sum and shasum escape a path containing a backslash and prefix
  // the digest with one; the installer hashes from stdin so the digest stays
  // bare. Each available tool is exercised on its own, which also covers the
  // fall-through to shasum and to openssl.
  for (const tool of ['sha256sum', 'shasum', 'openssl']) {
    test.skipIf(!Bun.which(tool))(`verifies with only ${tool} when the install directory name contains a backslash`, () => {
      const run = runInstaller(
        { binary: GOOD_BINARY, db: GOOD_DB },
        { destName: 'C\\tools', hashTools: tool === 'shasum' ? ['shasum', 'perl'] : [tool] }
      );
      expect(run.stderr).not.toContain('Cannot compute the SHA-256');
      expect(run.code).toBe(0);
      expect(Buffer.compare(installedBinary(run), Buffer.from(GOOD_BINARY))).toBe(0);
      expect(Buffer.compare(installedDb(run), Buffer.from(GOOD_DB))).toBe(0);
    });
  }

  test('upgrades in place when the install directory, HOME and TMPDIR contain spaces', () => {
    const run = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB },
      { previous: true, destName: 'my bin', homeName: 'home dir', tmpName: 'tmp dir' }
    );
    expect(run.code).toBe(0);
    expect(Buffer.compare(installedBinary(run), Buffer.from(GOOD_BINARY))).toBe(0);
    expect(Buffer.compare(installedDb(run), Buffer.from(GOOD_DB))).toBe(0);
    expect(leftovers(run)).toEqual([]);
    expect(existsSync(mkdirLockPath(run.tmp))).toBe(false);
  });

  test('a symlink planted at the lock directory path is refused and nothing changes', () => {
    let target = '';
    const run = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB },
      {
        previous: true,
        before: (tmp) => {
          target = join(tmp, 'elsewhere');
          mkdirSync(target);
          symlinkSync(target, mkdirLockPath(tmp));
        },
      }
    );
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Install lock path exists but is not a directory');
    expectUnchanged(run);
    expect(readdirSync(target)).toEqual([]);
    expect(lstatSync(mkdirLockPath(run.tmp)).isSymbolicLink()).toBe(true);
  });

  // Ctrl+C reaches the whole foreground process group, so the stalled download
  // and the installer are signalled together, as they are here.
  for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    test(`${signal} during the download exits ${status}, keeps the previous install and releases the lock`, async () => {
      const prepared = prepareInstall({ binary: GOOD_BINARY, db: GOOD_DB }, { previous: true, stallOn: ASSET });
      const child = spawn(prepared.argv[0], prepared.argv.slice(1), {
        env: prepared.env,
        detached: true,
        stdio: 'ignore',
      });
      const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
      const deadline = Date.now() + 20_000;
      while (!existsSync(prepared.stallMarker)) {
        if (Date.now() > deadline) throw new Error('the binary download never started');
        await Bun.sleep(25);
      }
      const run: Run = { ...prepared, code: -1, stdout: '', stderr: '' };
      // The interrupted download is a real partial file beside the binary.
      expect(leftovers(run)).toHaveLength(1);
      expect(existsSync(mkdirLockPath(prepared.tmp))).toBe(true);
      process.kill(-child.pid!, signal);
      expect(await exited).toBe(status);
      expectUnchanged(run);
      expect(existsSync(mkdirLockPath(prepared.tmp))).toBe(false);
      // Nothing still holds the lock: the next installer runs to completion.
      const next = runPrepared(prepared);
      expect(next.code).toBe(0);
      expect(Buffer.compare(installedBinary(next), Buffer.from(GOOD_BINARY))).toBe(0);
      expect(Buffer.compare(installedDb(next), Buffer.from(GOOD_DB))).toBe(0);
    }, 30_000);
  }
});

describe.skipIf(!supported || !Bun.which('flock'))('install.sh where flock exists', () => {
  test('a symlink planted at the lock file path is refused, and neither target is touched or created', () => {
    let victim = '';
    const planted = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB },
      {
        flock: true,
        previous: true,
        before: (tmp) => {
          victim = join(tmp, 'victim.txt');
          writeFileSync(victim, 'keep these bytes\n');
          symlinkSync(victim, flockPath(tmp));
        },
      }
    );
    expect(planted.code).not.toBe(0);
    expect(planted.stderr).toContain('Install lock path is a symlink');
    expectUnchanged(planted);
    expect(readFileSync(victim, 'utf8')).toBe('keep these bytes\n');

    let missing = '';
    const dangling = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB },
      {
        flock: true,
        previous: true,
        before: (tmp) => {
          missing = join(tmp, 'not-created');
          symlinkSync(missing, flockPath(tmp));
        },
      }
    );
    expect(dangling.code).not.toBe(0);
    expect(dangling.stderr).toContain('Install lock path is a symlink');
    expectUnchanged(dangling);
    expect(existsSync(missing)).toBe(false);
  });

  test('a held flock blocks a second installer and a free one installs', () => {
    const free = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB }, { flock: true });
    expect(free.code).toBe(0);

    let holder: ReturnType<typeof Bun.spawn> | undefined;
    const run = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB },
      {
        flock: true,
        previous: true,
        before: (tmp) => {
          const lock = join(tmp, `phage-explorer-install-${process.getuid?.()}.lock`);
          holder = Bun.spawn([Bun.which('flock')!, lock, 'sleep', '10']);
          Bun.sleepSync(300);
        },
      }
    );
    holder?.kill();
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Another installation is in progress');
    expectUnchanged(run);
  });
});

/**
 * The published release, end to end: real curl, real GitHub assets.
 * Opt-in because it downloads the platform binary and the 11 MB database.
 */
describe.skipIf(!supported || process.env.PHAGE_INSTALLER_LIVE !== '1')('install.sh against the published release', () => {
  // Defaults to the release this tree is versioned as.
  const liveVersion = process.env.PHAGE_INSTALLER_LIVE_VERSION ?? `v${treeVersion}`;

  function runLive(extra: string[], version = liveVersion, root = mkdtempSync(join(tmpdir(), 'phage-install-live-'))) {
    const home = join(root, 'home');
    const dest = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    // Retain the network path and certificate trust used by the checksum fetch.
    // HOME, install paths and release selection remain isolated for each run.
    const transport = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(https?_proxy|all_proxy|no_proxy|ssl_cert_file|ssl_cert_dir|curl_ca_bundle)$/i.test(key)));
    const result = Bun.spawnSync([SHELL, INSTALLER, '--dest', dest, '--version', version, ...extra], {
      env: { ...transport, PATH: '/usr/bin:/bin', HOME: home, TMPDIR: root },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { result, home, dest, root };
  }

  test.each(['fresh', 'upgrade'] as const)('verifies the published binary and catalog on %s install', async (mode) => {
    const sums = await (
      await fetch(`https://github.com/Dicklesworthstone/phage_explorer/releases/download/${liveVersion}/sha256.txt`, {
        headers: { 'User-Agent': 'phage-explorer-installer-test (+https://github.com/Dicklesworthstone/phage_explorer)' },
      })
    ).text();
    const published = new Map(
      sums.trim().split('\n').map((line) => {
        const [sum, name] = line.trim().split(/\s+/);
        return [name.replace(/^\*/, ''), sum.toLowerCase()] as const;
      })
    );
    let previousRoot: string | undefined;
    if (mode === 'upgrade') {
      const previous = runLive(['--with-database'], 'v1.4.1');
      expect(previous.result.exitCode, previous.result.stderr.toString()).toBe(0);
      expect(sha256(readFileSync(join(previous.home, '.phage-explorer', 'phage.db')))).toBe(V141_DB_SHA);
      previousRoot = previous.root;
    }
    const { result, home, dest } = runLive(mode === 'fresh' ? ['--with-database'] : [], liveVersion, previousRoot);
    expect(result.stderr.toString()).not.toContain('Another installation');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(sha256(readFileSync(join(dest, 'phage-explorer')))).toBe(published.get(ASSET)!);
    expect(sha256(readFileSync(join(home, '.phage-explorer', 'phage.db')))).toBe(published.get('phage.db')!);
    const version = Bun.spawnSync([join(dest, 'phage-explorer'), '--version'], {
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdin: 'ignore',
    });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toContain(liveVersion.replace(/^v/, ''));
  }, 600_000);
});
