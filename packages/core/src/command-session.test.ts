import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { CommandSession, parseCommandTape, serializeCommandTape, validateCommandTape, commandValuesEqual,
  type CommandAdapter, type CommandTape, type CommandValue, type PreparedCommand } from './command-session';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function fixture() {
  const applied: number[] = [];
  const adapter: CommandAdapter = {
    validate(parameters) { if (typeof parameters !== 'number' || !Number.isSafeInteger(parameters) || parameters < 0) throw new Error('Nonnegative integer position required.'); },
    async prepare(parameters) { return { output: { contentId: 'exact-input', position: parameters }, apply: () => { applied.push(parameters as number); } }; },
  };
  let contexts = 0;
  const session = new CommandSession(new Map([['nav.goto', adapter]]), async context => {
    contexts++; if (!commandValuesEqual(context, { input: 'exact-input' })) throw new Error('Input digest changed.');
  });
  return { session, adapter, applied, contexts: () => contexts };
}
async function record() {
  const f = fixture();
  f.session.start('A real workflow', { input: 'exact-input' });
  await f.session.dispatch('nav.goto', 10);
  await f.session.dispatch('nav.goto', 20);
  f.session.stop();
  return f;
}
const raw = (commands: CommandTape['commands'] = []): CommandTape => ({
  format: 'phage-explorer-commands', version: 1, name: 'test', context: { input: 'exact-input' }, commands,
});

