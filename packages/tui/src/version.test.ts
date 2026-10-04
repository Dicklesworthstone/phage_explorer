import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
