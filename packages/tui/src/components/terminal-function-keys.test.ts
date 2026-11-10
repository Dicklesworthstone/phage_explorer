import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { bindTerminalFunctionKeys } from './terminal-function-keys';

describe('single raw function-key owner', () => {
  it('accepts only existing exact unmodified sequences and removes its listener', () => {
    const stdin = new PassThrough(), keys: string[] = [];
    const dispose = bindTerminalFunctionKeys(stdin, key => keys.push(key));
    stdin.write('\u001b[17~');
    stdin.write(Buffer.from('\u001bOP'));
    for (const text of ['F6', '[17~', '\u001b[17;2~', '\u001b[17;5~', 'prefix\u001b[17~', '\u001b[17~suffix', 'constructor', '__proto__']) stdin.write(text);
    assert.deepEqual(keys, ['F6', 'F1']);
    assert.equal(stdin.listenerCount('data'), 1);
    dispose(); assert.equal(stdin.listenerCount('data'), 0);
    stdin.write('\u001b[17~'); assert.deepEqual(keys, ['F6', 'F1']);
  });
});
