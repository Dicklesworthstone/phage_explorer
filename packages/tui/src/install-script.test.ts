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
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
function toolDir(root: string, releaseDir: string, opts: { hashTools: boolean; flock?: boolean }) {
  const dir = join(root, 'tools');
  mkdirSync(dir);
  const names = [...BASE_TOOLS, ...(opts.hashTools ? HASH_TOOLS : []), ...(opts.flock ? ['flock'] : [])];
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
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
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

function runInstaller(
  release: Release,
  opts: {
    args?: string[];
    hashTools?: boolean;
    flock?: boolean;
    previous?: boolean;
    withDb?: boolean;
    destName?: string;
    before?: (tmp: string) => void;
  } = {}
): Run {
  const root = mkdtempSync(join(tmpdir(), 'phage-install-'));
  const home = join(root, 'home');
  const dest = join(root, opts.destName ?? 'bin');
  const tmp = join(root, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  if (opts.previous) {
    mkdirSync(dest);
    writeFileSync(join(dest, 'phage-explorer'), OLD_BINARY, { mode: 0o755 });
    mkdirSync(join(home, '.phage-explorer'));
    writeFileSync(join(home, '.phage-explorer', 'phage.db'), OLD_DB);
  }
  const releaseDir = makeRelease(root, release);
  const tools = toolDir(root, releaseDir, { hashTools: opts.hashTools ?? true, flock: opts.flock });
  opts.before?.(tmp);
  const result = Bun.spawnSync(
    [SHELL, INSTALLER, '--dest', dest, ...(opts.withDb === false ? [] : ['--with-database']), ...(opts.args ?? [])],
    {
      env: { PATH: tools, HOME: home, TMPDIR: tmp, VERSION },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    home,
    dest,
    tmp,
  };
}

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
      { withDb: false }
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain(`Checksum mismatch for ${ASSET}`);
  });

  test('verifies when the install directory name contains a backslash', () => {
    // sha256sum and shasum escape such paths and prefix the digest with a
    // backslash; the installer hashes from stdin so the digest stays bare.
    const run = runInstaller({ binary: GOOD_BINARY, db: GOOD_DB }, { destName: 'C\\tools' });
    expect(run.code).toBe(0);
    expect(Buffer.compare(installedBinary(run), Buffer.from(GOOD_BINARY))).toBe(0);
  });
});

describe.skipIf(!supported || !Bun.which('flock'))('install.sh where flock exists', () => {
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
