import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { WorkerTaskPool } from './WorkerTaskPool';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(capacity = 2) {
  type Resource = { id: number; kind: string };
  const created: Resource[] = [];
  const destroyed: Resource[] = [];
  const pool = new WorkerTaskPool<string, Resource>(capacity, kind => {
    const resource = { id: created.length, kind };
    created.push(resource);
    return resource;
  }, resource => { destroyed.push(resource); });
  return { pool, created, destroyed };
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('WorkerTaskPool', () => {
  it('enforces the global cap during a burst and schedules waiting tasks FIFO', async () => {
    const { pool, created } = fixture();
    const gates = Array.from({ length: 12 }, () => deferred<number>());
    const starts: number[] = [];
    const tasks = gates.map((gate, index) => pool.run('analysis', () => {
      starts.push(index);
      return gate.promise;
    }));
    assert.deepEqual(starts, [0, 1]);
    assert.equal(created.length, 2);
    assert.equal(pool.getStats().queued, 10);
    for (let index = 0; index < gates.length; index++) {
      gates[index].resolve(index);
      await tick();
      assert.ok(pool.getStats().total <= 2);
      assert.deepEqual(starts, Array.from({ length: Math.min(index + 3, 12) }, (_, i) => i));
    }
    assert.deepEqual(await Promise.all(tasks), Array.from({ length: 12 }, (_, i) => i));
    assert.equal(created.length, 2);
    assert.equal(pool.getStats().busy, 0);
    pool.dispose();
  });

  it('shares a one-worker budget between analysis and simulation without deadlock', async () => {
    const { pool, created, destroyed } = fixture(1);
    const gate = deferred<string>();
    const first = pool.run('analysis', () => gate.promise);
    const second = pool.run('simulation', resource => resource.kind);
    const third = pool.run('analysis', resource => resource.kind);
    gate.resolve('first');
    assert.deepEqual(await Promise.all([first, second, third]), ['first', 'simulation', 'analysis']);
    assert.equal(created.length, 3);
    assert.equal(destroyed.length, 2);
    assert.equal(pool.getStats().total, 1);
    pool.dispose();
  });

  it('reuses a healthy idle worker of the same kind', async () => {
    const { pool, created } = fixture();
    const first = await pool.run('analysis', resource => resource.id);
    assert.equal(await pool.run('analysis', resource => resource.id), first);
    assert.equal(created.length, 1);
    pool.dispose();
  });

  it('rejects a pre-aborted request without creating a worker', async () => {
    const { pool, created } = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pool.run('analysis', () => assert.fail('must not run'), controller.signal), { name: 'AbortError' });
    assert.equal(created.length, 0);
    pool.dispose();
  });

  it('removes queued cancellation without terminating another task', async () => {
    const { pool, destroyed } = fixture(1);
    const gate = deferred<number>();
    const first = pool.run('analysis', () => gate.promise);
    const controller = new AbortController();
    const second = pool.run('analysis', () => assert.fail('cancelled task ran'), controller.signal);
    const rejected = assert.rejects(second, { name: 'AbortError' });
    const third = pool.run('analysis', () => 3);
    controller.abort();
    await rejected;
    assert.equal(destroyed.length, 0);
    assert.equal(pool.getStats().queued, 1);
    gate.resolve(1);
    assert.deepEqual(await Promise.all([first, third]), [1, 3]);
    pool.dispose();
  });

  it('terminates running cancellation, starts the next task and ignores late success', async () => {
    const { pool, destroyed, created } = fixture(1);
    const gate = deferred<number>();
    const next = deferred<number>();
    const controller = new AbortController();
    const first = pool.run('analysis', () => gate.promise, controller.signal);
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const second = pool.run('analysis', () => next.promise);
    controller.abort();
    await rejected;
    assert.equal(destroyed.length, 1);
    assert.equal(created.length, 2);
    gate.resolve(99);
    await tick();
    assert.equal(pool.getStats().busy, 1);
    next.resolve(2);
    assert.equal(await second, 2);
    pool.dispose();
    assert.equal(destroyed.length, 2);
  });

  it('consumes a late rejected RPC after cancellation without affecting its replacement', async () => {
    const { pool } = fixture(1);
    const gate = deferred<number>();
    const controller = new AbortController();
    const first = pool.run('analysis', () => gate.promise, controller.signal);
    const rejected = assert.rejects(first, { name: 'AbortError' });
    controller.abort();
    await rejected;
    gate.reject(new Error('late worker response'));
    await tick();
    assert.equal(await pool.run('analysis', () => 7), 7);
    pool.dispose();
  });

  it('detaches abort listeners after success so a reused worker is not terminated', async () => {
    const { pool, destroyed } = fixture(1);
    const controller = new AbortController();
    await pool.run('analysis', () => 1, controller.signal);
    const gate = deferred<number>();
    const second = pool.run('analysis', () => gate.promise);
    controller.abort();
    assert.equal(destroyed.length, 0);
    gate.resolve(2);
    assert.equal(await second, 2);
    pool.dispose();
  });

  it('invalidates an unresponsive RPC on a browser worker error', async () => {
    const { pool, created, destroyed } = fixture(1);
    const stalled = deferred<number>();
    const first = pool.run('analysis', () => stalled.promise);
    const rejected = assert.rejects(first, /worker crashed/);
    const second = pool.run('analysis', () => 2);
    pool.invalidate(created[0], new Error('worker crashed'));
    await rejected;
    assert.equal(await second, 2);
    assert.equal(destroyed.length, 1);
    pool.invalidate(created[0], new Error('duplicate event'));
    assert.equal(destroyed.length, 1);
    pool.dispose();
  });

  it('recovers after synchronous task failure and asynchronous RPC rejection', async () => {
    const { pool, destroyed } = fixture(1);
    await assert.rejects(pool.run('analysis', () => { throw new Error('sync'); }), /sync/);
    await assert.rejects(pool.run('analysis', () => Promise.reject(new Error('async'))), /async/);
    assert.equal(destroyed.length, 2);
    assert.equal(await pool.run('analysis', () => 3), 3);
    pool.dispose();
  });

  it('continues the queue after worker construction fails', async () => {
    let attempts = 0;
    const pool = new WorkerTaskPool(1, () => {
      if (++attempts === 1) throw new Error('worker unavailable');
      return {};
    }, () => {});
    await assert.rejects(pool.run('analysis', () => 1), /worker unavailable/);
    assert.equal(await pool.run('analysis', () => 2), 2);
    pool.dispose();
  });

  it('settles both queued and running promises on disposal, exactly once', async () => {
    const { pool, destroyed } = fixture(1);
    const gate = deferred<number>();
    const first = pool.run('analysis', () => gate.promise);
    const second = pool.run('simulation', () => assert.fail('disposed task ran'));
    const rejected = Promise.all([
      assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' }),
    ]);
    pool.dispose();
    pool.dispose();
    await rejected;
    gate.resolve(9);
    await tick();
    assert.equal(destroyed.length, 1);
    assert.equal(pool.getStats().total, 0);
    assert.equal(pool.getStats().queued, 0);
    await assert.rejects(pool.run('analysis', () => 3), /disposed/);
  });

  it('prunes idle workers while preserving active tasks and one warm worker per kind', async () => {
    const { pool } = fixture(3);
    const gate = deferred<number>();
    const active = pool.run('analysis', () => gate.promise);
    await Promise.all([pool.run('analysis', () => 2), pool.run('simulation', () => 3)]);
    pool.pruneIdle(0, Date.now() + 1000);
    assert.equal(pool.getStats().total, 2);
    assert.equal(pool.getStats().busy, 1);
    gate.resolve(1);
    assert.equal(await active, 1);
    pool.dispose();
  });

  it('does not strand promises if worker termination itself throws', async () => {
    const pool = new WorkerTaskPool(1, () => ({}), () => { throw new Error('termination error'); });
    const gate = deferred<number>();
    const controller = new AbortController();
    const first = pool.run('analysis', () => gate.promise, controller.signal);
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const second = pool.run('simulation', () => 2);
    controller.abort();
    await rejected;
    assert.equal(await second, 2);
    pool.dispose();
  });

  it('rejects invalid capacity instead of silently creating unlimited workers', () => {
    for (const capacity of [0, -1, 1.5, Infinity, NaN]) {
      assert.throws(() => fixture(capacity), /positive safe integer/);
    }
  });
});
