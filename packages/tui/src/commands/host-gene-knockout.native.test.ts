import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hostGeneWorkflowFixture } from '../../../core/src/analysis/host-gene-knockout.fixture';
import { replayHostGeneRecord } from '../../../core/src/analysis/host-gene-knockout';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';

// Run against the real main entry point, then again against the compiled executable
// in CI. These do not use the unit tests' injectable transport or Node adapter.
it('runs gene deletion and verified replay through the source or compiled main entrypoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phage-gene-native-')), parameters = join(dir, 'genes.json');
  await writeFile(parameters, JSON.stringify({ genes: ['c', 'd'], mode: 'joint', reference: 'Independent synthetic capacity fixture' }), { flag: 'wx' });
  const command = process.env.PHAGE_HOST_TEST_BINARY ? [resolve(process.env.PHAGE_HOST_TEST_BINARY)] : [process.execPath, resolve(import.meta.dir, '../index.tsx')];
  const child = Bun.spawn([...command, 'host-metabolism', 'knockout', '-', '--params', parameters, '--require-optimal'], {
    cwd: dir, stdin: new Blob([JSON.stringify(hostGeneWorkflowFixture())]), stdout: 'pipe', stderr: 'pipe',
  });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, error);
  const saved = await replayHostGeneRecord(text);
  assert.equal(saved.result.baseline.objective, 9); assert.equal(saved.result.runs[0].scenario.objective, 6);
  const restored = Bun.spawn([...command, 'host-metabolism', 'replay', '-', '--require-optimal'], {
    cwd: dir, stdin: new Blob([text]), stdout: 'pipe', stderr: 'pipe',
  });
  const [replay, replayError, replayCode] = await Promise.all([new Response(restored.stdout).text(), new Response(restored.stderr).text(), restored.exited]);
  assert.equal(replayCode, 0, replayError); assert.equal((await parseAnalysisRecord(replay)).resultId, saved.record.resultId);
}, 30000);

it('preserves an infeasible knockout record while returning the strict pipeline exit code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phage-gene-native-failure-')), parameters = join(dir, 'genes.json');
  await writeFile(parameters, JSON.stringify({ genes: ['c', 'd'], reference: 'Joint deletion with forced objective >= 8' }), { flag: 'wx' });
  const input = hostGeneWorkflowFixture(); input.medium.bounds = [{ reactionId: 'objective', lowerBound: 8, upperBound: 20 }];
  const command = process.env.PHAGE_HOST_TEST_BINARY ? [resolve(process.env.PHAGE_HOST_TEST_BINARY)] : [process.execPath, resolve(import.meta.dir, '../index.tsx')];
  const child = Bun.spawn([...command, 'host-metabolism', 'knockout', '-', '--params', parameters, '--require-optimal'], {
    cwd: dir, stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 2, error);
  const saved = await replayHostGeneRecord(text);
  assert.equal(saved.result.runs[0].scenario.status, 'infeasible');
  assert.equal(saved.result.runs[0].objectiveDelta, null);
}, 30000);
