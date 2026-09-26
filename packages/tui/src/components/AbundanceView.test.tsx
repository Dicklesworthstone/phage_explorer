import React from 'react';
import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AbundanceView } from './AbundanceView';
import { AbundanceWorkspace, abundanceTerminalLabel } from '../commands/abundance';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';

async function until(check: () => boolean, description: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 10000) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it('real Ink keyboard workflow analyzes, edits, inspects, exports and verifies without firing shortcuts inside inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phage-abundance-ink-'));
  const inputFile = join(dir, 'input.csv'), outputFile = join(dir, 'saved.json');
  await writeFile(inputFile, 'taxon,S1,S2,S3\nA,1,4,16\nB,16,4,1\n');
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => input, ref: () => input, unref: () => input });
  let frames = '';
  const output = new Writable({ write(chunk, _encoding, done) { frames += abundanceTerminalLabel(chunk.toString()); done(); } });
  Object.assign(output, { columns: 100, rows: 32, isTTY: false });
  const workspace = new AbundanceWorkspace();
  const app = render(<AbundanceView workspace={workspace} initialPath={inputFile} />, {
    stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  let exited = false;
  const exit = app.waitUntilExit().then(() => { exited = true; });
  const key = async (value: string) => { input.write(value); await new Promise(resolve => setTimeout(resolve, 30)); };
  try {
    await until(() => !!workspace.getSnapshot().accepted && !workspace.getSnapshot().busy, 'initial file load');
    await until(() => frames.includes('Dataset loaded.'), 'initial view render');
    await key('\r');
    await until(() => !!workspace.getSnapshot().accepted?.record && !workspace.getSnapshot().busy, 'first analysis');
    const original = workspace.getSnapshot().accepted!.record!;
    assert.equal(original.seed, 42);
    await until(() => frames.includes(original.resultId), 'first result render');
    await key('p');
    await until(() => frames.includes('Parameter JSON'), 'parameter prompt');
    await key('{"seed":7}');
    assert.equal(exited, false);
    assert.strictEqual(workspace.getSnapshot().accepted!.record, original);
    await key('\r');
    await until(() => workspace.getSnapshot().options?.seed === 7, 'parameter edit');
    assert.equal(workspace.getSnapshot().accepted?.record?.seed, 42, 'editing must not relabel the previous result');
    await until(() => frames.includes('Parameters edited.'), 'parameter status render');
    await key('a');
    await until(() => workspace.getSnapshot().accepted?.record?.seed === 7 && !workspace.getSnapshot().busy, 'second analysis');
    const updated = workspace.getSnapshot().accepted!.record!;
    await until(() => frames.includes(updated.resultId), 'updated result render');
    await key('2'); await key('j');
    await until(() => frames.includes('Taxon 2/2'), 'taxon profile navigation');
    await key('e'); await key(outputFile); await key('\r');
    await until(() => !!workspace.getSnapshot().notice?.startsWith('Saved analysis') && !workspace.getSnapshot().busy, 'result export');
    assert.equal((await parseAnalysisRecord(await readFile(outputFile, 'utf8'))).resultId, updated.resultId);
    await key('o'); await key(outputFile); await key('\r');
    await until(() => !!workspace.getSnapshot().notice?.startsWith('Verified replay') && !workspace.getSnapshot().busy, 'verified restoration');
    assert.equal(workspace.getSnapshot().accepted?.record?.resultId, updated.resultId);
    await key('o'); await key('quit-file.csv');
    assert.equal(exited, false, 'the letter q inside a path must not quit the workspace');
    await key('\x1b'); await key('q'); await exit;
    assert.equal(exited, true);
  } finally { app.unmount(); workspace.deactivate(); input.end(); }
}, 30000);