describe('declarative command sessions', () => {
  it('records successful absolute commands and replays through the same adapters in order', async () => {
    const { session, applied, contexts } = await record();
    const tape = parseCommandTape(session.export());
    assert.deepEqual(tape.commands.map(c => c.actionId), ['nav.goto', 'nav.goto']);
    assert.deepEqual(tape.commands.map(c => c.expected), [{ contentId: 'exact-input', position: 10 }, { contentId: 'exact-input', position: 20 }]);
    await session.replay(2);
    assert.deepEqual(applied, [10, 20, 10, 20, 10, 20]);
    assert.equal(contexts(), 1);
    assert.equal(session.getSnapshot().completed, 4);
    assert.match(session.getSnapshot().notice!, /Verified 4/);
    assert.equal(parseCommandTape(session.export()).commands.length, 2, 'replay must not record itself');
  });
  it('imports without executing and preserves previous tape after invalid import', async () => {
    const { session } = await record();
    const target = fixture();
    target.session.load(session.export());
    assert.deepEqual(target.applied, []);
    assert.equal(target.contexts(), 0);
    const before = target.session.export();
    assert.throws(() => target.session.load('{invalid'), SyntaxError);
    assert.equal(target.session.export(), before);
    await target.session.replay();
    assert.deepEqual(target.applied, [10, 20]);
  });
  it('rejects unsupported schemas, fields, malformed IDs, nonfinite and executable values', () => {
    for (const value of [null, { ...raw(), version: 2 }, { ...raw(), shell: 'ignored?' },
      { ...raw(), name: '' }, { ...raw(), context: Infinity }, { ...raw(), context: () => 1 },
      raw([{ actionId: '__proto__', parameters: {}, expected: {} }]),
      raw([{ actionId: 'nav.goto', parameters: {}, expected: {}, script: 'oops' } as never])]) {
      assert.throws(() => validateCommandTape(value));
    }
    assert.throws(() => parseCommandTape(' '.repeat(10 * 1024 * 1024 + 1)), /10 MiB/);
    let value: unknown = null;
    for (let i = 0; i < 60; i++) value = [value];
    assert.throws(() => validateCommandTape({ ...raw(), context: value }), /nesting/);
    assert.throws(() => validateCommandTape({ ...raw(), context: Array(2) }), /plain JSON/);
  });
  it('validates the whole tape before any command or context side effect', () => {
    const f = fixture();
    assert.throws(() => f.session.load(serializeCommandTape(raw([
      { actionId: 'nav.goto', parameters: 1, expected: {} },
      { actionId: 'unregistered.action', parameters: 1, expected: {} },
    ]))), /Step 2: unsupported/);
    assert.deepEqual(f.applied, []);
    assert.equal(f.contexts(), 0);
  });
  it('revalidates imported parameters before running and names the failing step', () => {
    const f = fixture();
    assert.throws(() => f.session.load(serializeCommandTape(raw([{ actionId: 'nav.goto', parameters: -1, expected: {} }]))), /Step 1.*position/);
  });
  it('refuses changed inputs before preparing any command', async () => {
    const f = await record();
    const tape = parseCommandTape(f.session.export());
    tape.context = { input: 'different' };
    f.session.load(serializeCommandTape(tape));
    await assert.rejects(f.session.replay(), /Input digest changed/);
    assert.deepEqual(f.applied, [10, 20]);
    assert.match(f.session.getSnapshot().error!, /Step 1/);
  });
  it('rejects a recomputed output mismatch before application, even in an otherwise valid session', async () => {
    const f = await record();
    const tape = parseCommandTape(f.session.export());
    tape.commands[1].expected = { contentId: 'exact-input', position: 999 };
    f.session.load(serializeCommandTape(tape));
    await assert.rejects(f.session.replay(), /differs/);
    assert.deepEqual(f.applied, [10, 20, 10]);
    assert.equal(f.session.getSnapshot().completed, 1);
    assert.match(f.session.getSnapshot().error!, /Step 2 \(nav.goto\)/);
  });
  it('compares output structurally, independent of JSON object key insertion order', () => {
    assert.ok(commandValuesEqual({ b: [1, { x: true }], a: 2 }, { a: 2, b: [1, { x: true }] }));
    assert.ok(!commandValuesEqual([1, 2], [2, 1]));
  });
  it('does not record a failed command or allow stop/export while a command is pending', async () => {
    const f = fixture(), pending = deferred<PreparedCommand>();
    f.adapter.prepare = () => pending.promise;
    f.session.start('test', null);
    const task = f.session.dispatch('nav.goto', 1);
    assert.throws(f.session.stop, /active/);
    assert.throws(f.session.export, /active/);
    pending.reject(new Error('worker failed'));
    await assert.rejects(task, /worker failed/);
    assert.equal(f.session.getSnapshot().tape.commands.length, 0);
    assert.equal(f.session.getSnapshot().mode, 'recording');
  });
  it('snapshots command parameters before asynchronous work', async () => {
    const pending = deferred<void>(), applied: number[] = [];
    const session = new CommandSession(new Map([['view.set', {
      validate() {}, async prepare(parameters: CommandValue) { await pending.promise; return { output: parameters, apply: () => { applied.push((parameters as { x: number }).x); } }; },
    }]]), async () => {});
    const params = { x: 3 };
    session.start('test', { n: 1 });
    const work = session.dispatch('view.set', params);
    params.x = 50;
    pending.resolve();
    await work;
    assert.deepEqual(applied, [3]);
    assert.deepEqual(session.getSnapshot().tape.commands[0].parameters, { x: 3 });
  });
  it('cancel settles an ignored-abort provider immediately and its late output is not applied', async () => {
    const f = await record(), pending = deferred<PreparedCommand>();
    let signal!: AbortSignal;
    f.adapter.prepare = (_p, s) => { signal = s; return pending.promise; };
    const replay = f.session.replay();
    await flush();
    f.session.cancel();
    await assert.rejects(replay, { name: 'AbortError' });
    assert.equal(signal.aborted, true);
    pending.resolve({ output: { position: 10, contentId: 'exact-input' }, apply: () => { f.applied.push(999); } });
    await flush();
    assert.deepEqual(f.applied, [10, 20]);
    assert.equal(f.session.getSnapshot().error, null);
  });
  it('an obsolete provider rejection cannot overwrite a newer successful command', async () => {
    const f = await record(), pending = deferred<PreparedCommand>();
    const original = f.adapter.prepare;
    f.adapter.prepare = () => pending.promise;
    const old = f.session.replay();
    await flush();
    f.adapter.prepare = original;
    const handled = assert.rejects(old, { name: 'AbortError' });
    await f.session.dispatch('nav.goto', 77);
    pending.reject(new Error('obsolete'));
    await handled; await flush();
    assert.deepEqual(f.applied, [10, 20, 77]);
    assert.equal(f.session.getSnapshot().error, null);
  });
  it('pauses between commands, resumes at the next one and never re-applies a completed step', async () => {
    const f = await record();
    let paused = false;
    f.session.subscribe(() => {
      if (!paused && f.session.getSnapshot().completed === 1 && f.session.getSnapshot().mode === 'replaying') { paused = true; f.session.pause(); }
    });
    const task = f.session.replay();
    await flush();
    assert.equal(f.session.getSnapshot().mode, 'paused');
    assert.deepEqual(f.applied, [10, 20, 10]);
    f.session.resume();
    await task;
    assert.deepEqual(f.applied, [10, 20, 10, 20]);
  });
  it('cancels a paused replay without requiring resume', async () => {
    const f = await record();
    const task = f.session.replay();
    f.session.pause();
    await flush();
    f.session.cancel();
    await assert.rejects(task, { name: 'AbortError' });
    assert.deepEqual(f.applied, [10, 20]);
  });
  it('bounds repetition and recursion by rejecting unregistered nested macro actions', async () => {
    const f = await record();
    for (const count of [0, -1, 1.5, 11, NaN, Infinity]) await assert.rejects(f.session.replay(count), /repetitions/);
    const tape = raw(Array.from({ length: 128 }, () => ({ actionId: 'nav.goto', parameters: 1, expected: { contentId: 'exact-input', position: 1 } })));
    f.session.load(serializeCommandTape(tape));
    await assert.rejects(f.session.replay(3), /256/);
    assert.throws(() => f.session.load(serializeCommandTape(raw([{ actionId: 'macro.replay', parameters: 1, expected: null }]))), /unsupported/);
    assert.throws(() => validateCommandTape({ ...tape, commands: [...tape.commands, tape.commands[0]] }), /128/);
  });
  it('cannot launch work when cancellation occurs in a start notification', async () => {
    const f = fixture(); let preparations = 0;
    f.adapter.prepare = async () => { preparations++; throw new Error('must not run'); };
    const unsubscribe = f.session.subscribe(() => { if (f.session.getSnapshot().mode === 'executing') f.session.cancel(); });
    await assert.rejects(f.session.dispatch('nav.goto', 1), { name: 'AbortError' });
    unsubscribe();
    assert.equal(preparations, 0);
  });
  it('never publishes a verified completion after cancellation at the final progress callback', async () => {
    const f = await record();
    const unsub = f.session.subscribe(() => { if (f.session.getSnapshot().completed === 2 && f.session.getSnapshot().mode === 'replaying') f.session.cancel(); });
    await assert.rejects(f.session.replay(), { name: 'AbortError' });
    unsub();
    assert.match(f.session.getSnapshot().notice!, /Cancelled/);
    assert.equal(f.session.getSnapshot().mode, 'idle');
  });
  it('refuses empty playback and recording during a replay', async () => {
    const f = fixture();
    await assert.rejects(f.session.replay(), /no recorded/);
    const recorded = await record();
    const task = recorded.session.replay();
    assert.throws(() => recorded.session.start('other', null), /Cancel/);
    await task;
  });
});


it('a rapid resume then pause still blocks the next unstarted command', async () => {
  const f = await record();
  const task = f.session.replay();
  f.session.pause();
  await flush();
  f.session.resume();
  f.session.pause();
  await flush();
  assert.deepEqual(f.applied, [10, 20]);
  assert.equal(f.session.getSnapshot().mode, 'paused');
  f.session.resume();
  await task;
  assert.deepEqual(f.applied, [10, 20, 10, 20]);
});
