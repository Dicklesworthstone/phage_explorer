/** Shared identity for the page registering a worker and the worker's shell caches. */
const REPAIR_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export function applicationScope(base: string, page: string): string {
  const scope = new URL(base, page);
  if (scope.origin !== new URL(page).origin || scope.search || scope.hash) throw new Error('Invalid application base URL.');
  if (!scope.pathname.endsWith('/')) scope.pathname += '/';
  return scope.href;
}

export function workerGeneration(script: string, scope: string): string | null {
  const url = new URL(script), expected = new URL('sw.js', scope);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash) return null;
  if (!url.search) return 'default';
  const repair = url.searchParams.get('repair');
  return repair && REPAIR_ID.test(repair) && url.search === `?repair=${repair}` ? repair : null;
}

export function runtimeCache(scope: string, kind: 'shell' | 'wasm', generation: string): string {
  return `phage-explorer:${encodeURIComponent(scope)}:${kind}:${generation}`;
}

export function obsoleteRuntimeCache(name: string, scope: string, live: Set<string>): boolean {
  for (const kind of ['shell', 'wasm'] as const) {
    const prefix = runtimeCache(scope, kind, '');
    if (name.startsWith(prefix)) {
      const generation = name.slice(prefix.length);
      return (generation === 'default' || REPAIR_ID.test(generation)) && !live.has(generation);
    }
  }
  return false;
}
