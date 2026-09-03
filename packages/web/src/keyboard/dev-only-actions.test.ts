import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ActionRegistryList, isVisibleToUser, type ActionDefinition } from './actionRegistry';

/**
 * An action must not be offered where its overlay refuses to render.
 *
 * ## The defect
 *
 * `GpuWasmBenchmarkOverlay` returns `null` unless `import.meta.env.DEV`, but its
 * registry entry had no matching condition. It appeared in the Analysis Menu and
 * the Command Palette in production, where selecting it produced nothing at all:
 * no overlay, no error, no explanation. That is worse than an absent feature,
 * because the user cannot tell whether the app is broken or they are.
 *
 * ## Why the sweep rather than one assertion
 *
 * Asserting only that `gpuWasmBenchmark` is marked would pass forever and catch
 * nothing new. The defect class is "a component gated on DEV whose action is not
 * gated on DEV", so the test derives the expectation from the components: every
 * overlay whose render path is conditioned on `import.meta.env.DEV` must have a
 * `devOnly` action, and -- the direction that matters more -- no action may
 * claim `devOnly` while its component renders fine in production, which would
 * quietly hide a working feature.
 */

const OVERLAY_DIR = join(import.meta.dir, '../components/overlays');

/** Overlay ids whose component refuses to render outside a dev build. */
function devGatedOverlayIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of readdirSync(OVERLAY_DIR).filter(f => f.endsWith('.tsx'))) {
    const src = readFileSync(join(OVERLAY_DIR, file), 'utf8');
    // The shape that matters: an early return of null conditioned on DEV.
    if (!/if\s*\(\s*!import\.meta\.env\.DEV[\s\S]{0,120}?return null/.test(src)) continue;
    for (const m of src.matchAll(/<Overlay\s+id="([A-Za-z0-9_]+)"/g)) ids.add(m[1]!);
  }
  return ids;
}

const devGated = devGatedOverlayIds();
const byOverlayId = new Map(
  ActionRegistryList.filter(a => a.overlayId).map(a => [a.overlayId as string, a])
);

describe('dev-gated overlays are hidden from the menus', () => {
  it('finds at least one dev-gated overlay, so the sweep is not vacuous', () => {
    // If this ever legitimately drops to zero, the two tests below become
    // trivially true and this one is what says so out loud.
    expect(devGated.size).toBeGreaterThan(0);
    expect(devGated).toContain('gpuWasmBenchmark');
  });

  it('every overlay gated on DEV has a devOnly action', () => {
    const unmarked = [...devGated].filter(id => byOverlayId.get(id)?.devOnly !== true);
    expect(unmarked).toEqual([]);
  });

  it('no action claims devOnly while its overlay renders in production', () => {
    // The reverse direction: a stray devOnly hides a working feature from every
    // menu, and nothing else in the app would report it.
    const overHidden = ActionRegistryList
      .filter(a => a.devOnly && a.overlayId)
      .map(a => a.overlayId as string)
      .filter(id => !devGated.has(id));
    expect(overHidden).toEqual([]);
  });
});

describe('isVisibleToUser', () => {
  const base: ActionDefinition = {
    id: 'overlay.help' as ActionDefinition['id'],
    title: 'x',
    category: 'x',
    defaultShortcut: { key: 'x' },
    scope: 'global',
  };

  it('keeps an ordinary action', () => {
    expect(isVisibleToUser(base)).toBe(true);
  });

  it('drops an action belonging to another surface', () => {
    expect(isVisibleToUser({ ...base, surfaces: ['tui'] })).toBe(false);
    expect(isVisibleToUser({ ...base, surfaces: ['tui'] }, 'tui')).toBe(true);
  });

  it('ties devOnly visibility to the build, matching the component', () => {
    // Asserting against the same flag the component reads is the point: the two
    // must agree, and hardcoding either answer here would let them drift.
    expect(isVisibleToUser({ ...base, devOnly: true })).toBe(Boolean(import.meta.env.DEV));
  });

  it('is discriminating', () => {
    // A function returning true unconditionally passes the first test only.
    expect(isVisibleToUser({ ...base, surfaces: ['tui'] })).not.toBe(isVisibleToUser(base));
  });
});

describe('the menus route through the shared rule', () => {
  // Three surfaces each filtering with their own copy of the condition is how
  // this action ended up visible in two of them; the rule now lives in one
  // place and these assert the call sites still use it.
  for (const file of ['AnalysisMenu.tsx', 'HelpOverlay.tsx', 'CommandPalette.tsx']) {
    it(`${file} filters with isVisibleToUser`, () => {
      const src = readFileSync(join(OVERLAY_DIR, file), 'utf8');
      expect(src).toContain('isVisibleToUser');
      expect(src).not.toMatch(/surfaces\s*&&\s*!\s*\w+\.surfaces\.includes\('web'\)/);
    });
  }
});
