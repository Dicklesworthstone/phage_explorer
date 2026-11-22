import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableBuildOptions, executableCompileArgs, EXECUTABLE_WORKERS } from '../../../scripts/build';

async function run(args: string[], cwd: string, isolated = false) {
  const child = Bun.spawn(args, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    ...(isolated ? { env: { ...process.env, PATH: cwd, NODE_PATH: '', NODE_OPTIONS: '' } } : {}) });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

it('embeds the genomic search producer and runs it from a relocated native executable', async () => {
  const directory = () => mkdtemp(join(tmpdir(), 'phage-native-search-'));
  const staging = await directory(), isolated = await directory(), retained = await directory();
  const manifest = EXECUTABLE_WORKERS.find(worker => worker.define === 'PHAGE_SEARCH_WORKER');
  assert(manifest, 'the production worker manifest must embed the search producer');
  const helper = fileURLToPath(new URL('./terminal-search.ts', import.meta.url));
  const entry = join(staging, 'index.ts');
  await writeFile(entry, `import { runTerminalSearch } from ${JSON.stringify(helper)};
    const result = await runTerminalSearch({mode:'motif',query:'AAA',sequence:'AAAAATTT',features:[],options:{strand:'both'}}, new AbortController().signal);
    process.stdout.write(JSON.stringify(result));`, { flag: 'wx' });
  const options = executableBuildOptions(staging);
  // Exercise the real native helper and the production search-worker entry,
  // defines and compile route without compiling unrelated scientific workers.
  const workerEntry = (options.entrypoints as string[]).find(path => path.endsWith(manifest.source));
  assert(workerEntry);
  const bundled = await Bun.build({ ...options, entrypoints: [entry, workerEntry] });
  assert.equal(bundled.success, true, bundled.logs.map(String).join('\n'));
  const name = process.platform === 'win32' ? 'search-native.exe' : 'search-native';
  const unusedWorkers = new Set(EXECUTABLE_WORKERS.filter(worker => worker !== manifest).map(worker => join(staging, worker.bundle)));
  const args = executableCompileArgs(staging, join(staging, name)).filter(arg => !unusedWorkers.has(arg));
  const compiled = await run([process.execPath, ...args.slice(1)], staging);
  assert.equal(compiled.code, 0, compiled.stderr);
  const binary = join(isolated, name); await copyFile(join(staging, name), binary);
  await rename(staging, join(retained, 'build-artifacts'));
  const result = await run([binary], isolated, true);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.mode, 'motif'); assert.equal(parsed.query, 'AAA');
  assert.deepEqual(parsed.hits.map((hit: { position: number; end: number; strand: string }) => [hit.position, hit.end, hit.strand]),
    [[0, 3, '+'], [1, 4, '+'], [2, 5, '+'], [5, 8, '-']]);
  assert.deepEqual(await readdir(isolated), [name]);
}, 90000);
