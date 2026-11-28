import { test, expect } from 'bun:test';
import { repairApplicationShell } from './registerSW';
import { applicationScope, obsoleteRuntimeCache, runtimeCache, workerGeneration } from './service-worker-runtime';

const origin = 'https://example.test';
const id = '7ae09a84-2bc7-422a-a40d-cfb014fc532a';

test('only exact owned shell and WASM generations can be retired at root or at a subpath', () => {
  for (const base of ['/', '/tools/phage']) {
    const scope = applicationScope(base, origin + '/tools/phage/?view=1');
    expect(scope).toBe(origin + (base === '/' ? '/' : base + '/'));
    expect(workerGeneration(new URL('sw.js?repair=' + id, scope).href, scope)).toBe(id);
    expect(workerGeneration(new URL('sw.js?unrelated=1', scope).href, scope)).toBeNull();
    expect(workerGeneration(new URL('other/sw.js', scope).href, scope)).toBeNull();
    const live = new Set([id]);
    for (const kind of ['shell', 'wasm'] as const) {
      expect(obsoleteRuntimeCache(runtimeCache(scope, kind, 'default'), scope, live)).toBe(true);
      expect(obsoleteRuntimeCache(runtimeCache(scope, kind, id), scope, live)).toBe(false);
      expect(obsoleteRuntimeCache(runtimeCache(scope + 'sibling/', kind, 'default'), scope, live)).toBe(false);
    }
    for (const name of ['workbox-precache-v2-' + scope, 'other-wasm', 'phage-explorer-data-v3',
      'phage-explorer-manifests-v3', 'phage-explorer-offline-manifests-v3', 'phage-database-v2']) {
      expect(obsoleteRuntimeCache(name, scope, live)).toBe(false);
    }
  }
});

test('offline devices and an unrelated exact-scope worker cause no registration or storage writes', async () => {
  const scope = origin + '/genomes/';
  let lookups = 0, writes = 0;
  const container = {
    getRegistration: async () => {
      lookups++;
      return { scope, installing: null, waiting: null, active: { scriptURL: scope + 'other.js' } };
    },
    register: async () => { writes++; },
  } as unknown as ServiceWorkerContainer;
  await expect(repairApplicationShell(container, scope, () => false)).rejects.toThrow('Reconnect');
  expect(lookups).toBe(0);
  await expect(repairApplicationShell(container, scope, () => true)).rejects.toThrow('Another application');
  expect(writes).toBe(0);
});

test('a nested repair waits for the matching replacement and leaves the enclosing worker alone', async () => {
  const scope = origin + '/phage/';
  const parent = { scope: origin + '/', active: { scriptURL: origin + '/other.js' } };
  const active = new EventTarget();
  const candidate = Object.assign(new EventTarget(), {
    scriptURL: '', state: 'installing', postMessage: (message: unknown) => {
      expect(message).toEqual({ type: 'SKIP_WAITING' });
      container.controller = candidate;
      container.dispatchEvent(new Event('controllerchange'));
    },
  });
  const registration = Object.assign(new EventTarget(), { scope, installing: candidate, waiting: null, active });
  const container = Object.assign(new EventTarget(), {
    controller: parent.active,
    getRegistration: async () => parent,
    register: async (url: string, options: RegistrationOptions) => {
      expect(options).toEqual({ scope, updateViaCache: 'none' });
      expect(workerGeneration(url, scope)).toMatch(/^[a-f0-9-]{36}$/);
      candidate.scriptURL = url;
      setTimeout(() => { candidate.state = 'installed'; candidate.dispatchEvent(new Event('statechange')); }, 0);
      return registration;
    },
  });
  await repairApplicationShell(container as unknown as ServiceWorkerContainer, scope, () => true);
  expect(container.controller).toBe(candidate);
  expect(parent.active.scriptURL).toBe(origin + '/other.js');
});
