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
  'awk', 'cat', 'chmod', 'cp', 'gunzip', 'gzip', 'head', 'id', 'mkdir', 'mktemp',
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
  opts: { hashTools: boolean | string[]; flock?: boolean; stallOn?: string; stallMarker?: string }
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
  https://github.com/Dicklesworthstone/phage_explorer/releases/download/${VERSION}/*) ;;
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
  withDb?: boolean;
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
    hashTools: opts.hashTools ?? true,
    flock: opts.flock,
    stallOn: opts.stallOn,
    stallMarker,
  });
  opts.before?.(tmp);
  const argv = [SHELL, INSTALLER, '--dest', dest, ...(opts.withDb === false ? [] : ['--with-database']), ...(opts.args ?? [])];
  const env = { PATH: tools, HOME: home, TMPDIR: tmp, VERSION };
  return { argv, env, home, dest, tmp, stallMarker };
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
].filter((name) => name.includes('.download.'));

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
      { withDb: false }
    );
    expect(good.code).toBe(0);
    expect(Buffer.compare(installedBinary(good), Buffer.from(GOOD_BINARY))).toBe(0);

    const bad = runInstaller(
      { binary: GOOD_BINARY, db: GOOD_DB, sums: null, sidecar: `${sha256(OLD_BINARY)}  ${ASSET}\n` },
      { withDb: false, previous: true }
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

  function runLive(extra: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'phage-install-live-'));
    const home = join(root, 'home');
    const dest = join(root, 'bin');
    mkdirSync(home);
    const result = Bun.spawnSync([SHELL, INSTALLER, '--dest', dest, '--version', liveVersion, ...extra], {
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: root },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { result, home, dest };
  }

  test('installs the published binary and database with their published checksums', async () => {
    const sums = await (
      await fetch(`https://github.com/Dicklesworthstone/phage_explorer/releases/download/${liveVersion}/sha256.txt`, {
        headers: { 'User-Agent': 'OpenAI File Downloader, XaiImageApiFetch/1.0' },
      })
    ).text();
    const published = new Map(
      sums.trim().split('\n').map((line) => {
        const [sum, name] = line.trim().split(/\s+/);
        return [name.replace(/^\*/, ''), sum.toLowerCase()] as const;
      })
    );
    const { result, home, dest } = runLive(['--with-database']);
    expect(result.stderr.toString()).not.toContain('Another installation');
    expect(result.exitCode).toBe(0);
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
